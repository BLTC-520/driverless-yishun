"""Phase 2 page data: a compact, rounded subset of summary.json for the study page.

Usage (from pipeline/):
    python -m yishun.phase2.export_web [--summary PATH] [--out PATH]

Input:  data/processed/phase2/summary.json (default), written by yishun.phase2.summary.
Output: web/public/data/phase2.json, the only file the page's Phase 2 chapter reads.

* Every number the Phase 2 text quotes is formatted once, here, in "numbers" (as Phase 1's
  results.json "numbers"). Keys start with "p2_" so they never collide with Phase 1's keys;
  web/build.py pre-fills the page's data-v spans from them and app.js fills them again at runtime.
* "synthetic" is true when provenance.cost_parameters contains "SYNTHETIC" (a test fixture): the
  page then shows a banner in the Phase 2 chapter, and no cost figure may be read as a result.
* Nothing is computed that summary.json does not hold: this module selects, rounds and formats.
  Passenger-hours by period are the summary's "who" sums (never averages of means).
* Rounding: passenger-hours and SGD per day to whole units, cost per passenger-hour saved to cents,
  ride counts to one decimal (means over simulated days). The text rounds costs to two significant
  figures (definitions section 5), and always quotes the low-high range with the central case.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from ..paths import PROCESSED, WEB_DATA

SUMMARY = PROCESSED / "phase2" / "summary.json"
OUT = WEB_DATA / "phase2.json"
CASES = ("low", "central", "high")
ALL_RIDES = -1.0          # a C threshold at or below this offers every ride (runs.ALL_RIDES is -5)
KEPT, WITHDRAWN = "all buses kept", "internal-only services withdrawn"
WITHDRAWN_FEE = "internal-only services withdrawn, operator fee only"   # review R6: the bus cost without LTA's capital
# staffing is a structural switch (summary["staff_modes"]); the page lists the modes in this order, the
# current pilot requirement first, and any other mode after them in the summary's own order
MODE_ORDER = ("onboard", "remote_with_attendant", "remote")
MODE_SHORT = {"onboard": "safety operator on board", "remote_with_attendant": "remote + attendant",
              "remote": "remote only"}
# quadrants of the trade-off chart, in the order costs.CLASSIFICATIONS lists them
CLASSES = ["reduces cost and time", "increases cost, reduces time", "reduces cost, increases time",
           "increases cost and time"]
CATEGORIES = {  # costs.CATEGORIES, in the order the page lists them (staff first: the structural switch)
    "staff": "Staff", "vehicles": "Vehicles", "energy": "Energy", "maintenance": "Maintenance",
    "cleaning": "Cleaning", "insurance_permits": "Insurance and permits",
    "software_comms": "Software and communications", "charging_depot": "Charging and depot"}
PERIOD_NAMES = {"early": "Early", "am_peak": "Morning peak", "offpeak": "Off-peak", "pm_peak": "Evening peak",
                "evening": "Late evening"}
PARAM_LABELS = {  # definitions section 8
    "veh_price": "Vehicle price", "veh_life_years": "Vehicle life", "veh_residual_share": "Residual value",
    "lease_sgd_per_vehicle_year": "Lease charge", "discount_rate_real": "Real discount rate",
    "energy_kwh_per_km": "Energy use per km", "battery_usable_kwh": "Usable battery",
    "charging_efficiency": "Charging efficiency", "electricity_sgd_per_kwh": "Electricity price",
    "charger_power_kw": "Charger power", "maint_sgd_per_km": "Maintenance per km",
    "maint_fixed_sgd_per_vehicle_year": "Fixed maintenance per vehicle",
    "cleaning_sgd_per_vehicle_day": "Cleaning per vehicle-day", "insurance_sgd_per_vehicle_year": "Insurance per vehicle",
    "permit_fixed_sgd_per_year": "Permits (programme)", "software_sgd_per_vehicle_month": "Software per vehicle",
    "comms_sgd_per_vehicle_month": "Communications per vehicle", "control_centre_fixed_sgd_per_year": "Control centre",
    "vehicles_per_remote_operator": "Vehicles per remote operator", "min_remote_operators": "Minimum remote operators",
    "remote_operator_sgd_per_hour": "Remote operator cost per hour", "vehicles_per_field_staff": "Vehicles per field staff",
    "field_staff_sgd_per_hour": "Field staff cost per hour", "onboard_staff_sgd_per_hour": "On-board staff cost per hour",
    "charger_sgd_each": "Charger price, installed", "charger_life_years": "Charger life",
    "vehicles_per_charger": "Vehicles per charger", "depot_sgd_per_vehicle_year": "Depot space per vehicle",
    "depot_fixed_sgd_per_year": "Depot site", "maintenance_spare_ratio": "Maintenance spare ratio",
    "attendant_sgd_per_hour": "Attendant cost per hour", "vehicles_per_monitor_onboard_mode": "Vehicles per monitor (operator on board)"}


# ---------------------------------------------------------------------------- rounding and formats
def _r(x, nd=0):
    """JSON-safe rounded number (None for missing or non-finite)."""
    if x is None or isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
        return None
    v = round(float(x), nd)
    return int(v) if nd == 0 else v


def sig(x: float, n: int = 2) -> float:
    if not x:
        return 0.0
    return round(x, n - 1 - int(math.floor(math.log10(abs(x)))))


def _num(x: float, n: int = 2, strip: bool = False) -> str:
    """A number at n significant figures, with thousands separators. Whole values lose their
    decimals ('4.0' -> '4'); strip=True also drops trailing zeros ('0.150' -> '0.15')."""
    v = sig(x, n)
    nd = max(0, n - 1 - int(math.floor(math.log10(abs(v))))) if v else 0
    s = f"{abs(v):,.{nd}f}"
    if "." in s and (strip or not s.split(".")[1].strip("0")):
        s = s.rstrip("0").rstrip(".")
    return ("−" if v < 0 else "") + s


def sgd(x, n: int = 2) -> str | None:
    """SGD amount at n significant figures: 'SGD 420,000', 'SGD 23', 'SGD 0.56', '−SGD 12,000'."""
    if x is None:
        return None
    s = _num(x, n)
    return ("−SGD " + s[1:]) if s.startswith("−") else f"SGD {s}"


def sgd_range(lo, hi, n: int = 2) -> str | None:
    """'SGD 300,000–560,000' (one currency label), or a single amount when both ends round alike."""
    if lo is None or hi is None:
        return None
    lo, hi = sorted((lo, hi))
    a, b = _num(lo, n), _num(hi, n)
    if a == b:
        return sgd(lo, n)
    if lo < 0:
        return f"{sgd(lo, n)} to {sgd(hi, n)}"
    return f"SGD {a}–{b}"


def fint(x) -> str | None:
    return None if x is None else f"{x:,.0f}"


def int_range(a, b) -> str | None:
    if a is None or b is None:
        return None
    a, b = sorted((a, b))
    return fint(a) if round(a) == round(b) else f"{fint(a)}–{fint(b)}"


def pct(x, nd: int = 0) -> str | None:
    return None if x is None else f"{100 * x:.{nd}f}%"


def pct_range(a, b, nd: int = 0) -> str | None:
    if a is None or b is None:
        return None
    a, b = sorted((a, b))
    sa, sb = f"{100 * a:.{nd}f}", f"{100 * b:.{nd}f}"
    return f"{sa}%" if sa == sb else f"{sa}–{sb}%"


def theta_txt(t) -> str:
    return "every ride" if t is not None and t <= ALL_RIDES else f"{t:g} min"


_UNIT_SUFFIX = (("per hour", "/h"), ("per vehicle-year", "/vehicle-year"), ("per vehicle-month", "/vehicle-month"),
                ("per vehicle-day", "/vehicle-day"), ("per kWh", "/kWh"), ("per km", "/km"), ("per year", "/year"),
                ("per charger", "/charger"))


def param_text(v, unit: str | None) -> str | None:
    """A cost parameter's value with a short unit, as the tornado labels print it."""
    if v is None:
        return None
    u = unit or ""
    if u == "fraction":
        return f"{_num(100 * v, 3, strip=True)}%"
    if u.startswith("SGD"):
        suf = next((s for k, s in _UNIT_SUFFIX if k in u), "")
        return f"SGD {_num(v, 3, strip=True)}{suf}"
    short = {"years": " years", "kWh": " kWh", "kW": " kW", "kWh per km at the battery": " kWh/km", "persons": "",
             "vehicles per operator": "", "vehicles per charger": "", "vehicles per person": ""}.get(u, f" {u}" if u else "")
    return f"{_num(v, 3, strip=True)}{short}"


