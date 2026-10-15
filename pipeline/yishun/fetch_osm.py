"""Download a dated OpenStreetMap extract for Yishun plus a ~1 km buffer via Overpass.

Two files are written to data/raw/osm/ (gitignored; OSM data is ODbL, (c) OpenStreetMap contributors):
  - highways.osm      OSM XML of every highway way + its nodes (input to the road graph)
  - context.json      Overpass JSON with geometry: buildings, landuse/water/parks, rail,
                      amenities and point features (crossings, signals, calming, bus stops)
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "osm"
# (south, west, north, east) - Yishun planning area (approx. 1.40-1.445 N, 103.81-103.87 E) + ~1 km buffer
BBOX = (1.390, 103.805, 1.452, 103.875)
MIRRORS = [
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]


def _bbox() -> str:
    return ",".join(str(v) for v in BBOX)


HIGHWAYS = f"""
[out:xml][timeout:300];
way["highway"]({_bbox()});
(._;>;);
out body;
"""

CONTEXT = f"""
[out:json][timeout:300];
(
  way["building"]({_bbox()});
  relation["building"]({_bbox()});
  way["landuse"]({_bbox()});
  way["leisure"~"park|garden|pitch|playground|nature_reserve|sports_centre|golf_course"]({_bbox()});
  relation["leisure"~"park|nature_reserve|golf_course"]({_bbox()});
  way["natural"~"water|wood|scrub|wetland"]({_bbox()});
  relation["natural"~"water|wood"]({_bbox()});
  way["waterway"]({_bbox()});
  way["railway"]({_bbox()});
  node["railway"~"station|subway_entrance"]({_bbox()});
  node["public_transport"="station"]({_bbox()});
  way["amenity"]({_bbox()});
  node["amenity"]({_bbox()});
  node["highway"~"crossing|traffic_signals|bus_stop|give_way|stop|mini_roundabout|turning_circle"]({_bbox()});
  node["traffic_calming"]({_bbox()});
  node["shop"="mall"]({_bbox()});
  way["shop"="mall"]({_bbox()});
);
out body geom;
"""


def _overpass(query: str) -> bytes:
    last = None
    for url in MIRRORS:
        for attempt in range(3):
            try:
                r = requests.post(url, data={"data": query}, timeout=360)
                if r.status_code == 200 and len(r.content) > 1000:
                    print(f"  ok from {url} ({len(r.content)/1e6:.1f} MB)")
                    return r.content
                last = f"{url}: HTTP {r.status_code}"
            except requests.RequestException as exc:  # network hiccup: retry, then next mirror
                last = f"{url}: {exc}"
            time.sleep(5 * (attempt + 1))
    sys.exit(f"Overpass failed: {last}")


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    print("highways ...")
    (RAW / "highways.osm").write_bytes(_overpass(HIGHWAYS))
    print("context ...")
    ctx = _overpass(CONTEXT)
    json.loads(ctx)  # fail loudly on a truncated response
    (RAW / "context.json").write_bytes(ctx)
    meta = {"bbox_swne": BBOX, "retrieved_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "licence": "ODbL 1.0, (c) OpenStreetMap contributors"}
    (RAW / "manifest.json").write_text(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
