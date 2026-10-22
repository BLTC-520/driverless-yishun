"""Phase 2 experiments: options A, B and C on the same simulated weekdays.

Every job simulates one option on one demand replicate (seed) under one scenario. The same
seeds give the same requests for every option, so options are compared ride by ride.
Scenarios stress the roads and the bus (calibration variants), the fleet (availability) and the
kerb (berths). In a stress scenario, rule C-theta keeps the eligibility table planned on the
base case.

Usage (from pipeline/):
    python -m yishun.phase2.experiments <grid> [workers]
grids: coarse, refine, capacity, stress, replicates, wmax (see GRIDS below)

Outputs (data/processed/phase2/<grid>/):
    runs.parquet    one row per run: option, settings, day totals, resources
    hourly.parquet  one row per (run, request hour): passenger-hours, means, p90, vehicle-hours
    groups.parquet  one row per (run, period, hub ride, distance band, origin subzone): sums
    config.json     the jobs, the scenarios and provenance (model keys, input digests, git)
"""
from __future__ import annotations

import json
import multiprocessing as mp
import sys
import time
from dataclasses import asdict, replace

import numpy as np
import pandas as pd

from ..experiments import provenance, service_day_requests
from ..model import build_model, default_baseline_params
from ..paths import PROCESSED
from .assign import _cell_gaps, ride_gap, table_digest
from .runs import ALL_RIDES, OptionSpec, by_group, by_hour, run_option, summarise

OUT = PROCESSED / "phase2"
SEEDS = (1, 2, 3)


def scenarios() -> dict[str, dict]:
    """Model variants: build_model keyword arguments and a label. Road and bus variants come
    from the committed calibration, as in Phase 1's sensitivity analysis."""
    from ..calibrate import load as load_cal
    from ..sensitivity import joint_draws
    c = load_cal()
    bp = default_baseline_params()
    _, slow, note = joint_draws(c)
    out = {
        "base": {"label": "Calibrated base case", "kw": {}},
        "slow_roads": {
            "label": (f"Slower roads and buses: calibration draw at the 97.5th percentile of road time (cruise "
                      f"x{slow['mult']:.2f}, {slow['sig_s']:.0f} s per signal, bus dwell {slow['dwell_s']:.0f} s; {note})"),
            "kw": {"cal": {"mult_arterial": slow["mult"], "mult_local": slow["mult"], "sig_s": slow["sig_s"]},
                   "baseline_params": replace(bp, dwell_s=slow["dwell_s"], hub_extra_s=slow["hub_extra_s"])}},
    }
    out["shuttle_slow"] = {
        "label": ("Shuttles 25 % slower than buses on every road (cruise time x1.25, same signal delay); buses and "
                  "demand as in the base case. Assumption standing in for cautious automated driving"),
        "kw": {}, "sim_kw": {"cal": {"mult_arterial": c["mult"] * 1.25, "mult_local": c["mult"] * 1.25,
                                     "sig_s": c["sig_s"]}}}
    peak = PROCESSED / "calibration_pm_peak.json"
    if peak.exists():
        p = json.loads(peak.read_text())
        out["pm_peak"] = {
            "label": (f"Evening-peak calibration all day (cruise x{p['mult']:.2f}, {p['sig_s']:.0f} s per signal, "
                      f"bus dwell {p['dwell_s']:.0f} s, wait factor {p['kappa']:.2f})"),
            "kw": {"cal": {"mult_arterial": p["mult"], "mult_local": p["mult"], "sig_s": p["sig_s"]},
                   "baseline_params": replace(bp, dwell_s=p["dwell_s"], hub_extra_s=p["hub_extra_s"], kappa=p["kappa"])}}
    return out


_MODELS: dict = {}
_SCEN: dict = {}


def _model(name: str, part: str = "kw"):
    """The scenario's bus-and-demand model ("kw"), or the model its shuttles drive on ("sim_kw",
    the same model unless the scenario slows the shuttles only)."""
    if part == "sim_kw" and "sim_kw" not in _SCEN[name]:
        return _model(name)
    if (name, part) not in _MODELS:
        _MODELS[(name, part)] = build_model(**_SCEN[name][part])
    return _MODELS[(name, part)]


def job(spec: OptionSpec, seed: int, scenario: str = "base", tag: str = "") -> dict:
    return {"spec": asdict(spec), "seed": seed, "scenario": scenario, "tag": tag,
            "run_id": f"{scenario}|{spec.label()}|av{spec.availability:g}|b{spec.berths}|w{spec.w_max_s:g}"
                      f"|{json.dumps(spec.sim, sort_keys=True)}|s{seed}"}


