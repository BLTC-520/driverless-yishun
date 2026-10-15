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


def test_calibration_recovers_known_parameters():
    rng = np.random.default_rng(0)
    n = 600
    t_ff = rng.uniform(30, 400, n); n_sig = rng.integers(0, 6, n); gap = rng.integers(1, 7, n)
    n_hub = rng.binomial(1, 0.2, n) * np.minimum(gap, 1)
    true = dict(mult=0.9, sig_s=14.0, dwell_s=40.0, hub_extra_s=30.0)
    y = true["mult"] * t_ff + true["sig_s"] * n_sig + true["dwell_s"] * gap + true["hub_extra_s"] * n_hub
    seg = pd.DataFrame({"t_ff": t_ff, "n_sig": n_sig, "gap": gap, "n_hub": n_hub,
                        "median": y + rng.normal(0, 8, n), "count": rng.integers(5, 60, n), "used": True})
    res = fit(seg, n_boot=50)
    for k, v in true.items():
        assert res[k] == pytest.approx(v, rel=0.12), k
        lo, hi = res[f"{k}_ci"]
        assert lo <= v <= hi, k


def test_weekday_count():
    assert weekdays_in_month("202609") == 22


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
