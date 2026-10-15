"""Test the calibrated road model against bus GPS movement (observed positions).

The calibration (calibrate.py) fits LTA's *estimated* arrival times. This check uses what
BusArrival reports as observation instead: the current GPS position of every monitored
bus approaching a polled stop.

1. Each distinct reported position of a bus on a route pattern (service, trip origin, trip
   destination) is one fix, timed at the first poll that reports it.
2. The fix is placed on the route: the routed network path through LTA's stop sequence,
   searched only in the 2.5 km before the nearest stop the bus is reported heading to, and
   rejected if more than 40 m off the path.
3. Fixes of the same bus are chained across polling cycles: the nearest fix behind it on the
   same route within 4 minutes, at a plausible speed.
4. For pairs of fixes of one bus 5 to 20 minutes apart (more than 400 m, away from terminals),
   the observed elapsed time is compared with the model's running time between the two
   positions: calibrated road times plus bus dwell at the stops in between, as in busnet.py.

Fix times carry tens of seconds of noise (positions update between polls, and a stop is
polled every 90 s), so single pairs are noisy; the summaries pool hundreds of pairs.
Output: data/processed/gps_check.json, with results by hour of day (SGT).
Usage: python -m yishun.gps_check [bus_arrival_*.csv ...]
"""
from __future__ import annotations

import glob
import json

import numpy as np
import pandas as pd
from shapely.geometry import LineString, Point
from shapely.ops import substring

from .paths import PROCESSED, RAW
from .routing import node_path_to_stop


def leg_line(R, a: int, b: int) -> LineString | None:
    """Network path geometry from stop a to stop b (SVY21), as the simulator drives it."""
    ga = R.edge_geom.get((int(R.stop_u[a]), int(R.stop_v[a])))
    gb = R.edge_geom.get((int(R.stop_u[b]), int(R.stop_v[b])))
    if ga is None or gb is None:
        return None
    same = (R.stop_u[a] == R.stop_u[b] and R.stop_v[a] == R.stop_v[b] and R.stop_frac[b] >= R.stop_frac[a])
    if same:
        part = substring(ga, R.stop_frac[a], R.stop_frac[b], normalized=True)
        return part if part.geom_type == "LineString" and part.length > 0 else None
    pts = list(substring(ga, R.stop_frac[a], 1.0, normalized=True).coords)
    path = node_path_to_stop(R, int(R.stop_v[a]), b)
    for x, y in zip(path[:-1], path[1:]):
        g = R.edge_geom.get((x, y))
        pts += list(g.coords) if g is not None else [tuple(R.node_xy[x]), tuple(R.node_xy[y])]
    pts += list(substring(gb, 0.0, R.stop_frac[b], normalized=True).coords)
    clean = [pts[0]] + [p for q, p in zip(pts[:-1], pts[1:]) if p != q]
    return LineString(clean) if len(clean) > 1 else None


class Route:
    """One service direction: polyline, stop positions along it, the bus model's clock and the
    calibration features (free-flow seconds, signal points) accumulated along it."""

    def __init__(self, M, ln, cum, hubs: set):
        from .calibrate import leg_features
        R, idx = M.R, M.stop_index
        self.ok = True
        coords, S, A, run, FF, SG = [], [0.0], [float(cum[0])], [], [0.0], [0.0]
        for k in range(1, len(ln.stops)):
            a, b = ln.stops[k - 1], ln.stops[k]
            if a not in idx or b not in idx:
                self.ok = False
                return
            g = leg_line(R, idx[a], idx[b])
            if g is None or not np.isfinite(cum[k]):
                self.ok = False
                return
            c = list(g.coords)
            coords += c if not coords else c[1:]
            S.append(S[-1] + g.length)
            A.append(float(cum[k]))
            run.append(float(R.T[idx[a], idx[b]]))
            f = leg_features(R, idx[a], idx[b])
            FF.append(FF[-1] + f[0] + f[1])
            SG.append(SG[-1] + f[2])
        self.line = LineString(coords)
        self.S, self.A, self.run = np.array(S), np.array(A), np.array(run)
        self.FF, self.SG = np.array(FF), np.array(SG)
        self.stops = ln.stops
        self.hub = np.array([c in hubs for c in ln.stops])

    def features(self, s: float) -> tuple[float, float]:
        """Free-flow seconds and signal points from the first stop to position s."""
        return float(np.interp(s, self.S, self.FF)), float(np.interp(s, self.S, self.SG))

    def near_stop(self, s: float, tol: float = 25.0) -> bool:
        return bool(np.min(np.abs(self.S - s)) < tol)

    def stops_between(self, s0: float, s1: float) -> tuple[int, int]:
        """Stops served strictly between two positions, and how many of them are hubs."""
        m = (self.S > s0) & (self.S < s1)
        return int(m.sum()), int((m & self.hub).sum())

    def clock(self, s: float) -> float:
        """Modelled seconds since leaving the first stop when the bus is at position s."""
        k = int(np.clip(np.searchsorted(self.S, s, side="right"), 1, len(self.S) - 1))
        L = self.S[k] - self.S[k - 1]
        frac = 0.0 if L <= 0 else float(np.clip((s - self.S[k - 1]) / L, 0, 1))
        return self.A[k] - self.run[k - 1] * (1 - frac)

    def locate(self, xy, k_next: int, window: float = 2500.0, max_off: float = 40.0) -> float | None:
        hi = self.S[k_next] + 30.0
        lo = max(0.0, hi - window)
        part = substring(self.line, lo, hi)
        if part.length <= 0:
            return None
        p = Point(xy)
        if part.distance(p) > max_off:
            return None
        return lo + part.project(p)


