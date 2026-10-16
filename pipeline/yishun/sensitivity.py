"""Sensitivity of the headline result (all-day parity fleet, 10-seat shuttles) to assumptions.

For each variant we rebuild what the variant changes (road network, bus model, demand or
simulator settings), then bisect over FLEETS for the smallest fixed fleet that keeps up with
the bus in every hour on every demand replicate (the same rule and replicates as the main
experiment). Variants push in both directions: some make the bus better (raising the fleet
needed), some make it worse. Output: data/processed/sensitivity.json.
"""
from __future__ import annotations

import json
import multiprocessing as mp
import sys
import time
from dataclasses import replace

import numpy as np
import pandas as pd

from .calibrate import load as load_cal
from .experiments import keeps_up, provenance, service_day_requests
from .model import build_model, default_baseline_params
from .paths import PROCESSED
from .sim import SimConfig, Simulator

FLEETS = [300, 325, 350, 375, 400, 425, 450, 475, 500, 550, 600, 700, 800]
SEEDS = (1, 2, 3)
BASE_D0 = SimConfig().d0


def joint_draws(c: dict) -> tuple[dict, dict, str]:
    """Bootstrap draws (jointly fitted cruise multiplier, signal delay, bus dwell, hub dwell) at the
    2.5th and 97.5th percentile of road travel time for a typical calibration sequence. Varying
    one parameter at its marginal interval would ignore that the data pin down their sum. The
    LTA-estimate data separate cruise from dwell poorly, so when the GPS check has measured the
    bus dwell, only draws whose dwell lies in its 95% interval are used."""
    B = np.array(c["boot"])
    ref = c["road_ref"]
    note = "all bootstrap draws"
    gps = PROCESSED / "gps_check.json"
    if gps.exists():
        fit = json.loads(gps.read_text()).get("fit", {}).get("10-14")
        if fit:
            lo, hi = fit["dwell_s_ci"]
            keep = (B[:, 2] >= lo) & (B[:, 2] <= hi)
            if keep.sum() >= 40:
                B = B[keep]
                note = f"draws with bus dwell {lo:.0f}-{hi:.0f} s, as measured from bus GPS"
    road = B[:, 0] * ref["t_ff"] + B[:, 1] * ref["n_sig"]
    order = np.argsort(road)
    pick = lambda q: dict(zip(c["boot_cols"], B[order[int(round(q * (len(B) - 1)))]]))
    return pick(0.025), pick(0.975), note


