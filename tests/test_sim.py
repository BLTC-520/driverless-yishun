"""Simulator behaviour on a synthetic grid where every time can be computed by hand,
plus conservation invariants on random demand."""
import numpy as np
import pandas as pd
import pytest

from yishun.sim import SimConfig, Simulator


def run_sim(toy, req, **kw):
    cfg = SimConfig(**{"fleet": 1, "capacity": 4, "rebalance": "none", "start_s": 0.0, "record_legs": True, **kw})
    rates = toy["rates"].copy()
    rates[:, toy["stop_index"][req.o.iloc[0]]] = 1.0  # vehicles start at the first rider's stop
    sim = Simulator(toy["R"], toy["study_idx"], rates, toy["hub_idx"], cfg)
    return sim.run(req, toy["stop_index"]), cfg


def test_single_ride_exact_times(toy):
    R = toy["R"]
    o, d = R.codes[0], R.codes[5]
    req = pd.DataFrame({"t": [100.0], "o": [o], "d": [d], "hour": [0]})
    res, cfg = run_sim(toy, req)
    r = res.requests.iloc[0]
    i, j = toy["stop_index"][o], toy["stop_index"][d]
    # idle at the origin: boards immediately, full dwell, then drives direct
    assert r.t_pick == pytest.approx(100.0)
    assert r.t_drop == pytest.approx(100.0 + cfg.d0 + cfg.d1 + R.T[i, j])
    assert r.wait == pytest.approx(0.0)


def test_capacity_one_serialises_riders(toy):
    R = toy["R"]
    o, d = R.codes[0], R.codes[7]
    req = pd.DataFrame({"t": [100.0, 101.0], "o": [o, o], "d": [d, d], "hour": [0, 0]})
    res, _ = run_sim(toy, req, capacity=1)
    r = res.requests.sort_values("t")
    assert r.t_pick.iloc[1] >= r.t_drop.iloc[0]  # second rider boards only after the first alights


def test_pooling_shares_a_vehicle(toy):
    R = toy["R"]
    o, d = R.codes[0], R.codes[7]
    req = pd.DataFrame({"t": [100.0, 101.0], "o": [o, o], "d": [d, d], "hour": [0, 0]})
    res, cfg = run_sim(toy, req, capacity=4)
    r = res.requests
    assert (r.veh == r.veh.iloc[0]).all()
    assert r.t_drop.max() - r.t_drop.min() < 1e-6  # both alight on the same visit


def test_invariants_random_demand(toy):
    R = toy["R"]
    rng = np.random.default_rng(3)
    n = 400
    o = rng.choice(R.codes, n); d = rng.choice(R.codes, n)
    keep = o != d
    req = pd.DataFrame({"t": np.sort(rng.uniform(0, 3600, n))[keep], "o": o[keep], "d": d[keep], "hour": 0})
    req = req.reset_index(drop=True)
    res, cfg = run_sim(toy, req, fleet=6, capacity=3, rebalance="none")
    r = res.requests
    served = r[~r.refused]
    assert served.t_pick.notna().all() and served.t_drop.notna().all()
    assert (served.t_pick >= served.t - 1e-6).all()
    assert (served.t_drop > served.t_pick).all()
    # ride never exceeds the promise rule: alpha * direct + beta + allowed slip
    assert (served.ride <= cfg.alpha * served.direct + cfg.beta + cfg.lateness + cfg.d0 + 4 * cfg.d1 + 1e-6).all()
    # occupancy never exceeds capacity: reconstruct load per vehicle from boarding/alighting events
    ev = pd.concat([served[["veh", "t_pick"]].rename(columns={"t_pick": "time"}).assign(delta=1),
                    served[["veh", "t_drop"]].rename(columns={"t_drop": "time"}).assign(delta=-1)])
    ev = ev.sort_values(["veh", "time", "delta"])  # alight before board at the same instant
    load = ev.groupby("veh").delta.cumsum()
    assert load.max() <= cfg.capacity
    # each vehicle's legs are sequential in time
    legs = sorted(res.legs, key=lambda L: (L.v, L.t[0]))
    for a, b in zip(legs[:-1], legs[1:]):
        if a.v == b.v:
            end_a = a.cut_t if a.cut_t is not None else a.t[-1]
            assert b.t[0] >= end_a - 1e-6


