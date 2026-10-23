"""Daily operating cost of the shuttle options and of the bus service (Phase 2, definitions §5-8).

Money is SGD at 2026 prices, excluding GST. A daily cost is the cost of one average weekday of
service: annual costs are spread equally over the file's `days_per_year` operating days (365) and
capital is annualised with the capital recovery factor. A vehicle is either purchased (annuity)
or leased (lease charge), never both; a lease that bundles some categories switches them off.

Parameters come from data/parameters/cost_cases.json (schema §8). Every parameter has low_cost,
central and high_cost values, "low_cost" being the value that lowers cost. The low, central and
high cases take that column for every parameter; swings and thresholds override one parameter at
a time. The fleet terms (charging and maintenance reserves, chargers) are an availability
estimate from daily energy, usable battery and charger power, not a charging simulation.

Options are compared on passenger-hours (sums over the same rides), never on averages of
subgroup means. Thresholds are found by monotone bisection over this forward model.
"""
from __future__ import annotations

import copy
import json
import math
import numbers
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import pandas as pd

from .paths import ROOT

if TYPE_CHECKING:
    from .sim import SimConfig, SimResult

CASES_FILE = ROOT / "data" / "parameters" / "cost_cases.json"

# Conventions of definitions §5, checked against the file's header. days_per_year is read from the
# file; the §5 value (365: the service runs every day) is the default only when the file omits it.
CURRENCY, PRICE_YEAR, GST = "SGD", 2026, "excluded"
DEFAULT_DAYS_PER_YEAR = 365
HOURS_PER_DAY = 24

CASES = {"low": "low_cost", "central": "central", "high": "high_cost"}   # case -> column of the file
CAPACITY_KEYS = ("4", "10", "20")
BASES = ("measured", "supplier", "contract", "statistic", "assumption", "derived")

# Parameter ids of §8. Every shuttle id is required and the bus needs at least one rate. The social
# values are kept apart from cost: checked when present, not used here.
PARAMETER_IDS = {
    "vehicle": ("veh_price", "veh_life_years", "veh_residual_share", "lease_sgd_per_vehicle_year",
                "discount_rate_real"),
    "energy": ("energy_kwh_per_km", "battery_usable_kwh", "charging_efficiency", "electricity_sgd_per_kwh",
               "charger_power_kw"),
    "maintenance": ("maint_sgd_per_km", "maint_fixed_sgd_per_vehicle_year"),
    "cleaning": ("cleaning_sgd_per_vehicle_day",),
    "insurance_permits": ("insurance_sgd_per_vehicle_year", "permit_fixed_sgd_per_year"),
    "software_comms": ("software_sgd_per_vehicle_month", "comms_sgd_per_vehicle_month",
                       "control_centre_fixed_sgd_per_year"),
    "staff": ("vehicles_per_remote_operator", "min_remote_operators", "remote_operator_sgd_per_hour",
              "vehicles_per_field_staff", "field_staff_sgd_per_hour", "onboard_staff_sgd_per_hour"),
    "charging_depot": ("charger_sgd_each", "charger_life_years", "vehicles_per_charger",
                       "depot_sgd_per_vehicle_year", "depot_fixed_sgd_per_year"),
    "reserve": ("maintenance_spare_ratio",),
}
SHUTTLE_IDS = tuple(k for ids in PARAMETER_IDS.values() for k in ids)
BUS_IDS = ("bus_sgd_per_bus_km", "bus_sgd_per_bus_hour")
SOCIAL_IDS = ("vot_ivt_sgd_per_hour", "wait_time_weight")
# optional: control-room monitoring ratio while a safety operator rides every vehicle (the current
# pilot arrangement); without it the remote-operation ratio is used in both staff modes
OPTIONAL_IDS = ("vehicles_per_monitor_onboard_mode", "attendant_sgd_per_hour")
KNOWN_IDS = SHUTTLE_IDS + BUS_IDS + SOCIAL_IDS + OPTIONAL_IDS
POSITIVE_IDS = {"veh_life_years", "charger_life_years", "charging_efficiency", "battery_usable_kwh",
                "charger_power_kw", "vehicles_per_remote_operator", "vehicles_per_field_staff",
                "vehicles_per_charger", "vehicles_per_monitor_onboard_mode"}                         # divisors
FRACTION_IDS = {"veh_residual_share", "charging_efficiency"}   # at most 1

CATEGORIES = ("vehicles", "energy", "maintenance", "cleaning", "insurance_permits", "software_comms", "staff",
              "charging_depot")
CLASSES = ("fixed", "distance", "staff")
# staff modes: "onboard" = a safety operator on every vehicle in service (the current pilot rule);
# "remote_with_attendant" = remote supervision plus an onboard attendant (LTA's stated next phase for
# its autonomous buses); "remote" = remote supervision only
SWITCHES = {"acquisition": ("purchase", "lease"), "staff_mode": ("remote", "onboard", "remote_with_attendant")}
# What a vehicle lease may bundle. A contract that also covers energy or staff is a service
# contract, which is never treated as a vehicle price (§5).
LEASABLE = ("maintenance", "cleaning", "insurance_permits", "software_comms", "charging_depot")
BUS_BASES = {"km": ("bus_sgd_per_bus_km",), "hour": ("bus_sgd_per_bus_hour",),
             "km+hour": ("bus_sgd_per_bus_km", "bus_sgd_per_bus_hour")}
CLASSIFICATIONS = ("reduces cost and time", "increases cost, reduces time", "reduces cost, increases time",
                   "increases cost and time")


# ------------------------------------------------------------------ parameter file

class SchemaError(ValueError):
    """A parameter file that does not follow definitions §8."""


