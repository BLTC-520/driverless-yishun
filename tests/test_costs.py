"""Cost model (definitions §5-8) on a synthetic parameter file: annualisation, the fleet
availability estimate, staff, lease against purchase, categories and classes, bus cost, option
comparison, thresholds and swings. Expected values are worked out by hand from the fixture."""
import copy
import json

import numpy as np
import pandas as pd
import pytest

from yishun.costs import (CASES_FILE, CATEGORIES, SHUTTLE_IDS, BusOps, CostParams, SchemaError, ShuttleOps,
                          aggregate, annual_to_daily, bus_daily_cost, compare, compare_all, crf,
                          equivalent_annual_cost, fleet_estimate, load_cases, max_daily_cost_per_vehicle,
                          monthly_to_daily, required_rides_per_vehicle_hour, shuttle_daily_cost,
                          solve_parameter_for_target, staff_cost, swings, validate_cases)


def entry(unit, low, central, high, **kw):
    return {"unit": unit, "low_cost": low, "central": central, "high_cost": high, "basis": "assumption",
            "sources": ["T01"], "note": "synthetic test value", **kw}


def by_capacity(unit, values):
    return {"unit": unit, "basis": "assumption", "sources": ["T01"], "note": "synthetic test value",
            "by_capacity": {c: dict(zip(("low_cost", "central", "high_cost"), v)) for c, v in values.items()}}


# Round numbers, so that every expected value can be worked out by hand. Every low_cost value lowers
# cost and every high_cost value raises it: a longer life, a bigger battery, more vehicles per
# operator are low-cost values.
FIXTURE = {
    "currency": "SGD", "price_year": 2026, "days_per_year": 365, "gst": "excluded",
    "parameters": {
        "veh_price": by_capacity("SGD per vehicle", {"4": (150_000, 200_000, 250_000), "10": (250_000, 300_000, 400_000),
                                                     "20": (400_000, 500_000, 600_000)}),
        "veh_life_years": entry("years", 10, 8, 6),
        "veh_residual_share": entry("fraction", 0.2, 0.1, 0.0),
        "lease_sgd_per_vehicle_year": entry("SGD per vehicle-year", 40_000, 50_000, 60_000),
        "discount_rate_real": entry("fraction", 0.02, 0.05, 0.08),
        "energy_kwh_per_km": by_capacity("kWh per km at the battery", {"4": (0.15, 0.18, 0.22), "10": (0.25, 0.3, 0.35),
                                                                       "20": (0.4, 0.5, 0.6)}),
        "battery_usable_kwh": by_capacity("kWh", {"4": (70, 60, 50), "10": (100, 80, 60), "20": (150, 120, 100)}),
        "charging_efficiency": entry("fraction", 0.95, 0.9, 0.85),
        "electricity_sgd_per_kwh": entry("SGD per kWh", 0.25, 0.30, 0.35),
        "charger_power_kw": entry("kW", 60, 30, 20),
        "maint_sgd_per_km": by_capacity("SGD per km", {"4": (0.08, 0.10, 0.15), "10": (0.10, 0.15, 0.20),
                                                       "20": (0.15, 0.20, 0.30)}),
        "maint_fixed_sgd_per_vehicle_year": entry("SGD per vehicle-year", 2_000, 3_000, 5_000),
        "cleaning_sgd_per_vehicle_day": entry("SGD per vehicle-day", 10, 15, 20),
        "insurance_sgd_per_vehicle_year": entry("SGD per vehicle-year", 3_000, 4_000, 6_000),
        "permit_fixed_sgd_per_year": entry("SGD per year", 0, 36_500, 73_000),
        "software_sgd_per_vehicle_month": entry("SGD per vehicle-month", 200, 300, 500),
        "comms_sgd_per_vehicle_month": entry("SGD per vehicle-month", 50, 100, 150),
        "control_centre_fixed_sgd_per_year": entry("SGD per year", 182_500, 365_000, 730_000),
        "vehicles_per_remote_operator": entry("vehicles per operator", 20, 10, 4),
        "min_remote_operators": entry("persons", 1, 2, 3),
        "remote_operator_sgd_per_hour": entry("SGD per hour, fully loaded", 30, 40, 50),
        "vehicles_per_field_staff": entry("vehicles per person", 40, 25, 15),
        "field_staff_sgd_per_hour": entry("SGD per hour", 25, 30, 40),
        "onboard_staff_sgd_per_hour": entry("SGD per hour", 20, 25, 30),
        "charger_sgd_each": entry("SGD per charger incl. installation", 30_000, 50_000, 80_000),
        "charger_life_years": entry("years", 12, 10, 8),
        "vehicles_per_charger": entry("vehicles per charger", 3, 2, 1),
        "depot_sgd_per_vehicle_year": entry("SGD per vehicle-year", 1_000, 2_000, 3_000),
        "depot_fixed_sgd_per_year": entry("SGD per year", 0, 365_000, 730_000),
        "maintenance_spare_ratio": entry("fraction", 0.05, 0.1, 0.15),
        "bus_sgd_per_bus_km": entry("SGD per bus-km", 4.0, 5.0, 6.0, note="all-in operating cost incl. drivers"),
        "bus_sgd_per_bus_hour": entry("SGD per bus-hour", 100.0, 120.0, 150.0),
        "vot_ivt_sgd_per_hour": entry("SGD per hour", 10, 12, 15),
        "wait_time_weight": entry("multiplier", 1.5, 2.0, 2.5),
    },
    "switches": {"acquisition": "purchase", "staff_mode": "remote", "lease_includes": []},
}