# ---------------------------------------------------------------------------- configurations
def kind_of(c: dict) -> str:
    """A (today's buses), B, C (the main C family: 10 seats, all day, 15-min decline limit, one
    series per theta) or a C variant: C-cap (4 or 20 seats), C-window (evening only), C-wmax
    (45-min decline limit)."""
    if c["option"] != "C":
        return c["option"]
    if c.get("w_max_s", 900.0) != 900.0:
        return "C-wmax"
    if c.get("hours"):
        return "C-window"
    if int(c["capacity"]) != 10:
        return "C-cap"
    return "C"


def label_of(c: dict) -> tuple[str, str]:
    """(long label, short label) of a configuration, as the page and the charts print it."""
    o = c["option"]
    if o == "A":
        return "A: today's buses", "A"
    veh = f"{int(c['fleet'])} × {int(c['capacity'])}-seat"
    if o == "B":
        return f"B: full replacement, {veh} shuttles", f"B {int(c['fleet'])}"
    t = c.get("theta_min")
    parts = [f"θ {theta_txt(t)}" if t is not None and t > ALL_RIDES else "every ride"]
    if c.get("hours"):
        a, b = (int(x) for x in str(c["hours"]).split("-"))
        parts.append(f"{a % 24:02d}:00–{(b + 1) % 24:02d}:00 only")
    if c.get("w_max_s", 900.0) != 900.0:
        parts.append(f"declined after {c['w_max_s'] / 60:g} min")
    short = "C " + (f"θ={t:g}" if t is not None and t > ALL_RIDES else "all") + f" · {int(c['fleet'])}"
    if int(c["capacity"]) != 10:
        short += f"×{int(c['capacity'])}"
    if c.get("hours"):
        short += " eve"
    if c.get("w_max_s", 900.0) != 900.0:
        short += f" w{c['w_max_s'] / 60:g}"
    return f"C: {', '.join(parts)}; {veh} shuttles", short


