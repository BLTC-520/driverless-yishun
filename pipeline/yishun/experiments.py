"""Experiment runner: fleet size x vehicle capacity x demand replicate, full weekday.

Outputs (data/processed/experiments/<name>/):
  hourly.parquet   one row per (run, service-day hour) with shuttle and bus metrics
  runs.parquet     one row per run with day totals
  config.json      the grid and simulator settings used

Service-day hours run 5..25 (rides tapped in at 00:xx and 01:xx belong to the end of the
previous service day and are shifted by +24 h).
"""
from __future__ import annotations

import json
import multiprocessing as mp
import sys
import time
from dataclasses import asdict, replace

import numpy as np
import pandas as pd

from .demand import sample_requests
from .model import Model, build_model
from .paths import PROCESSED
from .sim import SimConfig, Simulator

_M: Model | None = None
_REQ: dict = {}


def station_of(desc: str) -> str:
    d = desc.lower()
    if "khatib" in d:
        return "Khatib"
    if "springleaf" in d:
        return "Springleaf"
    return "Yishun"


def service_day_requests(M: Model, seed: int, scale: float = 1.0) -> pd.DataFrame:
    key = (seed, scale)
    if key in _REQ:
        return _REQ[key]
    req = sample_requests(M.od, list(range(24)), seed=seed, scale=scale)
    late = req.hour < 4
    req.loc[late, "t"] += 86400
    req.loc[late, "hour"] += 24
    req = req.sort_values("t", kind="stable").reset_index(drop=True)
    b = [M.baseline.expected(o, d, t / 60.0) for o, d, t in zip(req.o, req.d, req.t)]
    req["b_wait"] = [x["wait_s"] if x else np.nan for x in b]
    req["b_ivt"] = [x["ivt_s"] if x else np.nan for x in b]
    req["b_total"] = req.b_wait + req.b_ivt
    req["is_hub_trip"] = req.o.map(M.stops.is_hub) | req.d.map(M.stops.is_hub)
    _REQ[key] = req
    return req


def _occupancy(intervals: pd.DataFrame, start_col: str, end_col: str, groups: pd.Series,
               t0: float, t1: float, step: float = 60.0) -> pd.DataFrame:
    """Vehicles present per station group, sampled every `step` seconds."""
    grid = np.arange(t0, t1, step)
    out = {}
    for g in sorted(groups.unique()):
        sub = intervals[intervals.stop.map(groups) == g]
        if sub.empty:
            out[g] = np.zeros(len(grid))
            continue
        s = np.sort(sub[start_col].to_numpy())
        e = np.sort(sub[end_col].to_numpy())
        out[g] = np.searchsorted(s, grid, side="right") - np.searchsorted(e, grid, side="right")
    df = pd.DataFrame(out, index=grid)
    df.index.name = "t"
    return df


