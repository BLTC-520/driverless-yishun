"""Property test: the numba insertion kernel must agree with an explicit brute-force reference."""
import numpy as np
import pytest

from yishun.insertion import eval_vehicle, reference_best


def _random_instance(rng, S=8, Nn=6):
    xy = rng.uniform(0, 2000, size=(S, 2))
    T = np.linalg.norm(xy[:, None] - xy[None], axis=-1) / 8.0 + rng.uniform(0, 20, (S, S))
    np.fill_diagonal(T, 0.0)
    TN = rng.uniform(10, 300, size=(Nn, S))
    return T, TN


def _random_schedule(rng, S, C, t0):
    # Build a consistent schedule: some riders already on board (only their dropoff remains),
    # others waiting (pickup then dropoff), with loose-to-tight deadlines.
    onboard = int(rng.integers(0, C + 1))
    events = []
    for _ in range(onboard):
        events.append([int(rng.integers(0, S)), -1])
    for _ in range(int(rng.integers(0, 3))):
        if onboard + 1 > C:
            break
        p, q = rng.integers(0, S, 2)
        events.insert(int(rng.integers(0, len(events) + 1)), [int(p), 1])
        k = next(i for i, e in enumerate(events) if e == [int(p), 1])
        events.insert(int(rng.integers(k + 1, len(events) + 1)), [int(q), -1])
    # keep capacity feasible
    load, ok = onboard, True
    for _, ty in events:
        load += ty
        ok &= load <= C
    if not ok:
        return None
    stops = np.array([e[0] for e in events], dtype=np.int64)
    types = np.array([e[1] for e in events], dtype=np.int64)
    dead = t0 + rng.uniform(100, 2500, size=len(events))
    return onboard, stops, types, dead


@pytest.mark.parametrize("seed", range(400))
def test_kernel_matches_reference(seed):
    rng = np.random.default_rng(seed)
    S, Nn = 8, 6
    T, TN = _random_instance(rng, S, Nn)
    C = int(rng.integers(1, 5))
    t0 = 1000.0
    sch = _random_schedule(rng, S, C, t0)
    if sch is None:
        pytest.skip("capacity-infeasible random schedule")
    onboard, stops, types, dead = sch
    anc_kind = int(rng.integers(0, 2))
    anc_id = int(rng.integers(0, Nn if anc_kind == 0 else S))
    anc_merge = bool(rng.integers(0, 2)) and anc_kind == 1
    o, d = rng.choice(S, 2, replace=False)
    direct = T[o, d]
    args = dict(o=int(o), d=int(d), t_req=t0, direct=direct, C=C, d0=20.0, d1=4.0, alpha=1.6, beta=180.0,
                w_other=1.0, w_veh=0.1, T=T, TN=TN)
    ref = reference_best(anc_kind, anc_id, t0 + 5.0, anc_merge, onboard, stops, types, dead, **args)
    fast = eval_vehicle(anc_kind, anc_id, t0 + 5.0, anc_merge, onboard, len(stops), stops, types, dead,
                        args["o"], args["d"], t0, direct, C, 20.0, 4.0, 1.6, 180.0, 1.0, 0.1, T, TN)
    assert (ref[1] == -1) == (fast[1] == -1)
    if ref[1] >= 0:
        # same optimal cost; ties may pick a different (i, j), so re-check the kernel's own
        # choice with the reference: it must be feasible with exactly the reported times.
        assert fast[0] == pytest.approx(ref[0], rel=1e-9, abs=1e-6)
        chk = reference_best(anc_kind, anc_id, t0 + 5.0, anc_merge, onboard, stops, types, dead,
                             only=(int(fast[1]), int(fast[2])), **args)
        assert chk[0] == pytest.approx(fast[0], rel=1e-9, abs=1e-6)
        assert chk[3] == pytest.approx(fast[3], abs=1e-6)
        assert chk[4] == pytest.approx(fast[4], abs=1e-6)


def test_idle_vehicle_direct_trip():
    T = np.array([[0.0, 100.0], [100.0, 0.0]])
    TN = np.zeros((1, 2))
    empty = np.zeros(0, dtype=np.int64)
    cost, i, j, ap, ad = eval_vehicle(1, 0, 50.0, False, 0, 0, empty, empty, np.zeros(0),
                                      0, 1, 50.0, 100.0, 4, 20.0, 4.0, 1.5, 120.0, 1.0, 0.0, T, TN)
    # pickup at the vehicle's own stop at t=50 (dwell 24 s), ride 100 s
    assert (i, j) == (0, 0)
    assert ap == pytest.approx(50.0)
    assert ad == pytest.approx(50.0 + 24.0 + 100.0)
    assert cost == pytest.approx(ad - 50.0)
