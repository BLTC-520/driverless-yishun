"""Phase 2 summary: the options compared on passenger time and cost.

Inputs: the experiment grids in data/processed/phase2/, the bus allocation
(bus_allocation.json), the cost parameters (data/parameters/cost_cases.json) and the
definitions in docs/phase2/definitions.md.
Outputs:
  data/processed/phase2/summary.json  every number the report and the page quote
  web/public/data/phase2.json         the subset the page draws

Conventions:
  * Costs are SGD per average weekday, 2026 prices, excluding GST.
  * Every option is compared with Option A on the same rides of the same simulated days.
  * The bus network is identical in A and C, so its cost cancels: delta cost (C - A) = shuttle cost.
    Only B(ii), the theoretical withdrawal of the services that carry only internal riders,
    avoids bus cost.
  * Cost per passenger-hour saved is computed only when time is saved.
  * Time savings are valued only in the separate social analysis, never as operator revenue.
"""
from __future__ import annotations

import json
import math
from dataclasses import replace

import numpy as np
import pandas as pd

from .. import costs
from ..experiments import provenance
from ..model import build_model
from ..paths import PROCESSED, WEB_DATA
from .aggregate import KEY, acceptable, configs, load_runs, load_table, service_level_fleet
from .bus_allocation import internal_only_supply
from .experiments import OUT, REFERENCE, STRESSES
from .runs import ALL_RIDES
from .tables import PERIOD_LABELS, who_table

MAIN_GRIDS = ["coarse", "refine", "capacity", "wmax", "window", "replicates"]
CASES = ("low", "central", "high")
# staffing is a structural switch, never part of a cost range: today's pilot rule (a safety operator
# on board every vehicle in service, plus real-time monitoring) and possible future remote supervision
MODES = ("onboard", "remote")
MODE_LABELS = {"onboard": "safety operator on board (current pilot requirement)",
               "remote": "remote supervision (possible future arrangement)"}
BUDGETS = [10_000, 20_000, 30_000, 50_000, 75_000, 100_000, 150_000, 200_000, 300_000]
BUS_ERROR = (0.1, 0.2, 0.3)


def _f(x, nd=1):
    """JSON-safe rounded float."""
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return None
    return round(float(x), nd)


def config_id(row) -> str:
    if row["option"] == "A":
        return "A"
    s = f"{row['option']}-{int(row['capacity'])}-{int(row['fleet'])}"
    if row["option"] == "C":
        s += "-all" if row["theta_min"] <= ALL_RIDES else f"-th{row['theta_min']:g}"
        if row.get("hours"):
            s += f"-h{row['hours']}"
    if row.get("w_max_s", 900.0) != 900.0 and row["option"] == "C":
        s += f"-w{row['w_max_s'] / 60:g}"
    return s


def ops_of(row) -> costs.ShuttleOps:
    """Cost-model inputs of one configuration: the planned fleet (a stress test that takes vehicles
    out of service keeps the planned fleet's cost), mean vehicle-km and rides over replicates."""
    return costs.ShuttleOps(capacity=int(row["capacity"]), fleet_in_service=int(row["fleet"]),
                            service_hours=float(row["service_hours"]), veh_km=float(row["veh_km"]),
                            veh_km_empty=float(row["veh_km_empty"]), rides=float(row["n_shuttle"]),
                            pax_km=float(row["shuttle_pax_km_direct"]))


# ---------------------------------------------------------------------------- bus side
def bus_side(M, p: costs.CostParams) -> dict:
    """Bus supply inside Yishun, its cost, the share allocated to internal riders (passenger-km key)
    and the cost of the services that carry only internal riders (avoidable only under B(ii))."""
    alloc = json.loads((OUT / "bus_allocation.json").read_text())
    sup = internal_only_supply(M, alloc["internal_only_services"])
    share = alloc["pax_km_share"]["internal"]
    out = {"allocation": {k: alloc[k] for k in ("months", "method", "pax_km_share", "ride_share",
                                                 "rides_per_weekday", "internal_only_services")},
           "supply": {k: _f(v) for k, v in sup.items()}, "internal_share_key": "in-area passenger-km",
           "internal_share": share, "cost": {}}
    for case in CASES:
        allb = costs.bus_daily_cost(costs.BusOps(sup["all_bus_km"], sup["all_bus_hours"], "all services"), p, case)
        avoid = costs.bus_daily_cost(costs.BusOps(sup["bus_km"], sup["bus_hours"], "internal-only services"), p, case)
        out["cost"][case] = {"all": allb["daily_cost"], "allocated_internal": allb["daily_cost"] * share,
                             "allocated_internal_by_rides": allb["daily_cost"] * alloc["ride_share"]["internal"],
                             "avoidable_internal_only": avoid["daily_cost"], "basis": allb["basis"],
                             "inclusions": allb["inclusions"]}
    return out


