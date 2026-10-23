"""Bus baseline (common lines), calibration recovery, demand sampling, routing consistency."""
import numpy as np
import pandas as pd
import pytest

from yishun.busnet import BaselineParams, BusBaseline, Line, band_for_minute, parse_headway
from yishun.calibrate import fit
from yishun.demand import sample_requests, weekdays_in_month


def test_parse_headway_and_bands():
    assert parse_headway("5-8") == 6.5
    assert parse_headway("06-08") == 7.0
    assert parse_headway("-") is None and parse_headway("") is None
    assert band_for_minute(7 * 60) == "AM_Peak_Freq"
    assert band_for_minute(12 * 60) == "AM_Offpeak_Freq"
    assert band_for_minute(18 * 60) == "PM_Peak_Freq"
    assert band_for_minute(22 * 60) == "PM_Offpeak_Freq"


def _toy_lines():
    hw = {b: 10.0 for b in ("AM_Peak_Freq", "AM_Offpeak_Freq", "PM_Peak_Freq", "PM_Offpeak_Freq")}
    fl = {c: (0, 1439) for c in "ABC"}
    return [Line("1", 1, ["A", "B", "C"], [0, 1, 2], hw, fl), Line("2", 1, ["A", "C"], [0, 2], hw, fl)]


def test_common_lines_combines_frequencies():
    codes = ["A", "B", "C"]
    T = np.array([[0, 100, 300], [100, 0, 100], [300, 100, 0]], float)
    bb = BusBaseline(codes, T, _toy_lines(), BaselineParams(kappa=0.5, dwell_s=20.0))
    e = bb.expected("A", "C", 12 * 60)
    # line 1: 100 + 100 run + dwell at A and B = 240 s; line 2: 300 run + dwell at A = 320 s.
    # With line 1 alone: wait 0.5 * 600 = 300, total 540 > 320 -> line 2 is attractive too.
    f = 1 / 600
    assert e["wait_s"] == pytest.approx(0.5 / (2 * f))
    assert e["ivt_s"] == pytest.approx((240 + 320) / 2)
    assert set(e["lines"]) == {"1", "2"}


def test_figure_of_eight_boards_at_the_nearest_visit():
    # Service 812 runs a figure of eight through the interchange H: H a H b H. A rider from H to b
    # boards for the second loop, not a whole loop earlier; a rider from a to b rides through H.
    hw = {b: 10.0 for b in ("AM_Peak_Freq", "AM_Offpeak_Freq", "PM_Peak_Freq", "PM_Offpeak_Freq")}
    fl = {c: (0, 1439) for c in "Hab"}
    codes = ["H", "a", "b"]
    T = np.array([[0, 300, 120], [300, 0, 400], [120, 400, 0]], float)
    ln = Line("812", 1, ["H", "a", "H", "b", "H"], [0, 1, 2, 3, 4], hw, fl)
    bb = BusBaseline(codes, T, [ln], BaselineParams(kappa=0.5, dwell_s=20.0))
    assert bb.expected("H", "b", 12 * 60)["ivt_s"] == pytest.approx(120 + 20)
    assert bb.expected("H", "a", 12 * 60)["ivt_s"] == pytest.approx(300 + 20)
    assert bb.expected("a", "b", 12 * 60)["ivt_s"] == pytest.approx(300 + 20 + 120 + 20)
    assert bb.expected("b", "a", 12 * 60) is None   # a does not follow b on the run
    assert [l.service for l in bb._serving("H", "b")] == ["812"]


def test_real_loop_lines_board_at_the_nearest_visit(real_model):
    # Every pair on every line that revisits a stop (812 at Yishun Int 59009; 861, 883 and 883M at
    # 58621) is timed from the visit that gives the shortest ride, checked against brute force.
    M = real_model
    seen = set()
    for ln, pos, cum in M.baseline.segments:
        if len(set(ln.stops)) == len(ln.stops):
            continue
        seen.add(ln.service)
        for o in set(ln.stops):
            for d in set(ln.stops) - {o}:
                brute = [cum[j] - cum[i] for i, a in enumerate(ln.stops) for j, b in enumerate(ln.stops)
                         if a == o and b == d and j > i]
                ij = BusBaseline.ride(pos, cum, o, d)
                if not brute:
                    assert ij is None
                elif np.isfinite(min(brute)):
                    assert cum[ij[1]] - cum[ij[0]] == pytest.approx(min(brute))
    assert {"812", "861", "883", "883M"} <= seen
    # Yishun Int -> Blk 121: the second loop of 812, not the whole first loop as well
    ivt = [cum[j] - cum[i] for ln, pos, cum in M.baseline.segments if ln.service == "812"
           for i, j in [BusBaseline.ride(pos, cum, "59009", "59121") or (0, 0)]]
    assert 0 < max(ivt) < 15 * 60


