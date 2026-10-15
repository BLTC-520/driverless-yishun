"""Event-driven simulation of a pooled, stop-based, on-demand shuttle fleet.

Every observed ride (origin stop -> destination stop, request time) must be served; there
are no rejections, so an undersized fleet shows up as long waits rather than refused trips
(today's buses also carry everyone). Requests are assigned immediately on arrival by the
cheapest feasible insertion (see insertion.py) among candidate vehicles. Vehicles can be
re-routed at any road-network node. Idle vehicles optionally reposition towards stops with
high expected demand (expected = observed average-weekday hourly rates, i.e. the operator
knows typical demand but not the realised requests).
"""
from __future__ import annotations

import heapq
from bisect import bisect_left
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .insertion import _times, best_over_candidates
from .routing import Routing, node_path_to_stop

ARRIVE, DEPART, REBAL, REQUEST = 0, 1, 2, 3
IDLE, MOVING, DWELL = 0, 1, 2


@dataclass
class SimConfig:
    fleet: int = 200
    capacity: int = 10
    d0: float = 20.0            # fixed dwell per stop visit: pull in, doors, pull out (s)
    d1: float = 4.0             # per boarding or alighting rider (s)
    alpha: float = 1.6          # max in-vehicle time = alpha * direct + beta
    beta: float = 240.0
    lateness: float = 300.0     # a promised pickup/dropoff may later slip by at most this (s)
    w_other: float = 1.0        # weight of delays imposed on already-assigned riders
    w_veh: float = 0.1          # weight of extra vehicle time
    k_eta: int = 24             # candidates nearest (by ETA) to the pickup
    k_end: int = 8              # candidates with the earliest end of schedule
    max_events: int = 96
    max_wait_reject: float = 2700.0   # a rider whose best pickup is > 45 min away is refused
    rebalance: str = "demand"   # "demand" | "none"
    rebalance_every: float = 60.0
    rebalance_horizon: float = 900.0
    rebalance_max_tt: float = 600.0
    start_s: float = 4.5 * 3600
    seed: int = 0
    record_legs: bool = False
    berths: int | None = None   # shuttles that can board/alight at once per station (None = no limit)


@dataclass
class Leg:
    v: int
    t: np.ndarray        # times at points
    pts: list            # ("stop", s) / ("node", n) markers, aligned with t
    dist: np.ndarray     # cumulative metres at points
    onboard: int
    rebal: bool
    cut_t: float | None = None   # set when the vehicle was re-routed before the end


@dataclass
class SimResult:
    requests: pd.DataFrame
    veh_km_loaded: float
    veh_km_empty: float
    veh_km_by_hour: np.ndarray            # (26,) metres driven per hour of day
    pax_km: float
    hub_visits: pd.DataFrame              # stop, t_arrive, t_depart (dwell intervals at hubs)
    hub_idle: pd.DataFrame                # stop, t_start, t_end (idle vehicles staging at hubs)
    legs: list = field(default_factory=list)
    hub_queue: pd.DataFrame | None = None  # stop, t_arrive, t_berth (waits for a free berth)