def _is_number(x) -> bool:
    return isinstance(x, numbers.Real) and not isinstance(x, bool) and math.isfinite(x)


def _domain_errors(pid: str, x: float) -> list[str]:
    if x < 0:
        return [f"{x} is negative"]
    if pid in POSITIVE_IDS and x == 0:
        return ["must be positive"]
    if pid in FRACTION_IDS and x > 1:
        return [f"{x} is a fraction above 1"]
    return []


def _value_errors(pid: str, cols) -> list[str]:
    if not isinstance(cols, dict):
        return ["needs low_cost, central and high_cost"]
    err = []
    for col in CASES.values():
        x = cols.get(col)
        if not _is_number(x):
            err.append(f"{col} must be a number, not {x!r}")
        else:
            err += [f"{col}: {m}" for m in _domain_errors(pid, x)]
    return err


def _entry_errors(pid: str, e, register: set[str] | None) -> list[str]:
    if not isinstance(e, dict):
        return ["entry must be an object"]
    err = []
    if not isinstance(e.get("unit"), str) or not e["unit"].strip():
        err.append("unit missing")
    bc = e.get("by_capacity")
    if bc is None:
        err += _value_errors(pid, e)
    elif not isinstance(bc, dict) or set(bc) != set(CAPACITY_KEYS):
        got = list(bc) if isinstance(bc, dict) else bc
        err.append(f"by_capacity needs exactly the keys {list(CAPACITY_KEYS)}, not {got!r}")
    else:
        for c in CAPACITY_KEYS:
            err += [f"by_capacity[{c}] {m}" for m in _value_errors(pid, bc[c])]
        # top-level values are not used next to by_capacity; if filled in they must still be numbers
        err += [f"{k} must be a number, not {e[k]!r}" for k in CASES.values()
                if e.get(k) is not None and not _is_number(e[k])]
    src = e.get("sources")
    if not isinstance(src, list) or not src or not all(isinstance(s, str) and s.strip() for s in src):
        err.append("sources must list at least one source id")
    elif register is not None and set(src) - register:
        err.append(f"sources not in the register: {sorted(set(src) - register)}")
    if "basis" in e and e["basis"] not in BASES:
        err.append(f"basis must be one of {'/'.join(BASES)}, not {e['basis']!r}")
    return err


def _switch_errors(sw) -> list[str]:
    if not isinstance(sw, dict):
        return ["switches must be an object with acquisition, staff_mode and lease_includes"]
    err = [f"switches.{k} must be one of {list(v)}, not {sw.get(k)!r}" for k, v in SWITCHES.items()
           if sw.get(k) not in v]
    inc = sw.get("lease_includes", [])
    if not isinstance(inc, list) or any(c not in LEASABLE for c in inc):
        err.append(f"switches.lease_includes may list only {list(LEASABLE)}, not {inc!r}")
    return err


def validate_cases(d, register_ids: Iterable[str] | None = None) -> list[str]:
    """Every way `d` (a parsed cost_cases.json) departs from the schema of definitions §8; empty when
    valid. register_ids: the source ids of cost_register.csv, to check that every source resolves."""
    if not isinstance(d, dict):
        return ["the file must hold one JSON object"]
    err = [f"{k} must be {want!r} (definitions §5), not {d.get(k)!r}"
           for k, want in (("currency", CURRENCY), ("price_year", PRICE_YEAR), ("gst", GST)) if d.get(k) != want]
    days = d.get("days_per_year", DEFAULT_DAYS_PER_YEAR)
    if not _is_number(days) or days <= 0:
        err.append(f"days_per_year must be a positive number, not {days!r}")
    params = d.get("parameters")
    if not isinstance(params, dict):
        return err + ["parameters must map parameter ids to entries"] + _switch_errors(d.get("switches"))
    err += [f"missing parameter {k!r}" for k in SHUTTLE_IDS if k not in params]
    if not any(k in params for k in BUS_IDS):
        err.append(f"missing bus cost: {BUS_IDS[0]!r} and/or {BUS_IDS[1]!r}")
    register = set(register_ids) if register_ids is not None else None
    for pid, e in params.items():
        err += [f"{pid}: {m}" for m in _entry_errors(pid, e, register)]
    return err + _switch_errors(d.get("switches"))