@pytest.fixture
def p(tmp_path):
    path = tmp_path / "cost_cases.json"
    path.write_text(json.dumps(FIXTURE))
    return load_cases(path)


def day(**kw):
    """100 ten-seat vehicles in service for 20 h, 20,000 veh-km: 60 kWh per vehicle against an 80 kWh
    battery (central), 10,000 rides over 2,000 vehicle-hours."""
    return ShuttleOps(**{"capacity": 10, "fleet_in_service": 100, "service_hours": 20.0, "veh_km": 20_000.0,
                         "veh_km_empty": 5_000.0, "rides": 10_000, "pax_km": 15_000.0, **kw})


def broken(mutate):
    d = copy.deepcopy(FIXTURE)
    mutate(d)
    return d


# ------------------------------------------------------------------ annualisation and units

def test_crf_matches_hand_values():
    assert crf(0.05, 10) == pytest.approx(0.129505, abs=1e-6)
    assert crf(0.05, 1) == pytest.approx(1.05)              # one year: the price plus a year's interest
    assert crf(0.0, 10) == 0.1
    assert crf(1e-12, 10) == pytest.approx(0.1, rel=1e-9)   # continuous as r -> 0
    with pytest.raises(ValueError):
        crf(0.05, 0)


def test_equivalent_annual_cost_discounts_the_residual():
    # 100 now, 20 back after 10 years at 5 %: 0.129505 x (100 - 20 / 1.05^10) = 0.129505 x 87.722
    assert equivalent_annual_cost(100, 10, 0.2, 0.05) == pytest.approx(0.1295046 * (100 - 20 / 1.6288946), rel=1e-6)
    assert equivalent_annual_cost(100, 10, 0.2, 0.05) == pytest.approx(11.36037, rel=1e-6)
    assert equivalent_annual_cost(100, 10, 0.2, 0.0) == pytest.approx(8.0)          # (100 - 20) / 10
    assert equivalent_annual_cost(100, 10, 0.0, 0.05) == pytest.approx(100 * crf(0.05, 10))


def test_daily_annual_and_monthly_conversions():
    assert annual_to_daily(36_500, 365) == pytest.approx(100.0)
    assert monthly_to_daily(365, 365) == pytest.approx(12.0)
    assert monthly_to_daily(100, 360) == pytest.approx(annual_to_daily(1_200, 360))


def test_days_per_year_is_read_from_the_file(p):
    assert p.days_per_year == 365 and CASES_FILE.parts[-3:] == ("data", "parameters", "cost_cases.json")
    p360 = CostParams.from_dict(broken(lambda d: d.update(days_per_year=360)))
    a, b = shuttle_daily_cost(day(), p)["categories"], shuttle_daily_cost(day(), p360)["categories"]
    for c in ("vehicles", "insurance_permits", "software_comms", "charging_depot"):   # per year or month
        assert b[c] == pytest.approx(a[c] * 365 / 360)
    for c in ("energy", "cleaning", "staff"):                                         # per km, day or hour
        assert b[c] == pytest.approx(a[c])


# ------------------------------------------------------------------ fleet availability estimate

def test_no_charging_reserve_when_the_battery_covers_the_day(p):
    f = fleet_estimate(day(), p)
    assert f["energy_per_vehicle_kwh"] == pytest.approx(60.0)       # 20,000 km x 0.3 kWh / 100 vehicles
    assert f["charging_reserve"] == 0 and f["excess_kwh_per_vehicle"] == 0
    assert "not a charging simulation" in f["estimate"]
    # exactly one full battery: 32,000 km x 0.25 kWh / 100 = 80 kWh = B, restored overnight when each
    # vehicle has its own charger (30 kW x 4 h = 120 kWh > B)
    one = p.with_override("energy_kwh_per_km", 0.25).with_override("vehicles_per_charger", 1)
    f = fleet_estimate(day(veh_km=32_000.0), one)
    assert f["energy_per_vehicle_kwh"] == 80.0 and f["overnight_cap_kwh_per_vehicle"] == 80.0
    assert f["charging_reserve"] == 0


def test_short_overnight_window_moves_charging_into_the_day(p):
    """With two vehicles per charger, 4 h without service restore only 30 kW x 4 h / 2 = 60 kWh of an
    80 kWh battery, so a day that uses exactly one battery still needs 20 kWh of daytime charging."""
    f = fleet_estimate(day(veh_km=32_000.0), p.with_override("energy_kwh_per_km", 0.25))
    assert f["overnight_window_h"] == 4.0 and f["overnight_cap_kwh_per_vehicle"] == pytest.approx(60.0)
    assert f["excess_kwh_per_vehicle"] == pytest.approx(20.0)
    assert f["charging_reserve"] == 4                      # ceil(100 x 20 / (30 x 20)) = ceil(3.33)
    assert f["overnight_fits"] is True