def variants() -> list[dict]:
    c = load_cal()
    base_cal = {"mult_arterial": c["mult"], "mult_local": c["mult"], "sig_s": c["sig_s"]}
    bp = default_baseline_params()
    fast, slow, note = joint_draws(c)

    def draw(d):
        return ({"mult_arterial": d["mult"], "mult_local": d["mult"], "sig_s": d["sig_s"]},
                replace(bp, dwell_s=d["dwell_s"], hub_extra_s=d["hub_extra_s"]))

    (cs, bs), (cf, bf) = draw(slow), draw(fast)
    out = [
        {"id": "base", "label": "Calibrated base case", "dir": 0},
        {"id": "speed_slow", "label": f"Slower roads: calibration draw at the 97.5th percentile of road time (cruise x{slow['mult']:.2f}, "
                                      f"{slow['sig_s']:.0f} s per signal, bus dwell {slow['dwell_s']:.0f} s; {note})",
         "cal": cs, "baseline": bs, "dir": 0},
        {"id": "speed_fast", "label": f"Faster roads: draw at the 2.5th percentile (cruise x{fast['mult']:.2f}, "
                                      f"{fast['sig_s']:.0f} s per signal, bus dwell {fast['dwell_s']:.0f} s)",
         "cal": cf, "baseline": bf, "dir": 0},
        {"id": "bus_dwell_low", "label": f"Bus dwell {c['dwell_s_ci'][0]:.0f} s (+{c['hub_extra_s_ci'][0]:.0f} s at stations), lower 95% CI",
         "baseline": replace(bp, dwell_s=c["dwell_s_ci"][0], hub_extra_s=c["hub_extra_s_ci"][0]), "dir": 1},
        {"id": "bus_dwell_high", "label": f"Bus dwell {c['dwell_s_ci'][1]:.0f} s (+{c['hub_extra_s_ci'][1]:.0f} s at stations), upper 95% CI",
         "baseline": replace(bp, dwell_s=c["dwell_s_ci"][1], hub_extra_s=c["hub_extra_s_ci"][1]), "dir": -1},
        {"id": "bus_regular", "label": f"More regular buses: wait factor {c['kappa_iqr'][0]:.2f} (lower quartile across services and stops)",
         "baseline": replace(bp, kappa=c["kappa_iqr"][0]), "dir": 1},
        {"id": "bus_irregular", "label": f"Less regular buses: wait factor {c['kappa_iqr'][1]:.2f} (upper quartile)",
         "baseline": replace(bp, kappa=c["kappa_iqr"][1]), "dir": -1},
        {"id": "bus_bunched", "label": "Bunched buses: wait factor 0.75 (headway CV 0.7, typical of congested peaks)",
         "baseline": replace(bp, kappa=0.75), "dir": -1},
        {"id": "bus_app_riders", "label": "Bus riders time their arrival with live-arrival apps (wait factor 0.35)",
         "baseline": replace(bp, kappa=0.35), "dir": 1},
        {"id": "stop_slow", "label": f"Shuttle stop takes 40 s + 4 s per rider (base {BASE_D0:.0f} s)", "sim": {"d0": 40.0}, "dir": 1},
        {"id": "stop_fast", "label": "Shuttle stop takes 15 s + 4 s per rider", "sim": {"d0": 15.0}, "dir": -1},
        {"id": "demand_sep", "label": "September 2026 demand (includes the one-week school holiday)", "months": ("202609",), "dir": -1},
        {"id": "demand_up", "label": "Demand +20% (same pattern)", "scale": 1.2, "dir": 1},
        {"id": "demand_down", "label": "Demand -20% (same pattern)", "scale": 0.8, "dir": -1},
        {"id": "no_rebalance", "label": "Idle shuttles stay where they are (no repositioning)", "sim": {"rebalance": "none"}, "dir": 1},
        {"id": "loose_pooling", "label": "Looser pooling: rides up to 2x direct + 10 min", "sim": {"alpha": 2.0, "beta": 600.0}, "dir": 0},
        {"id": "wider_search", "label": "Dispatcher searches twice as many vehicles per request (48 nearest + 16 soonest free)",
         "sim": {"k_eta": 48, "k_end": 16}, "dir": -1},
        {"id": "widest_search", "label": "Dispatcher searches four times as many vehicles per request (96 nearest + 32 soonest free)",
         "sim": {"k_eta": 96, "k_end": 32}, "dir": -1},
    ]
    gps = PROCESSED / "gps_check.json"
    if gps.exists():
        g = json.loads(gps.read_text()).get("fit", {}).get("10-14")
        if g:
            out.append({"id": "gps_calibration", "label": f"Robust fit to bus GPS movement (cruise x{g['mult']:.2f}, "
                                                          f"{g['sig_s']:.0f} s per signal, bus dwell {g['dwell_s']:.0f} s); "
                                                          f"tracks typical rather than average speeds",
                        "cal": {"mult_arterial": g["mult"], "mult_local": g["mult"], "sig_s": g["sig_s"]},
                        "baseline": replace(bp, dwell_s=g["dwell_s"], hub_extra_s=g["hub_extra_s"]), "dir": 0})
    peak = PROCESSED / "calibration_pm_peak.json"
    if peak.exists():
        p = json.loads(peak.read_text())
        out.append({"id": "pm_peak_roads", "label": f"Evening-peak calibration all day (cruise x{p['mult']:.2f}, {p['sig_s']:.0f} s per signal, "
                                                    f"bus dwell {p['dwell_s']:.0f} s, wait factor {p['kappa']:.2f})",
                    "cal": {"mult_arterial": p["mult"], "mult_local": p["mult"], "sig_s": p["sig_s"]},
                    "baseline": replace(bp, dwell_s=p["dwell_s"], hub_extra_s=p["hub_extra_s"], kappa=p["kappa"]),
                    "dir": 1})
    return out


