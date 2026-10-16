"""Road network for vehicles, stop snapping, and stop-to-stop travel times.

* Drivable OSM highway classes only; the largest strongly connected component is kept so
  every stop can reach every other stop.
* Bus stops are snapped to a directed edge on which the stop lies on the LEFT side of the
  direction of travel (Singapore drives on the left), so a vehicle serving the stop is
  travelling in the correct direction.
* Travel time on an edge = length / speed(class). The same network and speeds are used for
  buses and for shuttles, so service comparisons are not driven by inconsistent road speeds.
"""
from __future__ import annotations

import pickle
from dataclasses import dataclass, field

import networkx as nx
import numpy as np
import osmnx as ox
import pandas as pd
from shapely import STRtree
from shapely.geometry import LineString, Point

from .paths import CRS_METRIC, INTERIM, RAW
from .study_area import study_stops

DRIVABLE = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street", "service",
}
EXCLUDED_SERVICE = {"parking_aisle", "driveway", "drive-through", "emergency_access"}

# Free-flow cruise speeds (km/h) by OSM class before calibration. Singapore's default urban
# limit is 50 km/h; estate roads are slower in practice. These are calibrated against observed
# bus running times by `calibrate.py`; see docs/methodology.md.
DEFAULT_KMH = {
    "motorway": 70, "motorway_link": 50, "trunk": 60, "trunk_link": 40,
    "primary": 50, "primary_link": 35, "secondary": 45, "secondary_link": 30,
    "tertiary": 40, "tertiary_link": 30, "unclassified": 30, "residential": 30,
    "living_street": 15, "service": 15,
}


def _first(v):
    return v[0] if isinstance(v, list) else v


def build_drive_graph() -> nx.MultiDiGraph:
    cache = INTERIM / "drive_graph.pkl"
    if cache.exists():
        return pickle.loads(cache.read_bytes())
    ox.settings.useful_tags_way = sorted(set(ox.settings.useful_tags_way) | {"psv", "bus", "maxspeed", "lanes"})
    G = ox.graph_from_xml(RAW / "osm" / "highways.osm", simplify=True, retain_all=True)
    drop = []
    for u, v, k, d in G.edges(keys=True, data=True):
        hw = _first(d.get("highway"))
        svc = _first(d.get("service"))
        access = _first(d.get("access"))
        name = str(_first(d.get("name")) or "")
        # Public-transport vehicles may use bus-only roads (e.g. the interchange driveway,
        # tagged access=no, service=driveway, name="Yishun Bus Interchange").
        psv_ok = hw == "busway" or "Bus Interchange" in name or any(
            _first(d.get(t)) in ("yes", "designated") for t in ("psv", "bus"))
        if psv_ok:
            continue
        if hw not in DRIVABLE or svc in EXCLUDED_SERVICE or access in ("no", "private"):
            drop.append((u, v, k))
    G.remove_edges_from(drop)
    G.remove_nodes_from([n for n in list(G.nodes) if G.degree(n) == 0])
    largest = max(nx.strongly_connected_components(G), key=len)
    G = G.subgraph(largest).copy()
    G = ox.project_graph(G, to_crs=CRS_METRIC)
    for u, v, k, d in G.edges(keys=True, data=True):
        d["cls"] = _first(d.get("highway"))
        if d["cls"] == "busway":
            d["cls"] = "service"
        if "geometry" not in d:
            d["geometry"] = LineString([(G.nodes[u]["x"], G.nodes[u]["y"]), (G.nodes[v]["x"], G.nodes[v]["y"])])
    _count_signals(G)
    cache.write_bytes(pickle.dumps(G))
    return G