class Simulator:
    def __init__(self, R: Routing, study_idx: np.ndarray, origin_rates: np.ndarray, hub_idx: np.ndarray,
                 cfg: SimConfig, stop_group: np.ndarray | None = None):
        """origin_rates: (24, S) expected requests per second by hour and origin stop."""
        self.R, self.cfg = R, cfg
        self.study_idx = study_idx
        self.rates = origin_rates
        self.hub = np.zeros(len(R.codes), bool)
        self.hub[hub_idx] = True
        N, L = cfg.fleet, cfg.max_events
        self.N = N
        self.st = np.zeros(N, np.int64)
        self.stop = np.zeros(N, np.int64)          # current stop (idle/dwell) or leg target (moving)
        self.t_free = np.zeros(N)                  # dwell end
        self.onboard = np.zeros(N, np.int64)
        self.version = np.zeros(N, np.int64)
        self.n_ev = np.zeros(N, np.int64)
        self.ev_stop = np.zeros((N, L), np.int64)
        self.ev_type = np.zeros((N, L), np.int64)
        self.ev_rid = np.zeros((N, L), np.int64)
        self.ev_dead = np.zeros((N, L))
        self.plan_end_t = np.zeros(N)
        self.plan_end_stop = np.zeros(N, np.int64)
        self.leg: list[Leg | None] = [None] * N
        self.leg_arr = np.zeros(N)
        self.leg_rebal = np.zeros(N, bool)
        self.dwell_start = np.zeros(N)
        self.heap: list = []
        self._seq = 0
        self.km_loaded = 0.0
        self.km_empty = 0.0
        self.km_by_hour = np.zeros(26)
        self.pax_m = 0.0
        self.hub_visits: list[tuple[int, float, float]] = []
        self.hub_idle: list[tuple[int, float, float]] = []
        self.idle_since = np.full(N, np.nan)
        # kerb capacity: stop -> station group (-1 = unlimited); one heap of berth release times per group
        self.stop_group = stop_group if stop_group is not None else np.full(len(R.codes), -1)
        self.berth_heaps: dict[int, list[float]] = {}
        self.hub_queue: list[tuple[int, float, float]] = []
        self.legs_out: list[Leg] = []

    # ------------------------------------------------------------------ helpers
    def _push(self, t, kind, a, ver=0):
        self._seq += 1
        heapq.heappush(self.heap, (t, kind, self._seq, a, ver))

    def _make_leg(self, v, t0, start, target, rebal):
        """start = ("stop", s) or ("node", n). Returns the Leg and its arrival time."""
        R = self.R
        kind, sid = start
        ts, pts, ds = [t0], [start], [0.0]
        if kind == "stop":
            a = sid
            same_edge = (R.stop_u[a] == R.stop_u[target] and R.stop_v[a] == R.stop_v[target]
                         and R.stop_frac[target] >= R.stop_frac[a])
            if same_edge:
                dt = (R.stop_frac[target] - R.stop_frac[a]) * R.stop_edge_tt[a]
                dd = (R.stop_frac[target] - R.stop_frac[a]) * R.stop_edge_len[a]
                ts.append(t0 + dt); pts.append(("stop", target)); ds.append(dd)
                return Leg(v, np.array(ts), pts, np.array(ds), int(self.onboard[v]), rebal), t0 + dt
            t = t0 + (1 - R.stop_frac[a]) * R.stop_edge_tt[a]
            d = (1 - R.stop_frac[a]) * R.stop_edge_len[a]
            n0 = int(R.stop_v[a])
            ts.append(t); pts.append(("node", n0)); ds.append(d)
        else:
            n0, t, d = sid, t0, 0.0
        path = node_path_to_stop(R, n0, target)
        for x, y in zip(path[:-1], path[1:]):
            t += R.edge_tt[(x, y)]
            d += R.edge_len[(x, y)]
            ts.append(t); pts.append(("node", y)); ds.append(d)
        t += R.stop_frac[target] * R.stop_edge_tt[target]
        d += R.stop_frac[target] * R.stop_edge_len[target]
        ts.append(t); pts.append(("stop", target)); ds.append(d)
        return Leg(v, np.array(ts), pts, np.array(ds), int(self.onboard[v]), rebal), t

    def _close_leg(self, v, t_end, idx_end=None):
        """Account distance of the vehicle's current leg up to point idx_end (or the end)."""
        lg = self.leg[v]
        if lg is None:
            return
        k = len(lg.t) - 1 if idx_end is None else idx_end
        dist = lg.dist[k]
        if lg.onboard > 0:
            self.km_loaded += dist
            self.pax_m += dist * lg.onboard
        else:
            self.km_empty += dist
        # attribute metres to hours by the leg's time span (piecewise)
        for a in range(k):
            h = int(lg.t[a] // 3600)
            if 0 <= h < 26:
                self.km_by_hour[h] += lg.dist[a + 1] - lg.dist[a]
        if self.cfg.record_legs:
            cut = float(lg.t[k]) if idx_end is not None else None
            self.legs_out.append(Leg(v, lg.t, lg.pts, lg.dist, lg.onboard, lg.rebal, cut))
        self.leg[v] = None

    def _begin_idle(self, v, t):
        self.st[v] = IDLE
        if self.hub[self.stop[v]]:
            self.idle_since[v] = t

    def _end_idle(self, v, t):
        if self.st[v] == IDLE and not np.isnan(self.idle_since[v]):
            if t > self.idle_since[v]:
                self.hub_idle.append((int(self.stop[v]), float(self.idle_since[v]), float(t)))
            self.idle_since[v] = np.nan

    def _start_leg(self, v, t0, start, target, rebal=False):
        self._end_idle(v, t0)
        lg, t_arr = self._make_leg(v, t0, start, target, rebal)
        self.leg[v] = lg
        self.leg_arr[v] = t_arr
        self.leg_rebal[v] = rebal
        self.st[v] = MOVING
        self.stop[v] = target
        self.version[v] += 1
        self._push(t_arr, ARRIVE, v, self.version[v])

    def _anchor(self, v, t):
        """(kind, id, time, merge) - where vehicle v can next change course."""
        if self.st[v] == IDLE:
            return 1, self.stop[v], t, False
        if self.st[v] == DWELL:
            return 1, self.stop[v], max(self.t_free[v], t), True
        lg = self.leg[v]
        k = bisect_left(lg.t, t)
        # skip the leg's start marker; a stop marker at the end means "committed to arrive"
        while k < len(lg.t) and lg.pts[k][0] != "node":
            if k == len(lg.t) - 1:
                return 1, self.stop[v], self.leg_arr[v], False
            k += 1
        if k >= len(lg.t):
            return 1, self.stop[v], self.leg_arr[v], False
        return 0, lg.pts[k][1], lg.t[k], False

    def _recompute_plan_end(self, v, t):
        n = self.n_ev[v]
        if n == 0:
            self.plan_end_t[v] = self.t_free[v] if self.st[v] == DWELL else (
                self.leg_arr[v] if self.st[v] == MOVING else t)
            self.plan_end_stop[v] = self.stop[v]
            return
        kind, aid, at, merge = self._anchor(v, t)
        A = np.empty(n); Dp = np.empty(n)
        _times(kind, aid, at, merge, n, self.ev_stop[v, :n], self.R.T, self.R.TN, self.cfg.d0, self.cfg.d1, A, Dp)
        self.plan_end_t[v] = Dp[-1]
        self.plan_end_stop[v] = self.ev_stop[v, n - 1]

    # ------------------------------------------------------------------ events
    def _process_stop_events(self, v, t):
        """Board/alight every leading event at the vehicle's current stop. Returns count."""
        s = self.stop[v]
        k = 0
        n = self.n_ev[v]
        while k < n and self.ev_stop[v, k] == s:
            rid = self.ev_rid[v, k]
            if self.ev_type[v, k] > 0:
                self.r_pick[rid] = t
                self.onboard[v] += 1
            else:
                self.r_drop[rid] = t
                self.onboard[v] -= 1
            k += 1
        if k:
            self.ev_stop[v, :n - k] = self.ev_stop[v, k:n]
            self.ev_type[v, :n - k] = self.ev_type[v, k:n]
            self.ev_rid[v, :n - k] = self.ev_rid[v, k:n]
            self.ev_dead[v, :n - k] = self.ev_dead[v, k:n]
            self.n_ev[v] = n - k
        return k

    def _berth_start(self, s, t, k_events):
        """Earliest time the vehicle can start boarding at stop s (kerb capacity), and book it."""
        g = int(self.stop_group[s])
        if self.cfg.berths is None or g < 0 or k_events == 0:
            return t
        h = self.berth_heaps.setdefault(g, [])
        while h and h[0] <= t:
            heapq.heappop(h)
        if len(h) < self.cfg.berths:
            return t
        start = heapq.heappop(h)
        self.hub_queue.append((int(s), float(t), float(start)))
        return start

    def _on_arrive(self, v, t):
        self._end_idle(v, t)
        self._close_leg(v, t)
        s = self.stop[v]
        n = self.n_ev[v]
        k_here = 0
        while k_here < n and self.ev_stop[v, k_here] == s:
            k_here += 1
        t_start = self._berth_start(s, t, k_here)
        k = self._process_stop_events(v, t_start)
        if k:
            self.st[v] = DWELL
            self.dwell_start[v] = t_start
            self.t_free[v] = t_start + self.cfg.d0 + self.cfg.d1 * k
            g = int(self.stop_group[s])
            if self.cfg.berths is not None and g >= 0:
                heapq.heappush(self.berth_heaps.setdefault(g, []), float(self.t_free[v]))
            self.version[v] += 1
            self._push(self.t_free[v], DEPART, v, self.version[v])
        elif self.n_ev[v] > 0:
            self.st[v] = IDLE
            self._on_depart(v, t)
        else:
            self._begin_idle(v, t)
        self._recompute_plan_end(v, t)

    def _on_depart(self, v, t):
        s = self.stop[v]
        if self.st[v] == DWELL and self.hub[s]:
            self.hub_visits.append((s, self.dwell_start[v], t))
        if self.n_ev[v] == 0:
            self._begin_idle(v, t)
            self._recompute_plan_end(v, t)
            return
        target = self.ev_stop[v, 0]
        if target == s:  # a pickup was added here after the dwell was scheduled
            self.st[v] = IDLE
            self._on_arrive(v, t)
            return
        self._start_leg(v, t, ("stop", s), target)

    # ------------------------------------------------------------------ dispatch
    def _candidates(self, o, t):
        R, cfg = self.R, self.cfg
        pos_t = np.where(self.st == DWELL, np.maximum(self.t_free, t),
                         np.where(self.st == MOVING, self.leg_arr, t))
        eta = pos_t + R.T[self.stop, o]
        has = self.n_ev > 0
        end_eta = np.where(has, self.plan_end_t + R.T[self.plan_end_stop, o], eta)
        full = self.n_ev >= cfg.max_events - 2
        eta = np.where(full, np.inf, eta)
        end_eta = np.where(full, np.inf, end_eta)
        k1 = min(cfg.k_eta, self.N)
        k2 = min(cfg.k_end, self.N)
        c1 = np.argpartition(eta, k1 - 1)[:k1]
        c2 = np.argpartition(end_eta, k2 - 1)[:k2]
        c = np.unique(np.concatenate([c1, c2]))
        c = c[~full[c]]
        if len(c) == 0:  # every vehicle's schedule is full: least-loaded vehicles
            c = np.argsort(self.n_ev)[:k2]
        return c

    def _on_request(self, rid, t):
        cfg, R = self.cfg, self.R
        o, d = self.r_o[rid], self.r_d[rid]
        cands = self._candidates(o, t)
        ak = np.empty(len(cands), np.int64); ai = np.empty(len(cands), np.int64)
        at = np.empty(len(cands)); am = np.empty(len(cands), np.bool_)
        for c, v in enumerate(cands):
            ak[c], ai[c], at[c], am[c] = self._anchor(v, t)
        cost, v, i, j, ap, ad = best_over_candidates(
            cands.astype(np.int64), ak, ai, at, am, self.onboard, self.n_ev, self.ev_stop, self.ev_type,
            self.ev_dead, o, d, t, R.T[o, d], cfg.capacity, cfg.d0, cfg.d1, cfg.alpha, cfg.beta,
            cfg.w_other, cfg.w_veh, R.T, R.TN)
        if v < 0:
            raise RuntimeError("no feasible insertion; appends should always be feasible")
        if ap - t > cfg.max_wait_reject or self.n_ev[v] + 2 > cfg.max_events:
            self.r_veh[rid] = -2        # refused: the fleet cannot reach this rider in time
            return
        self._insert(v, i, j, rid, ap, ad, t)

    def _insert(self, v, i, j, rid, a_pick, a_drop, t):
        cfg = self.cfg
        n = self.n_ev[v]
        stops = list(self.ev_stop[v, :n]); types = list(self.ev_type[v, :n])
        rids = list(self.ev_rid[v, :n]); dead = list(self.ev_dead[v, :n])
        o, d = self.r_o[rid], self.r_d[rid]
        stops[j:j] = [d]; types[j:j] = [-1]; rids[j:j] = [rid]; dead[j:j] = [a_drop + cfg.lateness]
        stops[i:i] = [o]; types[i:i] = [1]; rids[i:i] = [rid]; dead[i:i] = [a_pick + cfg.lateness]
        n2 = n + 2
        self.ev_stop[v, :n2] = stops; self.ev_type[v, :n2] = types
        self.ev_rid[v, :n2] = rids; self.ev_dead[v, :n2] = dead
        self.n_ev[v] = n2
        self.r_veh[rid] = v
        self.r_promise[rid] = a_pick
        if i == 0:
            self._replan_front(v, t)
        self._recompute_plan_end(v, t)

    def _replan_front(self, v, t):
        """The first event changed: redirect the vehicle if it can still change course."""
        target = self.ev_stop[v, 0]
        if self.st[v] == IDLE:
            if target == self.stop[v]:
                self.version[v] += 1
                self._push(t, ARRIVE, v, self.version[v])
            else:
                self._start_leg(v, t, ("stop", self.stop[v]), target)
        elif self.st[v] == DWELL:
            if target == self.stop[v]:
                # join the current dwell: board when the doors would have closed
                self._process_stop_events(v, self.t_free[v])
                self.t_free[v] += self.cfg.d1
                self.version[v] += 1
                self._push(self.t_free[v], DEPART, v, self.version[v])
        else:  # MOVING
            kind, aid, at, _ = self._anchor(v, t)
            if kind == 0:
                lg = self.leg[v]
                k = int(np.searchsorted(lg.t, at))
                while lg.pts[k] != ("node", aid):
                    k += 1
                self._close_leg(v, at, k)
                self._start_leg(v, at, ("node", aid), target)
            # else: committed to the current target stop; it will continue on arrival

    def _on_rebalance(self, t):
        cfg, R = self.cfg, self.R
        idle = np.flatnonzero((self.st == IDLE) & (self.n_ev == 0))
        moving_reb = np.flatnonzero((self.st == MOVING) & self.leg_rebal & (self.n_ev == 0))
        total = len(idle) + len(moving_reb)
        if total == 0:
            return
        h = int(t // 3600) % 24
        dem = self.rates[h, self.study_idx] * cfg.rebalance_horizon
        if dem.sum() <= 0:
            return
        desired = total * dem / dem.sum()
        supply = np.zeros(len(R.codes))
        np.add.at(supply, self.stop[idle], 1)
        np.add.at(supply, self.stop[moving_reb], 1)
        sup_study = supply[self.study_idx]
        deficit = desired - sup_study
        need = {int(self.study_idx[k]): deficit[k] for k in np.flatnonzero(deficit >= 0.5)}
        if not need:
            return
        desired_full = np.zeros(len(R.codes)); desired_full[self.study_idx] = desired
        for v in idle:
            s = self.stop[v]
            if supply[s] <= desired_full[s] + 1.0:
                continue
            targets = [g for g, x in need.items() if x >= 0.5]
            if not targets:
                break
            tt = R.T[s, targets]
            k = int(np.argmin(tt))
            if tt[k] > cfg.rebalance_max_tt:
                continue
            g = targets[k]
            need[g] -= 1.0
            supply[s] -= 1.0
            self._start_leg(v, t, ("stop", s), g, rebal=True)

    # ------------------------------------------------------------------ run
    def run(self, req: pd.DataFrame, stop_index: dict[str, int]) -> SimResult:
        cfg = self.cfg
        rng = np.random.default_rng(cfg.seed)
        n = len(req)
        self.r_t = req.t.to_numpy(float)
        self.r_o = req.o.map(stop_index).to_numpy(np.int64)
        self.r_d = req.d.map(stop_index).to_numpy(np.int64)
        self.r_pick = np.full(n, np.nan); self.r_drop = np.full(n, np.nan)
        self.r_veh = np.full(n, -1); self.r_promise = np.full(n, np.nan)
        # initial positions: proportional to demand in the first service hour
        h0 = int(cfg.start_s // 3600) + 1
        w = self.rates[h0 % 24, self.study_idx]
        w = w / w.sum() if w.sum() > 0 else np.full(len(self.study_idx), 1 / len(self.study_idx))
        self.stop[:] = rng.choice(self.study_idx, size=self.N, p=w)
        self.st[:] = IDLE
        for v in range(self.N):
            self._begin_idle(v, cfg.start_s)
        self.plan_end_t[:] = cfg.start_s
        self.plan_end_stop[:] = self.stop
        for rid in range(n):
            self._push(self.r_t[rid], REQUEST, rid)
        if cfg.rebalance == "demand":
            t_end = float(self.r_t.max()) + 600 if n else cfg.start_s
            for t in np.arange(cfg.start_s, t_end, cfg.rebalance_every):
                self._push(float(t), REBAL, -1)
        while self.heap:
            t, kind, _, a, ver = heapq.heappop(self.heap)
            if kind == REQUEST:
                self._on_request(a, t)
            elif kind == ARRIVE:
                if ver == self.version[a]:
                    self._on_arrive(a, t)
            elif kind == DEPART:
                if ver == self.version[a]:
                    self._on_depart(a, t)
            else:
                self._on_rebalance(t)
        out = req.copy()
        out["refused"] = self.r_veh == -2
        out["t_pick"] = self.r_pick
        out["t_drop"] = self.r_drop
        out["veh"] = self.r_veh
        out["promise"] = self.r_promise
        out["wait"] = out["t_pick"] - out["t"]
        out["ride"] = out["t_drop"] - out["t_pick"]
        out["total"] = out["t_drop"] - out["t"]
        out["direct"] = self.R.T[self.r_o, self.r_d]
        t_last = float(np.nanmax(self.r_drop)) if n else cfg.start_s
        for v in range(self.N):
            self._end_idle(v, max(t_last, float(self.idle_since[v]) if not np.isnan(self.idle_since[v]) else t_last))
        hv = pd.DataFrame(self.hub_visits, columns=["stop", "t_arrive", "t_depart"])
        hi = pd.DataFrame(self.hub_idle, columns=["stop", "t_start", "t_end"])
        hq = pd.DataFrame(self.hub_queue, columns=["stop", "t_arrive", "t_berth"])
        return SimResult(out, self.km_loaded / 1000, self.km_empty / 1000, self.km_by_hour / 1000,
                         self.pax_m / 1000, hv, hi, self.legs_out, hq)
