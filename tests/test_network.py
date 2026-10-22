"""Road-graph construction rules: which merged OSM edges are drivable, which speed class they
get, and that the graph does not depend on Python's per-process hash seed."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

from yishun.network import keep_edge, road_class
from yishun.paths import RAW


@pytest.mark.parametrize("tags, keep", [
    ({"highway": "residential"}, True),
    ({"highway": ["residential", "service"]}, True),
    ({"highway": ["footway", "residential"]}, False),   # a road that continues as a footpath
    ({"highway": ["residential", "footway"]}, False),   # the same edge with the list in another order
    ({"highway": ["construction", "service"]}, False),
    ({"highway": "service", "service": ["driveway", "parking_aisle"]}, False),
    ({"highway": "service", "service": ["parking_aisle", "driveway"]}, False),
    ({"highway": "tertiary", "access": ["yes", "no"]}, False),
    ({"highway": "service", "access": "no", "service": "driveway", "name": "Yishun Bus Interchange"}, True),
    ({"highway": ["service", "footway"], "name": ["Yishun Bus Interchange", "x"]}, True),
    ({"highway": "service", "psv": "designated", "access": "no"}, True),
    ({"highway": "busway"}, True),
    ({}, False),
])
def test_keep_edge_uses_every_merged_part(tags, keep):
    assert keep_edge(tags) is keep


def test_road_class_is_the_slowest_part_whatever_the_order():
    assert road_class({"highway": ["residential", "service"]}) == "service"
    assert road_class({"highway": ["service", "residential"]}) == "service"
    assert road_class({"highway": ["primary", "secondary"]}) == "secondary"
    assert road_class({"highway": "busway"}) == "service"
    assert road_class({"highway": "primary"}) == "primary"


GRAPH_SIG = """
import hashlib
from yishun import network as N
N.INTERIM = __import__("pathlib").Path(__import__("tempfile").mkdtemp())
G = N.build_drive_graph()
print(G.number_of_nodes(), G.number_of_edges(), hashlib.sha1(repr(sorted(
    (u, v, k, d["cls"], round(d["length"], 2), d["n_sig"]) for u, v, k, d in G.edges(keys=True, data=True)
)).encode()).hexdigest())
"""


def test_graph_does_not_depend_on_hash_seed():
    """Phase 1 picked the first value of list-valued tags, whose order follows Python's string
    hash seed, so rebuilding the graph gave a different network in each process."""
    if not (RAW / "osm" / "highways.osm").exists() or not (RAW / "osm" / "context.json").exists():
        pytest.skip("OSM extract not downloaded (run `make data`)")
    root = Path(__file__).resolve().parents[1]
    out = []
    for seed in ("1", "7"):
        env = {**os.environ, "PYTHONHASHSEED": seed, "PYTHONPATH": str(root / "pipeline")}
        r = subprocess.run([sys.executable, "-c", GRAPH_SIG], capture_output=True, text=True, env=env, cwd=root,
                           timeout=600)
        assert r.returncode == 0, r.stderr[-2000:]
        out.append(r.stdout.strip().splitlines()[-1])
    assert out[0] == out[1]
