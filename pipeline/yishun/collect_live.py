"""Poll LTA DataMall BusArrival (v3) for a set of Yishun stops and log observations.

Each response lists, per bus service, the next three buses with an estimated arrival time
and (when GPS-monitored) the bus's current position, load band and deck type. Logged
observations are later used to estimate observed stop-to-stop bus running times.

Rate: one request per stop per cycle, cycles every `--interval` seconds, spread evenly
over the cycle (default ~0.7 request/second). The AccountKey comes from LTA_DATAMALL_KEY.

Usage:
    python -m yishun.collect_live --minutes 120 --interval 60
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "lta"
URL = "https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival"
SGT = dt.timezone(dt.timedelta(hours=8))
FIELDS = ["poll_ts", "stop", "service", "k", "origin", "destination", "eta", "monitored",
          "lat", "lon", "visit", "load", "type"]


def yishun_stops() -> list[str]:
    stops = json.loads((RAW / "bus_stops.json").read_text())
    return sorted(s["BusStopCode"] for s in stops if s["BusStopCode"].startswith("59"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=120)
    ap.add_argument("--interval", type=float, default=90, help="seconds per full polling cycle")
    args = ap.parse_args()

    key = os.environ["LTA_DATAMALL_KEY"]
    stops = yishun_stops()
    gap = args.interval / len(stops)
    day = dt.datetime.now(SGT).strftime("%Y%m%d")
    out = RAW / "live" / f"bus_arrival_{day}.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    new = not out.exists()
    end = time.time() + args.minutes * 60
    session = requests.Session()
    session.headers.update({"AccountKey": key, "accept": "application/json"})

    with open(out, "a", newline="") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(FIELDS)
        while time.time() < end:
            cycle_start = time.time()
            for stop in stops:
                t0 = time.time()
                try:
                    r = session.get(URL, params={"BusStopCode": stop}, timeout=20)
                    if r.status_code == 200:
                        ts = dt.datetime.now(SGT).isoformat(timespec="seconds")
                        for svc in r.json().get("Services", []):
                            for k, nb in enumerate(("NextBus", "NextBus2", "NextBus3"), start=1):
                                b = svc.get(nb) or {}
                                if not b.get("EstimatedArrival"):
                                    continue
                                w.writerow([ts, stop, svc["ServiceNo"], k, b.get("OriginCode"),
                                            b.get("DestinationCode"), b.get("EstimatedArrival"),
                                            b.get("Monitored"), b.get("Latitude"), b.get("Longitude"),
                                            b.get("VisitNumber"), b.get("Load"), b.get("Type")])
                    elif r.status_code == 429:
                        time.sleep(30)
                except requests.RequestException:
                    pass
                time.sleep(max(0.0, gap - (time.time() - t0)))
            fh.flush()
            time.sleep(max(0.0, args.interval - (time.time() - cycle_start)))


if __name__ == "__main__":
    main()