# ---------------------------------------------------------------------------- costs per option
def cost_rows(cfg: pd.DataFrame, p: costs.CostParams, bus: dict) -> pd.DataFrame:
    """Every configuration x staff mode x cost case (and, for B, both bus cases): daily cost, delta
    cost against A, passenger-hours saved, classification and cost per passenger-hour saved."""
    rows = []
    for _, r in cfg.iterrows():
        if r["option"] == "A":
            continue
        ops = ops_of(r)
        for mode, case in ((m, c) for m in MODES for c in CASES):
            sc = costs.shuttle_daily_cost(ops, p.with_switches(staff_mode=mode), case)
            bc = bus["cost"][case]
            bus_cases = [("all buses kept", 0.0)]
            if r["option"] == "B":
                bus_cases.append(("internal-only services withdrawn", bc["avoidable_internal_only"]))
            for bus_case, avoided in bus_cases:
                opt = {"daily_cost": bc["all"] - avoided + sc["total"], "passenger_hours": r["pax_h"],
                       "rides_completed": r["n_shuttle"] + r["n_bus"], "rides_refused": r["n_refused"],
                       "rides_declined": r["n_declined"], "label": config_id(r)}
                base = {"daily_cost": bc["all"], "passenger_hours": r["pax_h_A"], "rides_completed": r["n"],
                        "label": "A"}
                cmp_ = costs.compare(opt, base)
                completed = r["n_shuttle"] + r["n_bus"] + r["n_declined"]
                internal_cost = bc["allocated_internal"] - avoided + sc["total"]
                row = {"id": config_id(r), "staff_mode": mode, "case": case, "bus_case": bus_case,
                       "shuttle_cost": sc["total"], "avoided_bus_cost": avoided, "delta_cost": cmp_["delta_cost"],
                       "saved_h": cmp_["passenger_hours_saved"], "classification": cmp_["classification"],
                       "cost_per_hour_saved": cmp_["cost_per_passenger_hour_saved"],
                       "cost_per_shuttle_ride": sc["cost_per_ride"], "cost_per_shuttle_pax_km": sc["cost_per_pax_km"],
                       "cost_per_internal_ride": internal_cost / completed if completed else None,
                       "cost_per_internal_pax_km": internal_cost / r["pax_km_direct"],
                       "cost_per_vehicle_day": sc["cost_per_vehicle_day"],
                       "total_fleet": sc["fleet"]["total"], "charging_reserve": sc["fleet"]["charging_reserve"],
                       "maintenance_reserve": sc["fleet"]["maintenance_reserve"],
                       "unavailable_vehicle_hours": sc["fleet"]["unavailable_vehicle_hours"],
                       "chargers": sc["fleet"]["chargers"],
                       **{f"cat_{k}": v for k, v in sc["categories"].items()},
                       **{f"class_{k}": v for k, v in sc["classes"].items()},
                       **{f"share_{k}": v for k, v in sc["shares"].items()}}
                for t in ("R2", "R3"):
                    s = r[f"saved_h_{t}"]
                    row[f"saved_h_{t}"] = s
                    row[f"cost_per_hour_saved_{t}"] = cmp_["delta_cost"] / s if s > 0 else None
                rows.append(row)
    return pd.DataFrame(rows)


def frontier(cr: pd.DataFrame, case: str, ids: set[str] | None = None, mode: str = "onboard") -> list[str]:
    """Configurations that save more passenger-hours than every cheaper one (base scenario, all buses
    kept for B): the cost-time frontier, for one staff mode and cost case."""
    t = cr[(cr.case == case) & (cr.bus_case == "all buses kept")]
    if "staff_mode" in t:
        t = t[t.staff_mode == mode]
    if ids is not None:
        t = t[t.id.isin(ids)]
    t = t.sort_values(["delta_cost", "saved_h"], ascending=[True, False])
    best, out = -np.inf, []
    for _, r in t.iterrows():
        if r.saved_h > best:
            out.append(r.id)
            best = r.saved_h
    return out