def test_charging_reserve_when_a_day_needs_more_than_a_battery(p):
    one = p.with_override("vehicles_per_charger", 1)       # overnight cap = min(80, 30 x 4) = B
    f = fleet_estimate(day(veh_km=30_000.0), one)
    # E = 90 kWh, B = 80: 10 kWh at 30 kW = 1/3 h of daytime charging per vehicle; 100 vehicles x 1/3 h
    # spread over 20 h = 1.67 vehicles charging at any time -> 2 reserve vehicles
    assert f["energy_per_vehicle_kwh"] == pytest.approx(90.0)
    assert f["daytime_charge_hours_per_vehicle"] == pytest.approx(1 / 3)
    assert f["charging_reserve_unrounded"] == pytest.approx(100 * 10 / (30 * 20))
    assert f["charging_reserve"] == 2 and f["maintenance_reserve"] == 10          # ceil(0.1 x 100)
    assert f["total"] == 112 == f["in_service"] + f["charging_reserve"] + f["maintenance_reserve"]
    assert f["unavailable"] == 12 and f["unavailable_vehicle_hours"] == pytest.approx(12 * 20)
    # chargers: one per vehicle = 112; the day's 9,000 kWh in 24 h at 30 kW needs only 13
    assert (f["chargers_by_ratio"], f["chargers_by_energy"], f["chargers"]) == (112, 13, 112)
    # two vehicles per charger: the overnight cap falls to 30 x 4 / 2 = 60 kWh, so 30 kWh go by day,
    # ceil(100 x 30 / (30 x 20)) = 5 reserve vehicles; 115 vehicles at 2 per charger = 58 chargers
    f = fleet_estimate(day(veh_km=30_000.0), p)
    assert f["excess_kwh_per_vehicle"] == pytest.approx(30.0) and f["charging_reserve"] == 5
    assert (f["chargers_by_ratio"], f["chargers"]) == (58, 58)
    # the restored overnight energy always fits the chargers' overnight output by construction
    assert f["overnight_kwh"] == pytest.approx(100 * 60) and f["overnight_charger_kwh"] == pytest.approx(58 * 30 * 4)
    assert f["overnight_fits"] is True


def test_charging_absorbed_off_peak(p):
    assert fleet_estimate(day(veh_km=30_000.0), p, charging_offpeak=True)["charging_reserve"] == 0
    # the low-cost case absorbs it by default: low values give E = 60,000 x 0.25 / 100 = 150 kWh, of
    # which min(100, 60 kW x 4 h / 3) = 80 kWh come back overnight; the other 70 kWh spread over the
    # day would need ceil(100 x 70 / (60 x 20)) = 6 reserve vehicles
    o = day(veh_km=60_000.0)
    assert fleet_estimate(o, p, "low")["charging_reserve"] == 0
    assert fleet_estimate(o, p, "low", charging_offpeak=False)["charging_reserve"] == 6
    assert fleet_estimate(o, p, "central")["charging_offpeak"] is False


def test_maintenance_reserve_rounds_up_but_not_on_float_noise(p):
    assert fleet_estimate(day(fleet_in_service=105), p)["maintenance_reserve"] == 11   # 10.5 -> 11
    assert fleet_estimate(day(fleet_in_service=101), p)["maintenance_reserve"] == 11   # 10.1 -> 11
    assert 0.07 * 100 > 7                                                             # 7.000000000000001
    assert fleet_estimate(day(), p.with_override("maintenance_spare_ratio", 0.07))["maintenance_reserve"] == 7


# ------------------------------------------------------------------ staff

def test_staff_per_hour_ceilings_and_minimum(p):
    s = staff_cost(day(), p)
    # 100 vehicles: ceil(100 / 10) = 10 operators and ceil(100 / 25) = 4 field staff in each of 20 hours
    assert s["hours"] == {"remote_operator": 200.0, "field_staff": 80.0, "onboard": 0.0}
    assert s["total"] == pytest.approx(200 * 40 + 80 * 30)
    assert staff_cost(day(fleet_in_service=101), p)["hours"]["remote_operator"] == 11 * 20   # ceil(10.1)
    s = staff_cost(day(fleet_in_service=5, veh_km=1_000.0, veh_km_empty=250.0), p)
    assert s["persons_by_hour"]["remote_operator"] == [2] * 20       # ceil(5 / 10) = 1, below the minimum of 2
    assert s["persons_by_hour"]["field_staff"] == [1] * 20           # ceil(5 / 25)