@dataclass(frozen=True)
class CostParams:
    """A validated parameter file (see load_cases) and any one-parameter overrides."""
    parameters: dict                    # id -> entry as in the file (read-only)
    switches: dict                      # acquisition, staff_mode, lease_includes
    days_per_year: float = DEFAULT_DAYS_PER_YEAR
    overrides: dict = field(default_factory=dict)   # id -> value used in every case and capacity
    source: str = ""                    # where the parameters were read from

    @classmethod
    def from_dict(cls, d: dict, source: str = "", register_ids: Iterable[str] | None = None) -> CostParams:
        err = validate_cases(d, register_ids)
        if err:
            raise SchemaError(f"{source or 'cost parameters'} does not follow definitions §8:\n- " + "\n- ".join(err))
        return cls(copy.deepcopy(d["parameters"]), {"lease_includes": [], **copy.deepcopy(d["switches"])},
                   float(d.get("days_per_year", DEFAULT_DAYS_PER_YEAR)), source=source)

    def has(self, param_id: str) -> bool:
        return param_id in self.parameters or param_id in self.overrides

    def entry(self, param_id: str) -> dict:
        """The file's entry for a parameter: unit, values, basis, sources, note."""
        return self.parameters[param_id]

    def unit(self, param_id: str) -> str:
        return self.parameters[param_id]["unit"] if param_id in self.parameters else ""

    def value(self, param_id: str, case: str = "central", capacity: int | str | None = None) -> float:
        """Value in a case: "low" | "central" | "high" take the file's low_cost | central | high_cost.
        A parameter with by_capacity values needs the vehicle capacity (4, 10 or 20). An override
        replaces the value in every case."""
        if case not in CASES:
            raise ValueError(f"case must be one of {list(CASES)}, not {case!r}")
        if param_id in self.overrides:
            return self.overrides[param_id]
        if param_id not in self.parameters:
            raise KeyError(f"no parameter {param_id!r} in {self.source or 'the cost parameters'}")
        e = self.parameters[param_id]
        if e.get("by_capacity") is None:
            return float(e[CASES[case]])
        if capacity is None:
            raise ValueError(f"{param_id} depends on vehicle capacity: pass capacity")
        key = str(int(capacity))
        if key not in e["by_capacity"]:
            raise KeyError(f"{param_id} has no value for capacity {key} (only {list(e['by_capacity'])})")
        return float(e["by_capacity"][key][CASES[case]])

    def with_override(self, param_id: str, value: float) -> CostParams:
        """A copy in which `param_id` takes `value` in every case (swings, threshold searches)."""
        if param_id not in self.parameters and param_id not in KNOWN_IDS:
            raise KeyError(f"unknown parameter {param_id!r}")
        if not _is_number(value):
            raise ValueError(f"{param_id}: an override must be a number, not {value!r}")
        bad = _domain_errors(param_id, value)
        if bad:
            raise ValueError(f"{param_id} = {value}: {bad[0]}")
        return replace(self, overrides={**self.overrides, param_id: float(value)})

    def with_switches(self, **switches) -> CostParams:
        """A copy with other switches, e.g. the onboard-staff pilot case or a lease."""
        unknown = set(switches) - set(SWITCHES) - {"lease_includes"}
        sw = {**self.switches, **switches}
        err = [f"unknown switch {k!r}" for k in sorted(unknown)] + _switch_errors(sw)
        if err:
            raise SchemaError("; ".join(err))
        return replace(self, switches=sw)


def load_cases(path: Path | str = CASES_FILE, register_ids: Iterable[str] | None = None) -> CostParams:
    """Read and validate the cost parameter file (definitions §8); a SchemaError lists every problem.
    register_ids (the ids of data/parameters/cost_register.csv), when given, must hold every source."""
    path = Path(path)
    return CostParams.from_dict(json.loads(path.read_text()), source=str(path), register_ids=register_ids)


# ------------------------------------------------------------------ annualisation

def crf(r: float, n: float) -> float:
    """Capital recovery factor r(1+r)^n / ((1+r)^n - 1) for a real rate r over n years; 1/n at r = 0."""
    if n <= 0 or r <= -1:
        raise ValueError(f"crf needs n > 0 and r > -1, not n={n}, r={r}")
    if r == 0:
        return 1.0 / n
    return r / -math.expm1(-n * math.log1p(r))       # the same formula, accurate as r -> 0


def equivalent_annual_cost(price: float, life_years: float, residual_share: float, r: float) -> float:
    """CRF(r, n) x (price - residual / (1+r)^n), with residual = residual_share x price (§5)."""
    return crf(r, life_years) * price * (1.0 - residual_share / (1.0 + r) ** life_years)


def annual_to_daily(annual: float, days_per_year: float) -> float:
    """An annual cost spread equally over the operating days."""
    return annual / days_per_year


def monthly_to_daily(monthly: float, days_per_year: float) -> float:
    """A monthly cost per operating day: monthly x 12 / days_per_year."""
    return monthly * 12.0 / days_per_year


def _ceil(x):
    """Ceiling that ignores floating-point noise (0.07 x 100 = 7.000000000000001 -> 7); a scalar gives an int."""
    a = np.asarray(x, float)
    c = np.ceil(a - 1e-9 * np.maximum(1.0, np.abs(a)))
    return int(c) if c.ndim == 0 else c


def _values(p: CostParams, case: str, capacity) -> Callable[[str], float]:
    return lambda k: p.value(k, case, capacity)


# ------------------------------------------------------------------ operations