def budget_table(cr: pd.DataFrame, ids: set[str], mode: str = "onboard") -> list[dict]:
    """For each daily budget for added cost: the most passenger-hours any eligible configuration saves
    within it, per cost case, for one staff mode."""
    out = []
    if "staff_mode" in cr:
        cr = cr[cr.staff_mode == mode]
    for b in BUDGETS:
        row = {"budget_sgd_per_day": b}
        for case in CASES:
            t = cr[(cr.case == case) & (cr.bus_case == "all buses kept") & cr.id.isin(ids) & (cr.delta_cost <= b)]
            if t.empty:
                row[case] = None
                continue
            best = t.loc[t.saved_h.idxmax()]
            row[case] = {"id": best.id, "saved_h": _f(best.saved_h, 0), "delta_cost": _f(best.delta_cost, 0),
                         "cost_per_hour_saved": _f(best.cost_per_hour_saved, 2)}
        out.append(row)
    return out


# ---------------------------------------------------------------------------- social (separate)
def social(cfgrow, delta_cost: dict, p: costs.CostParams) -> dict | None:
    """Value of the passenger time saved, a social benefit kept apart from operator cost: in-vehicle
    hours saved plus the waiting weight times waiting hours saved, at the value of in-vehicle time.
    delta_cost: {staff mode: central delta cost}. Benefits are never operator revenue."""
    if not (p.has("vot_ivt_sgd_per_hour") and p.has("wait_time_weight")):
        return None
    d_wait = cfgrow["wait_h_A"] - cfgrow["wait_h"]
    d_ivt = cfgrow["ivt_h_A"] - cfgrow["ivt_h"]
    out = {"wait_h_saved": _f(d_wait), "ivt_h_saved": _f(d_ivt)}
    for side in CASES:   # low = low values of time, high = high values
        vot, w = p.value("vot_ivt_sgd_per_hour", side), p.value("wait_time_weight", side)
        benefit = vot * (d_ivt + w * d_wait)
        out[side] = {"vot": vot, "wait_weight": w, "benefit_sgd_per_day": _f(benefit, 0),
                     **{f"benefit_cost_ratio_{m}": _f(benefit / dc, 2) if dc > 0 else None for m, dc in delta_cost.items()},
                     **{f"net_{m}": _f(benefit - dc, 0) for m, dc in delta_cost.items()}}
    return out


# ---------------------------------------------------------------------------- thresholds
def thresholds(ref: pd.DataFrame, cr: pd.DataFrame, p: costs.CostParams, bus: dict, mode: str) -> dict:
    """Thresholds for the reference options (central case, one staff mode). Each is a value at which a
    stated target is met; whether that value is achievable or permitted is a separate question."""
    out = {}
    vot = p.value("vot_ivt_sgd_per_hour", "central") if p.has("vot_ivt_sgd_per_hour") else None
    p = p.with_switches(staff_mode=mode)
    solve_ids = ((("vehicles_per_remote_operator", (0.5, 200.0)), ("remote_operator_sgd_per_hour", (0.0, 200.0)))
                 if mode == "remote" else (("onboard_staff_sgd_per_hour", (0.0, 200.0)),)) + (("veh_price", (0.0, 3e6)),)
    for _, r in ref.iterrows():
        if r["option"] == "A":
            continue
        i = config_id(r)
        ops = ops_of(r)
        c = cr[(cr.id == i) & (cr.case == "central") & (cr.bus_case == "all buses kept") & (cr.staff_mode == mode)].iloc[0]
        t = {"saved_h": _f(r["saved_h"], 0), "delta_cost_central": _f(c.delta_cost, 0),
             "budget_max_cost_per_vehicle_day": [
                 {"budget": b, **{k: _f(v, 0) if isinstance(v, (int, float)) else v for k, v in
                                  costs.max_daily_cost_per_vehicle(b, ops, p, "central").items()
                                  if k in ("value", "total_fleet", "current", "headroom")}}
                 for b in BUDGETS if b >= 0.1 * c.delta_cost and b <= 3 * c.delta_cost]}
        targets = {"bus cost per internal ride (allocated, Option A)":
                       bus["cost"]["central"]["allocated_internal"] / r["n"],
                   "Punggol shuttle fare (context only, not revenue)": 4.0}
        t["rides_per_vehicle_hour"] = []
        for name, target in targets.items():
            res = costs.required_rides_per_vehicle_hour(target, ops, p, "central", bracket=(0.05, 40.0))
            t["rides_per_vehicle_hour"].append({"target": name, "target_cost_per_ride": _f(target, 2),
                                                "value": _f(res["value"], 2), "current": _f(res["current"], 2),
                                                "status": res["status"]})
        if vot and r["saved_h"] > 0:
            budget = vot * r["saved_h"]   # the daily cost at which cost per hour saved equals the value of time
            t["break_even_daily_cost"] = _f(budget, 0)
            for pid, bracket in solve_ids:
                try:
                    res = costs.solve_parameter_for_target(pid, "total", budget, ops, p, "central", bracket=bracket)
                    t[f"break_even_{pid}"] = {"value": _f(res["value"], 2), "status": res["status"],
                                              "met_for": res["met_for"], "bracket": res["bracket"],
                                              "central": _f(p.value(pid, "central", ops.capacity), 2)}
                except (KeyError, ValueError) as e:
                    t[f"break_even_{pid}"] = {"value": None, "status": f"not computed: {e}"}
        out[i] = t
    return out