def phrase_of(c: dict) -> str:
    """'θ 8 min with 175 shuttles' (C) or '450 shuttles' (B): the option as running text names it."""
    if c["option"] == "A":
        return "today's buses"
    veh = f"{int(c['fleet'])} shuttles" + ("" if int(c["capacity"]) == 10 else f" of {int(c['capacity'])} seats")
    t = c.get("theta_min")
    if c["option"] == "B":
        return veh
    return (f"θ {theta_txt(t)} with {veh}" if t is not None and t > ALL_RIDES else f"every ride offered, {veh}")


def config_rows(S: dict) -> list[dict]:
    out = []
    for c in S["configs"]:
        t = c.get("theta_min")
        long, short = label_of(c)
        out.append({
            "id": c["id"], "option": c["option"], "kind": kind_of(c), "label": long, "short": short,
            "phrase": phrase_of(c),
            "capacity": int(c["capacity"]), "fleet": int(c["fleet"]), "theta": _r(t, 2),
            "hours": c.get("hours") or "", "w_max_min": _r(c.get("w_max_s", 900.0) / 60, 1),
            "acceptable": bool(c.get("acceptable", True)), "n_seeds": int(c["n_seeds"]),
            "n": _r(c["n"]), "n_all": _r(c.get("n_all")), "n_no_bus": _r(c.get("n_no_bus"), 1),
            "n_offered": _r(c["n_offered"], 1), "n_shuttle": _r(c["n_shuttle"], 1),
            "n_declined": _r(c["n_declined"], 1), "n_refused": _r(c["n_refused"], 1),
            "pax_h": _r(c["pax_h"]), "pax_h_A": _r(c["pax_h_A"]), "wait_h": _r(c["wait_h"]), "ivt_h": _r(c["ivt_h"]),
            "wait_h_A": _r(c["wait_h_A"]), "ivt_h_A": _r(c["ivt_h_A"]),
            "saved_h": _r(c["saved_h"]), "saved_h_min": _r(c.get("saved_h_min")), "saved_h_max": _r(c.get("saved_h_max")),
            "saved_h_R2": _r(c.get("saved_h_R2")), "saved_h_R3": _r(c.get("saved_h_R3")),
            "mean_min": _r(c["mean_min"], 2), "mean_min_A": _r(c["mean_min_A"], 2),
            "p90_min": _r(c.get("p90_min"), 2), "p90_min_A": _r(c.get("p90_min_A"), 2),
            "veh_km": _r(c.get("veh_km")), "service_hours": _r(c.get("service_hours"), 1),
            "occupancy": _r(c.get("occupancy"), 2), "kerb_max_Yishun": _r(c.get("kerb_max_Yishun"), 1),
        })
    return out


def modes_of(S: dict) -> list[str]:
    """The staff modes of the summary, in the page's order (MODE_ORDER first)."""
    keys = list((S.get("staff_modes") or {}).keys())
    for part in ("budgets", "frontier", "thresholds"):
        keys += [k for k in (S.get(part) or {}) if k not in keys]
    keys += [r["staff_mode"] for r in S.get("costs", []) if r.get("staff_mode") not in keys]
    keys = list(dict.fromkeys(keys))
    return sorted(keys, key=lambda m: (MODE_ORDER.index(m) if m in MODE_ORDER else len(MODE_ORDER), keys.index(m)))


def references(S: dict, cfg: dict[str, dict]) -> tuple[str | None, list[str]]:
    """(B reference id, C reference ids by coverage: smallest theta, the broadest, first)."""
    ids = [i for i in S.get("reference_ids", []) if i in cfg]
    b = next((i for i in ids if cfg[i]["option"] == "B"), None)
    c = sorted((i for i in ids if cfg[i]["option"] == "C"),
               key=lambda i: (cfg[i]["theta"] if cfg[i]["theta"] is not None else -99, cfg[i]["fleet"]))
    return b, c