@dataclass
class ShuttleOps:
    """One simulated service day of a shuttle fleet: the inputs of the cost model (definitions §7).
    pax_km is the direct stop-to-stop road distance of the completed rides (§4), the same in every
    option; SimResult.pax_km is on-board passenger-km, which includes detours."""
    capacity: int                  # seats per vehicle
    fleet_in_service: int          # the simulated fixed fleet, available for dispatch all day
    service_hours: float           # H
    veh_km: float                  # vehicle-km, loaded + empty
    veh_km_empty: float            # of which empty
    rides: float                   # completed (shuttle-served) rides
    pax_km: float                  # passenger-km of those rides (direct distance)
    in_service_by_hour: np.ndarray | None = None   # vehicles in service in each service hour (default:
                                                   # the whole fleet in every hour)

    def __post_init__(self):
        if self.fleet_in_service <= 0 or int(self.fleet_in_service) != self.fleet_in_service:
            raise ValueError(f"fleet_in_service must be a positive whole number, not {self.fleet_in_service}")
        if not 0 < self.service_hours <= HOURS_PER_DAY:
            raise ValueError(f"service_hours must be in (0, {HOURS_PER_DAY}], not {self.service_hours}")
        if min(self.veh_km, self.veh_km_empty, self.rides, self.pax_km) < 0:
            raise ValueError("vehicle-km, rides and passenger-km cannot be negative")
        if self.veh_km_empty > self.veh_km * (1 + 1e-12):
            raise ValueError("veh_km is loaded + empty, so it cannot be below veh_km_empty")
        self.capacity, self.fleet_in_service = int(self.capacity), int(self.fleet_in_service)
        self.service_hours, self.veh_km, self.veh_km_empty = (float(self.service_hours), float(self.veh_km),
                                                              float(self.veh_km_empty))
        self.rides, self.pax_km = float(self.rides), float(self.pax_km)
        if self.in_service_by_hour is not None:
            n = np.asarray(self.in_service_by_hour, float)
            if n.ndim != 1 or abs(len(n) - self.service_hours) > 1e-9:
                raise ValueError(f"in_service_by_hour needs one value per service hour ({self.service_hours:g}), "
                                 f"not {n.size}")
            if (n < 0).any() or n.max() > self.fleet_in_service:
                raise ValueError("in_service_by_hour must lie between 0 and fleet_in_service: no hour can have more "
                                 "vehicles in service than the fleet")
            self.in_service_by_hour = n

    def hourly(self) -> tuple[np.ndarray, np.ndarray]:
        """Vehicles in service in each service hour and each hour's length (h, summing to H). Without a
        profile the whole fleet is in service for H hours; a fractional H ends with a part-hour."""
        if self.in_service_by_hour is not None:
            return self.in_service_by_hour, np.ones(len(self.in_service_by_hour))
        k = math.ceil(self.service_hours - 1e-9)
        w = np.ones(k)
        w[-1] = self.service_hours - (k - 1)
        return np.full(k, float(self.fleet_in_service)), w

    @property
    def vehicle_hours(self) -> float:
        """Vehicle-hours in service."""
        n, w = self.hourly()
        return float(n @ w)

    def scaled(self, factor: float, km: bool = True) -> ShuttleOps:
        """The same fleet with `factor` times the rides and passenger-km; vehicle-km scale too when `km`
        (vehicle-km per ride held constant), else they stay as simulated."""
        k = factor if km else 1.0
        return replace(self, rides=self.rides * factor, pax_km=self.pax_km * factor, veh_km=self.veh_km * k,
                       veh_km_empty=self.veh_km_empty * k)

    @classmethod
    def from_sim(cls, res: SimResult, cfg: SimConfig, service_hours: float, pax_km: float,
                 in_service_by_hour=None) -> ShuttleOps:
        """From a simulated day (sim.Simulator.run). pax_km: direct distance of the served rides (§4)."""
        served = int((~res.requests.refused.astype(bool)).sum())
        return cls(cfg.capacity, cfg.fleet, service_hours, res.veh_km_loaded + res.veh_km_empty, res.veh_km_empty,
                   served, pax_km, in_service_by_hour)

    @classmethod
    def from_run(cls, row, service_hours: float, pax_km: float, in_service_by_hour=None) -> ShuttleOps:
        """From one run summary (experiments.run_one: fleet, capacity, n, refused_share, veh_km,
        empty_share). pax_km: direct distance of the served rides (§4), not the summary's on-board pax_km."""
        return cls(int(row["capacity"]), int(row["fleet"]), service_hours, float(row["veh_km"]),
                   float(row["veh_km"]) * float(row["empty_share"]), round(row["n"] * (1.0 - row["refused_share"])),
                   pax_km, in_service_by_hour)


@dataclass
class BusOps:
    """Bus supply on one weekday: the in-area network (§6) or the services withdrawn in B(ii)."""
    bus_km: float
    bus_hours: float
    label: str = ""


# ------------------------------------------------------------------ shuttle cost

def fleet_estimate(ops: ShuttleOps, p: CostParams, case: str = "central", charging_offpeak: bool | None = None) -> dict:
    """Total fleet and chargers behind a simulated in-service fleet: an availability estimate, not a
    charging simulation (definitions §7).

    Each in-service vehicle uses E = vehicle-km x e / in service (kWh at the battery) a day. Overnight,
    in the 24 - H hours without service, a vehicle can take back at most
    O = min(B, P x (24 - H) / vehicles_per_charger): its usable battery B, or what its share of a
    charger delivers in that window. The rest, E - O, is charged by day, (E - O)/P hours per vehicle
    at charger power P; spread over the H service hours, ceil(in service x (E - O)/(P x H)) extra
    vehicles keep the in-service fleet on the road (charging reserve). `charging_offpeak` absorbs that
    charging in off-peak idle time instead (reserve 0); by default only the low-cost case does.
    Maintenance reserve = ceil(spare ratio x in service). Chargers: enough for the total fleet at
    vehicles_per_charger, and at least enough to deliver the day's energy in 24 h."""
    v = _values(p, case, ops.capacity)
    N, H = ops.fleet_in_service, ops.service_hours
    e, B, P = v("energy_kwh_per_km"), v("battery_usable_kwh"), v("charger_power_kw")
    if charging_offpeak is None:
        charging_offpeak = case == "low"
    daily_kwh = ops.veh_km * e
    E = daily_kwh / N
    window = HOURS_PER_DAY - H
    overnight_cap = min(B, P * window / v("vehicles_per_charger"))
    excess = max(E - overnight_cap, 0.0)
    charging_unrounded = 0.0 if charging_offpeak else N * excess / (P * H)
    maintenance_unrounded = v("maintenance_spare_ratio") * N
    charging, maintenance = _ceil(charging_unrounded), _ceil(maintenance_unrounded)
    total = N + charging + maintenance
    by_ratio = _ceil(total / v("vehicles_per_charger"))
    by_energy = _ceil(daily_kwh / (P * HOURS_PER_DAY))
    chargers = max(by_ratio, by_energy)
    overnight_kwh = N * min(E, overnight_cap)        # restored after service; the rest was charged by day
    overnight_charger_kwh = chargers * P * window
    return {
        "estimate": "availability estimate, not a charging simulation (definitions §7)",
        "case": case, "charging_offpeak": bool(charging_offpeak),
        "in_service": N, "charging_reserve": charging, "maintenance_reserve": maintenance, "total": total,
        "unavailable": total - N, "service_hours": H, "unavailable_vehicle_hours": (total - N) * H,
        "energy_kwh_per_km": e, "daily_energy_kwh": daily_kwh, "energy_per_vehicle_kwh": E,
        "battery_usable_kwh": B, "overnight_window_h": window, "overnight_cap_kwh_per_vehicle": overnight_cap,
        "excess_kwh_per_vehicle": excess, "charger_power_kw": P,
        "daytime_charge_hours_per_vehicle": excess / P,
        "charging_reserve_unrounded": charging_unrounded, "maintenance_reserve_unrounded": maintenance_unrounded,
        "chargers": chargers, "chargers_by_ratio": by_ratio, "chargers_by_energy": by_energy,
        "overnight_kwh": overnight_kwh, "overnight_charger_kwh": overnight_charger_kwh,
        "overnight_fits": overnight_kwh <= overnight_charger_kwh,
    }