def test_onboard_mode_adds_vehicle_hours_times_wage(p):
    onboard_p = p.with_switches(staff_mode="onboard")
    remote, onboard = staff_cost(day(), p), staff_cost(day(), onboard_p)
    assert onboard["hours"]["onboard"] == 100 * 20 == day().vehicle_hours
    assert onboard["total"] - remote["total"] == pytest.approx(100 * 20 * 25)
    assert shuttle_daily_cost(day(), onboard_p)["categories"]["staff"] == pytest.approx(onboard["total"])


def test_staff_follow_a_non_uniform_hourly_profile(p):
    o = day(service_hours=4, in_service_by_hour=[100, 50, 5, 0])
    s = staff_cost(o, p.with_switches(staff_mode="onboard"))
    assert s["persons_by_hour"]["remote_operator"] == [10, 5, 2, 2]  # the minimum holds when few or none run
    assert s["persons_by_hour"]["field_staff"] == [4, 2, 1, 0]
    assert s["hours"] == {"remote_operator": 19.0, "field_staff": 7.0, "onboard": 155.0}
    assert s["total"] == pytest.approx(19 * 40 + 7 * 30 + 155 * 25)
    assert o.vehicle_hours == 155


def test_fractional_service_hours_end_with_a_part_hour(p):
    s = staff_cost(day(service_hours=20.5), p)
    assert s["hour_lengths"][-1] == 0.5 and sum(s["hour_lengths"]) == 20.5
    assert s["hours"]["remote_operator"] == pytest.approx(10 * 20.5)


def test_ops_checks_its_inputs():
    with pytest.raises(ValueError, match="one value per service hour"):
        day(in_service_by_hour=[100] * 19)
    with pytest.raises(ValueError, match="more vehicles in service than the fleet"):
        day(service_hours=2, in_service_by_hour=[100, 101])
    with pytest.raises(ValueError, match="whole number"):
        day(fleet_in_service=100.5)
    with pytest.raises(ValueError, match="loaded \\+ empty"):
        day(veh_km_empty=30_000.0)


def test_ops_from_a_simulated_day_and_a_run_summary():
    from yishun.sim import SimConfig, SimResult
    res = SimResult(pd.DataFrame({"refused": [False, True, False, False]}), veh_km_loaded=300.0, veh_km_empty=100.0,
                    veh_km_by_hour=np.zeros(26), pax_km=999.0, hub_visits=pd.DataFrame(), hub_idle=pd.DataFrame())
    o = ShuttleOps.from_sim(res, SimConfig(fleet=50, capacity=10), service_hours=21, pax_km=420.0)
    assert (o.capacity, o.fleet_in_service, o.veh_km, o.veh_km_empty, o.rides, o.pax_km) == (10, 50, 400, 100, 3, 420)
    row = {"fleet": 50, "capacity": 10, "veh_km": 400.0, "empty_share": 0.25, "n": 4, "refused_share": 0.25,
           "pax_km": 999.0}
    o = ShuttleOps.from_run(row, service_hours=21, pax_km=420.0)
    assert (o.rides, o.veh_km_empty, o.pax_km) == (3, 100, 420)


# ------------------------------------------------------------------ categories, lease and purchase

def test_categories_by_hand(p):
    r = shuttle_daily_cost(day(), p)
    T = 110                                         # 100 in service + 0 charging + ceil(0.1 x 100)
    c = r["categories"]
    assert r["fleet"]["total"] == T and list(c) == list(CATEGORIES)
    # purchase: crf(5 %, 8 y) = 0.1547218 on 300,000 less the discounted 10 % residual
    assert c["vehicles"] == pytest.approx(T * 0.1547218 * (300_000 - 30_000 / 1.4774554) / 365, rel=1e-6)
    assert c["energy"] == pytest.approx(20_000 * 0.3 / 0.9 * 0.30)                  # 2,000
    assert c["maintenance"] == pytest.approx(20_000 * 0.15 + T * 3_000 / 365)
    assert c["cleaning"] == pytest.approx(T * 15)
    assert c["insurance_permits"] == pytest.approx((T * 4_000 + 36_500) / 365)
    assert c["software_comms"] == pytest.approx(T * (300 + 100) * 12 / 365 + 365_000 / 365)
    assert c["staff"] == pytest.approx(200 * 40 + 80 * 30)
    # chargers: max(ceil(110 / 2), ceil(6,000 kWh / (30 kW x 24 h))) = 55 at crf(5 %, 10 y), no residual
    assert r["fleet"]["chargers"] == 55
    assert c["charging_depot"] == pytest.approx((55 * 0.1295046 * 50_000 + T * 2_000 + 365_000) / 365, rel=1e-6)


def test_lease_and_purchase_are_never_both_counted(p):
    o = day()
    bought, leased = shuttle_daily_cost(o, p), shuttle_daily_cost(o, p.with_switches(acquisition="lease"))
    T = bought["fleet"]["total"]
    assert leased["categories"]["vehicles"] == pytest.approx(T * 50_000 / 365)
    assert bought["categories"]["vehicles"] == pytest.approx(T * equivalent_annual_cost(300_000, 8, 0.1, 0.05) / 365)
    # the purchase price never reaches a leased fleet, nor the lease charge a purchased one
    lease_p = p.with_switches(acquisition="lease").with_override("veh_price", 10_000_000)
    assert shuttle_daily_cost(o, lease_p)["total"] == pytest.approx(leased["total"])
    buy_p = p.with_override("lease_sgd_per_vehicle_year", 10_000_000)
    assert shuttle_daily_cost(o, buy_p)["total"] == pytest.approx(bought["total"])