# ---------------------------------------------------------------------------- costs
def cost_tables(S: dict, ref_ids: set[str]) -> tuple[dict, dict]:
    """costs[mode][id]: delta cost against A, cost per passenger-hour saved and class, per cost
    case (all buses kept; B also with the internal-only services withdrawn). detail[mode][id]:
    the reference options' daily cost by category (central) and the low-high total."""
    costs, detail = {}, {}
    for r in S["costs"]:
        m, i, case = r["staff_mode"], r["id"], r["case"]
        side = {WITHDRAWN: "withdrawn", WITHDRAWN_FEE: "withdrawn_fee"}.get(r["bus_case"], "kept")
        e = costs.setdefault(m, {}).setdefault(i, {})
        tgt = e if side == "kept" else e.setdefault(side, {})
        tgt.setdefault("delta_cost", {})[case] = _r(r["delta_cost"])
        tgt.setdefault("cost_per_hour_saved", {})[case] = _r(r["cost_per_hour_saved"], 2)
        tgt.setdefault("classification", {})[case] = r["classification"]
        if side != "kept":
            tgt.setdefault("avoided_bus_cost", {})[case] = _r(r["avoided_bus_cost"])
            continue
        e.setdefault("shuttle_cost", {})[case] = _r(r["shuttle_cost"])
        if i in ref_ids:
            d = detail.setdefault(m, {}).setdefault(i, {"total": {}})
            d["total"][case] = _r(r["shuttle_cost"])
            if case == "central":
                d.update({
                    "categories": {k: _r(r.get(f"cat_{k}")) for k in CATEGORIES},
                    "classes": {k: _r(r.get(f"class_{k}")) for k in ("fixed", "distance", "staff")},
                    "total_fleet": r.get("total_fleet"), "charging_reserve": r.get("charging_reserve"),
                    "maintenance_reserve": r.get("maintenance_reserve"), "chargers": r.get("chargers"),
                    "unavailable_vehicle_hours": _r(r.get("unavailable_vehicle_hours")),
                    "cost_per_shuttle_ride": _r(r.get("cost_per_shuttle_ride"), 2),
                    "cost_per_internal_ride": _r(r.get("cost_per_internal_ride"), 2),
                    "cost_per_vehicle_day": _r(r.get("cost_per_vehicle_day")),
                    "cost_per_hour_saved_R2": _r(r.get("cost_per_hour_saved_R2"), 2),
                    "cost_per_hour_saved_R3": _r(r.get("cost_per_hour_saved_R3"), 2)})
    return costs, detail


def budgets(S: dict) -> dict:
    out = {}
    for m, rows in S.get("budgets", {}).items():
        out[m] = [{"budget": r["budget_sgd_per_day"],
                   **{c: (None if r.get(c) is None else {"id": r[c]["id"], "saved_h": _r(r[c]["saved_h"]),
                                                          "delta_cost": _r(r[c]["delta_cost"]),
                                                          "cost_per_hour_saved": _r(r[c]["cost_per_hour_saved"], 2)})
                      for c in CASES}} for r in rows]
    return out


def thresholds(S: dict) -> dict:
    out = {}
    for m, by_id in S.get("thresholds", {}).items():
        for i, t in by_id.items():
            e = {"saved_h": _r(t.get("saved_h")), "delta_cost_central": _r(t.get("delta_cost_central")),
                 "break_even_daily_cost": _r(t.get("break_even_daily_cost")),
                 "rides_per_vehicle_hour": [{k: x.get(k) for k in ("target", "target_cost_per_ride", "value", "current",
                                                                   "status")} for x in t.get("rides_per_vehicle_hour", [])],
                 "budget_max_cost_per_vehicle_day": [{k: x.get(k) for k in ("budget", "value", "current", "headroom")}
                                                     for x in t.get("budget_max_cost_per_vehicle_day", [])]}
            for k, v in t.items():
                if k.startswith("break_even_") and isinstance(v, dict):
                    e[k] = {kk: v.get(kk) for kk in ("value", "status", "met_for", "central", "bracket")}
            out.setdefault(m, {})[i] = e
    return out