def staff_cost(ops: ShuttleOps, p: CostParams, case: str = "central") -> dict:
    """Staff-hours and cost per day (definitions §7). In each service hour: remote operators =
    max(min_remote_operators, ceil(in service / vehicles_per_remote_operator)), field staff =
    ceil(in service / vehicles_per_field_staff), and staff_mode "onboard" adds one person on every
    vehicle in service. With a safety operator on board, the control room monitors at
    vehicles_per_monitor_onboard_mode when the file has it. "remote_with_attendant" keeps the
    remote-operation ratio and adds one attendant per vehicle at attendant_sgd_per_hour (required in
    that mode). Cost = hours x fully loaded hourly cost."""
    v = _values(p, case, ops.capacity)
    n, w = ops.hourly()
    mode = p.switches["staff_mode"]
    ratio = ("vehicles_per_monitor_onboard_mode" if mode == "onboard" and p.has("vehicles_per_monitor_onboard_mode")
             else "vehicles_per_remote_operator")
    persons = {
        "remote_operator": np.maximum(v("min_remote_operators"), _ceil(n / v(ratio))),
        "field_staff": _ceil(n / v("vehicles_per_field_staff")),
        "onboard": n if mode in ("onboard", "remote_with_attendant") else np.zeros_like(n),
    }
    if mode == "remote_with_attendant" and not p.has("attendant_sgd_per_hour"):
        raise KeyError("staff_mode remote_with_attendant needs attendant_sgd_per_hour")
    wage = {"remote_operator": v("remote_operator_sgd_per_hour"), "field_staff": v("field_staff_sgd_per_hour"),
            "onboard": v("attendant_sgd_per_hour") if mode == "remote_with_attendant" else v("onboard_staff_sgd_per_hour")}
    hours = {k: float(x @ w) for k, x in persons.items()}
    cost = {k: hours[k] * wage[k] for k in persons}
    return {"staff_mode": mode, "control_room_ratio": ratio, "hour_lengths": w.tolist(),
            "persons_by_hour": {k: x.tolist() for k, x in persons.items()},
            "hours": hours, "sgd_per_hour": wage, "cost": cost, "total": sum(cost.values())}


def shuttle_daily_cost(ops: ShuttleOps, p: CostParams, case: str = "central",
                       charging_offpeak: bool | None = None) -> dict:
    """Daily cost of a shuttle fleet by category (SGD per day, definitions §7), its fixed / distance /
    staff classes and shares, cost per completed ride and per passenger-km, staff and fleet detail.

    Vehicles are the total fleet x (annuity of price, life, residual and r | lease charge) per year,
    by the acquisition switch. Under a lease the categories in lease_includes are inside the lease
    charge and count 0; under a purchase nothing is bundled. Maintenance splits into its distance
    (per km) and fixed (per vehicle-year) parts. Chargers have no residual value: the schema has no
    id for one."""
    v = _values(p, case, ops.capacity)
    days = p.days_per_year
    fl = fleet_estimate(ops, p, case, charging_offpeak)
    T = fl["total"]
    r = v("discount_rate_real")
    lease = p.switches["acquisition"] == "lease"
    if lease:
        vehicle_year = v("lease_sgd_per_vehicle_year")
    else:
        vehicle_year = equivalent_annual_cost(v("veh_price"), v("veh_life_years"), v("veh_residual_share"), r)
    charger_year = equivalent_annual_cost(v("charger_sgd_each"), v("charger_life_years"), 0.0, r)
    staff = staff_cost(ops, p, case)
    maint = {"distance": ops.veh_km * v("maint_sgd_per_km"),
             "fixed": annual_to_daily(T * v("maint_fixed_sgd_per_vehicle_year"), days)}
    cats = {
        "vehicles": annual_to_daily(T * vehicle_year, days),
        "energy": ops.veh_km * v("energy_kwh_per_km") / v("charging_efficiency") * v("electricity_sgd_per_kwh"),
        "maintenance": maint["distance"] + maint["fixed"],
        "cleaning": T * v("cleaning_sgd_per_vehicle_day"),
        "insurance_permits": annual_to_daily(T * v("insurance_sgd_per_vehicle_year") + v("permit_fixed_sgd_per_year"),
                                             days),
        "software_comms": monthly_to_daily(T * (v("software_sgd_per_vehicle_month") + v("comms_sgd_per_vehicle_month")),
                                           days) + annual_to_daily(v("control_centre_fixed_sgd_per_year"), days),
        "staff": staff["total"],
        "charging_depot": annual_to_daily(fl["chargers"] * charger_year + T * v("depot_sgd_per_vehicle_year")
                                          + v("depot_fixed_sgd_per_year"), days),
    }
    bundled = sorted(p.switches["lease_includes"]) if lease else []
    for c in bundled:                    # paid inside the lease charge: never counted twice
        cats[c] = 0.0
    if "maintenance" in bundled:
        maint = {"distance": 0.0, "fixed": 0.0}
    classes = {"fixed": cats["vehicles"] + maint["fixed"] + cats["cleaning"] + cats["insurance_permits"]
               + cats["software_comms"] + cats["charging_depot"],
               "distance": cats["energy"] + maint["distance"],
               "staff": cats["staff"]}
    total = sum(cats.values())
    return {
        "case": case, "capacity": ops.capacity, "acquisition": p.switches["acquisition"],
        "staff_mode": p.switches["staff_mode"], "bundled_in_lease": bundled,
        "units": f"{CURRENCY} per day, {PRICE_YEAR} prices, GST {GST}",
        "categories": cats, "maintenance_parts": maint, "classes": classes,
        "shares": {k: x / total if total > 0 else None for k, x in classes.items()},
        "total": total,
        "cost_per_ride": total / ops.rides if ops.rides > 0 else None,
        "cost_per_pax_km": total / ops.pax_km if ops.pax_km > 0 else None,
        "cost_per_vehicle_day": total / T,
        "vehicle_sgd_per_year": vehicle_year, "charger_sgd_per_year": charger_year,
        "fleet": fl, "staff": staff,
    }