def _fixes(d: pd.DataFrame) -> pd.DataFrame:
    """One row per (route pattern, reported position, run of consecutive sightings)."""
    d = d.sort_values("poll_t")
    key = ["service", "origin", "destination", "lat", "lon"]
    d["gap"] = d.groupby(key).poll_t.diff().dt.total_seconds()
    d["run"] = (d.gap.isna() | (d.gap > 300)).astype(int).groupby([d[c] for c in key]).cumsum()
    d["lead"] = (d.eta_t - d.poll_t).dt.total_seconds()
    first = d.groupby(key + ["run"]).poll_t.min().rename("t_fix")
    ahead = d[d.lead > -30].sort_values("lead").groupby(key + ["run"]).first()[["stop", "visit", "lead"]]
    return first.to_frame().join(ahead, how="inner").reset_index()


def collect(M, paths: list[str]) -> pd.DataFrame:
    from pyproj import Transformer
    tr = Transformer.from_crs(4326, 3414, always_xy=True)
    d = pd.concat([pd.read_csv(p, dtype={"stop": str, "service": str, "origin": str, "destination": str},
                               on_bad_lines="skip") for p in paths], ignore_index=True)
    d = d[(d.monitored == 1) & (d.lat > 1.0) & d.eta.notna()].copy()
    d["poll_t"] = pd.to_datetime(d.poll_ts)
    d["eta_t"] = pd.to_datetime(d.eta)
    d["visit"] = pd.to_numeric(d.visit, errors="coerce").fillna(1).astype(int)
    fx = _fixes(d)
    x, y = tr.transform(fx.lon.to_numpy(), fx.lat.to_numpy())
    fx["x"], fx["y"] = x, y
    routes = {}
    for ln, pos, cum in M.baseline.segments:
        routes[(ln.service, ln.stops[0], ln.stops[-1])] = (ln, cum)
    hubs = set(M.stops.index[M.stops.is_hub])
    out, objs = [], {}
    for (svc, o, dst), g in fx.groupby(["service", "origin", "destination"]):
        if (svc, o, dst) not in routes:
            continue
        rt = Route(M, *routes[(svc, o, dst)], hubs)
        if not rt.ok:
            continue
        objs[f"{svc}:{o}-{dst}"] = rt
        occ = {}
        for k, c in enumerate(rt.stops):
            occ.setdefault(c, []).append(k)
        rows = []
        for r in g.itertuples(index=False):
            ks = occ.get(r.stop, [])
            if not ks:
                continue
            k = ks[min(int(r.visit), len(ks)) - 1]
            if k == 0:
                continue
            s = rt.locate((r.x, r.y), k)
            if s is not None:
                rows.append((r.t_fix, s, k))
        if not rows:
            continue
        f = pd.DataFrame(rows, columns=["t", "s", "k"]).sort_values("t").reset_index(drop=True)
        f["track"] = _track(f)
        f["service"], f["route"] = svc, f"{svc}:{o}-{dst}"
        f["clock"] = [rt.clock(s) for s in f.s]
        ft = [rt.features(s) for s in f.s]
        f["ff"], f["sig"] = [a for a, _ in ft], [b for _, b in ft]
        f["at_stop"] = [rt.near_stop(s) for s in f.s]
        f["s_end"] = rt.S[-1]
        out.append(f)
    fx = pd.concat(out, ignore_index=True) if out else pd.DataFrame()
    fx.attrs["routes"] = objs
    return fx