def _hourly(M: Model, res, req: pd.DataFrame, cfg: SimConfig) -> pd.DataFrame:
    r = res.requests.join(req[["b_wait", "b_ivt", "b_total", "is_hub_trip"]])
    served = r[~r.refused]
    g = served.groupby("hour")
    h = pd.DataFrame({
        "n": r.groupby("hour").size(),
        "refused_share": r.groupby("hour").refused.mean(),
        "wait_mean": g.wait.mean(), "wait_p90": g.wait.quantile(0.9),
        "ride_mean": g.ride.mean(), "total_mean": g.total.mean(), "total_p90": g.total.quantile(0.9),
        "bus_wait_mean": r.groupby("hour").b_wait.mean(), "bus_ivt_mean": r.groupby("hour").b_ivt.mean(),
        "bus_total_mean": r.groupby("hour").b_total.mean(),
        "share_faster": g.apply(lambda x: float((x.total < x.b_total).mean())),
    })
    h["veh_km"] = [res.veh_km_by_hour[int(x)] if int(x) < 26 else np.nan for x in h.index]
    groups = pd.Series({i: station_of(M.stops.Description.iloc[i]) for i in M.hub_idx})
    t0, t1 = 5 * 3600, 26 * 3600
    dw = _occupancy(res.hub_visits, "t_arrive", "t_depart", groups, t0, t1)
    st = _occupancy(res.hub_idle, "t_start", "t_end", groups, t0, t1)
    for name, df in (("kerb_dwell", dw), ("kerb_staging", st)):
        hr = (df.index // 3600).astype(int)
        for col in df.columns:
            agg = df[col].groupby(hr).agg(["max", lambda x: np.percentile(x, 95)])
            h[f"{name}_max_{col}"] = agg["max"].reindex(h.index)
            h[f"{name}_p95_{col}"] = agg.iloc[:, 1].reindex(h.index)
    h.index.name = "hour"
    return h.reset_index()


def run_one(job: dict) -> dict:
    global _M
    if _M is None:
        _M = build_model()
    M = _M
    cfg = SimConfig(**job["cfg"])
    req = service_day_requests(M, job["seed"], job.get("scale", 1.0))
    t = time.time()
    sim = Simulator(M.R, M.study_idx, M.origin_rates, M.hub_idx, cfg)
    res = sim.run(req[["t", "o", "d", "hour"]], M.stop_index)
    hourly = _hourly(M, res, req, cfg)
    r = res.requests
    summary = {
        "label": job["label"], "seed": job["seed"], "fleet": cfg.fleet, "capacity": cfg.capacity,
        "scale": job.get("scale", 1.0), "runtime_s": time.time() - t, "n": len(r),
        "refused_share": float(r.refused.mean()),
        "total_mean": float(r.loc[~r.refused, "total"].mean()),
        "bus_total_mean": float(req.b_total.mean()),
        "veh_km": res.veh_km_loaded + res.veh_km_empty, "empty_share": res.veh_km_empty / max(
            res.veh_km_loaded + res.veh_km_empty, 1e-9), "pax_km": res.pax_km,
        "occupancy": res.pax_km / max(res.veh_km_loaded + res.veh_km_empty, 1e-9),
    }
    for k, v in job.get("tags", {}).items():
        summary[k] = v
        hourly[k] = v
    for k in ("label", "seed", "fleet", "capacity", "scale"):
        hourly[k] = summary[k]
    return {"summary": summary, "hourly": hourly}


def run_grid(name: str, jobs: list[dict], workers: int = 4) -> tuple[pd.DataFrame, pd.DataFrame]:
    global _M
    _M = build_model()  # load before forking so workers share it copy-on-write
    out_dir = PROCESSED / "experiments" / name
    out_dir.mkdir(parents=True, exist_ok=True)
    t = time.time()
    ctx = mp.get_context("fork")
    results = []
    with ctx.Pool(workers) as pool:
        for k, r in enumerate(pool.imap_unordered(run_one, jobs)):
            results.append(r)
            s = r["summary"]
            print(f"[{k + 1}/{len(jobs)}] {s['label']} seed={s['seed']}: total {s['total_mean'] / 60:.2f} min "
                  f"(bus {s['bus_total_mean'] / 60:.2f}), refused {s['refused_share']:.1%}, "
                  f"{s['runtime_s']:.0f}s", flush=True)
    runs = pd.DataFrame([r["summary"] for r in results]).sort_values(["capacity", "fleet", "seed"])
    hourly = pd.concat([r["hourly"] for r in results], ignore_index=True)
    runs.to_parquet(out_dir / "runs.parquet")
    hourly.to_parquet(out_dir / "hourly.parquet")
    (out_dir / "config.json").write_text(json.dumps({"jobs": jobs, "elapsed_s": time.time() - t}, indent=1))
    return runs, hourly


def fleet_grid(name: str, grid: dict[int, list[int]], seeds: list[int], base: SimConfig | None = None,
               scale: float = 1.0, tags: dict | None = None) -> list[dict]:
    base = base or SimConfig()
    jobs = []
    for cap, fleets in grid.items():
        for n in fleets:
            for s in seeds:
                cfg = replace(base, fleet=n, capacity=cap, seed=s, start_s=4.75 * 3600)
                jobs.append({"label": f"{name}:C{cap}:N{n}", "seed": s, "scale": scale,
                             "cfg": asdict(cfg), "tags": tags or {}})
    return jobs


MAIN_GRID = {
    4: [400, 600, 800, 1000, 1300],
    10: [250, 300, 350, 400, 500, 650],
    20: [200, 250, 300, 350, 450, 600],
}

def keeps_up(r: pd.DataFrame, hour: int) -> tuple[bool, float, float, float]:
    """Parity rule for one hour: no refused riders, and mean stop-to-stop time (wait + ride)
    no worse than the bus model's expected time for the same rides."""
    sub = r[r.hour == hour]
    if sub.empty:
        return True, np.nan, np.nan, 0.0
    refused = float(sub.refused.mean())
    sh = float(sub.loc[~sub.refused, "total"].mean())
    bus = float(sub.b_total.mean())
    return (refused == 0.0 and sh <= bus), sh, bus, refused


def hour_window_job(job: dict) -> dict:
    """Smallest fleet that keeps up with one hour's demand in steady state.

    The hour is simulated with a 45-minute warm-up of real demand before it and 15 minutes
    after it, starting from a fleet spread over stops in proportion to that hour's demand.
    Bisection over FLEETS assumes service improves with fleet size (checked in the log)."""
    global _M
    if _M is None:
        _M = build_model()
    M = _M
    h, cap, seed = job["hour"], job["capacity"], job["seed"]
    req = service_day_requests(M, seed, job.get("scale", 1.0))
    win = req[(req.t >= h * 3600 - 2700) & (req.t < (h + 1) * 3600 + 900)]
    fleets = job["fleets"]
    cache = {}

    def run(n):
        if n not in cache:
            base = SimConfig(**job.get("cfg", {}))
            cfg = replace(base, fleet=n, capacity=cap, seed=seed, start_s=h * 3600 - 2700)
            res = Simulator(M.R, M.study_idx, M.origin_rates, M.hub_idx, cfg).run(
                win[["t", "o", "d", "hour"]].reset_index(drop=True), M.stop_index)
            r = res.requests.join(win[["b_total"]].reset_index(drop=True))
            cache[n] = keeps_up(r, h)
        return cache[n]

    lo, hi = 0, len(fleets) - 1
    if not run(fleets[hi])[0]:
        best = None
    elif run(fleets[lo])[0]:
        best = fleets[lo]
    else:
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if run(fleets[mid])[0]:
                hi = mid
            else:
                lo = mid
        best = fleets[hi]
    return {"hour": h, "capacity": cap, "seed": seed, "fleet_needed": best,
            "evaluated": {int(k): [bool(v[0]), v[1], v[2], v[3]] for k, v in cache.items()},
            "tags": job.get("tags", {})}


HOURLY_FLEETS = [25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300, 325, 350, 375, 400, 450, 500, 550,
                 600, 650, 700, 800, 900, 1000]


def run_hourly(name: str, capacities=(4, 10, 20), seeds=(1, 2), workers: int = 3, cfg: dict | None = None,
               scale: float = 1.0) -> pd.DataFrame:
    global _M
    _M = build_model()
    jobs = [{"hour": h, "capacity": c, "seed": s, "fleets": HOURLY_FLEETS, "scale": scale, "cfg": cfg or {}}
            for c in capacities for s in seeds for h in range(5, 26)]
    out_dir = PROCESSED / "experiments" / name
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    with mp.get_context("fork").Pool(workers) as pool:
        for k, r in enumerate(pool.imap_unordered(hour_window_job, jobs)):
            rows.append(r)
            print(f"[{k + 1}/{len(jobs)}] C{r['capacity']} h{r['hour']} s{r['seed']}: needs {r['fleet_needed']}",
                  flush=True)
    df = pd.DataFrame([{k: v for k, v in r.items() if k != "evaluated"} for r in rows])
    df.to_parquet(out_dir / "hourly_frontier.parquet")
    (out_dir / "evaluated.json").write_text(json.dumps(rows, indent=1, default=float))
    return df


STATIONS = ["Yishun", "Khatib", "Springleaf"]


def stop_groups(M: Model) -> np.ndarray:
    """Station group per network stop (index into STATIONS) for MRT/interchange stops, else -1."""
    g = np.full(len(M.R.codes), -1)
    for i in M.hub_idx:
        g[i] = STATIONS.index(station_of(M.stops.Description.iloc[i]))
    return g


def kerb_job(job: dict) -> dict:
    """One fixed-fleet day with a limit on shuttles boarding/alighting at once per station."""
    global _M
    if _M is None:
        _M = build_model()
    M = _M
    cfg = SimConfig(**job["cfg"])
    req = service_day_requests(M, job["seed"])
    res = Simulator(M.R, M.study_idx, M.origin_rates, M.hub_idx, cfg, stop_group=stop_groups(M)).run(
        req[["t", "o", "d", "hour"]], M.stop_index)
    r = res.requests.join(req[["b_total"]])
    q = res.hub_queue.assign(wait=lambda x: x.t_berth - x.t_arrive) if res.hub_queue is not None else None
    hv = res.hub_visits
    out = {"seed": job["seed"], "fleet": cfg.fleet, "capacity": cfg.capacity,
           "berths": cfg.berths if cfg.berths is not None else -1,
           "day_total_min": float(r.loc[~r.refused, "total"].mean() / 60), "refused": float(r.refused.mean()),
           "bus_day_min": float(r.b_total.mean() / 60)}
    for h in (7, 8, 18):
        ok, sh, bus, ref = keeps_up(r, h)
        out[f"h{h}_total_min"], out[f"h{h}_bus_min"], out[f"h{h}_ok"] = sh / 60, bus / 60, ok
    peak = (lambda df, col: df[(df[col] >= 7 * 3600) & (df[col] < 9 * 3600)])
    if q is not None and len(q):
        qp = peak(q, "t_arrive")
        out["peak_queued_share"] = float(len(qp) / max(len(peak(hv, "t_arrive")), 1))
        out["peak_queue_wait_mean_s"] = float(qp.wait.mean()) if len(qp) else 0.0
        out["peak_queue_wait_p95_s"] = float(qp.wait.quantile(0.95)) if len(qp) else 0.0
    else:
        out.update({"peak_queued_share": 0.0, "peak_queue_wait_mean_s": 0.0, "peak_queue_wait_p95_s": 0.0})
    return out


def run_kerb(name: str = "kerb", fleets=(400, 450), berths=(None, 30, 20, 14, 10, 7), seeds=(1, 2),
             workers: int = 3) -> pd.DataFrame:
    global _M
    _M = build_model()
    jobs = [{"seed": s, "cfg": asdict(SimConfig(fleet=n, capacity=10, seed=s, start_s=4.75 * 3600, berths=b))}
            for n in fleets for b in berths for s in seeds]
    out_dir = PROCESSED / "experiments" / name
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    with mp.get_context("fork").Pool(workers) as pool:
        for k, r in enumerate(pool.imap_unordered(kerb_job, jobs)):
            rows.append(r)
            print(f"[{k + 1}/{len(jobs)}] N{r['fleet']} berths={r['berths']} s{r['seed']}: day {r['day_total_min']:.2f} min, "
                  f"07h {r['h7_total_min']:.2f} vs bus {r['h7_bus_min']:.2f}, queued {r['peak_queued_share']:.0%}", flush=True)
    df = pd.DataFrame(rows).sort_values(["fleet", "berths", "seed"])
    df.to_parquet(out_dir / "kerb.parquet")
    return df


EXT_GRID = {4: [400, 1000], 10: [250, 600], 20: [200, 600]}

FRONTIER_GRID = {
    4: [450, 500, 550, 600, 650, 700, 800],
    10: [300, 325, 350, 375, 400, 450, 500],
    20: [250, 275, 300, 325, 350, 400, 450],
}

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "main"
    workers = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    if which == "main":
        run_grid("main", fleet_grid("main", MAIN_GRID, seeds=[1, 2]), workers)
    elif which == "frontier":
        run_grid("frontier", fleet_grid("frontier", FRONTIER_GRID, seeds=[1, 2, 3]), workers)
    elif which == "ext":
        run_grid("ext", fleet_grid("ext", EXT_GRID, seeds=[1, 2, 3]), workers)
    elif which == "hourly":
        run_hourly("hourly", workers=workers)
    elif which == "kerb":
        run_kerb("kerb", workers=workers)
