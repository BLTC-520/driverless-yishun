"""Download LTA DataMall datasets used by the project.

The DataMall AccountKey is read from the LTA_DATAMALL_KEY environment variable and is
never written to disk or logs. Raw downloads go to data/raw/lta/ (gitignored) because
redistribution of raw files is governed by the DataMall terms of use.

Usage:
    python -m yishun.fetch_lta all            # everything below
    python -m yishun.fetch_lta bus            # stops, services, routes
    python -m yishun.fetch_lta pv 202609      # passenger volumes for a month (YYYYMM)
    python -m yishun.fetch_lta geo            # geospatial whole-island layers
    python -m yishun.fetch_lta speedbands     # one snapshot of v4 TrafficSpeedBands
    python -m yishun.fetch_lta pinned         # restore the committed stops, services and routes
    python -m yishun.fetch_lta pin            # commit-ready copies of the current ones
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

import requests

BASE = "https://datamall2.mytransport.sg/ltaodataservice/"
ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "lta"

# Paged OData collections (500 records per page).
PAGED = {"BusStops": "bus_stops.json", "BusServices": "bus_services.json", "BusRoutes": "bus_routes.json"}

# Passenger-volume endpoints return a signed link to a monthly zip file.
PV = {"PV/Bus": "pv_bus", "PV/ODBus": "pv_odbus", "PV/Train": "pv_train", "PV/ODTrain": "pv_odtrain"}

# Geospatial Whole Island layer IDs (exact spelling per the DataMall API guide,
# including LTA's own "Pedestrain" typo).
GEO_LAYERS = [
    "BusStopLocation", "TrafficLight", "RoadCrossing", "RoadHump", "SilverZone", "SchoolZone",
    "PassengerPickupBay", "RoadSectionLine", "KerbLine", "LaneMarking", "CyclingPath",
    "CoveredLinkWay", "PedestrainOverheadbridge_UnderPass", "TaxiStand",
]


def _key() -> str:
    key = os.environ.get("LTA_DATAMALL_KEY", "").strip()
    if not key:
        sys.exit("LTA_DATAMALL_KEY is not set. Register at https://datamall.lta.gov.sg and export it.")
    return key


def _get(path: str, params: dict | None = None, retries: int = 4) -> dict:
    headers = {"AccountKey": _key(), "accept": "application/json"}
    for attempt in range(retries):
        r = requests.get(BASE + path, headers=headers, params=params, timeout=60)
        if r.status_code == 200:
            return r.json()
        if r.status_code in (429, 500, 502, 503, 504):
            time.sleep(2 ** (attempt + 1))
            continue
        r.raise_for_status()
    r.raise_for_status()
    return {}


def _download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        tmp = dest.with_suffix(dest.suffix + ".part")
        with open(tmp, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
        tmp.replace(dest)
    return dest


def _write_manifest(name: str, info: dict) -> None:
    manifest = RAW / "manifest.json"
    data = json.loads(manifest.read_text()) if manifest.exists() else {}
    data[name] = {**info, "retrieved_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    manifest.write_text(json.dumps(data, indent=2, sort_keys=True))


def fetch_paged() -> None:
    for endpoint, fname in PAGED.items():
        rows, skip = [], 0
        while True:
            page = _get(endpoint, {"$skip": skip}).get("value", [])
            rows.extend(page)
            if len(page) < 500:
                break
            skip += 500
        out = RAW / fname
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(rows))
        _write_manifest(endpoint, {"file": fname, "records": len(rows)})
        print(f"{endpoint}: {len(rows)} records -> {out.relative_to(ROOT)}")


def fetch_pv(month: str | None = None, only: tuple[str, ...] | None = None) -> None:
    """Passenger-volume files for a month (default: the latest). DataMall serves only the last
    three months, so the Yishun-filtered OD table is also kept in data/processed."""
    for endpoint, stem in PV.items():
        if only and endpoint not in only:
            continue
        params = {"Date": month} if month else None
        link = _get(endpoint, params)["value"][0]["Link"]
        # The month is embedded in the signed link path, e.g. .../202609/origin_destination_bus_202609.zip
        fname = link.split("?")[0].rsplit("/", 1)[-1]
        dest = RAW / "pv" / fname
        if not dest.exists():
            _download(link, dest)
        _write_manifest(endpoint, {"file": f"pv/{fname}", "bytes": dest.stat().st_size, "requested_month": month})
        print(f"{endpoint}: {dest.relative_to(ROOT)} ({dest.stat().st_size/1e6:.1f} MB)")


def fetch_geo() -> None:
    for layer in GEO_LAYERS:
        try:
            link = _get("GeospatialWholeIsland", {"ID": layer})["value"][0]["Link"]
        except requests.HTTPError as exc:
            print(f"{layer}: unavailable ({exc.response.status_code})")
            continue
        dest = RAW / "geo" / f"{layer}.zip"
        _download(link, dest)
        _write_manifest(f"Geo/{layer}", {"file": f"geo/{layer}.zip", "bytes": dest.stat().st_size})
        print(f"{layer}: {dest.stat().st_size/1e3:.0f} kB")


def fetch_speedbands() -> None:
    rows, skip = [], 0
    while True:
        page = _get("v4/TrafficSpeedBands", {"$skip": skip}).get("value", [])
        rows.extend(page)
        if len(page) < 500:
            break
        skip += 500
    stamp = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).strftime("%Y%m%dT%H%M")
    out = RAW / "speedbands" / f"speedbands_{stamp}_sgt.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows))
    print(f"TrafficSpeedBands: {len(rows)} links -> {out.relative_to(ROOT)}")


# LTA updates routes and headways without notice, and these three files define the bus model, rule
# C's eligibility table, the internal-only services and the bus supply. The versions the results
# were computed from are committed (xz-compressed, Singapore Open Data Licence) and restored with
# `python -m yishun.fetch_lta pinned`, checked against their SHA-256.
PINNED = ROOT / "data" / "processed" / "lta"


def _sha256(b: bytes) -> str:
    import hashlib
    return hashlib.sha256(b).hexdigest()


def pin() -> None:
    """Write xz copies of the current stops, services and routes and their checksums to data/processed/lta."""
    import lzma
    PINNED.mkdir(parents=True, exist_ok=True)
    got = json.loads((RAW / "manifest.json").read_text()) if (RAW / "manifest.json").exists() else {}
    meta = {"licence": "Singapore Open Data Licence v1.0; contains information from LTA DataMall", "files": {}}
    for endpoint, name in PAGED.items():
        raw = (RAW / name).read_bytes()
        (PINNED / f"{name}.xz").write_bytes(lzma.compress(raw, preset=9))
        meta["files"][name] = {"endpoint": endpoint, "sha256": _sha256(raw), "bytes": len(raw),
                               "records": got.get(endpoint, {}).get("records"),
                               "retrieved_utc": got.get(endpoint, {}).get("retrieved_utc")}
    (PINNED / "manifest.json").write_text(json.dumps(meta, indent=2))
    print(f"pinned {', '.join(PAGED.values())} -> {PINNED.relative_to(ROOT)}")


def restore_pinned() -> None:
    """Restore the committed stops, services and routes into data/raw/lta, checking their checksums."""
    import lzma
    meta = json.loads((PINNED / "manifest.json").read_text())
    RAW.mkdir(parents=True, exist_ok=True)
    for name, info in meta["files"].items():
        raw = lzma.decompress((PINNED / f"{name}.xz").read_bytes())
        if _sha256(raw) != info["sha256"]:
            sys.exit(f"{name}: checksum does not match {PINNED / 'manifest.json'}")
        (RAW / name).write_bytes(raw)
        _write_manifest(info["endpoint"], {"file": name, "records": info["records"],
                                           "restored_from": f"data/processed/lta/{name}.xz",
                                           "originally_retrieved_utc": info["retrieved_utc"]})
    print(f"restored {', '.join(meta['files'])} into {RAW.relative_to(ROOT)}")


def main(argv: list[str]) -> None:
    cmd = argv[1] if len(argv) > 1 else "all"
    if cmd == "pin":
        return pin()
    if cmd == "pinned":
        return restore_pinned()
    if cmd in ("bus", "all"):
        fetch_paged()
    if cmd in ("pv", "all"):
        fetch_pv(argv[2] if len(argv) > 2 else None)
    if cmd == "pv-od":   # origin-destination bus volumes only, for one month: pv-od 202607
        fetch_pv(argv[2] if len(argv) > 2 else None, only=("PV/ODBus",))
    if cmd == "geo":   # not used by the model; kept for exploration
        fetch_geo()
    if cmd in ("speedbands", "all"):
        fetch_speedbands()


if __name__ == "__main__":
    main(sys.argv)