def _track(f: pd.DataFrame, max_dt: float = 240.0, vmax: float = 22.0) -> np.ndarray:
    """Chain fixes of one route into buses: each fix joins the open track whose last fix is
    nearest behind it (or at most 30 m ahead) and reachable at <= vmax m/s."""
    tracks: list[list[float]] = []   # [last_t, last_s, id]
    ids = np.zeros(len(f), int)
    nxt = 0
    t = (f.t - f.t.min()).dt.total_seconds().to_numpy()
    for i, (ti, si) in enumerate(zip(t, f.s.to_numpy())):
        best, gapbest = None, np.inf
        for tr_ in tracks:
            dt = ti - tr_[0]
            ds = si - tr_[1]
            if 0 < dt <= max_dt and -30.0 <= ds <= vmax * dt + 50.0 and ds < gapbest:
                best, gapbest = tr_, ds
        if best is None:
            best = [ti, si, nxt]
            tracks.append(best)
            nxt += 1
        best[0], best[1] = ti, si
        ids[i] = best[2]
        tracks = [x for x in tracks if ti - x[0] <= max_dt]
    return ids


def pairs(fx: pd.DataFrame, min_dt: float = 300.0, max_dt: float = 1200.0, min_ds: float = 400.0,
          end_margin: float = 150.0, moving_only: bool = False) -> pd.DataFrame:
    """Non-overlapping pairs of fixes of one bus, away from both terminals. With moving_only,
    fixes within 25 m of a stop are dropped (the bus may be dwelling there), so that the stops
    a pair spans are passed in full."""
    out = []
    routes = fx.attrs.get("routes", {})
    for (route, tr_), g in fx.groupby(["route", "track"]):
        g = g[(g.s > end_margin) & (g.s < g.s_end - end_margin)].sort_values("t")
        if moving_only:
            g = g[~g.at_stop]
        if len(g) < 2:
            continue
        t = np.array([x.timestamp() for x in g.t])
        i = 0
        while i < len(g) - 1:
            dt = t[i + 1:] - t[i]
            js = np.flatnonzero(dt >= min_dt)
            if not len(js):
                break
            j = i + 1 + js[0]
            a, b = g.iloc[i], g.iloc[j]
            if dt[js[0]] <= max_dt and b.s - a.s >= min_ds:
                ns, nh = routes[route].stops_between(a.s, b.s) if route in routes else (np.nan, np.nan)
                out.append({"route": route, "service": a.service, "t0": a.t, "obs_s": float(dt[js[0]]),
                            "model_s": float(b.clock - a.clock), "dist_m": float(b.s - a.s),
                            "t_ff": float(b.ff - a.ff), "n_sig": float(b.sig - a.sig), "gap": ns, "n_hub": nh})
            i = j
    return pd.DataFrame(out)


def summarise(p: pd.DataFrame) -> dict:
    p = p[(p.model_s > 0)].copy()
    p["hour"] = p.t0.dt.hour
    p["ratio"] = p.obs_s / p.model_s
    # drop gross outliers (a bus held at a terminal or a broken chain), symmetric in log ratio
    p = p[np.abs(np.log(p.ratio)) < np.log(3)]

    def block(x):
        if len(x) < 20:
            return None
        bs = np.random.default_rng(0)
        # bootstrap over routes for the pooled ratio (pairs of one route are correlated)
        routes = x.route.unique()
        grp = {r: x[x.route == r] for r in routes}
        boots = []
        for _ in range(300):
            pick = pd.concat([grp[r] for r in bs.choice(routes, len(routes))])
            boots.append(pick.obs_s.sum() / pick.model_s.sum())
        return {"n_pairs": int(len(x)), "n_routes": int(len(routes)),
                "pooled_ratio": float(x.obs_s.sum() / x.model_s.sum()),
                "pooled_ratio_ci": [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))],
                "median_ratio": float(x.ratio.median()), "iqr_ratio": [float(x.ratio.quantile(.25)), float(x.ratio.quantile(.75))],
                "km_per_h_obs": float(x.dist_m.sum() / x.obs_s.sum() * 3.6),
                "km_per_h_model": float(x.dist_m.sum() / x.model_s.sum() * 3.6)}

    windows = {"10-12": (10, 12), "13-14": (13, 14), "15-16": (15, 16), "17-19": (17, 19)}
    return {"by_hour": {int(h): block(g) for h, g in p.groupby("hour") if block(g)},
            "by_window": {k: block(p[p.hour.between(a, b)]) for k, (a, b) in windows.items()
                          if block(p[p.hour.between(a, b)])},
            "all": block(p)}