def bracket_search(fleets: list[int], ok, start: tuple[int, int] = (375, 550)) -> int | None:
    """Smallest fleet in `fleets` for which ok() holds, assuming ok is monotone in the fleet.
    Starts from a bracket around the expected answer and widens it only when needed, so most
    cases need about five simulated fleets instead of six or seven."""
    lo, hi = fleets.index(start[0]), fleets.index(start[1])
    while not ok(fleets[hi]):            # widen upwards until a fleet keeps up
        if hi == len(fleets) - 1:
            return None
        lo, hi = hi, min(len(fleets) - 1, hi + 2)
    while ok(fleets[lo]):                # widen downwards until a fleet fails
        if lo == 0:
            return fleets[0]
        hi, lo = lo, max(0, lo - 2)
    while hi - lo > 1:                   # fleets[lo] fails, fleets[hi] keeps up
        mid = (lo + hi) // 2
        if ok(fleets[mid]):
            hi = mid
        else:
            lo = mid
    return fleets[hi]


def run_variant(v: dict) -> dict:
    t0 = time.time()
    M = build_model(cal=v.get("cal"), baseline_params=v.get("baseline"), months=v.get("months"))
    scale = v.get("scale", 1.0)
    reqs = {s: service_day_requests(M, s, scale) for s in SEEDS}
    cache = {}

    def ok(n):
        if n in cache:
            return cache[n]["ok"]
        res_all, good, worst = [], True, None
        for s in SEEDS:
            cfg = replace(SimConfig(**v.get("sim", {})), fleet=n, capacity=10, seed=s, start_s=4.75 * 3600)
            req = reqs[s]
            res = Simulator(M.R, M.study_idx, M.origin_rates, M.hub_idx, cfg).run(req[["t", "o", "d", "hour"]],
                                                                                  M.stop_index)
            r = res.requests.join(req[["b_total"]])
            for h in sorted(r.hour.unique()):
                k = keeps_up(r, h)
                if not k[0]:
                    good = False
                    worst = worst or int(h)
            res_all.append(r)
        r = pd.concat(res_all)
        c = r[r.b_total.notna()]
        cache[n] = {"ok": good, "first_failing_hour": worst,
                    "shuttle_min": float(c.loc[~c.refused, "total"].mean() / 60),
                    "bus_min": float(c.b_total.mean() / 60), "refused": float(r.refused.mean())}
        return good

    need = bracket_search(FLEETS, ok)
    at = cache.get(need) if need else None
    return {"id": v["id"], "label": v["label"], "direction": v.get("dir", 0), "parity_fleet": need,
            "parity_below": max([f for f, c in cache.items() if not c["ok"] and (need is None or f < need)], default=None),
            "bus_day_min": at["bus_min"] if at else float(np.nanmean([c["bus_min"] for c in cache.values()])),
            "shuttle_day_min_at_parity": at["shuttle_min"] if at else None,
            "evaluated": {int(k): c for k, c in cache.items()}, "runtime_s": time.time() - t0,
            "model_key": M.key}


def main(workers: int = 3, only: list[str] | None = None) -> None:
    vs = [v for v in variants() if not only or v["id"] in only]
    out = []
    with mp.get_context("fork").Pool(workers) as pool:
        for r in pool.imap_unordered(run_variant, vs):
            out.append(r)
            print(f"{r['id']}: parity fleet {r['parity_fleet']} (bus {r['bus_day_min']:.2f} min) "
                  f"[{r['runtime_s']:.0f}s]", flush=True)
    path = PROCESSED / "sensitivity.json"
    if only and path.exists():  # merge into an existing run
        keep = [r for r in json.loads(path.read_text())["variants"] if r["id"] not in only]
        out = keep + out
    order = [v["id"] for v in variants()]
    out.sort(key=lambda r: order.index(r["id"]) if r["id"] in order else 99)
    M = build_model()
    path.write_text(json.dumps({"provenance": provenance(M), "fleets": FLEETS, "seeds": list(SEEDS),
                                "variants": out}, indent=1, default=float))


if __name__ == "__main__":
    args = sys.argv[1:]
    w = int(args[0]) if args and args[0].isdigit() else 3
    main(w, [a for a in args if not a.isdigit()] or None)