def test_lease_includes_switches_categories_off(p):
    o = day()
    bundled = ["maintenance", "insurance_permits", "software_comms"]
    plain = shuttle_daily_cost(o, p.with_switches(acquisition="lease"))
    full = shuttle_daily_cost(o, p.with_switches(acquisition="lease", lease_includes=bundled))
    assert all(full["categories"][c] == 0 for c in bundled) and full["bundled_in_lease"] == sorted(bundled)
    assert full["maintenance_parts"] == {"distance": 0.0, "fixed": 0.0}
    assert full["total"] == pytest.approx(plain["total"] - sum(plain["categories"][c] for c in bundled))
    for c in set(CATEGORIES) - set(bundled):
        assert full["categories"][c] == pytest.approx(plain["categories"][c])
    # a purchased fleet bundles nothing, whatever lease_includes says
    bought = shuttle_daily_cost(o, p.with_switches(lease_includes=bundled))
    assert bought["bundled_in_lease"] == [] and bought["categories"]["maintenance"] > 0
    with pytest.raises(SchemaError, match="lease_includes"):
        p.with_switches(lease_includes=["energy"])          # a service contract, not a lease
    with pytest.raises(SchemaError, match="unknown switch"):
        p.with_switches(staffmode="onboard")


def test_classes_add_up_to_the_total_and_unit_costs(p):
    for sw in ({}, {"acquisition": "lease", "lease_includes": ["maintenance"]}, {"staff_mode": "onboard"}):
        r = shuttle_daily_cost(day(veh_km=30_000.0), p.with_switches(**sw))
        m = r["maintenance_parts"]
        assert sum(r["categories"].values()) == pytest.approx(r["total"])
        assert sum(r["classes"].values()) == pytest.approx(r["total"])
        assert sum(r["shares"].values()) == pytest.approx(1.0)
        assert m["distance"] + m["fixed"] == pytest.approx(r["categories"]["maintenance"])
        assert r["classes"]["distance"] == pytest.approx(r["categories"]["energy"] + m["distance"])
        assert r["classes"]["staff"] == r["categories"]["staff"]
        assert r["cost_per_ride"] == pytest.approx(r["total"] / 10_000)
        assert r["cost_per_pax_km"] == pytest.approx(r["total"] / 15_000)
        assert r["cost_per_vehicle_day"] == pytest.approx(r["total"] / r["fleet"]["total"])
        json.dumps(r)                               # plain numbers, ready for summary.json


def test_low_central_high_order_total_cost(p):
    for cap in (4, 10, 20):
        o = day(capacity=cap, veh_km=40_000.0)      # daytime charging in the central and high cases
        totals = [shuttle_daily_cost(o, p, case)["total"] for case in ("low", "central", "high")]
        assert totals[0] < totals[1] < totals[2], cap


# ------------------------------------------------------------------ parameter file

def test_by_capacity_lookup(p):
    assert p.value("veh_price", "central", 4) == 200_000
    assert p.value("veh_price", "high", 20) == 600_000
    assert p.value("veh_price", "low", "10") == 250_000
    assert p.value("veh_life_years", "low", capacity=4) == 10      # no by_capacity: capacity is ignored
    with pytest.raises(ValueError, match="capacity"):
        p.value("veh_price")
    with pytest.raises(KeyError):
        p.value("veh_price", "central", 6)
    with pytest.raises(ValueError, match="case"):
        p.value("veh_life_years", "medium")
    # one charger per vehicle restores a full battery overnight for both sizes, so the fleets match
    one = p.with_override("vehicles_per_charger", 1)
    small, large = shuttle_daily_cost(day(capacity=4), one), shuttle_daily_cost(day(capacity=20), one)
    assert small["fleet"]["total"] == large["fleet"]["total"]
    assert large["categories"]["vehicles"] == pytest.approx(small["categories"]["vehicles"] * 500_000 / 200_000)


def test_overrides_return_a_copy(p):
    q = p.with_override("veh_price", 123_456)
    assert q.value("veh_price", "low", 4) == q.value("veh_price", "high", 20) == 123_456
    assert p.value("veh_price", "central", 10) == 300_000 and not p.overrides
    with pytest.raises(KeyError):
        p.with_override("veh_prise", 1.0)
    with pytest.raises(ValueError):
        p.with_override("vehicles_per_remote_operator", 0)