def fit_gps(p: pd.DataFrame, n_boot: int = 300, seed: int = 0) -> dict | None:
    """The calibration model fitted to observed GPS movement instead of LTA estimates:

        elapsed ~ m * t_ff + sig_s * n_sig + dwell_s * stops passed + hub_extra_s * hubs passed

    Short pairs that pass no stop pin down road speed; the number of stops passed varies
    independently of distance, which separates dwell from cruise. Robust (soft-L1) loss,
    since fix times are noisy; uncertainty by bootstrap over routes."""
    from scipy.optimize import least_squares
    p = p.dropna(subset=["gap"])
    p = p[(p.obs_s > 0) & (p.t_ff > 0)]
    if len(p) < 200:
        return None
    X = np.c_[p.t_ff, p.n_sig, p.gap, p.n_hub]
    y = p.obs_s.to_numpy()

    def solve(idx):
        return least_squares(lambda q: (X[idx] @ q - y[idx]) / 60.0, x0=[1.0, 15.0, 30.0, 20.0], loss="soft_l1",
                             f_scale=0.5, bounds=([0.3, 0.0, 0.0, 0.0], [5.0, 90.0, 150.0, 300.0])).x

    q = solve(np.arange(len(p)))
    rng = np.random.default_rng(seed)
    routes = p.route.to_numpy()
    ur = np.unique(routes)
    members = {r: np.flatnonzero(routes == r) for r in ur}
    boots = np.array([solve(np.concatenate([members[r] for r in rng.choice(ur, len(ur))])) for _ in range(n_boot)])
    lo, hi = np.percentile(boots, [2.5, 97.5], axis=0)
    names = ["mult", "sig_s", "dwell_s", "hub_extra_s"]
    out = {k: float(v) for k, v in zip(names, q)}
    out.update({f"{k}_ci": [round(float(a), 3), round(float(b), 3)] for k, a, b in zip(names, lo, hi)})
    out.update({"n_pairs": int(len(p)), "n_routes": int(len(ur)),
                "corr_mult_dwell": float(np.corrcoef(boots[:, 0], boots[:, 2])[0, 1]),
                "share_pairs_no_stop": float((p.gap == 0).mean())})
    return out


def run(paths: list[str] | None = None) -> dict:
    from .model import build_model
    paths = paths or sorted(glob.glob(str(RAW / "lta" / "live" / "bus_arrival_*.csv")))
    if not paths:
        raise SystemExit("No live BusArrival logs found (run `make live`).")
    M = build_model()
    fx = collect(M, paths)
    pr = pairs(fx)
    res = summarise(pr)
    short = pairs(fx, min_dt=45.0, max_dt=600.0, min_ds=100.0, moving_only=True)
    short["hour"] = short.t0.dt.hour
    res["fit"] = {}
    for name, (a, b) in {"10-14": (10, 14), "10-12": (10, 12), "17-19": (17, 19)}.items():
        fit = fit_gps(short[short.hour.between(a, b)])
        if fit:
            res["fit"][name] = fit
    res.update({"n_fixes_on_route": int(len(fx)), "n_tracks": int(fx.groupby(["route", "track"]).ngroups),
                "source_files": [str(p).split("data/")[-1] for p in paths],
                "note": "Observed: elapsed time between two GPS positions of the same bus. Modelled: calibrated "
                        "road time plus bus dwell between those positions. Ratio > 1: buses slower than the model."})
    (PROCESSED / "gps_check.json").write_text(json.dumps(res, indent=1, default=str))
    sample = pr.sample(min(len(pr), 1500), random_state=0) if len(pr) else pr
    (PROCESSED / "gps_pairs_sample.csv").write_text(sample.to_csv(index=False))
    return res


if __name__ == "__main__":
    import sys
    r = run(sys.argv[1:] or None)
    print(json.dumps({k: v for k, v in r.items() if k != "by_hour"}, indent=1, default=str))
    for h, b in sorted(r["by_hour"].items()):
        print(h, b["n_pairs"], round(b["pooled_ratio"], 3), [round(x, 3) for x in b["pooled_ratio_ci"]])