def bus_daily_cost(bus: BusOps, p: CostParams, case: str = "central", basis: str | None = None) -> dict:
    """Daily cost of bus supply: bus-km x bus_sgd_per_bus_km and/or bus-hours x bus_sgd_per_bus_hour.
    basis "km" | "hour" | "km+hour" (a two-part rate whose inclusions do not overlap); by default per
    bus-km when the file has that rate, else per bus-hour. A rate in the file that is not used is
    reported under `alternatives`, never added. Inclusions are each rate's note."""
    if basis is None:
        basis = "km" if p.has("bus_sgd_per_bus_km") else "hour"
    if basis not in BUS_BASES:
        raise ValueError(f"basis must be one of {list(BUS_BASES)}, not {basis!r}")
    keys = BUS_BASES[basis]
    missing = [k for k in keys if not p.has(k)]
    if missing:
        raise KeyError(f"basis {basis!r} needs {missing}, which the parameters do not have")
    qty = {"bus_sgd_per_bus_km": bus.bus_km, "bus_sgd_per_bus_hour": bus.bus_hours}
    parts = {k: qty[k] * p.value(k, case) for k in BUS_IDS if p.has(k)}
    return {"label": bus.label, "case": case, "basis": basis, "keys_used": list(keys),
            "daily_cost": sum(parts[k] for k in keys), "by_key": {k: parts[k] for k in keys},
            "alternatives": {k: x for k, x in parts.items() if k not in keys},
            "inclusions": {k: p.entry(k).get("note", "") if k in p.parameters else "override" for k in keys}}


# ------------------------------------------------------------------ comparison

RESULT_SUMS = ("passenger_hours", "rides_completed", "rides_refused", "rides_declined")


def _result(r: dict) -> dict:
    """An option result with its ride total and its mean minutes per ride, both from the sums."""
    missing = [k for k in ("daily_cost", "passenger_hours", "rides_completed") if k not in r]
    if missing:
        raise KeyError(f"an option result needs {missing}")
    out = {"label": r.get("label", ""), "daily_cost": float(r["daily_cost"]),
           **{k: float(r.get(k, 0.0)) for k in RESULT_SUMS}}
    out["rides"] = out["rides_completed"] + out["rides_refused"] + out["rides_declined"]
    out["mean_minutes"] = 60.0 * out["passenger_hours"] / out["rides"] if out["rides"] else None
    return out


def aggregate(parts, daily_cost: float | None = None, days: int = 1, label: str = "") -> dict:
    """One option result from parts that add up: groups of one day (periods, areas) or `days`
    replicate days. Passenger-hours and ride counts are summed and divided by `days`; the mean time
    per ride then comes from those sums, never from the parts' means. Replicate days carry their own
    daily_cost, averaged the same way; for groups of one day pass the day's cost as `daily_cost`,
    since a fleet's cost does not split by period.

    Result keys: daily_cost (SGD per day), passenger_hours (sum over the comparison set, refused and
    declined rides at their treatment value), rides_completed, rides_refused, rides_declined
    (refused and declined rides are not in rides_completed), rides, mean_minutes, label."""
    rows = parts.to_dict("records") if isinstance(parts, pd.DataFrame) else list(parts)
    if not rows:
        raise ValueError("nothing to aggregate")
    if any("passenger_hours" not in r or "rides_completed" not in r for r in rows):
        raise KeyError("every part needs passenger_hours and rides_completed")
    out = {k: sum(float(r.get(k, 0.0)) for r in rows) / days for k in RESULT_SUMS}
    if daily_cost is None:
        if not all("daily_cost" in r for r in rows):
            raise ValueError("pass daily_cost: the parts carry none (a day's cost does not split by group)")
        daily_cost = sum(float(r["daily_cost"]) for r in rows) / days
    return _result({**out, "daily_cost": daily_cost, "label": label})


