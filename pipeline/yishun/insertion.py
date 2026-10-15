"""Request-insertion evaluation for stop-based pooled shuttles (numba kernel + reference).

Vocabulary
----------
A vehicle has an *anchor* (where it can next change course) and an ordered list of future
*events* (pickup +1 / dropoff -1 at a stop, each with a latest-allowed arrival time).

* anchor kind 0 = a road-network node reached at time anc_t (vehicle is driving)
* anchor kind 1 = a stop; the vehicle is there (or arriving) at time anc_t. If
  anc_merge is True the vehicle is already dwelling there, so an event at the same stop
  joins the current dwell (no extra fixed dwell).

Timing rules (shared by the kernel, the reference and the simulator):
* travel between stops a -> b takes T[a, b]; from a node anchor n it takes TN[n, b]
* an event at the same stop as the previous event costs d1 seconds of dwell (merged);
  otherwise the vehicle travels there and dwells d0 + d1
* vehicles never wait idle in front of a stop, so a delay shifts every later event

Insertion (i, j): the pickup is placed before original event i and the dropoff before
original event j (j >= i; j == i means the dropoff directly follows the pickup).
Feasibility: every event's arrival <= its deadline; load <= capacity; the new rider's
in-vehicle time <= alpha * direct + beta. Cost: new rider's (wait + ride) + w_other *
(sum of arrival delays imposed on existing dropoffs) + w_veh * (extension of the
vehicle's schedule end).
"""
from __future__ import annotations

import numpy as np
from numba import njit

INF = 1e18


@njit(cache=True)
def _times(anc_kind, anc_id, anc_t, anc_merge, n, stops, T, TN, d0, d1, A, Dp):
    prev = anc_id if anc_kind == 1 else -1
    merge_ok = anc_merge if anc_kind == 1 else False
    t = anc_t
    for k in range(n):
        s = stops[k]
        if s == prev and (k > 0 or merge_ok):
            A[k] = t
            Dp[k] = t + d1
        else:
            if k == 0 and anc_kind == 0:
                A[k] = t + TN[anc_id, s]
            else:
                A[k] = t + (T[prev, s] if prev >= 0 else 0.0)
            Dp[k] = A[k] + d0 + d1
        t = Dp[k]
        prev = s


@njit(cache=True)
def eval_vehicle(anc_kind, anc_id, anc_t, anc_merge, onboard, n, stops, types, dead,
                 o, d, t_req, direct, C, d0, d1, alpha, beta, w_other, w_veh, T, TN):
    """Best insertion for one vehicle. Returns (cost, i, j, A_pick, A_drop)."""
    A = np.empty(n + 1)
    Dp = np.empty(n + 1)
    _times(anc_kind, anc_id, anc_t, anc_merge, n, stops, T, TN, d0, d1, A, Dp)
    # load before event k, slack after k, count of dropoffs from k on
    L = np.empty(n + 1)
    L[0] = onboard
    for k in range(n):
        L[k + 1] = L[k] + types[k]
    slack = np.empty(n + 1)
    slack[n] = INF
    for k in range(n - 1, -1, -1):
        s = dead[k] - A[k]
        slack[k] = s if s < slack[k + 1] else slack[k + 1]
    ndrop_from = np.zeros(n + 1)
    for k in range(n - 1, -1, -1):
        ndrop_from[k] = ndrop_from[k + 1] + (1.0 if types[k] < 0 else 0.0)
    end_old = Dp[n - 1] if n > 0 else anc_t
    max_ride = alpha * direct + beta

    best_cost = INF
    bi = -1
    bj = -1
    bap = 0.0
    bad = 0.0
    for i in range(n + 1):
        if L[i] + 1 > C:
            continue
        # --- pickup before event i
        if i == 0:
            if anc_kind == 1:
                prev = anc_id
                merge = (prev == o) and anc_merge
                t_prev = anc_t
                trav = 0.0 if prev == o else T[prev, o]
            else:
                prev = -1
                merge = False
                t_prev = anc_t
                trav = TN[anc_id, o]
        else:
            prev = stops[i - 1]
            merge = prev == o
            t_prev = Dp[i - 1]
            trav = 0.0 if merge else T[prev, o]
        if merge:
            a_pick = t_prev
            dp_pick = a_pick + d1
        else:
            a_pick = t_prev + trav
            dp_pick = a_pick + d0 + d1

        # j == i : dropoff right after pickup
        a_drop = dp_pick + T[o, d]
        dp_drop = a_drop + d0 + d1
        if a_drop - dp_pick <= max_ride:
            ok = True
            delay_cost = 0.0
            if i < n:
                s = stops[i]
                if s == d:
                    a_i = dp_drop
                    dp_i = a_i + d1
                else:
                    a_i = dp_drop + T[d, s]
                    dp_i = a_i + d0 + d1
                if a_i > dead[i] and a_i > A[i] + 1e-9:
                    ok = False
                shift = dp_i - Dp[i]
                if shift > 1e-9 and shift > slack[i + 1]:
                    ok = False
                d_i = a_i - A[i]
                delay_cost = (d_i if types[i] < 0 else 0.0) + shift * ndrop_from[i + 1]
                end_new = Dp[n - 1] + shift if i < n - 1 else dp_i
            else:
                end_new = dp_drop
            if ok:
                cost = (a_drop - t_req) + w_other * delay_cost + w_veh * (end_new - end_old)
                if cost < best_cost:
                    best_cost = cost
                    bi = i
                    bj = i
                    bap = a_pick
                    bad = a_drop

        if i == n:
            continue
        # --- j > i : original events i..j-1 sit between pickup and dropoff
        s = stops[i]
        if s == o:
            a_i = dp_pick
            dp_i = a_i + d1
        else:
            a_i = dp_pick + T[o, s]
            dp_i = a_i + d0 + d1
        if a_i > dead[i] and a_i > A[i] + 1e-9:
            continue
        shift1 = dp_i - Dp[i]
        delay_i = a_i - A[i]
        run_min = INF      # min over m in (i, j-1] of dead[m] - A[m]
        cap_ok = True
        drops_between = 0.0  # dropoff events strictly between i and j
        for j in range(i + 1, n + 1):
            if L[j] + 1 > C:
                cap_ok = False
            if not cap_ok:
                break
            if j - 1 > i:
                m = j - 1
                v = dead[m] - A[m]
                if v < run_min:
                    run_min = v
                if types[m] < 0:
                    drops_between += 1.0
            if shift1 > 1e-9 and shift1 > run_min:
                break  # larger j only adds constraints
            prev = stops[j - 1]
            t_prev = Dp[j - 1] + shift1 if j - 1 > i else dp_i
            if prev == d:
                a_drop = t_prev
                dp_drop = a_drop + d1
            else:
                a_drop = t_prev + T[prev, d]
                dp_drop = a_drop + d0 + d1
            if a_drop - dp_pick > max_ride:
                continue
            ok = True
            delay_cost = (delay_i if types[i] < 0 else 0.0) + shift1 * drops_between
            if j < n:
                s2 = stops[j]
                if s2 == d:
                    a_j = dp_drop
                    dp_j = a_j + d1
                else:
                    a_j = dp_drop + T[d, s2]
                    dp_j = a_j + d0 + d1
                if a_j > dead[j] and a_j > A[j] + 1e-9:
                    ok = False
                shift2 = dp_j - Dp[j]
                if shift2 > 1e-9 and shift2 > slack[j + 1]:
                    ok = False
                delay_cost += (a_j - A[j] if types[j] < 0 else 0.0) + shift2 * ndrop_from[j + 1]
                end_new = Dp[n - 1] + shift2 if j < n - 1 else dp_j
            else:
                end_new = dp_drop
            if ok:
                cost = (a_drop - t_req) + w_other * delay_cost + w_veh * (end_new - end_old)
                if cost < best_cost:
                    best_cost = cost
                    bi = i
                    bj = j
                    bap = a_pick
                    bad = a_drop
    return best_cost, bi, bj, bap, bad