# ---------------------------------------------------------------------------- sensitivity
def cost_swings(ref: pd.DataFrame, p: costs.CostParams, mode: str) -> dict:
    """One-at-a-time swings of every cost parameter, as cost per passenger-hour saved, for one staff
    mode (parameters that do not act in that mode show no swing)."""
    out = {}
    p = p.with_switches(staff_mode=mode)
    for _, r in ref.iterrows():
        if r["option"] == "A" or r["saved_h"] <= 0:
            continue
        rows = costs.swings(ops_of(r), p)
        for x in rows:
            x["cost_per_hour_saved"] = x["result"] / r["saved_h"]
            x["central_cost_per_hour_saved"] = x["central_result"] / r["saved_h"]
        out[config_id(r)] = [{k: (_f(v, 3) if isinstance(v, float) else v) for k, v in x.items()} for x in rows]
    return out


def bus_error(ref: pd.DataFrame) -> list[dict]:
    """Saving if the bus model overstates the bus time of the rides the shuttle carried by a share e:
    only those rides' bus times differ between the two sides."""
    out = []
    for _, r in ref.iterrows():
        if r["option"] == "A" or "sh_wait_h_A" not in r or pd.isna(r.get("sh_wait_h_A")):
            continue
        a = r["sh_wait_h_A"] + r["sh_ivt_h_A"]
        out.append({"id": config_id(r), "saved_h": _f(r["saved_h"], 0), "shuttle_rides_bus_hours": _f(a, 0),
                    **{f"saved_h_e{int(e * 100)}": _f(r["saved_h"] - e * a, 0) for e in BUS_ERROR}})
    return out


def stress_table(p: costs.CostParams) -> list[dict]:
    """Each stress test: passenger-hours saved against A in the same scenario, declines and refusals,
    and the central cost per hour saved at the planned fleet."""
    runs = load_runs(["stress"])
    if runs.empty:
        return []
    cfg = configs(runs)
    tag = runs.groupby(KEY, dropna=False).tag.first().reset_index() if "tag" in runs else None
    if tag is not None:
        cfg = cfg.merge(tag.fillna({"theta_min": -1.0}).assign(theta_min=lambda x: x.theta_min.replace(-1.0, np.nan)),
                        on=KEY, how="left")
    out = []
    for _, r in cfg.iterrows():
        if r["option"] == "A":
            continue
        sc = {m: costs.shuttle_daily_cost(ops_of(r), p.with_switches(staff_mode=m), "central") for m in MODES}
        out.append({"id": config_id(r), "stress": r.get("tag", ""), "scenario": r["scenario"],
                    "availability": _f(r["availability"], 2), "berths": int(r["berths"]),
                    "saved_h": _f(r["saved_h"], 0), "saved_h_min": _f(r["saved_h_min"], 0),
                    "saved_h_max": _f(r["saved_h_max"], 0),
                    "declined": _f(r["n_declined"], 0), "refused": _f(r["n_refused"], 0),
                    "offered": _f(r["n_offered"], 0), "mean_min": _f(r["mean_min"], 2), "mean_min_A": _f(r["mean_min_A"], 2),
                    "p90_min": _f(r["p90_min"], 2), "p90_min_A": _f(r["p90_min_A"], 2),
                    **{f"cost_per_hour_saved_central_{m}": _f(sc[m]["total"] / r["saved_h"], 2) if r["saved_h"] > 0 else None
                       for m in MODES},
                    "kerb_max_Yishun": _f(r.get("kerb_max_Yishun"), 0), "n_seeds": int(r["n_seeds"])})
    return out


# ---------------------------------------------------------------------------- run
def _ref_mask(cfg: pd.DataFrame) -> pd.Series:
    m = (cfg.option == "A") & (cfg.scenario == "base")
    for s in REFERENCE:
        mm = (cfg.option == s.option) & (cfg.fleet == s.fleet) & (cfg.capacity == s.capacity) & (cfg.scenario == "base")
        mm &= (cfg.w_max_s == s.w_max_s) & (cfg.hours == s.hours)
        mm &= cfg.theta_min.isna() if s.theta_min is None else (cfg.theta_min == s.theta_min)
        m |= mm & (cfg.availability == 1.0) & (cfg.berths == -1)
    return m