def compare(option: dict, baseline: dict) -> dict:
    """An option against a baseline on the same rides (definitions §4): delta_cost (SGD per day) and
    delta_passenger_hours, both option - baseline, the cost-time classification and the cost per
    passenger-hour saved. Results hold the keys of aggregate(); every ride of the comparison set
    must be in both, refused and declined rides included.

    "Reduces" means strictly lower: an equal cost or time is listed in `ties` and counts as an
    increase. cost_per_passenger_hour_saved = delta_cost / hours saved, only when hours are saved
    (it is negative when the option also saves money); otherwise None with the reason."""
    o, b = _result(option), _result(baseline)
    if not math.isclose(o["rides"], b["rides"], rel_tol=1e-9, abs_tol=1e-9):
        raise ValueError(f"options must be compared on the same rides: {o['rides']:g} against {b['rides']:g} "
                         "(completed + refused + declined)")
    d_cost = o["daily_cost"] - b["daily_cost"]
    d_hours = o["passenger_hours"] - b["passenger_hours"]
    ties = [k for k, x, y in (("cost", o["daily_cost"], b["daily_cost"]),
                              ("time", o["passenger_hours"], b["passenger_hours"]))
            if math.isclose(x, y, rel_tol=1e-9, abs_tol=1e-9)]
    less_cost = d_cost < 0 and "cost" not in ties
    less_time = d_hours < 0 and "time" not in ties
    classification = CLASSIFICATIONS[(0 if less_cost else 1) if less_time else (2 if less_cost else 3)]
    if less_time:
        per_hour, reason = d_cost / -d_hours, None
    else:
        per_hour = None
        reason = ("no passenger time saved: equal passenger-hours" if "time" in ties else
                  f"no passenger time saved: the option takes {d_hours:.6g} more passenger-hours")
    return {"option": o["label"], "baseline": b["label"],
            "delta_cost": d_cost, "delta_passenger_hours": d_hours, "passenger_hours_saved": -d_hours,
            "classification": classification, "ties": ties,
            "cost_per_passenger_hour_saved": per_hour, "reason": reason,
            "rides": o["rides"], "minutes_saved_per_ride": -60.0 * d_hours / o["rides"] if o["rides"] else None,
            "mean_minutes": {"option": o["mean_minutes"], "baseline": b["mean_minutes"]},
            "rides_refused": {"option": o["rides_refused"], "baseline": b["rides_refused"]},
            "rides_declined": {"option": o["rides_declined"], "baseline": b["rides_declined"]}}


def compare_all(results: dict[str, dict], baseline: str = "A") -> dict[str, dict]:
    """compare() for every option of {name: result} against the one named `baseline`."""
    base = {**results[baseline], "label": baseline}
    return {k: compare({**r, "label": k}, base) for k, r in results.items() if k != baseline}


# ------------------------------------------------------------------ thresholds

def _bisect(f: Callable[[float], float], target: float, lo: float, hi: float, tol: float = 1e-9,
            max_iter: int = 200) -> dict:
    """Where a monotone f crosses `target` on [lo, hi]; the target is met where f(x) <= target.
    value = the end of the final interval on the met side, within tol x (hi - lo) of the crossing,
    or None when f - target keeps one sign over the bracket (status says which). `monotone` checks
    the assumption on every point evaluated."""
    lo, hi = sorted((float(lo), float(hi)))
    seen: dict[float, float] = {}

    def g(x):
        if x not in seen:
            y = f(x)
            if y is None:
                raise ValueError(f"the target function is undefined at {x}")
            seen[x] = float(y) - target
        return seen[x]

    out = {"value": None, "bracket": [lo, hi], "met_for": None}
    g_lo, g_hi = g(lo), g(hi)
    if g_lo <= 0 and g_hi <= 0:
        out.update(status="met throughout bracket", reason="the target is met at both ends: the crossing is outside")
    elif g_lo > 0 and g_hi > 0:
        out.update(status="not met in bracket", reason="the target is met at neither end of the bracket")
    else:
        met, unmet = (lo, hi) if g_lo <= 0 else (hi, lo)
        for _ in range(max_iter):
            mid = 0.5 * (met + unmet)
            if abs(unmet - met) <= tol * (hi - lo) or mid in (met, unmet):
                break
            if g(mid) <= 0:
                met = mid
            else:
                unmet = mid
        out.update(value=met, status="solved", reason=None, met_for="<= value" if g_lo <= 0 else ">= value")
    ys = np.array([seen[x] for x in sorted(seen)])
    d, eps = np.diff(ys), 1e-9 * max(1.0, float(np.abs(ys).max()))
    out.update(monotone=bool((d >= -eps).all() or (d <= eps).all()), evaluations=len(seen), tol=tol)
    return out


def max_daily_cost_per_vehicle(budget_sgd_per_day: float, ops: ShuttleOps, p: CostParams, case: str = "central",
                               charging_offpeak: bool | None = None) -> dict:
    """Highest all-in cost per vehicle-day of the total fleet that keeps the shuttle within a daily
    budget: budget / total fleet (closed form, no bracket). It must cover every category, the
    programme-level fixed costs (permits, control centre, depot site) and staff included, so it
    compares with an all-in contract rate, not with a vehicle price or lease charge."""
    r = shuttle_daily_cost(ops, p, case, charging_offpeak)
    T = r["fleet"]["total"]
    value = budget_sgd_per_day / T
    return {"value": value, "unit": f"{CURRENCY} per vehicle-day (total fleet)", "bracket": None, "status": "solved",
            "budget_sgd_per_day": budget_sgd_per_day, "total_fleet": T, "in_service": ops.fleet_in_service,
            "covers": list(CATEGORIES), "bundled_in_lease": r["bundled_in_lease"],
            "current": r["cost_per_vehicle_day"], "current_by_category": {c: x / T for c, x in r["categories"].items()},
            "headroom": value - r["cost_per_vehicle_day"], "case": case}