def signal_locations(link_m: float = 30.0) -> np.ndarray:
    """Signal-controlled locations: OSM signal nodes (junction or pedestrian signals) merged by
    single-linkage clustering at `link_m` metres (one junction is mapped with several signal
    nodes, one per approach). Returns cluster centroids (SVY21 metres)."""
    import json

    import geopandas as gpd
    from scipy.cluster.hierarchy import fcluster, linkage

    els = json.loads((RAW / "osm" / "context.json").read_text())["elements"]
    pts = [(e["lon"], e["lat"]) for e in els if e["type"] == "node" and (
        e.get("tags", {}).get("highway") == "traffic_signals"
        or e.get("tags", {}).get("crossing") == "traffic_signals")]
    g = gpd.GeoSeries(gpd.points_from_xy(*zip(*pts)), crs=4326).to_crs(CRS_METRIC)
    xy = np.c_[g.x, g.y]
    lab = fcluster(linkage(xy, method="single"), t=link_m, criterion="distance")
    return np.array([xy[lab == k].mean(axis=0) for k in np.unique(lab)])


def _count_signals(G: nx.MultiDiGraph, radius: float = 25.0) -> None:
    """n_sig on each directed edge = signal-controlled locations within `radius` m of the edge
    and in its downstream half (the stop lines a vehicle on this edge meets; locations in
    the upstream half belong to the previous edge or the opposite direction)."""
    cent = signal_locations()
    tree = STRtree([Point(x, y) for x, y in cent])
    for _, _, d in G.edges(data=True):
        line = d["geometry"]
        n = 0
        for i in tree.query(line.buffer(radius)):
            p = Point(*cent[i])
            if line.distance(p) <= radius and line.project(p) >= 0.5 * line.length:
                n += 1
        d["n_sig"] = n


# Calibrated against LTA live bus running times (see calibrate.py / docs/validation.md).
# Multipliers scale free-flow time by road group; sig_s is added per signal point passed.
UNCALIBRATED = {"mult_arterial": 1.0, "mult_local": 1.0, "sig_s": 0.0}


def set_speeds(G: nx.MultiDiGraph, kmh: dict[str, float], cal: dict | None = None) -> None:
    from .calibrate import GROUPS

    cal = cal or UNCALIBRATED
    for _, _, d in G.edges(data=True):
        ff = d["length"] / (kmh.get(d["cls"], 25.0) / 3.6)
        d["tt_ff"] = ff
        mult = cal["mult_arterial"] if d["cls"] in GROUPS["arterial"] else cal["mult_local"]
        d["tt"] = ff * mult + d.get("n_sig", 0) * cal["sig_s"]


@dataclass
class Snap:
    u: int
    v: int
    key: int
    offset: float      # metres from u along the edge
    length: float      # edge length (m)
    dist: float        # perpendicular distance stop -> edge (m)


@dataclass
class StopNetwork:
    G: nx.MultiDiGraph
    stops: pd.DataFrame                       # study stops, index = BusStopCode
    snaps: dict[str, Snap] = field(default_factory=dict)

    @property
    def codes(self) -> list[str]:
        return list(self.stops.index)


def _left_of(seg_a, seg_b, p) -> bool:
    dx, dy = seg_b[0] - seg_a[0], seg_b[1] - seg_a[1]
    return dx * (p[1] - seg_a[1]) - dy * (p[0] - seg_a[0]) > 0


def snap_stops(G: nx.MultiDiGraph, stops, max_dist: float = 60.0) -> dict[str, Snap]:
    edges = list(G.edges(keys=True, data=True))
    geoms = [d["geometry"] for _, _, _, d in edges]
    tree = STRtree(geoms)
    snaps = {}
    for code, pt in zip(stops.index, stops.geometry):
        cand = tree.query(pt.buffer(max_dist))
        best, best_any = None, None
        for i in cand:
            u, v, k, d = edges[i]
            line = geoms[i]
            dist = line.distance(pt)
            if dist > max_dist:  # the STRtree query is by bounding box
                continue
            off = line.project(pt)
            # direction of the local segment at the projection point
            a = line.interpolate(max(0.0, off - 1.0))
            b = line.interpolate(min(line.length, off + 1.0))
            snap = Snap(u, v, k, off * d["length"] / max(line.length, 1e-9), d["length"], dist)
            if best_any is None or dist < best_any.dist:
                best_any = snap
            if _left_of((a.x, a.y), (b.x, b.y), (pt.x, pt.y)) and (best is None or dist < best.dist):
                best = snap
        chosen = best or best_any
        if chosen is None:
            if bool(stops.loc[code].get("in_study", True)):
                raise ValueError(f"study stop {code} has no drivable edge within {max_dist} m")
            continue  # buffer stop at the extract edge: routes fall back to LTA distances
        snaps[code] = chosen
    return snaps


