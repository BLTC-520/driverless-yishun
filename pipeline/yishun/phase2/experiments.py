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
from .assign import ride_gap, table_digest
from .runs import OptionSpec, by_group, by_hour, run_option, summarise

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


def _model(name: str):
    if name not in _MODELS:
        _MODELS[name] = build_model(**_SCEN[name]["kw"])
    return _MODELS[name]


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
    out = run_option(M, req, spec, j["seed"], plan_gap, plan_M)
    r = out["rides"]
    lab = {"run_id": j["run_id"], "scenario": j["scenario"], "option": spec.option, "label": spec.label(),
           "fleet": spec.fleet, "capacity": spec.capacity, "theta_min": spec.theta_min, "w_max_s": spec.w_max_s,
           "availability": spec.availability, "berths": -1 if spec.berths is None else spec.berths,
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
    prov = {s: {"model_key": _model(s).key, "inputs": _model(s).inputs, "label": _SCEN[s]["label"]}
            for s in sorted({j["scenario"] for j in jobs} | {"base"})}
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


GRIDS = {"coarse": grid_coarse}

if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else "coarse"
    workers = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    run_jobs(name, GRIDS[name](), workers)