def tornado_ids(S: dict, c_refs: list[str]) -> dict:
    """The one C reference option whose cost swings the tornado shows, per staff mode: the middle
    of the C references by coverage (the same option in both modes when it has swings in both)."""
    sw = S.get("sensitivity", {}).get("cost_swings", {})
    out = {}
    for m in [k for k in modes_of(S) if k in sw] + [k for k in sw if k not in modes_of(S)]:
        by_id = sw[m]
        order = c_refs[(len(c_refs) - 1) // 2:] + c_refs[:(len(c_refs) - 1) // 2][::-1]
        out[m] = next((i for i in order if by_id.get(i)), None)
    return out


def swings(S: dict, ids: dict) -> dict:
    """Tornado rows for each staff mode's chosen option: each parameter at its low-cost and
    high-cost value (the others central), as cost per passenger-hour saved, widest swing first.
    Parameters that do not act in that mode (no swing) are left out."""
    sw = S.get("sensitivity", {}).get("cost_swings", {})
    out = {}
    for m, i in ids.items():
        rows = sw.get(m, {}).get(i) or []
        by = {}
        for r in rows:
            p = by.setdefault(r["param_id"], {"param_id": r["param_id"], "label": PARAM_LABELS.get(r["param_id"],
                                                                                             r["param_id"].replace("_", " ")),
                                               "unit": r.get("unit"), "central_value": r.get("central_value"),
                                               "direction_ok": r.get("direction_ok", True)})
            p[r["side"]] = {"value": r.get("value"), "text": param_text(r.get("value"), r.get("unit")),
                            "cost_per_hour_saved": _r(r.get("cost_per_hour_saved"), 2), "daily_cost": _r(r.get("result"))}
            p["central_text"] = param_text(r.get("central_value"), r.get("unit"))
            p["central_cost_per_hour_saved"] = _r(r.get("central_cost_per_hour_saved"), 2)
            p["central_daily_cost"] = _r(r.get("central_result"))
            p["direction_ok"] = p["direction_ok"] and r.get("direction_ok", True)
        keep = [p for p in by.values() if "low" in p and "high" in p and
                p["low"]["cost_per_hour_saved"] is not None and p["high"]["cost_per_hour_saved"] is not None]
        for p in keep:
            p["range"] = _r(abs(p["high"]["cost_per_hour_saved"] - p["low"]["cost_per_hour_saved"]), 2)
        keep = [p for p in keep if p["range"] and p["range"] > 0]
        keep.sort(key=lambda p: -p["range"])
        out[m] = {"id": i, "rows": keep}
    return out


# ---------------------------------------------------------------------------- time
def periods(S: dict, ids: list[str]) -> dict:
    """Passenger-hours by time period for the reference options, from the summary's "who" sums:
    saved = passenger-hours(A) - passenger-hours(option), same rides and days."""
    out = {}
    for i in ids:
        rows = (S.get("who", {}).get(i) or {}).get("period") or []
        out[i] = [{"period": r["period"], "label": r.get("label"), "n": _r(r["n"]), "n_offered": _r(r.get("n_offered"), 1),
                   "n_shuttle": _r(r.get("n_shuttle"), 1), "n_declined": _r(r.get("n_declined"), 1),
                   "n_refused": _r(r.get("n_refused"), 1), "pax_h": _r(r["pax_h"]), "pax_h_A": _r(r["pax_h_A"]),
                   "saved_h": _r(r["pax_h_A"] - r["pax_h"]), "n_seeds": r.get("n_seeds")}
                  for r in rows if r.get("pax_h") is not None]
    return out


def stress_rows(S: dict) -> list[dict]:
    """Stress tests (passenger time against A in the same scenario; cost per hour saved at the
    planned fleet, central case, one key per staff mode)."""
    keep = ("id", "stress", "scenario", "availability", "berths", "saved_h", "saved_h_min", "saved_h_max", "saved_h_R2",
            "saved_h_R3", "declined",
            "refused", "offered", "mean_min", "mean_min_A", "p90_min", "p90_min_A", "kerb_max_Yishun", "n_seeds")
    return [{**{k: r.get(k) for k in keep},
             **{k: v for k, v in r.items() if k.startswith("cost_per_hour_saved_central_")}}
            for r in S.get("sensitivity", {}).get("stress", [])]


# ---------------------------------------------------------------------------- numbers in the text
def numbers(P: dict) -> dict[str, str]:
    """Every value the Phase 2 text quotes, formatted once (app.js and web/build.py fill the page's
    data-v spans from these). Costs at two significant figures, with their low-high range."""
    cfg = {c["id"]: c for c in P["configs"]}
    a = cfg.get("A")
    b = P["refs"]["B"]
    cs = P["refs"]["C"]
    B = cfg.get(b) if b else None
    C = [cfg[i] for i in cs]
    n: dict[str, str | None] = {}
    if a:
        n["p2_rides"] = fint(a["n"])
        n["p2_nobus"] = pct(a["n_no_bus"] / a["n_all"], 1) if a.get("n_all") else None
        n["p2_a_pax_h"] = fint(a["pax_h"])
        n["p2_a_wait_h"] = fint(a["wait_h"])
        n["p2_a_wait_share"] = pct(a["wait_h"] / a["pax_h"]) if a["pax_h"] else None
        n["p2_a_mean"] = f"{a['mean_min']:.1f} min"
    n["p2_n_configs"] = fint(sum(1 for c in P["configs"] if c["option"] != "A"))
    seeds = [c["n_seeds"] for c in P["configs"] if c["option"] != "A"]
    if seeds:
        n["p2_days_min"] = fint(min(seeds))
    refs = ([B] if B else []) + C
    if refs:
        n["p2_days"] = fint(min(c["n_seeds"] for c in refs))
    if B:
        n["p2_b_fleet"], n["p2_b_seats"] = fint(B["fleet"]), fint(B["capacity"])
        n["p2_b_saved"] = fint(B["saved_h"])
        n["p2_b_saved_share"] = pct(B["saved_h"] / B["pax_h_A"]) if B["pax_h_A"] else None
        n["p2_b_mean"] = f"{B['mean_min']:.1f} min"
    if C:
        th = [c["theta"] for c in C if c["theta"] is not None and c["theta"] > ALL_RIDES]
        if th:
            n["p2_c_theta_range"] = (f"{min(th):g}–{max(th):g} min" if min(th) != max(th) else f"{th[0]:g} min")
        n["p2_c_n"] = fint(len(C))
        n["p2_c_fleet_range"] = int_range(min(c["fleet"] for c in C), max(c["fleet"] for c in C))
        n["p2_c_saved_range"] = int_range(min(c["saved_h"] for c in C), max(c["saved_h"] for c in C))
        sh = [c["saved_h"] / c["pax_h_A"] for c in C if c["pax_h_A"]]
        n["p2_c_saved_share_range"] = pct_range(min(sh), max(sh)) if sh else None
        off = [c["n_offered"] / c["n"] for c in C if c["n"]]
        n["p2_c_offered_range"] = pct_range(min(off), max(off)) if off else None
        n["p2_c_seats"] = fint(C[0]["capacity"]) if len({c["capacity"] for c in C}) == 1 else None
    for m in P["modes"]:
        by_id = P["costs"].get(m, {})
        if B and b in by_id:
            e = by_id[b]
            n[f"p2_b_dcost_{m}"] = sgd(e["delta_cost"]["central"])
            n[f"p2_b_dcost_range_{m}"] = sgd_range(e["delta_cost"]["low"], e["delta_cost"]["high"])
            n[f"p2_b_cphs_{m}"] = sgd(e["cost_per_hour_saved"]["central"])
            n[f"p2_b_cphs_range_{m}"] = sgd_range(e["cost_per_hour_saved"]["low"], e["cost_per_hour_saved"]["high"])
            w = e.get("withdrawn")
            if w:
                n[f"p2_bw_dcost_{m}"] = sgd(w["delta_cost"]["central"])
                n[f"p2_bw_dcost_range_{m}"] = sgd_range(w["delta_cost"]["low"], w["delta_cost"]["high"])
                n[f"p2_bw_cphs_{m}"] = sgd(w["cost_per_hour_saved"]["central"])
            wf = e.get("withdrawn_fee")
            if wf:
                n[f"p2_bwf_cphs_{m}"] = sgd(wf["cost_per_hour_saved"]["central"])
        cc = [by_id[i] for i in cs if i in by_id]
        if cc:
            dc = [e["delta_cost"]["central"] for e in cc]
            n[f"p2_c_dcost_range_{m}"] = sgd_range(min(dc), max(dc))
            ph = [e["cost_per_hour_saved"]["central"] for e in cc if e["cost_per_hour_saved"]["central"] is not None]
            if ph:
                n[f"p2_c_cphs_range_{m}"] = sgd_range(min(ph), max(ph))
        # how the configurations fall into the four classes (central case, all buses kept)
        cls = [e["classification"].get("central") for i, e in by_id.items()]
        for k, name in enumerate(CLASSES):
            n[f"p2_class{k}_{m}"] = fint(sum(1 for x in cls if x == name))
        fr = P["frontier"].get(m, {}).get("central") or []
        n[f"p2_frontier_n_{m}"] = fint(len(fr))
    # the same figures across staff modes, for text that does not name a mode: lowest to highest
    # central value, each end labelled with its mode
    def span(key: str, get):
        vals = [(get(m), m) for m in P["modes"]]
        vals = [(v, m) for v, m in vals if v is not None]
        if not vals:
            return
        (lo, mlo), (hi, mhi) = min(vals), max(vals)
        short = lambda m: P["staff_modes"].get(m, {}).get("short", m)
        n[key] = (sgd(lo) if len(vals) == 1 or sgd(lo) == sgd(hi) else
                  f"{sgd(lo)} ({short(mlo)}) to {sgd(hi)} ({short(mhi)})")
    cost = lambda m, i, what="delta_cost": ((P["costs"].get(m, {}).get(i) or {}).get(what) or {}).get("central")
    if b:
        span("p2_b_dcost_span", lambda m: cost(m, b))
        span("p2_b_cphs_span", lambda m: cost(m, b, "cost_per_hour_saved"))
    if cs:
        lo = [min((cost(m, i) for i in cs if cost(m, i) is not None), default=None) for m in P["modes"]]
        hi = [max((cost(m, i) for i in cs if cost(m, i) is not None), default=None) for m in P["modes"]]
        lo, hi = [v for v in lo if v is not None], [v for v in hi if v is not None]
        if lo and hi:
            n["p2_c_dcost_span"] = sgd_range(min(lo), max(hi))
        ph = [cost(m, i, "cost_per_hour_saved") for m in P["modes"] for i in cs]
        ph = [v for v in ph if v is not None]
        if ph:
            n["p2_c_cphs_span"] = sgd_range(min(ph), max(ph))
    n["p2_n_modes"] = fint(len(P["modes"]))
    bus = P["bus"]
    if bus:
        c = bus["cost"]
        n["p2_bus_cost"] = sgd(c["central"]["all"])
        n["p2_bus_cost_range"] = sgd_range(c["low"]["all"], c["high"]["all"])
        n["p2_bus_internal_share"] = pct(bus["internal_share"], 1)
        n["p2_bus_avoidable"] = sgd(c["central"]["avoidable_internal_only"])
        n["p2_bus_avoidable_range"] = sgd_range(c["low"]["avoidable_internal_only"], c["high"]["avoidable_internal_only"])
        n["p2_bus_n_internal_only"] = fint(bus.get("n_internal_only"))
        if a and a["n"]:
            n["p2_bus_cost_ride"] = sgd(c["central"]["allocated_internal"] / a["n"])
            n["p2_bus_cost_ride_range"] = sgd_range(c["low"]["allocated_internal"] / a["n"],
                                                    c["high"]["allocated_internal"] / a["n"])
    # the option the sensitivity chart shows, and its thresholds (one per staff mode)
    for m in P["modes"]:
        t = P["tornado"].get(m) or {"id": None, "rows": []}
        i = t["id"]
        if not i or i not in cfg:
            continue
        n[f"p2_focus_{m}"] = cfg[i]["phrase"]
        n[f"p2_focus_saved_{m}"] = fint(cfg[i]["saved_h"])
        e = P["costs"].get(m, {}).get(i)
        if e:
            n[f"p2_focus_dcost_{m}"] = sgd(e["delta_cost"]["central"])
            n[f"p2_focus_cphs_{m}"] = sgd(e["cost_per_hour_saved"]["central"])
            n[f"p2_focus_cphs_range_{m}"] = sgd_range(e["cost_per_hour_saved"]["low"], e["cost_per_hour_saved"]["high"])
        rows = t["rows"]
        if rows:
            n[f"p2_tornado_top_{m}"] = rows[0]["label"].lower() if rows[0]["label"][1:2].islower() else rows[0]["label"]
            n[f"p2_tornado_n_{m}"] = fint(len(rows))
        th = P["thresholds"].get(m, {}).get(i, {})
        if th.get("break_even_daily_cost") is not None:
            n[f"p2_focus_breakeven_{m}"] = sgd(th["break_even_daily_cost"])
        for k, v in th.items():
            if k.startswith("break_even_") and isinstance(v, dict):
                n[f"p2_focus_{k.replace('break_even_', 'be_')}_{m}"] = _be_text(k.replace("break_even_", ""), v)
        for x in th.get("rides_per_vehicle_hour", []):
            key = "fare" if "fare" in (x.get("target") or "").lower() else "bus" if "bus" in (x.get("target") or "").lower() else None
            if key:
                n[f"p2_focus_rph_{key}_{m}"] = (f"{x['value']:.1f}" if x.get("value") is not None else
                                                "not reached in the range searched")
                n[f"p2_focus_rph_now_{m}"] = f"{x['current']:.1f}" if x.get("current") is not None else None
                n[f"p2_focus_rph_{key}_target_{m}"] = sgd(x.get("target_cost_per_ride"))
    soc = P.get("social", {})
    vots = {v["central"]["vot"] for v in soc.values() if v and v.get("central") and v["central"].get("vot") is not None}
    if len(vots) == 1:
        n["p2_vot"] = sgd(vots.pop())
    ws = {v["central"]["wait_weight"] for v in soc.values() if v and v.get("central") and v["central"].get("wait_weight")}
    if len(ws) == 1:
        n["p2_wait_weight"] = f"{ws.pop():g}"
    # the social estimate in plain words: what the riders' time saved is worth per SGD 1 of added cost
    # (central value of time), for full replacement and across the C reference designs, per staffing case
    def per1(r):
        return None if r is None else f"SGD {r:.2f}"
    for m in P["modes"]:
        bcr = lambda i: (((soc.get(i) or {}).get("central") or {}).get(f"benefit_cost_ratio_{m}"))
        if b:
            n[f"p2_b_per1_{m}"] = per1(bcr(b))
        rs = [bcr(i) for i in cs if bcr(i) is not None]
        if rs:
            lo, hi = f"{min(rs):.2f}", f"{max(rs):.2f}"
            n[f"p2_c_per1_range_{m}"] = f"SGD {lo}" if lo == hi else f"SGD {lo}–{hi}"
    be = P.get("bus_error", [])
    tid = next((P["tornado"][m]["id"] for m in P["modes"] if (P["tornado"].get(m) or {}).get("id")), None)
    row = next((r for r in be if r["id"] == tid), None)
    if row:
        n["p2_focus"] = cfg[tid]["phrase"]
        n["p2_focus_saved"] = fint(cfg[tid]["saved_h"])
        n["p2_focus_buserr20"] = fint(row.get("saved_h_e20"))
    n["p2_stress_n"] = fint(len(P.get("stress_labels", [])))
    return {k: v for k, v in n.items() if v is not None}


def _be_text(pid: str, v: dict) -> str | None:
    """A break-even parameter value as the text quotes it, with the central value for comparison."""
    unit_money = pid.endswith("_sgd_per_hour") or pid == "veh_price"
    fmt = (lambda x: sgd(x)) if unit_money else (lambda x: _num(x, 2))
    st = v.get("status") or ""
    if v.get("value") is not None and st == "solved":
        side = {"<= value": "at most ", ">= value": "at least "}.get(v.get("met_for") or "", "")
        out = f"{side}{fmt(v['value'])}"
        if v.get("central") is not None:
            out += f" (central {fmt(v['central'])})"
        return out
    br = v.get("bracket")
    if st == "not met in bracket" and br:
        return f"not reached between {fmt(br[0])} and {fmt(br[1])}"
    if st == "met throughout bracket" and br:
        return f"met at any value between {fmt(br[0])} and {fmt(br[1])}"
    return st or None


# ---------------------------------------------------------------------------- export
def build(S: dict) -> dict:
    prov = S.get("provenance", {})
    cp = str(prov.get("cost_parameters", ""))
    cfgs = config_rows(S)
    cfg = {c["id"]: c for c in cfgs}
    b, cs = references(S, cfg)
    ref_ids = ([b] if b else []) + cs
    costs, detail = cost_tables(S, set(ref_ids))
    tids = tornado_ids(S, cs)
    bus = S.get("bus") or {}
    modes = modes_of(S)
    labels = S.get("staff_modes") or {}
    in_order = lambda d: {m: d[m] for m in modes if m in d} | {m: v for m, v in d.items() if m not in modes}
    P = {
        "synthetic": "SYNTHETIC" in cp,
        "provenance": {"model_key": prov.get("model_key"), "git": prov.get("git"),
                       "pipeline_modified": prov.get("pipeline_modified"), "cost_parameters": cp,
                       "seeds": prov.get("seeds"), "grids": prov.get("grids"), "grid_runs": prov.get("grid_runs"),
                       "cost_parameters_sha256": prov.get("cost_parameters_sha256"), "demand_months": prov.get("demand_months"),
                       "graph_nodes": (prov.get("inputs") or {}).get("graph_nodes"),
                       "graph_edges": (prov.get("inputs") or {}).get("graph_edges")},
        "units": S.get("units"),
        "modes": modes,
        "staff_modes": {m: {"label": labels.get(m, m), "short": MODE_SHORT.get(m, labels.get(m, m))} for m in modes},
        "cases": list(CASES), "classes": CLASSES, "categories": CATEGORIES,
        "period_labels": S.get("period_labels", {}), "period_names": PERIOD_NAMES,
        "stress_labels": S.get("stress_labels", []),
        "refs": {"B": b, "C": cs},
        "configs": cfgs,
        "costs": in_order(costs), "cost_detail": in_order(detail),
        "frontier": in_order(S.get("frontier", {})),
        "budgets": in_order(budgets(S)),
        "thresholds": in_order(thresholds(S)),
        "tornado": swings(S, tids),
        "periods": periods(S, ref_ids),
        "stress": stress_rows(S),
        "bus_error": [{k: r.get(k) for k in ("id", "saved_h", "shuttle_rides_bus_hours", "saved_h_e10", "saved_h_e20",
                                              "saved_h_e30")} for r in S.get("sensitivity", {}).get("bus_error", [])],
        "social": {i: (None if v is None else {"wait_h_saved": v.get("wait_h_saved"), "ivt_h_saved": v.get("ivt_h_saved"),
                                               **{c: v.get(c) for c in CASES}})
                   for i, v in (S.get("social") or {}).items()},
        "bus": ({"internal_share": bus.get("internal_share"), "internal_share_key": bus.get("internal_share_key"),
                 "supply": bus.get("supply"),
                 "n_internal_only": len((bus.get("allocation") or {}).get("internal_only_services") or []),
                 "cost": {c: {k: _r((bus.get("cost") or {}).get(c, {}).get(k)) for k in
                              ("all", "allocated_internal", "allocated_internal_by_rides", "avoidable_internal_only")}
                          for c in CASES},
                 "basis": ((bus.get("cost") or {}).get("central") or {}).get("basis"),
                 "inclusions": ((bus.get("cost") or {}).get("central") or {}).get("inclusions")} if bus else None),
    }
    P["numbers"] = numbers(P)
    return P


def main(argv: list[str] | None = None) -> dict:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--summary", type=Path, default=SUMMARY, help=f"summary.json to read (default {SUMMARY})")
    ap.add_argument("--out", type=Path, default=OUT, help=f"page data to write (default {OUT})")
    a = ap.parse_args(argv)
    S = json.loads(Path(a.summary).read_text())
    P = build(S)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(P, separators=(",", ":"), ensure_ascii=False, allow_nan=False))
    print(f"wrote {a.out} ({a.out.stat().st_size / 1e3:.0f} kB): {len(P['configs'])} configurations, "
          f"{len(P['numbers'])} numbers, synthetic={P['synthetic']}")
    if P["synthetic"]:
        print("  cost parameters are a SYNTHETIC fixture: the page shows a development-data banner")
    return P


if __name__ == "__main__":
    main()