@njit(cache=True)
def best_over_candidates(cands, anc_kind, anc_id, anc_t, anc_merge, onboard, n_ev, ev_stop, ev_type,
                         ev_dead, o, d, t_req, direct, C, d0, d1, alpha, beta, w_other, w_veh, T, TN):
    best = (INF, -1, -1, -1, 0.0, 0.0)
    for c in range(cands.shape[0]):
        v = cands[c]
        n = n_ev[v]
        cost, i, j, ap, ad = eval_vehicle(anc_kind[c], anc_id[c], anc_t[c], anc_merge[c], onboard[v], n,
                                          ev_stop[v, :n], ev_type[v, :n], ev_dead[v, :n], o, d, t_req,
                                          direct, C, d0, d1, alpha, beta, w_other, w_veh, T, TN)
        if cost < best[0]:
            best = (cost, v, i, j, ap, ad)
    return best


# ----------------------------------------------------------------------------------------
# Brute-force reference used by the tests: build each candidate schedule explicitly.
def reference_times(anc_kind, anc_id, anc_t, anc_merge, stops, T, TN, d0, d1):
    n = len(stops)
    A = np.empty(n); Dp = np.empty(n)
    _times(anc_kind, anc_id, anc_t, anc_merge, n, np.asarray(stops, dtype=np.int64), T, TN, d0, d1, A, Dp)
    return A, Dp


def reference_best(anc_kind, anc_id, anc_t, anc_merge, onboard, stops, types, dead, o, d, t_req, direct,
                   C, d0, d1, alpha, beta, w_other, w_veh, T, TN, only=None):
    """Explicit enumeration; `only=(i, j)` evaluates a single insertion."""
    stops = list(stops); types = list(types); dead = list(dead)
    n = len(stops)
    A0, D0 = reference_times(anc_kind, anc_id, anc_t, anc_merge, stops, T, TN, d0, d1)
    end_old = D0[-1] if n else anc_t
    best = (INF, -1, -1, 0.0, 0.0)
    pairs = [only] if only else [(i, j) for i in range(n + 1) for j in range(i, n + 1)]
    for i, j in pairs:
        if True:
            new_stops = stops[:i] + [o] + stops[i:j] + [d] + stops[j:]
            new_types = types[:i] + [1] + types[i:j] + [-1] + types[j:]
            orig_pos = list(range(i)) + [-1] + list(range(i, j)) + [-2] + list(range(j, n))
            A, Dp = reference_times(anc_kind, anc_id, anc_t, anc_merge, new_stops, T, TN, d0, d1)
            load = onboard; ok = True
            for k, ty in enumerate(new_types):
                load += ty
                if load > C:
                    ok = False
            if not ok:
                continue
            kp = orig_pos.index(-1); kd = orig_pos.index(-2)
            if A[kd] - Dp[kp] > alpha * direct + beta + 1e-9:
                continue
            delay = 0.0
            for k, op in enumerate(orig_pos):
                if op >= 0:
                    # an event may not be pushed later past its deadline (events that are
                    # already late in the base plan only block insertions that delay them)
                    if A[k] > dead[op] + 1e-9 and A[k] > A0[op] + 1e-9:
                        ok = False
                    if types[op] < 0:
                        delay += A[k] - A0[op]
            if not ok:
                continue
            cost = (A[kd] - t_req) + w_other * delay + w_veh * (Dp[-1] - end_old)
            if cost < best[0] - 1e-9:
                best = (cost, i, j, A[kp], A[kd])
    return best