@pytest.mark.parametrize("mutate, message", [
    (lambda d: d["parameters"].pop("veh_price"), "missing parameter 'veh_price'"),
    (lambda d: d["parameters"]["charger_power_kw"].pop("unit"), "charger_power_kw: unit missing"),
    (lambda d: d["parameters"]["charger_power_kw"].update(unit=" "), "charger_power_kw: unit missing"),
    (lambda d: d["parameters"]["electricity_sgd_per_kwh"].update(central="0.3"), "central must be a number"),
    (lambda d: d["parameters"]["electricity_sgd_per_kwh"].pop("high_cost"), "high_cost must be a number"),
    (lambda d: d["parameters"]["veh_price"]["by_capacity"].pop("20"), "by_capacity needs exactly the keys"),
    (lambda d: d["parameters"]["veh_price"]["by_capacity"].update({"6": {}}), "by_capacity needs exactly the keys"),
    (lambda d: d["parameters"]["veh_price"]["by_capacity"].update({"10": {}}), r"by_capacity\[10\] low_cost"),
    (lambda d: d["parameters"]["cleaning_sgd_per_vehicle_day"].update(sources=[]), "sources must list"),
    (lambda d: d["parameters"]["cleaning_sgd_per_vehicle_day"].pop("sources"), "sources must list"),
    (lambda d: d["parameters"]["charging_efficiency"].update(central=90), "fraction above 1"),
    (lambda d: d["parameters"]["vehicles_per_charger"].update(low_cost=0), "must be positive"),
    (lambda d: d["parameters"]["veh_price"].update(basis="guess"), "basis must be one of"),
    (lambda d: [d["parameters"].pop(k) for k in ("bus_sgd_per_bus_km", "bus_sgd_per_bus_hour")], "missing bus cost"),
    (lambda d: d["switches"].update(acquisition="rent"), "switches.acquisition"),
    (lambda d: d["switches"].pop("staff_mode"), "switches.staff_mode"),
    (lambda d: d["switches"].update(lease_includes=["vehicles"]), "lease_includes"),
    (lambda d: d.pop("switches"), "switches must be an object"),
    (lambda d: d.update(currency="USD"), "currency"),
    (lambda d: d.update(gst="included"), "gst"),
])
def test_schema_errors(mutate, message):
    with pytest.raises(SchemaError, match=message):
        CostParams.from_dict(broken(mutate))


def test_validation_lists_every_problem_and_checks_the_register():
    assert validate_cases(FIXTURE) == []
    two = broken(lambda d: [d["parameters"].pop(k) for k in ("veh_price", "cleaning_sgd_per_vehicle_day")])
    assert len(validate_cases(two)) == 2
    assert validate_cases(FIXTURE, register_ids={"T01"}) == []
    assert any("not in the register" in e for e in validate_cases(FIXTURE, register_ids={"S01"}))
    # the social values are kept apart from cost: optional; a single bus rate is enough
    assert validate_cases(broken(lambda d: [d["parameters"].pop(k) for k in ("vot_ivt_sgd_per_hour",
                                                                            "bus_sgd_per_bus_hour")])) == []


# ------------------------------------------------------------------ bus

def test_bus_cost_names_the_rate_it_used(p):
    bus = BusOps(bus_km=33_871, bus_hours=2_439, label="in-area")
    r = bus_daily_cost(bus, p)
    assert r["keys_used"] == ["bus_sgd_per_bus_km"] and r["daily_cost"] == pytest.approx(33_871 * 5.0)
    assert r["alternatives"] == {"bus_sgd_per_bus_hour": pytest.approx(2_439 * 120.0)}   # shown, never added
    assert r["inclusions"] == {"bus_sgd_per_bus_km": "all-in operating cost incl. drivers"}
    assert bus_daily_cost(bus, p, basis="hour")["daily_cost"] == pytest.approx(2_439 * 120.0)
    assert bus_daily_cost(bus, p, "high", basis="km+hour")["daily_cost"] == pytest.approx(33_871 * 6 + 2_439 * 150)
    only_hour = CostParams.from_dict(broken(lambda d: d["parameters"].pop("bus_sgd_per_bus_km")))
    r = bus_daily_cost(bus, only_hour)
    assert r["keys_used"] == ["bus_sgd_per_bus_hour"] and r["alternatives"] == {}
    with pytest.raises(KeyError):
        bus_daily_cost(bus, only_hour, basis="km")


# ------------------------------------------------------------------ comparison

BASE = {"daily_cost": 1_000.0, "passenger_hours": 500.0, "rides_completed": 3_000}


@pytest.mark.parametrize("cost, hours, classification", [
    (900.0, 400.0, "reduces cost and time"),
    (1_100.0, 400.0, "increases cost, reduces time"),
    (900.0, 600.0, "reduces cost, increases time"),
    (1_100.0, 600.0, "increases cost and time"),
])
def test_compare_classifies(cost, hours, classification):
    c = compare({"daily_cost": cost, "passenger_hours": hours, "rides_completed": 3_000}, BASE)
    assert c["classification"] == classification
    assert c["delta_cost"] == pytest.approx(cost - 1_000) and c["delta_passenger_hours"] == pytest.approx(hours - 500)
    if hours < 500:
        assert c["cost_per_passenger_hour_saved"] == pytest.approx((cost - 1_000) / (500 - hours)) and not c["reason"]
    else:
        assert c["cost_per_passenger_hour_saved"] is None and "no passenger time saved" in c["reason"]