def test_calibration_estimator_recovers_known_parameters():
    """Software check of the estimator (not a validation of the model): data generated from the
    model's own form with known parameters must be recovered, with intervals covering them."""
    rng = np.random.default_rng(0)
    n = 600
    t_ff = rng.uniform(30, 400, n); n_sig = rng.integers(0, 6, n); gap = rng.integers(1, 7, n)
    n_hub = rng.binomial(1, 0.2, n) * np.minimum(gap, 1)
    true = dict(mult=0.9, sig_s=14.0, dwell_s=40.0, hub_extra_s=30.0)
    y = true["mult"] * t_ff + true["sig_s"] * n_sig + true["dwell_s"] * gap + true["hub_extra_s"] * n_hub
    seg = pd.DataFrame({"t_ff": t_ff, "n_sig": n_sig, "gap": gap, "n_hub": n_hub,
                        "median": y + rng.normal(0, 8, n), "count": rng.integers(5, 60, n), "used": True,
                        "cluster": rng.integers(0, 40, n).astype(str), "net_m": t_ff * 11.0})
    res = fit(seg, n_boot=50)
    for k, v in true.items():
        assert res[k] == pytest.approx(v, rel=0.12), k
        lo, hi = res[f"{k}_ci"]
        assert lo <= v <= hi, k
    assert len(res["boot"]) == 50
    # held-out services: the true model form must beat a distance-only line on these data
    ho = res["holdout_services"]
    assert ho["model"]["mae_s"] < ho["distance_only"]["mae_s"]


def test_weekday_count():
    assert weekdays_in_month("202609") == 22
    assert weekdays_in_month("202607") == 23
    assert weekdays_in_month("202608") == 20   # 10 Aug 2026: National Day holiday (observed)


def test_sampling_respects_service_windows():
    od = pd.DataFrame({"o": ["A"], "d": ["B"], "hour": [5], "rides_per_weekday": [500.0],
                       "win_a": [1800.0], "win_b": [3600.0]})
    r = sample_requests(od, [5], seed=3)
    assert len(r) > 400 and (r.t >= 5 * 3600 + 1800).all() and (r.t < 6 * 3600).all()


def test_bus_wait_draws_match_expected_waits():
    from yishun.experiments import bus_wait_draws
    rng = np.random.default_rng(0)
    b = np.full(200_000, 300.0)
    for kappa in (0.5, 0.556, 0.75, 1.0):
        w = bus_wait_draws(b, kappa, rng)
        assert w.mean() == pytest.approx(300.0, rel=0.01), kappa
        assert (w >= 0).all()
    # exponential headways (kappa = 1): waits are exponential too, so P(W > mean) = e^-1
    w = bus_wait_draws(b, 1.0, rng)
    assert (w > 300).mean() == pytest.approx(np.exp(-1), abs=0.01)
    assert np.isnan(bus_wait_draws(np.array([np.nan]), 0.6, rng)).all()


def test_service_window_follows_first_bus():
    codes = ["A", "B", "C"]
    T = np.array([[0, 100, 300], [100, 0, 100], [300, 100, 0]], float)
    lines = _toy_lines()
    for ln in lines:
        ln.first_last = {c: (5 * 60 + 30, 23 * 60) for c in ln.stops}
    bb = BusBaseline(codes, T, lines, BaselineParams())
    assert bb.service_window("A", "C", 5) == (1800.0, 3600.0)
    assert bb.service_window("A", "C", 12) == (0.0, 3600.0)
    assert bb.service_window("A", "C", 23) == (0.0, 60.0)
    assert bb.service_window("C", "A", 12) is None


def test_keeps_up_compares_the_same_riders():
    from yishun.experiments import keeps_up
    r = pd.DataFrame({"hour": [7] * 4, "refused": [False] * 4, "total": [300.0, 300.0, 300.0, 3000.0],
                      "b_total": [400.0, 400.0, 400.0, np.nan]})
    ok, sh, bus, ref = keeps_up(r, 7)
    assert ok and sh == 300.0 and bus == 400.0 and ref == 0.0


def test_poisson_sampling_matches_rates():
    od = pd.DataFrame({"o": ["A"] * 3, "d": ["B"] * 3, "hour": [7, 8, 9], "rides_per_weekday": [100.0, 50.0, 10.0]})
    counts = np.array([sample_requests(od, [7, 8, 9], seed=s).groupby("hour").size().reindex([7, 8, 9], fill_value=0)
                       for s in range(200)])
    assert counts.mean(axis=0) == pytest.approx([100, 50, 10], rel=0.05)
    r = sample_requests(od, [7], seed=1)
    assert ((r.t >= 7 * 3600) & (r.t < 8 * 3600)).all() and r.t.is_monotonic_increasing


def test_real_network_times_match_networkx(real_model):
    from yishun.network import stop_network, travel_time_matrix
    from yishun.model import default_cal
    net = stop_network(cal=default_cal())
    T, D, _ = travel_time_matrix(net)
    R = real_model.R
    assert np.abs(R.T - T).max() < 1e-6
    assert np.abs(R.Dm - D).max() < 1e-3


def test_real_baseline_covers_observed_rides(real_model):
    M = real_model
    od = M.od[M.od.hour == 12]
    missing = sum(r.rides_per_weekday for r in od.itertuples() if M.baseline.expected(r.o, r.d, 12 * 60 + 30) is None)
    assert missing / od.rides_per_weekday.sum() < 0.02


def test_keeps_up_hour_without_bus_option():
    from yishun.experiments import keeps_up
    r = pd.DataFrame({"hour": [4, 4], "refused": [False, False], "total": [600.0, 700.0], "b_total": [np.nan, np.nan]})
    assert keeps_up(r, 4)[0]
    r.loc[0, "refused"] = True
    assert not keeps_up(r, 4)[0]


@pytest.mark.parametrize("true", [None, 250, 300, 375, 425, 450, 600, 800])
def test_bracket_search_finds_smallest_passing_fleet(true):
    from yishun.sensitivity import FLEETS, bracket_search
    ok = lambda n: true is not None and n >= true  # noqa: E731
    expected = None if true is None else min(f for f in FLEETS if f >= true)
    assert bracket_search(FLEETS, ok) == expected
