"""Calibrate road speeds against bus running times derived from LTA's live BusArrival feed.

Observation: in one polling cycle the same GPS-monitored bus often appears as the next bus
of its service at two consecutive stops A -> B of its route. The difference of the two
estimated arrival times is LTA's current estimate of the running time A -> B (it includes
the bus's dwell at A). We match the bus at A and B by service, monitored status, an
identical reported GPS position (within 30 m) and eta_A <= eta_B, and keep pairs whose
polls are less than 90 s apart.

These are LTA *estimates* based on live GPS, not observed passage times; they are used
to calibrate one speed multiplier per road class group, with the bus dwell as a second
parameter. The model's bus running time for A -> B is T[A, B] + dwell (as in busnet.py).
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
from scipy.optimize import least_squares

from .paths import RAW


def segment_observations(path, max_gap: int = 6) -> pd.DataFrame:
    """Running-time observations between stops A and B that are 1..max_gap stops apart on
    the same service route (the bus is matched at A and B by service, cycle and position)."""
    d = pd.read_csv(path, dtype={"stop": str, "service": str, "origin": str, "destination": str})
    d = d[(d.monitored == 1) & (d.lat != 0)].copy()
    d["poll"] = pd.to_datetime(d.poll_ts)
    d["eta_t"] = pd.to_datetime(d.eta)
    routes = pd.DataFrame(json.loads((RAW / "lta" / "bus_routes.json").read_text()))
    pairs = []
    for (s, _), g in routes.groupby(["ServiceNo", "Direction"]):
        c = g.sort_values("StopSequence").BusStopCode.tolist()
        for i in range(len(c)):
            for k in range(1, max_gap + 1):
                if i + k < len(c) and c[i] != c[i + k]:
                    pairs.append((s, c[i], c[i + k], k, tuple(c[i:i + k + 1])))
    pairs = pd.DataFrame(pairs, columns=["service", "a", "b", "gap", "seq"])
    pairs = pairs.drop_duplicates(["service", "a", "b"])
    d["cyc"] = (d.poll.astype("int64") // 10**9 // 90).astype(int)
    # The same bus reports the same GPS fix at both stops: join on a coarse position key
    # (~110 m cells, plus the neighbouring cell to avoid edge effects) so the merge stays
    # close to one-to-one, then keep only (service, a, b) pairs that are on a route.
    d["la"] = (d.lat * 1000).round().astype(int)
    d["lo"] = (d.lon * 1000).round().astype(int)
    A = d.rename(columns={"stop": "a"})[["cyc", "service", "a", "poll", "eta_t", "lat", "lon", "la", "lo"]]
    B = d.rename(columns={"stop": "b"})[["cyc", "service", "b", "poll", "eta_t", "lat", "lon", "la", "lo"]]
    parts = []
    for dla in (-1, 0, 1):
        for dlo in (-1, 0, 1):
            Bs = B.assign(la=B.la + dla, lo=B.lo + dlo)
            parts.append(A.merge(Bs, on=["cyc", "service", "la", "lo"], suffixes=("_a", "_b")))
    m = pd.concat(parts, ignore_index=True)
    m = m[m.a != m.b].merge(pairs, on=["service", "a", "b"])
    lat0 = np.deg2rad(1.42)
    dist = np.hypot((m.lat_a - m.lat_b) * 111_320, (m.lon_a - m.lon_b) * 111_320 * np.cos(lat0))
    dt_poll = (m.poll_b - m.poll_a).dt.total_seconds().abs()
    run = (m.eta_t_b - m.eta_t_a).dt.total_seconds()
    ok = (dist < 30) & (dt_poll < 90) & (run > 0) & (run < 1800)
    out = m.loc[ok, ["service", "a", "b", "gap", "seq", "poll_a"]].copy()
    out["run_s"] = run[ok]
    out["hour"] = out.poll_a.dt.hour
    return out


GROUPS = {
    "arterial": {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
                 "secondary", "secondary_link"},
    "local": {"tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service"},
}


def _group(cls: str) -> int:
    return 0 if cls in GROUPS["arterial"] else 1


def leg_features(R, a: int, b: int) -> np.ndarray:
    """[free-flow s on arterials, free-flow s on local roads, signal points] along the routed
    leg a->b; partially traversed stop edges contribute in proportion to the part driven."""
    from .routing import node_path_to_stop
    out = np.zeros(3)

    def add(cls, ff, nsig, share):
        out[_group(cls)] += ff * share
        out[2] += nsig * share

    same = (R.stop_u[a] == R.stop_u[b] and R.stop_v[a] == R.stop_v[b] and R.stop_frac[b] >= R.stop_frac[a])
    if same:
        add(R.stop_edge_cls[a], *R.stop_edge_ff[a], R.stop_frac[b] - R.stop_frac[a])
        return out
    add(R.stop_edge_cls[a], *R.stop_edge_ff[a], 1 - R.stop_frac[a])
    path = node_path_to_stop(R, int(R.stop_v[a]), b)
    for x, y in zip(path[:-1], path[1:]):
        add(R.edge_cls[(x, y)], *R.edge_ff[(x, y)], 1.0)
    add(R.stop_edge_cls[b], *R.stop_edge_ff[b], R.stop_frac[b])
    return out


def segment_table(obs: pd.DataFrame, R, stop_index: dict, hub_codes: set[str],
                  max_dist_mismatch: float = 0.4) -> pd.DataFrame:
    """One row per observed (A, B, stop sequence): median observed time, n, model features.

    Features are summed over the consecutive legs of the route between A and B; dwell is
    incurred at A and at every intermediate stop (`gap` stops in total). Sequences containing
    a leg whose routed network distance differs from LTA's published route distance by more
    than `max_dist_mismatch` are dropped (network snapping/topology errors, not speed info)."""
    routes = pd.DataFrame(json.loads((RAW / "lta" / "bus_routes.json").read_text()))
    lta_m = {}
    for _, g in routes.groupby(["ServiceNo", "Direction"]):
        g = g.sort_values("StopSequence")
        for a, b, ka, kb in zip(g.BusStopCode[:-1], g.BusStopCode[1:], g.Distance[:-1], g.Distance[1:]):
            lta_m.setdefault((a, b), (float(kb) - float(ka)) * 1000)
    obs = obs[obs.seq.apply(lambda q: all(c in stop_index for c in q))]
    seg = obs.groupby(["a", "b", "seq", "gap"]).run_s.agg(["median", "count"]).reset_index()
    feats, used = [], []
    cache = {}
    for q in seg.seq:
        f = np.zeros(3); ok = True; lta = net = 0.0
        for x, y in zip(q[:-1], q[1:]):
            if (x, y) not in cache:
                cache[(x, y)] = leg_features(R, stop_index[x], stop_index[y])
            f += cache[(x, y)]
            n_m = R.Dm[stop_index[x], stop_index[y]]
            l_m = lta_m.get((x, y), np.nan)
            if not np.isfinite(l_m) or abs(n_m - l_m) / max(l_m, 100) > max_dist_mismatch:
                ok = False
            net += n_m
        hubs = sum(c in hub_codes for c in q[:-1])
        feats.append((f[0] + f[1], f[2], hubs, net))
        used.append(ok)
    F = np.array(feats)
    seg["t_ff"], seg["n_sig"], seg["n_hub"], seg["net_m"] = F[:, 0], F[:, 1], F[:, 2], F[:, 3]
    seg["used"] = used
    return seg


def fit(seg: pd.DataFrame, n_boot: int = 300, seed: int = 0) -> dict:
    """Weighted least squares on segment medians (weights = sqrt(observations)):

        median_run ~ m * t_ff + sig_s * n_sig + dwell_s * gap + hub_extra_s * n_hub

    t_ff: free-flow seconds along the route at the default class speeds, n_sig: signal-
    controlled locations passed, gap: stops served (A and intermediate stops), n_hub: of
    those, MRT/interchange stops.
    Uncertainty: bootstrap over segments."""
    s = seg[seg.used]
    X = np.c_[s.t_ff, s.n_sig, s.gap, s.n_hub]
    y = s["median"].to_numpy()
    w = np.sqrt(s["count"].to_numpy())

    def solve(idx):
        sol = least_squares(lambda p: (X[idx] @ p - y[idx]) * w[idx], x0=[1.3, 10.0, 30.0, 30.0],
                            bounds=([0.3, 0.0, 0.0, 0.0], [5.0, 90.0, 150.0, 300.0]))
        return sol.x

    p = solve(np.arange(len(s)))
    rng = np.random.default_rng(seed)
    boots = np.array([solve(rng.integers(0, len(s), len(s))) for _ in range(n_boot)])
    lo, hi = np.percentile(boots, [2.5, 97.5], axis=0)
    pred = X @ p
    names = ["mult", "sig_s", "dwell_s", "hub_extra_s"]
    out = {k: float(v) for k, v in zip(names, p)}
    out.update({f"{k}_ci": [round(float(a), 3), round(float(b), 3)] for k, a, b in zip(names, lo, hi)})
    out.update({"n_segments_used": int(len(s)), "n_segments_dropped": int((~seg.used).sum()),
                "n_obs_used": int(s["count"].sum()),
                "segment_mae_s": float(np.average(np.abs(pred - y), weights=s["count"])),
                "segment_r": float(np.corrcoef(pred, y)[0, 1]),
                "mean_obs_s": float(np.average(y, weights=s["count"]))})
    return out


def headway_kappa(paths: list) -> dict:
    """kappa = E[W] / E[H] for random rider arrivals, E[W] = E[H^2] / (2 E[H]), from the
    instantaneous headways between successive predicted arrivals (NextBus, NextBus2,
    NextBus3) of each service at each polled stop. Returns the median over service-stops
    with >= 10 headways, its IQR and the pooled headway CV."""
    d = pd.concat([pd.read_csv(p, dtype={"stop": str, "service": str}) for p in paths], ignore_index=True)
    d["eta_t"] = pd.to_datetime(d.eta)
    w = d.pivot_table(index=["poll_ts", "stop", "service"], columns="k", values="eta_t", aggfunc="first")
    hs = []
    for a, b in ((1, 2), (2, 3)):
        if a in w and b in w:
            x = ((w[b] - w[a]).dt.total_seconds() / 60).rename("h").reset_index()
            hs.append(x)
    hw = pd.concat(hs, ignore_index=True).dropna()
    hw = hw[(hw.h > 0.5) & (hw.h < 60)]
    k = hw.groupby(["service", "stop"]).h.apply(
        lambda s: (s.pow(2).mean() / (2 * s.mean())) / s.mean() if len(s) >= 10 else np.nan).dropna()
    cv = hw.groupby("service").h.apply(lambda s: s.std() / s.mean())
    n = hw.groupby("service").size()
    return {"kappa": float(k.median()), "kappa_iqr": [float(k.quantile(.25)), float(k.quantile(.75))],
            "kappa_n_service_stops": int(len(k)), "headway_cv_pooled": float(np.average(cv, weights=n))}


def run(paths: list, out_path=None) -> dict:
    """Fit on the given live BusArrival logs and write data/processed/calibration.json."""
    from .model import build_model
    from .paths import PROCESSED

    M = build_model(cal={"mult_arterial": 1.0, "mult_local": 1.0, "sig_s": 0.0})  # free-flow routing
    obs = pd.concat([segment_observations(p) for p in paths], ignore_index=True)
    hubs = set(M.stops.index[M.stops.is_hub])
    seg = segment_table(obs, M.R, M.stop_index, hubs)
    res = fit(seg)
    res.update(headway_kappa(paths))
    res["source_files"] = [str(p).split("data/")[-1] for p in paths]
    res["hours_sgt"] = sorted(int(h) for h in obs.hour.unique())
    res["note"] = ("Running times are differences of LTA BusArrival estimated arrival times for the same "
                   "GPS-monitored bus at two stops of its route in one polling cycle (LTA estimates, not "
                   "observed passage times).")
    out = out_path or PROCESSED / "calibration.json"
    out.write_text(json.dumps(res, indent=2))
    return res


def load() -> dict:
    from .paths import PROCESSED
    return json.loads((PROCESSED / "calibration.json").read_text())


def as_network_cal(res: dict) -> dict:
    return {"mult_arterial": res["mult"], "mult_local": res["mult"], "sig_s": res["sig_s"]}


if __name__ == "__main__":
    import glob
    import sys
    from .paths import RAW as _RAW
    files = sys.argv[1:] or sorted(glob.glob(str(_RAW / "lta" / "live" / "bus_arrival_*.csv")))
    print(json.dumps(run(files), indent=2))