def test_compare_gives_no_cost_per_hour_without_a_saving():
    c = compare(dict(BASE, daily_cost=2_000.0), BASE)                  # the same passenger-hours
    assert c["cost_per_passenger_hour_saved"] is None and c["ties"] == ["time"]
    assert c["reason"] == "no passenger time saved: equal passenger-hours"
    assert c["classification"] == "increases cost and time"            # an equal time is not a saving
    with pytest.raises(ValueError, match="same rides"):
        compare(dict(BASE, rides_completed=2_900), BASE)                # an option may not drop riders
    # refused and declined rides stay in the comparison set and are reported separately
    c = compare(dict(BASE, rides_completed=2_900, rides_refused=60, rides_declined=40, passenger_hours=450.0), BASE)
    assert c["rides"] == 3_000 and c["rides_refused"] == {"option": 60, "baseline": 0}
    assert c["rides_declined"]["option"] == 40 and c["cost_per_passenger_hour_saved"] == 0.0


def test_compare_aggregates_passenger_hours_not_means():
    """1,000 peak rides lose a minute each, 10 evening rides gain 30 minutes each. The mean of the two
    periods' mean changes says the option is faster; the passenger-hours say it is slower."""
    base = [{"passenger_hours": 1_000 * 10 / 60, "rides_completed": 1_000},
            {"passenger_hours": 10 * 40 / 60, "rides_completed": 10}]
    opt = [{"passenger_hours": 1_000 * 11 / 60, "rides_completed": 1_000},
           {"passenger_hours": 10 * 10 / 60, "rides_completed": 10}]
    mean_of_means = np.mean([60 * (o["passenger_hours"] - b["passenger_hours"]) / b["rides_completed"]
                             for o, b in zip(opt, base)])
    assert mean_of_means == pytest.approx(-14.5)                       # (+1 - 30) / 2: looks faster
    A, C = aggregate(base, daily_cost=0.0, label="A"), aggregate(opt, daily_cost=500.0, label="C")
    assert A["rides"] == 1_010 and A["passenger_hours"] == pytest.approx(10_400 / 60)
    assert A["mean_minutes"] == pytest.approx(10_400 / 1_010)          # 10.3 min, not (10 + 40) / 2
    c = compare(C, A)
    assert c["delta_passenger_hours"] == pytest.approx(700 / 60)        # 11,100 - 10,400 passenger-minutes
    assert c["minutes_saved_per_ride"] == pytest.approx(-700 / 1_010)
    assert c["classification"] == "increases cost and time" and c["cost_per_passenger_hour_saved"] is None
    # the same from a table of periods
    assert aggregate(pd.DataFrame(opt), daily_cost=500.0)["passenger_hours"] == pytest.approx(C["passenger_hours"])


def test_aggregate_over_replicate_days():
    days = [{"daily_cost": 100.0, "passenger_hours": 10.0, "rides_completed": 100},
            {"daily_cost": 120.0, "passenger_hours": 30.0, "rides_completed": 200}]
    r = aggregate(days, days=2)
    assert r["daily_cost"] == pytest.approx(110.0) and r["passenger_hours"] == pytest.approx(20.0)
    assert r["mean_minutes"] == pytest.approx(60 * 40 / 300)          # 8 min pooled, not (6 + 9) / 2
    with pytest.raises(ValueError, match="daily_cost"):
        aggregate([{"passenger_hours": 1.0, "rides_completed": 1}])


def test_compare_all_against_a_baseline():
    out = compare_all({"A": BASE, "C": dict(BASE, daily_cost=1_500.0, passenger_hours=450.0)}, "A")
    assert list(out) == ["C"] and (out["C"]["option"], out["C"]["baseline"]) == ("C", "A")
    assert out["C"]["cost_per_passenger_hour_saved"] == pytest.approx(500 / 50)


# ------------------------------------------------------------------ thresholds and swings

def test_break_even_vehicle_price_round_trip(p):
    o = day()
    target = shuttle_daily_cost(o, p.with_override("veh_price", 350_000))["total"]
    s = solve_parameter_for_target("veh_price", "total", target, o, p, bracket=(100_000, 1_000_000))
    assert s["status"] == "solved" and s["value"] == pytest.approx(350_000, rel=1e-6)
    assert s["met_for"] == "<= value" and s["bracket"] == [100_000, 1_000_000] and s["monotone"]
    # default bracket: the file's low..high range for this capacity
    target = shuttle_daily_cost(o, p.with_override("veh_price", 320_000))["total"]
    s = solve_parameter_for_target("veh_price", lambda r: r["total"], target, o, p)
    assert s["bracket"] == [250_000, 400_000] and s["value"] == pytest.approx(320_000, rel=1e-6)
    json.dumps(s)