def run_job(j: dict) -> dict:
    spec = OptionSpec(**j["spec"])
    M = _model(j["scenario"])
    req = service_day_requests(M, j["seed"])
    plan_gap, plan_M = None, None
    if spec.option == "C" and j["scenario"] != "base":
        Mb = _model("base")
        rb = service_day_requests(Mb, j["seed"])
        same = (rb.t.to_numpy() == req.t.to_numpy()).all() and (rb.o.to_numpy() == req.o.to_numpy()).all()
        if not same:
            raise RuntimeError("a scenario changed the requests; the planned eligibility table does not apply")
        plan_gap, plan_M = ride_gap(Mb, rb), Mb
    out = run_option(M, req, spec, j["seed"], plan_gap, plan_M, sim_M=_model(j["scenario"], "sim_kw"))
    r = out["rides"]
    lab = {"run_id": j["run_id"], "scenario": j["scenario"], "option": spec.option, "label": spec.label(),
           "fleet": spec.fleet, "capacity": spec.capacity, "theta_min": spec.theta_min, "w_max_s": spec.w_max_s,
           "hours": spec.hours, "availability": spec.availability, "berths": -1 if spec.berths is None else spec.berths,
           "sim": json.dumps(spec.sim, sort_keys=True), "seed": j["seed"], "tag": j["tag"]}
    res = out["resources"]
    summary = {**lab, **summarise(r), **{k: v for k, v in res.items() if not isinstance(v, list)}}
    if spec.option == "C":
        gap = ride_gap(M, req) if plan_gap is None else plan_gap
        summary["eligibility_digest"] = table_digest(gap, spec.theta_min)
    hourly = by_hour(r)
    for k in ("moving_h_by_hour", "dwell_h_by_hour", "veh_km_by_hour"):
        if k in res:
            hourly[k.replace("_by_hour", "")] = [res[k][h] if h < len(res[k]) else np.nan for h in hourly.hour]
    for st in ("Yishun", "Khatib", "Springleaf"):
        k = f"kerb_max_by_hour_{st}"
        if k in res:
            hourly[f"kerb_max_{st}"] = [res[k][h - 5] if 5 <= h <= 25 else np.nan for h in hourly.hour]
    groups = by_group(r)
    for df in (hourly, groups):
        for k, v in lab.items():
            df[k] = v
    return {"summary": summary, "hourly": hourly, "groups": groups}


def run_jobs(name: str, jobs: list[dict], workers: int = 4) -> pd.DataFrame:
    global _SCEN
    _SCEN = scenarios()
    for s in sorted({j["scenario"] for j in jobs} | {"base"}):   # build once, share copy-on-write
        _model(s)
        _model(s, "sim_kw")
    _cell_gaps(_model("base"))     # rule C-theta's planning table, built before the workers fork
    out_dir = OUT / name
    out_dir.mkdir(parents=True, exist_ok=True)
    t = time.time()
    results = []
    with mp.get_context("fork").Pool(workers) as pool:
        for k, r in enumerate(pool.imap_unordered(run_job, jobs)):
            results.append(r)
            s = r["summary"]
            print(f"[{k + 1}/{len(jobs)}] {s['scenario']} {s['label']} av{s['availability']:g} b{s['berths']} "
                  f"s{s['seed']}: saved {s['saved_h']:,.0f} pax-h, offered {s['n_offered']:,}, "
                  f"declined/refused {s['n_declined'] + s['n_refused']:,}, {s.get('runtime_s', 0):.0f}s", flush=True)
    runs = pd.DataFrame([r["summary"] for r in results]).sort_values(["scenario", "option", "capacity", "theta_min",
                                                                       "fleet", "seed"], na_position="first")
    runs.to_parquet(out_dir / "runs.parquet")
    pd.concat([r["hourly"] for r in results], ignore_index=True).to_parquet(out_dir / "hourly.parquet")
    pd.concat([r["groups"] for r in results], ignore_index=True).to_parquet(out_dir / "groups.parquet")
    prov = {s: {"model_key": _model(s).key, "shuttle_model_key": _model(s, "sim_kw").key, "inputs": _model(s).inputs,
                "label": _SCEN[s]["label"]} for s in sorted({j["scenario"] for j in jobs} | {"base"})}
    (out_dir / "config.json").write_text(json.dumps({
        "grid": name, "jobs": jobs, "elapsed_s": time.time() - t, "seeds": sorted({j["seed"] for j in jobs}),
        "scenarios": prov, "provenance": provenance(_model("base"))}, indent=1, default=str))
    return runs


# ---------------------------------------------------------------------------- grids
COARSE_THETA_FLEETS = {4: [150, 200, 250, 300, 350, 400], 6: [100, 150, 200, 250, 300],
                       8: [50, 75, 100, 125, 150, 200], 10: [25, 50, 75, 100, 125], 12: [25, 40, 50, 75, 100]}
B_FLEETS = [400, 450, 500]


def grid_coarse() -> list[dict]:
    jobs = [job(OptionSpec("A"), s) for s in SEEDS]
    jobs += [job(OptionSpec("B", fleet=n), s) for n in B_FLEETS for s in SEEDS]
    jobs += [job(OptionSpec("C", fleet=n, theta_min=th), s) for th, fl in COARSE_THETA_FLEETS.items()
             for n in fl for s in SEEDS]
    return jobs