def network_stops():
    """All bus stops inside the OSM extract bbox (study stops plus the ~1 km buffer).

    Routes that serve Yishun often pass a few stops just outside the planning area, so
    in-vehicle times are computed over this wider set; demand stays restricted to the
    planning area (`in_study`)."""
    from .fetch_osm import BBOX
    from .study_area import all_bus_stops

    s, w, n, e = BBOX
    allst = all_bus_stops().reset_index(drop=True)
    inbox = allst.Latitude.between(s + 0.002, n - 0.002) & allst.Longitude.between(w + 0.002, e - 0.002)
    st = allst.loc[inbox].copy()
    study = study_stops().set_index("BusStopCode")
    st["in_study"] = st.BusStopCode.isin(study.index)
    st["is_hub"] = st.BusStopCode.map(study.is_hub).fillna(False).astype(bool)
    st["SUBZONE_N"] = st.BusStopCode.map(study.SUBZONE_N)
    return st.sort_values("BusStopCode").set_index("BusStopCode", drop=False)


def stop_network(kmh: dict[str, float] | None = None, cal: dict | None = None) -> StopNetwork:
    G = build_drive_graph()
    set_speeds(G, kmh or DEFAULT_KMH, cal)
    st = network_stops()
    snaps = snap_stops(G, st)
    st = st.loc[[c for c in st.index if c in snaps]]
    return StopNetwork(G=G, stops=st, snaps=snaps)


def travel_time_matrix(net: StopNetwork, weight: str = "tt") -> tuple[np.ndarray, np.ndarray, dict]:
    """Stop-to-stop travel time (s) and distance (m) honouring the snapped edge offsets.

    Returns (T, D, paths) where paths[(i, j)] is the node list from the end node of stop
    i's edge to the start node of stop j's edge (empty when i and j share an edge and j is
    downstream of i).
    """
    G = net.G
    codes = net.codes
    n = len(codes)
    T = np.zeros((n, n))
    D = np.zeros((n, n))
    paths: dict[tuple[int, int], list[int]] = {}
    edge_tt = {}
    for c in codes:
        s = net.snaps[c]
        d = G.edges[s.u, s.v, s.key]
        edge_tt[c] = (d[weight], d["length"])
    targets = {net.snaps[c].u for c in codes}
    for i, ci in enumerate(codes):
        si = net.snaps[ci]
        tti, leni = edge_tt[ci]
        frac_rest = 1.0 - si.offset / leni
        dist_t, path_t = nx.single_source_dijkstra(G, si.v, weight=weight)
        dist_m = {}
        for j, cj in enumerate(codes):
            if i == j:
                continue
            sj = net.snaps[cj]
            ttj, lenj = edge_tt[cj]
            if (sj.u, sj.v, sj.key) == (si.u, si.v, si.key) and sj.offset >= si.offset:
                T[i, j] = (sj.offset - si.offset) / leni * tti
                D[i, j] = sj.offset - si.offset
                paths[(i, j)] = []
                continue
            p = path_t[sj.u]
            if sj.u not in dist_m:
                dist_m[sj.u] = sum(min(dd["length"] for dd in G[a][b].values()) for a, b in zip(p[:-1], p[1:]))
            T[i, j] = frac_rest * tti + dist_t[sj.u] + sj.offset / lenj * ttj
            D[i, j] = frac_rest * leni + dist_m[sj.u] + sj.offset
            paths[(i, j)] = p
    return T, D, paths
