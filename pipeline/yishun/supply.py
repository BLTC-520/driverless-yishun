"""Today's bus supply inside the study area, for like-for-like resource comparisons.

From LTA BusRoutes (stop sequences and cumulative route distance), BusServices (headway
ranges per time band) and first/last bus times, we estimate per hour of a weekday:
  * bus trips run per service-direction (60 / mean headway while the service operates)
  * bus-km driven *inside the Yishun planning area* (route segments whose both end stops
    lie inside the area)
  * the number of buses on the road for Yishun's feeder services (cycle time / headway)
  * the average number of buses of *any* service inside the planning area (modelled running
    time on in-area segments x trips per hour)
These are estimates from published headways, not operator logs.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .busnet import band_for_minute, parse_headway
from .paths import RAW


def _hhmm(s):
    s = str(s)
    if not s.isdigit():
        return None
    v = int(s)
    return (v // 100) * 60 + v % 100


def inside_minutes(baseline, study_codes: set[str]) -> dict[tuple[str, int], float]:
    """Modelled minutes each service-direction spends between consecutive in-area stops."""
    out = {}
    for ln, pos, cum in baseline.segments:
        m = sum(cum[k] - cum[k - 1] for k in range(1, len(ln.stops))
                if ln.stops[k - 1] in study_codes and ln.stops[k] in study_codes and np.isfinite(cum[k] - cum[k - 1]))
        if m > 0:
            out[(ln.service, ln.direction)] = m / 60.0
    return out


def bus_supply(study_codes: set[str], cycle_min: dict[tuple[str, int], float] | None = None,
               inside_min: dict[tuple[str, int], float] | None = None) -> pd.DataFrame:
    routes = pd.DataFrame(json.loads((RAW / "lta" / "bus_routes.json").read_text()))
    svc = pd.DataFrame(json.loads((RAW / "lta" / "bus_services.json").read_text())).set_index(
        ["ServiceNo", "Direction"])
    rows = []
    for (sno, d), g in routes.groupby(["ServiceNo", "Direction"]):
        g = g.sort_values("StopSequence")
        codes = g.BusStopCode.tolist()
        km = g.Distance.astype(float).tolist()
        inside_km = sum(b - a for c1, c2, a, b in zip(codes[:-1], codes[1:], km[:-1], km[1:])
                        if c1 in study_codes and c2 in study_codes)
        if inside_km <= 0 or (sno, d) not in svc.index:
            continue
        s = svc.loc[(sno, d)]
        first, last = _hhmm(g.WD_FirstBus.iloc[0]), _hhmm(g.WD_LastBus.iloc[0])
        if first is None or last is None:
            continue
        if last < first:
            last += 1440
        for hour in range(5, 26):
            m0, m1 = hour * 60, hour * 60 + 60
            active = max(0, min(m1, last) - max(m0, first))
            if active <= 0:
                continue
            hw = parse_headway(s[band_for_minute((m0 + 30) % 1440)])
            if hw is None:
                continue
            trips = active / hw
            buses = (cycle_min or {}).get((sno, int(d)), np.nan) / hw if s.Category == "FEEDER" else np.nan
            inside = (inside_min or {}).get((sno, int(d)), np.nan) * trips / 60.0
            rows.append({"service": sno, "direction": int(d), "category": s.Category, "hour": hour,
                         "trips": trips, "km_inside": trips * inside_km, "buses_on_road": buses,
                         "buses_inside": inside})
    return pd.DataFrame(rows)


def feeder_cycle_minutes(baseline, lines, layover_min: float = 5.0) -> dict:
    """Modelled end-to-end running time of each feeder loop (+ layover) from the bus model."""
    out = {}
    for ln, pos, cum in baseline.segments:
        if not ln.service.startswith("8") or len(ln.stops) < 3:
            continue
        if np.isfinite(cum[-1]):
            out[(ln.service, ln.direction)] = cum[-1] / 60.0 + layover_min
    return out