def test_same_seed_same_result(toy):
    R = toy["R"]
    rng = np.random.default_rng(5)
    o = rng.choice(R.codes, 150); d = rng.choice(R.codes, 150)
    keep = o != d
    req = pd.DataFrame({"t": np.sort(rng.uniform(0, 1800, 150))[keep], "o": o[keep], "d": d[keep], "hour": 0})
    a, _ = run_sim(toy, req.reset_index(drop=True), fleet=4)
    b, _ = run_sim(toy, req.reset_index(drop=True), fleet=4)
    pd.testing.assert_frame_equal(a.requests, b.requests)


def test_berth_limit_queues_second_vehicle(toy):
    """Two capacity-1 shuttles leave the same stop together for the same destination. Without
    a kerb limit they alight together; with one berth the second must wait for the first's
    dwell (d0 + d1) and the queue is logged."""
    R = toy["R"]
    o, d = R.codes[0], R.codes[9]
    req = pd.DataFrame({"t": [100.0, 100.0], "o": [o, o], "d": [d, d], "hour": [0, 0]})
    group = np.full(len(R.codes), -1)
    group[toy["stop_index"][d]] = 0
    rates = toy["rates"].copy()
    rates[:, toy["stop_index"][o]] = 1.0          # both vehicles start at the origin
    out = {}
    for berths in (None, 1):
        cfg = SimConfig(fleet=2, capacity=1, rebalance="none", start_s=0.0, berths=berths, seed=4)
        sim = Simulator(R, toy["study_idx"], rates, toy["hub_idx"], cfg, stop_group=group)
        out[berths] = sim.run(req, toy["stop_index"])
    free, limited = out[None].requests, out[1].requests
    assert free.veh.nunique() == 2 and limited.veh.nunique() == 2
    a0, b0 = sorted(free.t_drop)
    assert b0 == pytest.approx(a0)              # separate vehicles board in parallel and arrive together
    a, b = sorted(limited.t_drop)
    cfg = SimConfig()
    assert a == pytest.approx(a0)               # the first vehicle is unaffected
    assert b == pytest.approx(a + cfg.d0 + cfg.d1)  # the second waits for the berth
    assert len(out[1].hub_queue) == 1


def test_berth_limit_with_simultaneous_arrivals(toy):
    """Two vehicles arriving at a one-berth stop at the same instant: the second starts its
    dwell exactly when the first ends it."""
    from yishun.sim import ARRIVE
    R = toy["R"]
    d = R.codes[9]
    di = toy["stop_index"][d]
    group = np.full(len(R.codes), -1)
    group[di] = 0
    cfg = SimConfig(fleet=2, capacity=4, rebalance="none", start_s=0.0, berths=1)
    sim = Simulator(R, toy["study_idx"], toy["rates"], toy["hub_idx"], cfg, stop_group=group)
    sim.r_pick = np.full(2, np.nan); sim.r_drop = np.full(2, np.nan)
    # two vehicles, each carrying one rider who alights at d
    for v, rid in ((0, 0), (1, 1)):
        sim.stop[v] = di; sim.st[v] = 1; sim.onboard[v] = 1
        sim.ev_stop[v, 0] = di; sim.ev_type[v, 0] = -1; sim.ev_rid[v, 0] = rid; sim.n_ev[v] = 1
    sim._on_arrive(0, 500.0)
    sim._on_arrive(1, 500.0)
    assert sim.r_drop[0] == pytest.approx(500.0)
    assert sim.r_drop[1] == pytest.approx(500.0 + cfg.d0 + cfg.d1)
    assert len(sim.hub_queue) == 1


def test_berth_release_moves_when_a_rider_joins(toy):
    """A rider who joins a dwelling shuttle extends its dwell by d1; with one berth, the next
    shuttle must not start boarding until the extended dwell ends."""
    from yishun.sim import MOVING
    R = toy["R"]
    S = len(R.codes)
    H, D = 0, 9
    group = np.full(S, -1)
    group[toy["hub_idx"]] = 0
    cfg = SimConfig(fleet=2, capacity=4, rebalance="none", start_s=0.0, berths=1)
    sim = Simulator(R, toy["study_idx"], np.zeros((24, S)), toy["hub_idx"], cfg, stop_group=group)
    sim.r_t = np.array([0.0, 110.0, 0.0]); sim.r_o = np.array([H, H, H]); sim.r_d = np.array([D, D, D])
    sim.r_pick = np.full(3, np.nan); sim.r_drop = np.full(3, np.nan)
    sim.r_veh = np.full(3, -1); sim.r_promise = np.full(3, np.nan); sim.r_reason = np.zeros(3, np.int64)
    for v, rid in ((0, 0), (1, 2)):
        sim.stop[v] = H; sim.st[v] = MOVING; sim.onboard[v] = 1; sim.n_ev[v] = 1
        sim.ev_stop[v, 0] = H; sim.ev_type[v, 0] = -1; sim.ev_rid[v, 0] = rid; sim.r_veh[rid] = v
    assert H in toy["hub_idx"]
    sim._on_arrive(0, 100.0)                      # A drops off: dwell 100 -> 100 + d0 + d1
    sim._insert(0, 0, 0, 1, 124.0, 184.0, 110.0)  # a rider joins A's dwell at 110 s
    assert sim.t_free[0] == pytest.approx(100.0 + cfg.d0 + 2 * cfg.d1)
    sim._on_arrive(1, 126.0)                      # B arrives while A still holds the only berth
    assert sim.dwell_start[1] == pytest.approx(sim.t_free[0])


