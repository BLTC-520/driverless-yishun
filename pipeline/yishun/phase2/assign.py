"""Option C's service rule: which rides are offered a shuttle.

Rule C-theta ("timetable gap"). A ride from stop o to stop d requested at minute t is offered a
shuttle when the bus is expected to be slow for it. The test: the expected bus stop-to-stop
time E[wait] + E[in-vehicle] exceeds the direct road time T[o, d] plus the shuttle's two stops by
at least theta minutes.
  * E[wait] + E[in-vehicle] is the bus model's value at that minute, built from LTA's published
    routes, headway bands and first/last-bus times. It is the same value Option A uses for the ride.
  * All inputs are known before the passenger travels; eligibility is a published table of stop
    pair x time of day. The realised (simulated) bus wait is never used.
  * Rides with no bus option are not offered a shuttle; they are outside every comparison.

The gap is computed on a *planning* model. Stress tests change roads or dwell in the model that
is simulated, but keep the eligibility table that was planned on the base case.
"""
from __future__ import annotations

import hashlib
import os

import numpy as np
import pandas as pd

from ..paths import INTERIM
from ..sim import SimConfig

# a shuttle ride with no wait and no detour still stops twice: d0 + d1 to board, d0 + d1 to alight
SHUTTLE_STOPS_S = 2 * (SimConfig.d0 + SimConfig.d1)
GAP_SAMPLES = 6     # minutes sampled per (stop pair, hour) cell for the operator's expected rates


def ride_gap(M, req: pd.DataFrame) -> np.ndarray:
    """Timetable gap (s) of each ride: expected bus time minus a direct shuttle ride (NaN when
    the bus model has no option). `req` carries the bus model's expected time b_total."""
    i = req.o.map(M.stop_index).to_numpy()
    j = req.d.map(M.stop_index).to_numpy()
    return req.b_total.to_numpy(float) - (M.R.T[i, j] + SHUTTLE_STOPS_S)


def offered(gap: np.ndarray, theta_min: float) -> np.ndarray:
    """Rule C-theta: offered a shuttle when the gap is at least theta minutes."""
    return np.isfinite(gap) & (gap >= theta_min * 60.0)


def _cell_gaps(M) -> pd.DataFrame:
    """Gap at GAP_SAMPLES evenly spaced minutes inside each OD cell's service window (the part of
    the hour in which a bus serving the pair runs), cached per model."""
    path = INTERIM / f"cellgaps_{M.key}_{GAP_SAMPLES}.parquet"
    if path.exists():
        return pd.read_parquet(path)
    od = M.od
    frac = (np.arange(GAP_SAMPLES) + 0.5) / GAP_SAMPLES
    rows = np.empty((len(od), GAP_SAMPLES))
    T = M.R.T
    for k, r in enumerate(od.itertuples()):
        direct = T[M.stop_index[r.o], M.stop_index[r.d]] + SHUTTLE_STOPS_S
        for s, f in enumerate(frac):
            minute = (r.hour * 3600 + r.win_a + f * (r.win_b - r.win_a)) / 60.0
            e = M.baseline.expected(r.o, r.d, minute)
            rows[k, s] = e["total_s"] - direct if e else np.nan
    out = pd.DataFrame(rows, columns=[f"g{s}" for s in range(GAP_SAMPLES)])
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    out.to_parquet(tmp)
    os.replace(tmp, path)        # atomic: a worker never reads a half-written cache
    return out


def offered_rates(M, theta_min: float) -> np.ndarray:
    """(24, S) expected shuttle requests per second by clock hour and origin stop under rule
    C-theta, i.e. what the operator knows in advance about shuttle demand (used for the initial
    fleet positions and for repositioning, as Phase 1 uses the expected rates of all rides)."""
    g = _cell_gaps(M).to_numpy()
    share = (np.nan_to_num(g, nan=-np.inf) >= theta_min * 60.0).mean(axis=1)   # no bus option: not offered
    od = M.od
    rates = np.zeros((24, len(M.R.codes)))
    w = od.rides_per_weekday.to_numpy() * share / 3600.0
    np.add.at(rates, (od.hour.to_numpy() % 24, od.o.map(M.stop_index).to_numpy()), w)
    return rates


def table_digest(gap: np.ndarray, theta_min: float) -> str:
    """Short digest of an eligibility vector, so runs can prove they used the same table."""
    return hashlib.sha1(np.packbits(offered(gap, theta_min)).tobytes()).hexdigest()[:10]
