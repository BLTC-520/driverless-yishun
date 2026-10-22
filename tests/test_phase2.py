"""Phase 2 service options on the synthetic grid: rule C-theta, one assignment per ride,
declined and refused rides, aggregate time savings, and the simulator's vehicle-hour counters."""
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from yishun.phase2 import assign
from yishun.phase2.runs import (REFUSED_WAIT_S, OptionSpec, by_group, by_hour, run_option, summarise,
                                treatment_totals)
from yishun.sim import SimConfig, Simulator


class StubBaseline:
    """Bus model stand-in: every pair served, the expected time set per test."""
    def __init__(self, wait_s=300.0, ivt_s=600.0):
        self.wait_s, self.ivt_s = wait_s, ivt_s
        self.p = SimpleNamespace(kappa=0.57)

    def expected(self, o, d, minute):
        return {"wait_s": self.wait_s, "ivt_s": self.ivt_s, "total_s": self.wait_s + self.ivt_s, "lines": ["x"]}


def toy_model(toy, baseline=None, key="toy"):
    R = toy["R"]
    S = len(R.codes)
    stops = pd.DataFrame({"SUBZONE_N": ["NORTH" if i % 2 else "SOUTH" for i in range(S)],
                          "Description": [f"stop {c}" for c in R.codes], "is_hub": [i == 0 for i in range(S)]},
                         index=R.codes)
    pairs = [(a, b) for a in R.codes[:6] for b in R.codes[6:12]]
    od = pd.DataFrame({"o": [a for a, _ in pairs], "d": [b for _, b in pairs], "hour": 7,
                       "rides_per_weekday": 2.0, "win_a": 0.0, "win_b": 3600.0})
    rates = np.zeros((24, S))
    return SimpleNamespace(R=R, stop_index=toy["stop_index"], study_idx=toy["study_idx"], hub_idx=toy["hub_idx"],
                           origin_rates=rates + 1e-4, stops=stops, od=od, baseline=baseline or StubBaseline(), key=key)


def toy_requests(M, n=120, seed=0, t0=7 * 3600, span=1800.0, no_bus=0):
    rng = np.random.default_rng(seed)
    pick = rng.integers(0, len(M.od), n)
    req = pd.DataFrame({"t": np.sort(t0 + rng.uniform(0, span, n)), "o": M.od.o.to_numpy()[pick],
                        "d": M.od.d.to_numpy()[pick], "hour": 7})
    i, j = req.o.map(M.stop_index).to_numpy(), req.d.map(M.stop_index).to_numpy()
    # bus: slow for some pairs (indirect), fast for others, so the rule splits the rides
    req["b_wait"] = 240.0
    req["b_ivt"] = M.R.T[i, j] * np.where(pick % 3 == 0, 4.0, 1.2) + 60.0
    req["b_total"] = req.b_wait + req.b_ivt
    req.loc[req.index[:no_bus], ["b_wait", "b_ivt", "b_total"]] = np.nan
    req["b_wait_draw"] = req.b_wait * rng.uniform(0, 2, n)
    req["b_total_draw"] = req.b_wait_draw + req.b_ivt
    req["is_hub_trip"] = req.o.eq(M.R.codes[0]) | req.d.eq(M.R.codes[0])
    return req


@pytest.fixture
def isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(assign, "INTERIM", tmp_path)


def test_offered_is_inclusive_and_excludes_missing_bus():
    g = np.array([np.nan, 479.9, 480.0, 600.0])
    assert assign.offered(g, 8).tolist() == [False, False, True, True]


def test_rule_never_uses_the_realised_bus_wait(toy):
    M = toy_model(toy)
    req = toy_requests(M)
    a = assign.offered(assign.ride_gap(M, req), 6)
    req2 = req.assign(b_wait_draw=req.b_wait_draw * 3.0, b_total_draw=req.b_total_draw * 3.0)
    b = assign.offered(assign.ride_gap(M, req2), 6)
    assert (a == b).all() and 0 < a.sum() < len(a)