def run() -> dict:
    p = costs.load_cases()
    M = build_model()
    bus = bus_side(M, p)
    runs = load_runs(MAIN_GRIDS)
    runs = runs[(runs.scenario == "base") & (runs.availability == 1.0) & (runs.berths == -1)]
    cfg = configs(runs)
    hourly = load_table(MAIN_GRIDS, "hourly")
    groups = load_table(MAIN_GRIDS, "groups")
    base_h = hourly[(hourly.scenario == "base") & (hourly.availability == 1.0) & (hourly.berths == -1)]
    acc = acceptable(base_h).fillna({"theta_min": -1.0})
    cfg = cfg.fillna({"theta_min": -1.0}).merge(acc, on=KEY, how="left")
    cfg["theta_min"] = cfg.theta_min.replace(-1.0, np.nan)
    cfg["acceptable"] = cfg.acceptable.fillna(True) | (cfg.option == "A")
    cfg["id"] = [config_id(r) for _, r in cfg.iterrows()]
    cr = cost_rows(cfg, p, bus)
    sl = service_level_fleet(base_h)
    sl_ids = set()
    for _, s in sl.iterrows():
        if s.fleet_sl is not None and not pd.isna(s.fleet_sl):
            sl_ids.add(config_id({"option": "C", "capacity": s.capacity, "fleet": s.fleet_sl, "theta_min": s.theta_min,
                                  "w_max_s": s.w_max_s, "hours": s.hours}))
    # the frontier and the budget table use acceptable service only (<= 1 % declined in every hour
    # for C, no refusals for B) and the default 15-minute decline limit
    main_ids = set(cfg[((cfg.w_max_s == 900.0) | (cfg.option != "C")) & cfg.acceptable].id)
    ref = cfg[_ref_mask(cfg)]
    fr = {m: {case: frontier(cr, case, main_ids, m) for case in CASES} for m in MODES}
    out = {
        "provenance": {**provenance(M), "grids": MAIN_GRIDS + ["stress"], "cost_parameters": p.source,
                       "seeds": sorted(runs.seed.unique().tolist())},
        "units": "SGD per average weekday, 2026 prices, excluding GST; passenger-hours per weekday; stop to stop",
        "bus": bus,
        "configs": json.loads(cfg.drop(columns=["sim"]).to_json(orient="records")),
        "costs": json.loads(cr.to_json(orient="records")),
        "service_level": json.loads(sl.assign(fleets=sl.fleets.apply(list)).to_json(orient="records")),
        "service_level_ids": sorted(sl_ids),
        "reference_ids": [config_id(r) for _, r in ref.iterrows()],
        "frontier": fr,
        "staff_modes": MODE_LABELS,
        "budgets": {m: budget_table(cr, main_ids, m) for m in MODES},
        "thresholds": {m: thresholds(ref, cr, p, bus, m) for m in MODES},
        "sensitivity": {"cost_swings": {m: cost_swings(ref, p, m) for m in MODES},
                        "bus_error": bus_error(ref), "stress": stress_table(p)},
        "social": {config_id(r): social(r, {m: float(cr[(cr.id == config_id(r)) & (cr.case == "central") &
                                                        (cr.bus_case == "all buses kept") & (cr.staff_mode == m)]
                                                     .delta_cost.iloc[0]) for m in MODES}, p)
                   for _, r in ref.iterrows() if r["option"] != "A"},
        "who": {}, "hourly": {},
    }
    for _, r in ref.iterrows():
        i = config_id(r)
        keycfg = {k: r[k] for k in ("scenario", "option", "capacity", "fleet", "w_max_s", "hours")}
        keycfg["theta_min"] = None if pd.isna(r["theta_min"]) else r["theta_min"]
        keycfg.update({"availability": 1.0, "berths": -1})
        out["who"][i] = {k: json.loads(t.to_json(orient="records")) for k, t in who_table(groups, keycfg).items()}
        hm = hourly
        for k, v in keycfg.items():
            hm = hm[hm[k].isna()] if v is None else hm[hm[k] == v]
        hh = hm.groupby("hour").mean(numeric_only=True).reset_index()
        out["hourly"][i] = json.loads(hh.to_json(orient="records"))
    out["period_labels"] = PERIOD_LABELS
    out["stress_labels"] = [s[0] for s in STRESSES]
    path = OUT / "summary.json"
    path.write_text(json.dumps(out, indent=1, default=str))
    print(f"wrote {path} ({path.stat().st_size / 1e6:.1f} MB)")
    return out


if __name__ == "__main__":
    run()