# refine: intermediate coverage levels and finer fleets around each service-level fleet of the
# coarse search (theta 4: 350, 6: 300, 8: 200, 10: 100, 12: 75), same seeds
REFINE_THETA_FLEETS = {4: [325, 375], 5: [275, 300, 325, 350], 6: [275, 325], 7: [200, 225, 250, 275],
                       8: [175, 225], 9: [100, 125, 150, 175], 10: [85, 110], 11: [60, 75, 90, 100],
                       12: [60, 85], 14: [30, 40, 50, 60], 16: [20, 30, 40, 50]}


def grid_refine() -> list[dict]:
    return [job(OptionSpec("C", fleet=n, theta_min=th), s) for th, fl in REFINE_THETA_FLEETS.items()
            for n in fl for s in SEEDS]


# vehicle size: 4 and 20 seats at a targeted and a broad coverage level, and B at the Phase 1
# parity fleets of those sizes (700 four-seat, 375 twenty-seat)
CAPACITY_FLEETS = {(4, 10): [100, 125, 150, 175, 200], (20, 10): [60, 75, 90, 100, 125],
                   (4, 6): [350, 400, 450, 500], (20, 6): [200, 225, 250, 275, 300]}


def grid_capacity() -> list[dict]:
    jobs = [job(OptionSpec("C", fleet=n, capacity=cap, theta_min=th), s)
            for (cap, th), fl in CAPACITY_FLEETS.items() for n in fl for s in SEEDS]
    jobs += [job(OptionSpec("B", fleet=n, capacity=cap), s) for cap, n in ((4, 700), (20, 375)) for s in SEEDS]
    return jobs


def grid_wmax() -> list[dict]:
    """Declining at 45 min (Phase 1's refusal limit) instead of 15, at and below the service-level fleets."""
    return [job(OptionSpec("C", fleet=n, theta_min=th, w_max_s=2700.0), s)
            for th, fl in ((6, [250, 275]), (8, [150, 175]), (10, [85, 100]), (14, [30, 40])) for n in fl for s in SEEDS]


# reference options for stress tests and extra replicates: B at its parity fleet, and C at the
# service-level fleet (<= 1 % declined in every hour) of four coverage levels, from the refine grid
REFERENCE = [OptionSpec("B", fleet=450), OptionSpec("C", fleet=275, theta_min=6),
             OptionSpec("C", fleet=175, theta_min=8), OptionSpec("C", fleet=100, theta_min=10),
             OptionSpec("C", fleet=40, theta_min=14)]
STRESSES = [  # (label, scenario, availability, berths)
    ("slower roads and buses", "slow_roads", 1.0, None),
    ("evening-peak roads and buses all day", "pm_peak", 1.0, None),
    ("shuttles 25 % slower", "shuttle_slow", 1.0, None),
    ("15 % of the fleet unavailable", "base", 0.85, None),
    ("kerb: 10 shuttles at once per station", "base", 1.0, 10),
    ("kerb: 7 shuttles at once per station", "base", 1.0, 7),
    ("combined: slower roads, 15 % unavailable, kerb 7", "slow_roads", 0.85, 7),
]


# B at its parity fleet sits on the edge of its capacity cliff; a 50-vehicle margin shows whether
# that, rather than full replacement as such, makes it fragile under the fleet and kerb stresses
B_MARGIN = OptionSpec("B", fleet=500)
B_MARGIN_STRESSES = {"15 % of the fleet unavailable", "kerb: 10 shuttles at once per station",
                     "combined: slower roads, 15 % unavailable, kerb 7"}


def grid_stress() -> list[dict]:
    jobs = [job(OptionSpec("A"), s, sc) for sc in ("slow_roads", "pm_peak") for s in SEEDS]
    for label, sc, av, b in STRESSES:
        specs = REFERENCE + ([B_MARGIN] if label in B_MARGIN_STRESSES else [])
        for spec in specs:
            jobs += [job(replace(spec, availability=av, berths=b), s, sc, tag=label) for s in SEEDS]
    return jobs


def grid_replicates() -> list[dict]:
    """Seeds 4-10 for the reference options, to show variation between simulated days."""
    seeds = range(4, 11)
    return [job(spec, s) for spec in [OptionSpec("A")] + REFERENCE for s in seeds]


def grid_window() -> list[dict]:
    """Shuttles only in the period with the longest bus headways: every internal ride requested from
    20:00 (service-day hours 20-25) is offered a shuttle, and the fleet is in service only then; and
    rule C-theta (8 min) confined to the same window."""
    jobs = [job(OptionSpec("C", fleet=n, theta_min=ALL_RIDES, hours="20-25"), s) for n in (250, 300, 350, 400)
            for s in SEEDS]
    jobs += [job(OptionSpec("C", fleet=n, theta_min=8, hours="20-25"), s) for n in (75, 100, 125, 150) for s in SEEDS]
    return jobs


GRIDS = {"coarse": grid_coarse, "refine": grid_refine, "capacity": grid_capacity, "wmax": grid_wmax,
         "window": grid_window, "stress": grid_stress, "replicates": grid_replicates}

if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else "coarse"
    workers = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    run_jobs(name, GRIDS[name](), workers)