def test_each_ride_assigned_once_and_declined_rides_take_the_bus(toy, isolated_cache):
    M = toy_model(toy)
    req = toy_requests(M, n=200, no_bus=5)
    out = run_option(M, req, OptionSpec("C", fleet=1, capacity=2, theta_min=2, w_max_s=300.0), seed=1)
    r = out["rides"]
    assert set(r["mode"]) <= {"bus", "shuttle", "declined"} and r.index.equals(req.index)
    assert (r.offered == r["mode"].isin(["shuttle", "declined"])).all()
    assert not r.offered[~r.cmp].any()                       # no bus option: never offered, never compared
    bus = r["mode"].isin(["bus", "declined"])
    assert np.allclose(r.total[bus & r.cmp], r.a_total[bus & r.cmp])
    assert (r["mode"] == "declined").sum() > 0               # one small vehicle cannot serve them all
    s = summarise(r)
    assert s["n_bus"] + s["n_shuttle"] + s["n_declined"] + s["n_refused"] == s["n"] == r.cmp.sum()
    assert s["n_offered"] == s["n_shuttle"] + s["n_declined"]
    # aggregate passenger-hours, the same rides on both sides
    c = r[r.cmp]
    assert s["saved_h"] == pytest.approx((c.a_total.sum() - c.total.sum()) / 3600)
    h = by_hour(r)
    assert h.n.sum() == s["n"] and h.pax_h.sum() == pytest.approx(s["pax_h"])
    g = by_group(r)
    assert g.n.sum() == s["n"] and g.pax_h_A.sum() == pytest.approx(s["pax_h_A"])
    assert g.n_shuttle.sum() == s["n_shuttle"] and g.gain_h.sum() == pytest.approx(s["saved_h"])


def test_declined_treatments(toy, isolated_cache):
    M = toy_model(toy)
    req = toy_requests(M, n=200)
    r = run_option(M, req, OptionSpec("C", fleet=1, capacity=2, theta_min=2, w_max_s=300.0), seed=1)["rides"]
    dec = r["mode"] == "declined"
    assert dec.any()
    assert np.allclose(treatment_totals(r, "R1")[dec], r.a_total[dec])
    assert np.allclose(treatment_totals(r, "R2")[dec], REFUSED_WAIT_S + r.direct_s[dec])
    assert np.allclose(treatment_totals(r, "R3")[dec], r.a_total[dec] + 300.0)
    s = summarise(r)
    assert s["saved_h_R2"] < s["saved_h_R3"] < s["saved_h"]


def test_full_replacement_refusals_are_penalised_not_dropped(toy):
    M = toy_model(toy)
    req = toy_requests(M, n=600, span=900.0)
    r = run_option(M, req, OptionSpec("B", fleet=1, capacity=1), seed=2)["rides"]
    ref = r["mode"] == "refused"
    assert ref.any() and set(r["mode"]) <= {"shuttle", "refused"} and r.offered.all()
    assert np.allclose(r.total[ref], REFUSED_WAIT_S + r.direct_s[ref])
    s = summarise(r)
    assert s["n_refused"] == int((ref & r.cmp).sum()) and s["n"] == r.cmp.sum()


def test_option_a_saves_nothing(toy):
    M = toy_model(toy)
    s = summarise(run_option(M, toy_requests(M), OptionSpec("A"), seed=1)["rides"])
    assert s["saved_h"] == 0 and s["n_bus"] == s["n"]


def test_offered_rates_are_the_expected_offered_demand(toy, isolated_cache):
    M = toy_model(toy, StubBaseline(wait_s=300.0, ivt_s=900.0))
    gaps = assign._cell_gaps(M).to_numpy()
    rates = assign.offered_rates(M, 0.0)
    expected = M.od.rides_per_weekday.to_numpy()[(gaps >= 0).all(axis=1)].sum()
    assert rates.sum() * 3600 == pytest.approx(expected)
    assert assign.offered_rates(M, 1e6).sum() == 0


def test_vehicle_hour_counters_match_a_single_ride(toy):
    R = toy["R"]
    o, d = R.codes[0], R.codes[5]
    req = pd.DataFrame({"t": [100.0], "o": [o], "d": [d], "hour": [0]})
    rates = toy["rates"].copy()
    rates[:, toy["stop_index"][o]] = 1.0
    cfg = SimConfig(fleet=1, capacity=4, rebalance="none", start_s=0.0)
    res = Simulator(R, toy["study_idx"], rates, toy["hub_idx"], cfg).run(req, toy["stop_index"])
    i, j = toy["stop_index"][o], toy["stop_index"][d]
    assert res.moving_h_by_hour.sum() * 3600 == pytest.approx(R.T[i, j])
    assert res.dwell_h_by_hour.sum() * 3600 == pytest.approx(2 * (cfg.d0 + cfg.d1))