def required_rides_per_vehicle_hour(target_cost_per_ride: float, ops: ShuttleOps, p: CostParams,
                                    case: str = "central", bracket: tuple[float, float] | None = None,
                                    scale_km: bool = True, tol: float = 1e-9,
                                    charging_offpeak: bool | None = None) -> dict:
    """Rides per in-service vehicle-hour (the utilisation) at which the cost per completed ride falls
    to the target, by bisection over the forward model.

    Rides are scaled at a fixed fleet, service day and staff plan: rides and passenger-km by u / u0
    (u0 = the simulated rides per vehicle-hour) and, with scale_km, vehicle-km and empty km by the
    same factor, so vehicle-km per ride stay as simulated (conservative: a busier fleet pools more).
    With scale_km=False the vehicle-km stay as simulated, so extra rides add no driving (the optimistic
    bound). More driving raises energy, maintenance and the charging reserve. Whether the fleet could
    serve that many rides is for the simulator to say. bracket: rides per vehicle-hour (default
    u0/10 to 10 u0)."""
    if ops.rides <= 0:
        raise ValueError("needs a simulated day with completed rides to scale from")
    vh = ops.vehicle_hours
    u0 = ops.rides / vh
    lo, hi = bracket if bracket is not None else (u0 / 10, u0 * 10)
    if min(lo, hi) <= 0:
        raise ValueError("the bracket must hold positive utilisations")

    def cost_per_ride(u):
        return shuttle_daily_cost(ops.scaled(u / u0, km=scale_km), p, case, charging_offpeak)["cost_per_ride"]

    res = _bisect(cost_per_ride, target_cost_per_ride, lo, hi, tol)
    u = res["value"]
    return {"unit": "rides per in-service vehicle-hour", "target_cost_per_ride": target_cost_per_ride, "case": case,
            **res, "rides_per_day": u * vh if u is not None else None, "scale": u / u0 if u is not None else None,
            "current": u0, "current_cost_per_ride": cost_per_ride(u0), "vehicle_hours": vh,
            "scaling": "vehicle-km per ride constant" if scale_km else "vehicle-km as simulated"}


def solve_parameter_for_target(param_id: str, target_fn: Callable[[dict], float] | str, target_value: float,
                               ops: ShuttleOps, p: CostParams, case: str = "central",
                               bracket: tuple[float, float] | None = None, tol: float = 1e-9,
                               charging_offpeak: bool | None = None) -> dict:
    """Value of one parameter at which a cost output meets a target, by monotone bisection over
    shuttle_daily_cost with that parameter overridden.

    target_fn: a key of the shuttle_daily_cost result ("total", "cost_per_ride", ...) or a function
    of it; the target is met where target_fn <= target_value, and `met_for` says on which side of
    the value. bracket: the search range (default: the parameter's low_cost..high_cost range in the
    file). E.g. the vehicles_per_remote_operator that brings the daily total under a budget (met for
    >= value) or the break-even vehicle price (met for <= value). value is None when the crossing
    is not in the bracket."""
    fn = (lambda r: r[target_fn]) if isinstance(target_fn, str) else target_fn
    if bracket is None:
        a, b = (p.value(param_id, c, ops.capacity) for c in ("low", "high"))
        bracket = (min(a, b), max(a, b))
    res = _bisect(lambda x: fn(shuttle_daily_cost(ops, p.with_override(param_id, x), case, charging_offpeak)),
                  target_value, *bracket, tol=tol)
    return {"param_id": param_id, "unit": p.unit(param_id), "target_value": target_value, "case": case, **res}


# ------------------------------------------------------------------ swings

def swings(ops: ShuttleOps, p: CostParams, param_ids: Iterable[str] | None = None, metric: str = "total",
           charging_offpeak: bool | None = None) -> list[dict]:
    """One-at-a-time swings for a tornado chart: each parameter at its low_cost and at its high_cost
    value, every other parameter at central. Tidy rows, one per parameter and side, largest range
    first. direction_ok is False where the low_cost value raises the metric or the high_cost value
    lowers it (a sign of swapped columns). Parameters that do not act under the current switches
    (the lease charge of a purchased fleet, say) show no swing."""
    base = shuttle_daily_cost(ops, p, "central", charging_offpeak)[metric]
    ids = list(param_ids) if param_ids is not None else [k for k in SHUTTLE_IDS if k in p.parameters]
    eps = 1e-9 * max(1.0, abs(base))
    rows = []
    for k in ids:
        res = {}
        for side in ("low", "high"):
            x = p.value(k, side, ops.capacity)
            res[side] = (x, shuttle_daily_cost(ops, p.with_override(k, x), "central", charging_offpeak)[metric])
        ok = res["low"][1] <= base + eps and res["high"][1] >= base - eps
        rng = abs(res["high"][1] - res["low"][1])
        for side, (x, y) in res.items():
            rows.append({"param_id": k, "unit": p.unit(k), "side": side, "column": CASES[side], "value": x,
                         "central_value": p.value(k, "central", ops.capacity), "metric": metric, "result": y,
                         "central_result": base, "delta": y - base, "range": rng, "direction_ok": ok})
    rows.sort(key=lambda r: -r["range"])       # stable: ties keep the parameter order, low before high
    return rows


if __name__ == "__main__":
    import sys
    cp = load_cases(sys.argv[1] if len(sys.argv) > 1 else CASES_FILE)
    print(f"{cp.source}: valid, {len(cp.parameters)} parameters, switches {cp.switches}")