def test_operator_ratio_needed_for_a_budget(p):
    """Cost steps down where ceil(100 / ratio) drops: 8 operators from a ratio of exactly 12.5."""
    o = day()

    def cost(x):
        return shuttle_daily_cost(o, p.with_override("vehicles_per_remote_operator", x))["total"]

    budget = cost(12.5)
    s = solve_parameter_for_target("vehicles_per_remote_operator", "total", budget, o, p, bracket=(1, 100))
    assert s["met_for"] == ">= value" and s["value"] == pytest.approx(12.5, abs=1e-6)
    assert cost(s["value"]) <= budget < cost(s["value"] - 1e-3)


def test_thresholds_out_of_bracket_return_none(p):
    o = day()
    s = solve_parameter_for_target("vehicles_per_remote_operator", "total", 1.0, o, p, bracket=(1, 100))
    assert s["value"] is None and s["status"] == "not met in bracket" and s["reason"]
    s = solve_parameter_for_target("veh_price", "total", 1e9, o, p, bracket=(100_000, 1_000_000))
    assert s["value"] is None and s["status"] == "met throughout bracket"


def test_required_utilisation_round_trip(p):
    o = day()                                        # 10,000 rides over 2,000 vehicle-hours: 5 per vehicle-hour
    # charging absorbed off-peak: the charging reserve would add a vehicle in steps as the driving grows,
    # which makes cost per ride non-monotone in small jumps (the solver flags it; checked below)
    target = shuttle_daily_cost(o.scaled(2.0), p, charging_offpeak=True)["cost_per_ride"]
    r = required_rides_per_vehicle_hour(target, o, p, charging_offpeak=True)
    assert r["current"] == pytest.approx(5.0) and r["bracket"] == [0.5, 50.0]
    assert r["value"] == pytest.approx(10.0, rel=1e-6) and r["rides_per_day"] == pytest.approx(20_000, rel=1e-6)
    assert r["met_for"] == ">= value" and r["scaling"] == "vehicle-km per ride constant"
    # with the vehicle-km as simulated the total does not move: twice the rides halve the cost per ride
    r = required_rides_per_vehicle_hour(shuttle_daily_cost(o, p)["cost_per_ride"] / 2, o, p, scale_km=False)
    assert r["value"] == pytest.approx(10.0, rel=1e-6)
    # with the charging reserve the steps show up in the monotone flag instead of passing silently
    stepped = required_rides_per_vehicle_hour(shuttle_daily_cost(o.scaled(2.0), p)["cost_per_ride"], o, p)
    assert stepped["status"] == "solved" and stepped["monotone"] is False
    # energy and maintenance alone cost 0.5 per ride here (5,000 per 10,000 rides): no utilisation reaches 0.4
    r = required_rides_per_vehicle_hour(0.4, o, p)
    assert r["value"] is None and r["status"] == "not met in bracket"


def test_max_daily_cost_per_vehicle(p):
    o = day()
    r = max_daily_cost_per_vehicle(22_000.0, o, p)
    assert r["total_fleet"] == 110 and r["value"] == pytest.approx(200.0) and r["covers"] == list(CATEGORIES)
    now = shuttle_daily_cost(o, p)["total"]
    assert r["current"] == pytest.approx(now / 110)
    assert sum(r["current_by_category"].values()) == pytest.approx(r["current"])
    assert max_daily_cost_per_vehicle(now, o, p)["headroom"] == pytest.approx(0.0, abs=1e-9)


def test_swings_are_tidy_and_bracket_central(p):
    o = day()
    rows = swings(o, p)
    base = shuttle_daily_cost(o, p)["total"]
    assert len(rows) == 2 * len(SHUTTLE_IDS)
    assert all(r["central_result"] == pytest.approx(base) for r in rows)
    # every low_cost value of the fixture lowers cost, except vehicles per charger: fewer chargers cost
    # less but restore less energy overnight, so more vehicles charge by day (a real trade-off)
    assert all(r["direction_ok"] for r in rows if r["param_id"] != "vehicles_per_charger")
    assert not all(r["direction_ok"] for r in rows if r["param_id"] == "vehicles_per_charger")
    assert [r["range"] for r in rows] == sorted((r["range"] for r in rows), reverse=True)
    price = {r["side"]: r for r in rows if r["param_id"] == "veh_price"}
    assert (price["low"]["value"], price["high"]["value"], price["low"]["column"]) == (250_000, 400_000, "low_cost")
    eac = [equivalent_annual_cost(x, 8, 0.1, 0.05) for x in (250_000, 300_000)]
    assert price["low"]["delta"] == pytest.approx(110 * (eac[0] - eac[1]) / 365)
    lease = [r for r in rows if r["param_id"] == "lease_sgd_per_vehicle_year"]
    assert [r["delta"] for r in lease] == [0.0, 0.0]   # no swing where a parameter does not act
    json.dumps(rows)
    # swapped columns are flagged
    q = CostParams.from_dict(broken(lambda d: d["parameters"]["cleaning_sgd_per_vehicle_day"].update(
        low_cost=20, high_cost=10)))
    assert not any(r["direction_ok"] for r in swings(o, q, ["cleaning_sgd_per_vehicle_day"]))
