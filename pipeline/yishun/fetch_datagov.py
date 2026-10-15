"""Download open datasets from data.gov.sg (Singapore Open Data Licence) without an API key.

Files go to data/raw/datagov/<name>.<ext>. The poll-download endpoint returns a short-lived
signed URL; HTTP 429 responses are retried with backoff.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "datagov"
API = "https://api-open.data.gov.sg/v1/public/api/datasets/{id}/{action}"

DATASETS = {
    # name: (dataset id, extension)
    "hdb_property_information": ("d_17f5382f26140b1fdae0ba2ef6239d2f", "csv"),
    "hdb_existing_building": ("d_16b157c52ed637edd6ba1232e026258d", "geojson"),
    "hdb_carpark_information": ("d_23f946fa557947f93a8043bbef41dd09", "csv"),
    "mp2019_planning_area": ("d_4765db0e87b9c86336792efe8a1f7a66", "geojson"),
    "mp2019_subzone": ("d_8594ae9ff96d0c708bc2af633048edfb", "geojson"),
    "census2020_subzone_age_sex": ("d_d95ae740c0f8961a0b10435836660ce0", "csv"),
    "census2020_mode_to_work": ("d_1f8f5ec7201964e365c77551cab99503", "csv"),
    "lta_mrt_station_exit": ("d_b39d3a0871985372d7e1637193335da5", "geojson"),
}


def _call(dataset_id: str, action: str) -> dict:
    for attempt in range(6):
        r = requests.get(API.format(id=dataset_id, action=action), timeout=60)
        if r.status_code == 429:
            time.sleep(10 * (attempt + 1))
            continue
        r.raise_for_status()
        return r.json()
    sys.exit(f"data.gov.sg rate-limited on {dataset_id}")


def fetch(name: str) -> Path:
    dataset_id, ext = DATASETS[name]
    dest = RAW / f"{name}.{ext}"
    if dest.exists():
        return dest
    _call(dataset_id, "initiate-download")
    for _ in range(30):
        data = _call(dataset_id, "poll-download").get("data", {})
        if data.get("url"):
            break
        time.sleep(3)
    else:
        sys.exit(f"download of {name} never became ready")
    r = requests.get(data["url"], timeout=600)
    r.raise_for_status()
    RAW.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(r.content)
    manifest = RAW / "manifest.json"
    meta = json.loads(manifest.read_text()) if manifest.exists() else {}
    meta[name] = {"dataset_id": dataset_id, "bytes": len(r.content),
                  "retrieved_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                  "licence": "Singapore Open Data Licence v1.0"}
    manifest.write_text(json.dumps(meta, indent=2, sort_keys=True))
    return dest


def main() -> None:
    for name in DATASETS:
        p = fetch(name)
        print(f"{name}: {p.stat().st_size/1e6:.1f} MB")
        time.sleep(2)


if __name__ == "__main__":
    main()
