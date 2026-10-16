"""Compact routing tables for the simulator.

For every network stop s we run one reverse Dijkstra on the road graph and keep
  TN[n, s]   travel time (s) from graph node n to stop s (through s's snapped edge)
  NH[s, n]   next node after n on the fastest path towards stop s (-1 when n is the
             start node of s's edge, i.e. the last node before the stop)
Stop-to-stop times T[a, b] use the same edge weights, so every leg the simulator drives
is consistent with the times it planned with.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from .network import StopNetwork


@dataclass
class Routing:
    codes: list[str]            # network stop codes, index = stop id
    node_ids: np.ndarray        # graph node id per node index
    node_xy: np.ndarray         # (Nn, 2) SVY21 metres
    T: np.ndarray               # (S, S) stop -> stop seconds
    Dm: np.ndarray              # (S, S) stop -> stop metres
    TN: np.ndarray              # (Nn, S) node -> stop seconds
    LN: np.ndarray              # (Nn, S) node -> stop metres along that fastest path
    NH: np.ndarray              # (S, Nn) next hop towards stop
    stop_u: np.ndarray          # node index of the start of each stop's edge
    stop_v: np.ndarray          # node index of the end of each stop's edge
    stop_frac: np.ndarray       # position of the stop along its edge (0..1)
    stop_edge_tt: np.ndarray    # travel time of the stop's edge (s)
    stop_edge_len: np.ndarray   # length of the stop's edge (m)
    stop_xy: np.ndarray         # (S, 2) snapped stop position (SVY21)
    edge_tt: dict               # (ni, nj) -> min travel time between adjacent nodes
    edge_len: dict              # (ni, nj) -> length of that fastest parallel edge
    edge_geom: dict             # (ni, nj) -> shapely LineString (SVY21) for drawing
    edge_cls: dict              # (ni, nj) -> OSM highway class of that edge
    stop_edge_cls: np.ndarray   # OSM highway class of each stop's edge
    edge_ff: dict               # (ni, nj) -> (free-flow seconds, signal points) of that edge
    stop_edge_ff: np.ndarray    # (S, 2) free-flow seconds and signal points of each stop's edge


def build_routing(net: StopNetwork, weight: str = "tt") -> Routing:
    G = net.G
    node_ids = np.array(list(G.nodes))
    nidx = {n: i for i, n in enumerate(node_ids)}
    Nn = len(node_ids)
    edge_tt, edge_len, edge_geom, edge_cls, edge_ff = {}, {}, {}, {}, {}
    for u, v, d in G.edges(data=True):
        a, b = nidx[u], nidx[v]
        if (a, b) not in edge_tt or d[weight] < edge_tt[(a, b)]:
            edge_tt[(a, b)] = d[weight]
            edge_len[(a, b)] = d["length"]
            edge_geom[(a, b)] = d["geometry"]
            edge_cls[(a, b)] = d["cls"]
            edge_ff[(a, b)] = (d.get("tt_ff", d[weight]), d.get("n_sig", 0))
    rows = np.array([k[0] for k in edge_tt]); cols = np.array([k[1] for k in edge_tt])
    vals = np.array(list(edge_tt.values()))
    A = csr_matrix((vals, (rows, cols)), shape=(Nn, Nn))

    codes = net.codes
    S = len(codes)
    su = np.zeros(S, int); sv = np.zeros(S, int); frac = np.zeros(S); ett = np.zeros(S); elen = np.zeros(S)
    sxy = np.zeros((S, 2)); scls = np.empty(S, dtype=object); sff = np.zeros((S, 2))
    for i, c in enumerate(codes):
        sn = net.snaps[c]
        d = G.edges[sn.u, sn.v, sn.key]
        su[i], sv[i] = nidx[sn.u], nidx[sn.v]
        frac[i] = sn.offset / d["length"] if d["length"] > 0 else 0.0
        ett[i], elen[i] = d[weight], d["length"]
        scls[i] = d["cls"]
        sff[i] = (d.get("tt_ff", d[weight]), d.get("n_sig", 0))
        p = d["geometry"].interpolate(frac[i], normalized=True)
        sxy[i] = (p.x, p.y)

    # Reverse Dijkstra from each stop's edge start node: distances n -> u_s and predecessors
    # in the transposed graph, which are next hops in the original graph.
    uniq_u, inv = np.unique(su, return_inverse=True)
    dist_r, pred_r = dijkstra(A.T.tocsr(), directed=True, indices=uniq_u, return_predecessors=True)
    TN = (dist_r[inv] + (frac * ett)[:, None]).T.astype(np.float64)   # (Nn, S)
    NH = pred_r[inv].astype(np.int32)                                    # (S, Nn); -9999 -> unreachable/self
    NH[NH < 0] = -1

    # Length (m) from each node to each stop along the *fastest* path (what vehicles drive).
    LN = np.full((Nn, S), np.nan)
    for s in range(S):
        target = su[s]
        order = np.argsort(TN[:, s])          # nodes closer (in time) to the stop come first
        LN[target, s] = 0.0
        for n in order:
            if n == target or not np.isfinite(TN[n, s]):
                continue
            nh = NH[s, n]
            if nh >= 0 and np.isfinite(LN[nh, s]):
                LN[n, s] = edge_len[(n, nh)] + LN[nh, s]
        LN[:, s] += frac[s] * elen[s]

    # Stop -> stop: leave along the rest of a's edge to v_a, then go to b.
    T = np.zeros((S, S)); Dm = np.zeros((S, S))
    for a in range(S):
        T[a] = (1 - frac[a]) * ett[a] + TN[sv[a]]
        Dm[a] = (1 - frac[a]) * elen[a] + LN[sv[a]]
        same = (su == su[a]) & (sv == sv[a]) & (frac >= frac[a])
        T[a, same] = (frac[same] - frac[a]) * ett[a]
        Dm[a, same] = (frac[same] - frac[a]) * elen[a]
        T[a, a] = 0.0; Dm[a, a] = 0.0
    node_xy = np.array([(G.nodes[n]["x"], G.nodes[n]["y"]) for n in node_ids])
    return Routing(codes, node_ids, node_xy, T, Dm, TN, LN, NH, su, sv, frac, ett, elen, sxy,
                   edge_tt, edge_len, edge_geom, edge_cls, scls, edge_ff, sff)


def node_path_to_stop(R: Routing, start_node: int, s: int, max_hops: int = 2000) -> list[int]:
    """Nodes from start_node to the start node of stop s's edge (inclusive)."""
    path = [start_node]
    n = start_node
    target = R.stop_u[s]
    while n != target:
        n = int(R.NH[s, n])
        if n < 0 or len(path) > max_hops:
            raise RuntimeError(f"no path from node {start_node} to stop {R.codes[s]}")
        path.append(n)
    return path
