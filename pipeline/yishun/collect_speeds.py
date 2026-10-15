"""Snapshot LTA v4 TrafficSpeedBands for the Yishun bounding box at a fixed interval.

Each snapshot is reduced to links whose start point lies inside the study bbox and is
appended to data/raw/lta/live/speedbands_<date>.csv (one row per link per snapshot).

Usage:
    python -m yishun.collect_speeds --minutes 120 --interval 900
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import os
import time
from pathlib import Path

import requests

from .fetch_osm import BBOX

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "raw" / "lta" / "live"
URL = "https://datamall2.mytransport.sg/ltaodataservice/v4/TrafficSpeedBands"
SGT = dt.timezone(dt.timedelta(hours=8))
FIELDS = ["snap_ts", "LinkID", "RoadName", "RoadCategory", "SpeedBand", "MinimumSpeed", "MaximumSpeed",
          "StartLon", "StartLat", "EndLon", "EndLat"]


def snapshot(session: requests.Session) -> list[dict]:
    rows, skip = [], 0
    while True:
        r = session.get(URL, params={"$skip": skip}, timeout=60)
        r.raise_for_status()
        page = r.json().get("value", [])
        rows.extend(page)
        if len(page) < 500:
            return rows
        skip += 500


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=120)
    ap.add_argument("--interval", type=float, default=900)
    args = ap.parse_args()
    s, w, n, e = BBOX
    session = requests.Session()
    session.headers.update({"AccountKey": os.environ["LTA_DATAMALL_KEY"], "accept": "application/json"})
    OUT.mkdir(parents=True, exist_ok=True)
    end = time.time() + args.minutes * 60
    while time.time() < end:
        t0 = time.time()
        ts = dt.datetime.now(SGT).isoformat(timespec="seconds")
        try:
            rows = snapshot(session)
        except requests.RequestException:
            time.sleep(60)
            continue
        out = OUT / f"speedbands_{ts[:10].replace('-', '')}.csv"
        new = not out.exists()
        with open(out, "a", newline="") as fh:
            wr = csv.writer(fh)
            if new:
                wr.writerow(FIELDS)
            for r in rows:
                lat, lon = float(r["StartLat"]), float(r["StartLon"])
                if s <= lat <= n and w <= lon <= e:
                    wr.writerow([ts] + [r[k] for k in FIELDS[1:]])
        time.sleep(max(0.0, args.interval - (time.time() - t0)))


if __name__ == "__main__":
    main()
