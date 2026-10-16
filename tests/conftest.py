"""Shared fixtures: a small synthetic road network (no external data needed) and, when the
raw data has been downloaded, the real Yishun model."""
from __future__ import annotations

import networkx as nx
import numpy as np
import pandas as pd
import pytest
from shapely.geometry import LineString, Point

from yishun.network import Snap, StopNetwork
from yishun.paths import RAW
from yishun.routing import build_routing


def grid_network(n=4, spacing=300.0, kmh=36.0):
    """n x n grid of two-way streets; one stop at the middle of every eastbound and
    northbound edge. 36 km/h = 10 m/s, so edge travel time = 30 s."""
    G = nx.MultiDiGraph()
    for i in range(n):
        for j in range(n):
            G.add_node(i * n + j, x=j * spacing, y=i * spacing)
    for i in range(n):
        for j in range(n):
            a = i * n + j
            for b in ([a + 1] if j + 1 < n else []) + ([a + n] if i + 1 < n else []):
                for u, v in ((a, b), (b, a)):
                    geom = LineString([(G.nodes[u]["x"], G.nodes[u]["y"]), (G.nodes[v]["x"], G.nodes[v]["y"])])
                    G.add_edge(u, v, 0, length=spacing, cls="residential", geometry=geom, n_sig=0,
                               tt=spacing / (kmh / 3.6), tt_ff=spacing / (kmh / 3.6))
    rows, snaps = [], {}
    for u, v, k, d in G.edges(keys=True, data=True):
        if v - u in (1, n):  # eastbound or northbound
            code = f"{u:02d}{v:02d}"
            p = d["geometry"].interpolate(0.5, normalized=True)
            rows.append({"BusStopCode": code, "Description": f"stop {code}", "geometry": Point(p.x, p.y),
                         "in_study": True, "is_hub": False, "SUBZONE_N": "TEST"})
            snaps[code] = Snap(u, v, k, spacing / 2, spacing, 0.0)
    stops = pd.DataFrame(rows).set_index("BusStopCode", drop=False)
    return StopNetwork(G=G, stops=stops, snaps=snaps)


@pytest.fixture(scope="session")
def toy():
    net = grid_network()
    R = build_routing(net)
    S = len(R.codes)
    rates = np.zeros((24, S))
    return {"net": net, "R": R, "study_idx": np.arange(S), "hub_idx": np.array([0]), "rates": rates,
            "stop_index": {c: i for i, c in enumerate(R.codes)}}


@pytest.fixture(scope="session")
def real_model():
    needed = [RAW / "osm" / "highways.osm", RAW / "lta" / "bus_routes.json", RAW / "datagov" / "mp2019_planning_area.geojson"]
    if not all(p.exists() for p in needed):
        pytest.skip("raw data not downloaded (run `make data`)")
    from yishun.model import build_model
    return build_model()
