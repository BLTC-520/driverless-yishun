"""Sensitivity of the headline result (all-day parity fleet, 10-seat shuttles) to assumptions.

For each variant we rebuild what the variant changes (road network, bus model, demand or
simulator settings), then bisect over FLEETS for the smallest fixed fleet that keeps up with
the bus in every hour on both demand replicates. Output: data/processed/sensitivity.json.
"""
from __future__ import annotations

import json
import multiprocessing as mp
import time
from dataclasses import replace

import numpy as np
import pandas as pd

from .busnet import BaselineParams
from .calibrate import load as load_cal
from .demand import sample_requests
from .experiments import keeps_up
from .model import build_model, default_baseline_params
from .paths import PROCESSED
from .sim import SimConfig, Simulator

FLEETS = [300, 325, 350, 375, 400, 425, 450, 500, 550, 600, 700]
SEEDS = (1, 2)


def variants() -> list[dict]:
    c = load_cal()
    base_cal = {"mult_arterial": c["mult"], "mult_local": c["mult"], "sig_s": c["sig_s"]}
    bp = default_baseline_params()
    return [
        {"id": "base", "label": "Calibrated base case"},
        {"id": "speed_slow", "label": f"Road travel slower (cruise multiplier {c['mult_ci'][1]:.2f}, upper 95% CI)",
         "cal": {**base_cal, "mult_arterial": c["mult_ci"][1], "mult_local": c["mult_ci"][1]}},
        {"id": "speed_fast", "label": f"Road travel faster (cruise multiplier {c['mult_ci'][0]:.2f}, lower 95% CI)",
         "cal": {**base_cal, "mult_arterial": c["mult_ci"][0], "mult_local": c["mult_ci"][0]}},
        {"id": "signals_slow", "label": f"Signal delay {c['sig_s_ci'][1]:.1f} s (upper 95% CI)",
         "cal": {**base_cal, "sig_s": c["sig_s_ci"][1]}},
        {"id": "bus_dwell_low", "label": f"Bus dwell {c['dwell_s_ci'][0]:.0f} s (+{c['hub_extra_s_ci'][0]:.0f} s at stations), lower CI",
         "baseline": replace(bp, dwell_s=c["dwell_s_ci"][0], hub_extra_s=c["hub_extra_s_ci"][0])},
        {"id": "bus_regular", "label": f"Bus wait factor {c['kappa_iqr'][0]:.2f} (lower quartile of measured regularity)",
         "baseline": replace(bp, kappa=c["kappa_iqr"][0])},
        {"id": "bus_app_riders", "label": "Bus riders time their arrival with live-arrival apps (wait factor 0.35)",
         "baseline": replace(bp, kappa=0.35)},
        {"id": "stop_slow", "label": "Shuttle stop takes 40 s + 4 s per rider (base 25 s)", "sim": {"d0": 40.0}},
        {"id": "stop_fast", "label": "Shuttle stop takes 15 s + 4 s per rider", "sim": {"d0": 15.0}},
        {"id": "demand_up", "label": "Demand +20% (same pattern)", "scale": 1.2},
        {"id": "demand_down", "label": "Demand -20% (same pattern)", "scale": 0.8},
        {"id": "no_rebalance", "label": "Idle shuttles stay where they are (no repositioning)", "sim": {"rebalance": "none"}},
        {"id": "loose_pooling", "label": "Looser pooling: rides up to 2x direct + 10 min", "sim": {"alpha": 2.0, "beta": 600.0}},
    ]


def _requests(M, seed, scale):
    req = sample_requests(M.od, list(range(24)), seed=seed, scale=scale)
    late = req.hour < 4
    req.loc[late, "t"] += 86400
    req.loc[late, "hour"] += 24
    req = req.sort_values("t", kind="stable").reset_index(drop=True)
    b = [M.baseline.expected(o, d, t / 60.0) for o, d, t in zip(req.o, req.d, req.t)]
    req["b_total"] = [x["total_s"] if x else np.nan for x in b]
    return req


def run_variant(v: dict) -> dict:
    t0 = time.time()
    M = build_model(cal=v.get("cal"), baseline_params=v.get("baseline"))
    scale = v.get("scale", 1.0)
    reqs = {s: _requests(M, s, scale) for s in SEEDS}
    cache = {}

    def ok(n):
        if n in cache:
            return cache[n]["ok"]
        res_all, good = [], True
        for s in SEEDS:
            cfg = replace(SimConfig(**v.get("sim", {})), fleet=n, capacity=10, seed=s, start_s=4.75 * 3600)
            req = reqs[s]
            res = Simulator(M.R, M.study_idx, M.origin_rates, M.hub_idx, cfg).run(req[["t", "o", "d", "hour"]],
                                                                                  M.stop_index)
            r = res.requests.join(req[["b_total"]])
            good &= all(keeps_up(r, h)[0] for h in sorted(r.hour.unique()))
            res_all.append(r)
        r = pd.concat(res_all)
        cache[n] = {"ok": good, "shuttle_min": float(r.loc[~r.refused, "total"].mean() / 60),
                    "bus_min": float(r.b_total.mean() / 60), "refused": float(r.refused.mean())}
        return good

    lo, hi = 0, len(FLEETS) - 1
    if not ok(FLEETS[hi]):
        need = None
    elif ok(FLEETS[lo]):
        need = FLEETS[lo]
    else:
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if ok(FLEETS[mid]):
                hi = mid
            else:
                lo = mid
        need = FLEETS[hi]
    at = cache.get(need) if need else None
    return {"id": v["id"], "label": v["label"], "parity_fleet": need,
            "bus_day_min": at["bus_min"] if at else float(np.nanmean([c["bus_min"] for c in cache.values()])),
            "shuttle_day_min_at_parity": at["shuttle_min"] if at else None,
            "evaluated": {int(k): c for k, c in cache.items()}, "runtime_s": time.time() - t0}


def main(workers: int = 3) -> None:
    vs = variants()
    out = []
    with mp.get_context("fork").Pool(workers) as pool:
        for r in pool.imap_unordered(run_variant, vs):
            out.append(r)
            print(f"{r['id']}: parity fleet {r['parity_fleet']} (bus {r['bus_day_min']:.2f} min) "
                  f"[{r['runtime_s']:.0f}s]", flush=True)
    order = [v["id"] for v in vs]
    out.sort(key=lambda r: order.index(r["id"]))
    (PROCESSED / "sensitivity.json").write_text(json.dumps(out, indent=1, default=float))


if __name__ == "__main__":
    main()