@pytest.mark.parametrize("mode", ["none", "demand", "berths"])
def test_fuzz_invariants_with_repositioning(toy, mode):
    """Random fleets, capacities and demand, with and without demand-led repositioning and
    kerb limits: rider accounting, capacity, leg continuity, km identity, berth limits."""
    R = toy["R"]
    S = len(R.codes)
    codes = np.array(R.codes)
    hub_idx = toy["hub_idx"]
    for seed in range(12):
        rng = np.random.default_rng(1000 + seed)
        berths = int(rng.integers(1, 3)) if mode == "berths" else None
        group = np.full(S, -1)
        if berths is not None:
            group[hub_idx] = 0
        n = int(rng.integers(60, 250))
        o = rng.choice(codes, n); d = rng.choice(codes, n); keep = o != d
        req = pd.DataFrame({"t": np.sort(rng.uniform(0, 1800, n))[keep], "o": o[keep], "d": d[keep],
                            "hour": 0}).reset_index(drop=True)
        rates = rng.uniform(0, 0.05, size=(24, S))
        cfg = SimConfig(fleet=int(rng.integers(2, 9)), capacity=int(rng.integers(1, 5)),
                        rebalance="none" if mode == "none" else "demand", start_s=0.0, record_legs=True,
                        berths=berths, seed=seed)
        res = Simulator(R, np.arange(S), rates, hub_idx, cfg, stop_group=group).run(req, toy["stop_index"])
        r = res.requests
        served = r[~r.refused]
        assert ((r.veh == -2) == r.refused).all()
        assert served.t_pick.notna().all() and served.t_drop.notna().all() and r[r.refused].t_pick.isna().all()
        assert ((r.refuse_reason > 0) == r.refused).all()
        assert (served.t_pick >= served.t - 1e-6).all() and (served.t_drop > served.t_pick).all()
        assert (served.ride >= served.direct - 1e-6).all()
        ev = pd.concat([served[["veh", "t_pick"]].rename(columns={"t_pick": "time"}).assign(delta=1),
                        served[["veh", "t_drop"]].rename(columns={"t_drop": "time"}).assign(delta=-1)])
        load = ev.sort_values(["veh", "time", "delta"]).groupby("veh").delta.cumsum()
        assert load.max() <= cfg.capacity and load.min() >= 0
        assert res.veh_km_by_hour.sum() == pytest.approx(res.veh_km_loaded + res.veh_km_empty)
        assert not any(L.rebal and L.onboard > 0 for L in res.legs)
        if mode != "berths":   # without kerb queues, promises slip by at most `lateness`
            assert (served.t_pick - served.promise <= cfg.lateness + 1e-6).all()
        legs = sorted(res.legs, key=lambda L: (L.v, L.t[0]))
        for a, b in zip(legs[:-1], legs[1:]):
            if a.v != b.v:
                continue
            end_a = a.t[-1] if a.cut_t is None else a.cut_t
            ends = [a.pts[-1]] if a.cut_t is None else [a.pts[k] for k in np.flatnonzero(np.isclose(a.t, a.cut_t))]
            assert b.t[0] >= end_a - 1e-6 and b.pts[0] in ends
        if berths is not None:
            iv = res.hub_visits[res.hub_visits.stop.isin(hub_idx)]
            evs = sorted([(x, 1) for x in iv.t_arrive] + [(y, -1) for y in iv.t_depart], key=lambda z: (z[0], z[1]))
            conc = mx = 0
            for _, dl in evs:
                conc += dl
                mx = max(mx, conc)
            assert mx <= berths
