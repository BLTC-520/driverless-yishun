"""Calibrate road speeds against bus running times derived from LTA's live BusArrival feed.

Observation: in one polling cycle the same GPS-monitored bus often appears as the next bus
of its service at two consecutive stops A -> B of its route. The difference of the two
estimated arrival times is LTA's current estimate of the running time A -> B (it includes
the bus's dwell at A). We match the bus at A and B by service, monitored status, an
identical reported GPS position (within 30 m) and eta_A <= eta_B, and keep pairs whose
polls are less than 90 s apart.

These are LTA *estimates* based on live GPS, not observed passage times. They calibrate
one cruise multiplier shared by all road classes, a delay per signal-controlled location
passed, a bus dwell per stop served and an extra dwell at MRT/interchange stops (see fit()).
Uncertainty is a cluster bootstrap over bus services; predictive skill is checked by
holding out whole services. gps_check.py tests the result against bus GPS movement.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
from scipy.optimize import least_squares

from .paths import RAW

CALIBRATION_HOURS = (10, 12)   # late morning, 10:00-12:59 SGT: the base calibration window


def segment_observations(path, max_gap: int = 6) -> pd.DataFrame:
    """Running-time observations between stops A and B that are 1..max_gap stops apart on
    the same service route.

    Within one polling cycle a GPS-monitored bus is identified by (service, reported position
    rounded to ~11 m). For each such bus we look up its predicted arrival at every polled stop
    and keep stop pairs that are route-adjacent within max_gap stops, with the downstream ETA
    later than the upstream one and the two polls less than 90 s apart. Grouping by bus first
    keeps memory linear in the log size."""
    d = pd.read_csv(path, dtype={"stop": str, "service": str, "origin": str, "destination": str})
    d = d[(d.monitored == 1) & d.lat.notna() & (d.lat != 0)].copy()
    poll = pd.to_datetime(d.poll_ts)
    eta = pd.to_datetime(d.eta)
    d["poll_s"] = (poll - poll.min()).dt.total_seconds()
    d["eta_s"] = (eta - poll.min()).dt.total_seconds()
    d["cyc"] = (d.poll_s // 90).astype(int)
    d["bus"] = (d.lat * 1e4).round().astype(int).astype(str) + "_" + (d.lon * 1e4).round().astype(int).astype(str)
    d["hour"] = poll.dt.hour
    routes = pd.DataFrame(json.loads((RAW / "lta" / "bus_routes.json").read_text()))
    nxt: dict[tuple[str, str], list[tuple[str, int, tuple]]] = {}
    for (svc, _), g in routes.groupby(["ServiceNo", "Direction"]):
        c = g.sort_values("StopSequence").BusStopCode.tolist()
        for i in range(len(c)):
            for k in range(1, max_gap + 1):
                if i + k < len(c) and c[i] != c[i + k]:
                    lst = nxt.setdefault((svc, c[i]), [])
                    if all(b != c[i + k] for b, _, _ in lst):
                        lst.append((c[i + k], k, tuple(c[i:i + k + 1])))
    out = []
    cols = ["stop", "eta_s", "poll_s", "hour"]
    for (svc, cyc, bus), g in d.groupby(["service", "cyc", "bus"], sort=False):
        if len(g) < 2:
            continue
        at = {r[0]: r for r in g[cols].itertuples(index=False)}
        for a, ra in at.items():
            for b, gap, seq in nxt.get((svc, a), ()):
                rb = at.get(b)
                if rb is None:
                    continue
                run = rb[1] - ra[1]
                if 0 < run < 1800 and abs(rb[2] - ra[2]) < 90:
                    out.append((svc, a, b, gap, seq, run, ra[3]))
    return pd.DataFrame(out, columns=["service", "a", "b", "gap", "seq", "run_s", "hour"])


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
    grp = obs.groupby(["a", "b", "seq", "gap"])
    seg = grp.run_s.agg(["median", "count"]).reset_index()
    # the service contributing most observations: overlapping sequences of one service are not
    # independent, so the bootstrap and the hold-out resample whole services
    seg["cluster"] = grp.service.agg(lambda x: x.value_counts().index[0]).to_numpy()
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


def _wls(X, y, w, x0, lb, ub):
    return least_squares(lambda p: (X @ p - y) * w, x0=x0, bounds=(lb, ub)).x


def fit(seg: pd.DataFrame, n_boot: int = 300, seed: int = 0, folds: int = 5) -> dict:
    """Weighted least squares on segment medians (weights = sqrt(observations)):

        median_run ~ m * t_ff + sig_s * n_sig + dwell_s * gap + hub_extra_s * n_hub

    t_ff: free-flow seconds along the route at the default class speeds, n_sig: signal-
    controlled locations passed, gap: stops served (A and intermediate stops), n_hub: of
    those, MRT/interchange stops.

    Uncertainty: bootstrap over bus services (clusters of overlapping sequences); every draw
    is kept so that sensitivity runs can use jointly consistent parameter sets. Skill: the
    model and a distance-only baseline (a + b * routed metres) are refitted with whole services
    held out (`folds`-fold) and scored on the held-out sequences."""
    s = seg[seg.used].reset_index(drop=True)
    X = np.c_[s.t_ff, s.n_sig, s.gap, s.n_hub]
    y = s["median"].to_numpy()
    n = s["count"].to_numpy()
    w = np.sqrt(n)
    x0, lb, ub = [1.3, 10.0, 30.0, 30.0], [0.3, 0.0, 0.0, 0.0], [5.0, 90.0, 150.0, 300.0]

    def solve(idx):
        return _wls(X[idx], y[idx], w[idx], x0, lb, ub)

    p = solve(np.arange(len(s)))
    rng = np.random.default_rng(seed)
    cl = s["cluster"].to_numpy()
    uc = np.unique(cl)
    members = {c: np.flatnonzero(cl == c) for c in uc}
    boots = np.array([solve(np.concatenate([members[c] for c in rng.choice(uc, len(uc))]))
                      for _ in range(n_boot)])
    lo, hi = np.percentile(boots, [2.5, 97.5], axis=0)
    pred = X @ p
    names = ["mult", "sig_s", "dwell_s", "hub_extra_s"]
    out = {k: float(v) for k, v in zip(names, p)}
    out.update({f"{k}_ci": [round(float(a), 3), round(float(b), 3)] for k, a, b in zip(names, lo, hi)})

    def score(pr, idx):
        e = pr - y[idx]
        return {"mae_s": float(np.average(np.abs(e), weights=n[idx])),
                "mape": float(np.average(np.abs(e) / y[idx], weights=n[idx])),
                "bias_s": float(np.average(e, weights=n[idx])),
                "r": float(np.corrcoef(pr, y[idx])[0, 1])}

    # held-out services: model vs distance-only baseline
    order = rng.permutation(uc)
    fold_of = {c: k % folds for k, c in enumerate(order)}
    f = np.array([fold_of[c] for c in cl])
    Xd = np.c_[np.ones(len(s)), s.net_m]
    pm, pd_ = np.empty(len(s)), np.empty(len(s))
    for k in range(folds):
        tr, te = np.flatnonzero(f != k), np.flatnonzero(f == k)
        pm[te] = X[te] @ solve(tr)
        pd_[te] = Xd[te] @ _wls(Xd[tr], y[tr], w[tr], [30.0, 0.1], [-600.0, 0.0], [600.0, 2.0])
    allidx = np.arange(len(s))
    out.update({"n_segments_used": int(len(s)), "n_segments_dropped": int((~seg.used).sum()),
                "n_obs_used": int(n.sum()), "n_services": int(len(uc)),
                "segment_mae_s": float(np.average(np.abs(pred - y), weights=n)),
                "segment_r": float(np.corrcoef(pred, y)[0, 1]),
                "mean_obs_s": float(np.average(y, weights=n)),
                "in_sample": score(pred, allidx),
                "holdout_services": {"folds": folds, "model": score(pm, allidx), "distance_only": score(pd_, allidx)},
                "boot": [[round(float(v), 4) for v in b] for b in boots],
                "boot_cols": names,
                # mean free-flow seconds and signal points per sequence, to rank draws by road time
                "road_ref": {"t_ff": float(np.average(s.t_ff, weights=n)), "n_sig": float(np.average(s.n_sig, weights=n))}})
    return out


def headway_kappa(paths: list, hours: tuple[int, int] = CALIBRATION_HOURS, monitored_only: bool = True) -> dict:
    """kappa = E[W] / E[H] for random rider arrivals, E[W] = E[H^2] / (2 E[H]), from the
    instantaneous headways between successive predicted arrivals (NextBus, NextBus2,
    NextBus3) of each service at each polled stop. With `monitored_only`, a headway is used only
    when both buses are GPS-monitored (their predictions follow real positions rather than
    the timetable). Returns the median over service-stops with >= 10 headways, its IQR and the
    pooled headway CV; also the value without the monitored filter, for comparison."""
    d = pd.concat([pd.read_csv(p, dtype={"stop": str, "service": str}) for p in paths], ignore_index=True)
    d = d[pd.to_datetime(d.poll_ts).dt.hour.between(*hours)]
    d["eta_t"] = pd.to_datetime(d.eta)
    w = d.pivot_table(index=["poll_ts", "stop", "service"], columns="k", values="eta_t", aggfunc="first")
    mon = d.pivot_table(index=["poll_ts", "stop", "service"], columns="k", values="monitored", aggfunc="first")

    def est(filter_mon: bool) -> dict:
        hs = []
        for a, b in ((1, 2), (2, 3)):
            if a in w and b in w:
                x = ((w[b] - w[a]).dt.total_seconds() / 60).rename("h")
                if filter_mon:
                    x = x[(mon[a] == 1) & (mon[b] == 1)]
                hs.append(x.reset_index())
        hw = pd.concat(hs, ignore_index=True).dropna()
        hw = hw[(hw.h > 0.5) & (hw.h < 60)]
        k = hw.groupby(["service", "stop"]).h.apply(
            lambda s: (s.pow(2).mean() / (2 * s.mean())) / s.mean() if len(s) >= 10 else np.nan).dropna()
        cv = hw.groupby("service").h.apply(lambda s: s.std() / s.mean())
        nn = hw.groupby("service").size()
        return {"kappa": float(k.median()), "kappa_iqr": [float(k.quantile(.25)), float(k.quantile(.75))],
                "kappa_n_service_stops": int(len(k)), "headway_cv_pooled": float(np.average(cv, weights=nn))}

    out = est(monitored_only)
    out["kappa_monitored_only"] = monitored_only
    out["kappa_all_predictions"] = est(False)["kappa"]
    return out


def _score_hours(obs_all, hours, res, R, stop_index, hubs) -> dict | None:
    """Score fitted parameters (no refit) on observations from other hours of the day."""
    o2 = obs_all[obs_all.hour.between(*hours)]
    if len(o2) < 2000:
        return None
    s2 = segment_table(o2, R, stop_index, hubs)
    s2 = s2[s2.used]
    pred = res["mult"] * s2.t_ff + res["sig_s"] * s2.n_sig + res["dwell_s"] * s2.gap + res["hub_extra_s"] * s2.n_hub
    y, n = s2["median"].to_numpy(), s2["count"].to_numpy()
    e = pred.to_numpy() - y
    return {"hours_sgt": list(range(hours[0], hours[1] + 1)), "n_obs": int(n.sum()), "n_segments": int(len(s2)),
            "mae_s": float(np.average(np.abs(e), weights=n)), "bias_s": float(np.average(e, weights=n)),
            "obs_over_pred": float(np.average(y / pred.to_numpy(), weights=n)),
            "r": float(np.corrcoef(pred, y)[0, 1])}


def run(paths: list, out_path=None, hours: tuple[int, int] = CALIBRATION_HOURS,
        check_hours: tuple[tuple[int, int], ...] = ((10, 12), (13, 14), (17, 19))) -> dict:
    """Fit on the given live BusArrival logs (observations whose first poll falls in `hours`,
    inclusive) and write data/processed/calibration.json. The fitted parameters are also
    scored, without refitting, on other hours present in the logs (`check_hours`)."""
    from .model import build_model
    from .paths import PROCESSED

    M = build_model(cal={"mult_arterial": 1.0, "mult_local": 1.0, "sig_s": 0.0})  # free-flow routing
    obs_all = pd.concat([segment_observations(p) for p in paths], ignore_index=True)
    obs = obs_all[obs_all.hour.between(*hours)]
    hubs = set(M.stops.index[M.stops.is_hub])
    seg = segment_table(obs, M.R, M.stop_index, hubs)
    res = fit(seg)
    res.update(headway_kappa(paths, hours))
    res["holdout_hours"] = {f"{a:02d}-{b:02d}": sc for a, b in check_hours if not (a <= hours[1] and b >= hours[0])
                            for sc in [_score_hours(obs_all, (a, b), res, M.R, M.stop_index, hubs)] if sc}
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
    import argparse
    import glob

    from .paths import PROCESSED
    from .paths import RAW as _RAW
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*")
    ap.add_argument("--hours", default=f"{CALIBRATION_HOURS[0]}-{CALIBRATION_HOURS[1]}",
                    help="SGT hours to fit on, inclusive, e.g. 10-12 (base) or 17-19 (evening peak)")
    ap.add_argument("--out", default=None, help="output file (default data/processed/calibration.json)")
    a = ap.parse_args()
    files = a.files or sorted(glob.glob(str(_RAW / "lta" / "live" / "bus_arrival_*.csv")))
    if not files:
        raise SystemExit("No live BusArrival logs found (run `make live`). The committed "
                         "data/processed/calibration.json is used as is.")
    h0, h1 = (int(x) for x in a.hours.split("-"))
    res = run(files, out_path=(PROCESSED / a.out) if a.out else None, hours=(h0, h1))
    print(json.dumps({k: v for k, v in res.items() if k != "boot"}, indent=2))
