"""Baseline: what today's bus network offers each observed stop-to-stop ride.

For an origin stop i, destination stop j and hour h, the rider can board any service that
visits i and later j on the same run. Following the common-lines model (Chriqui & Robillard,
1975, Transportation Science 9(2)), the rider boards the first arriving bus among the
*attractive* lines, so

    E[wait] = kappa / sum_l f_l           (f_l = 1 / headway_l)
    E[ivt]  = sum_l f_l * ivt_l / sum_l f_l

where kappa = 0.5 * (1 + CV^2) converts mean headway to mean wait for random passenger
arrivals with headway coefficient of variation CV (kappa = 0.5 for perfectly regular buses,
1.0 for exponential headways). Lines are added in increasing order of in-vehicle time while
they reduce the expected total time.

Inputs: LTA BusRoutes (stop sequences), BusServices (headway ranges per time band), and the
shared road network (in-vehicle time = network travel time between consecutive stops + a dwell
at every intermediate stop).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .paths import RAW

# LTA DataMall BusServices time bands (minutes after midnight, inclusive start).
# AM_Peak 06:30-08:30, AM_Offpeak 08:31-16:59, PM_Peak 17:00-19:00, PM_Offpeak after 19:00.
# Before 06:30 no band is published; we use PM_Offpeak (late-evening headways) - an assumption.
def band_for_minute(m: float) -> str:
    if 6 * 60 + 30 <= m <= 8 * 60 + 30:
        return "AM_Peak_Freq"
    if 8 * 60 + 30 < m < 17 * 60:
        return "AM_Offpeak_Freq"
    if 17 * 60 <= m <= 19 * 60:
        return "PM_Peak_Freq"
    return "PM_Offpeak_Freq"


def parse_headway(s: str | None) -> float | None:
    """'5-8' -> 6.5 minutes; '-' or blank -> None (no service in that band)."""
    if not s or not isinstance(s, str):
        return None
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", s)]
    if not nums:
        return None
    return float(np.mean(nums[:2]))


def _hhmm(s: str) -> float | None:
    if not s or not s.strip().isdigit():
        return None
    v = int(s)
    return (v // 100) * 60 + v % 100


@dataclass
class Line:
    service: str
    direction: int
    stops: list[str]
    km: list[float]                            # LTA cumulative route distance at each stop
    headways: dict[str, float | None]          # band -> mean headway (min)
    first_last: dict[str, tuple[float | None, float | None]]  # stop -> (first, last) minutes


def load_lines(study_codes: set[str]) -> list[Line]:
    routes = pd.DataFrame(json.loads((RAW / "lta" / "bus_routes.json").read_text()))
    svc = pd.DataFrame(json.loads((RAW / "lta" / "bus_services.json").read_text()))
    svc = svc.set_index(["ServiceNo", "Direction"])
    lines = []
    for (sno, d), g in routes.groupby(["ServiceNo", "Direction"]):
        g = g.sort_values("StopSequence")
        if not set(g.BusStopCode) & study_codes:
            continue
        row = svc.loc[(sno, d)] if (sno, d) in svc.index else None
        hw = {b: parse_headway(row[b]) if row is not None else None
              for b in ("AM_Peak_Freq", "AM_Offpeak_Freq", "PM_Peak_Freq", "PM_Offpeak_Freq")}
        fl = {}
        for c, f, l in zip(g.BusStopCode, g.WD_FirstBus, g.WD_LastBus):
            fl.setdefault(c, (_hhmm(f), _hhmm(l)))
        lines.append(Line(sno, int(d), g.BusStopCode.tolist(), g.Distance.astype(float).tolist(), hw, fl))
    return lines


def _in_service(first: float | None, last: float | None, minute: float) -> bool:
    if first is None or last is None:
        return False
    if last < first:            # last bus after midnight, e.g. 05:20 -> 00:55
        return minute >= first or minute <= last
    return first <= minute <= last


@dataclass
class BaselineParams:
    kappa: float = 0.5 * (1 + 0.5 ** 2)   # headway CV 0.5 assumed until calibrated
    dwell_s: float = 25.0                  # per intermediate stop (s)
    hub_extra_s: float = 0.0               # extra dwell at intermediate MRT/interchange stops (s)
    fallback_kmh: float = 25.0             # bus speed on segments outside the network extract


class BusBaseline:
    """Expected wait / in-vehicle / total time for stop pairs under the current bus network."""

    def __init__(self, codes: list[str], T: np.ndarray, lines: list[Line], params: BaselineParams,
                 hub_codes: set[str] | None = None):
        self.idx = {c: i for i, c in enumerate(codes)}
        hub_codes = hub_codes or set()
        self.T = T
        self.p = params
        # For every line, pre-compute cumulative in-vehicle time along its stop sequence,
        # restricted to consecutive stops that are both inside the study area.
        self.segments: list[tuple[Line, dict[str, int], np.ndarray]] = []
        for ln in lines:
            pos, cum, t = {}, [0.0], 0.0
            seq = ln.stops
            for k, c in enumerate(seq):
                if k > 0:
                    a, b = seq[k - 1], c
                    if a in self.idx and b in self.idx:
                        run = T[self.idx[a], self.idx[b]]
                    else:  # segment outside the network extract: LTA route distance at a fallback speed
                        run = max(ln.km[k] - ln.km[k - 1], 0.0) * 1000 / (params.fallback_kmh / 3.6)
                    # cum[k] - cum[i] = in-vehicle time from boarding at position i to alighting at
                    # k: dwell at the boarding stop and every intermediate stop, plus running
                    # time (the shuttle's ride time is measured the same way).
                    dwell = params.dwell_s + (params.hub_extra_s if a in hub_codes else 0.0)
                    t += run + dwell
                    cum.append(t)
                pos.setdefault(c, k)  # first visit (loops revisit the interchange at the end)
            self.segments.append((ln, pos, np.array(cum)))

    def options(self, o: str, d: str, minute: float) -> list[tuple[float, float, str]]:
        """(headway_min, ivt_s, service) for every line serving o -> d at this time."""
        band = band_for_minute(minute % 1440)
        out = []
        for ln, pos, cum in self.segments:
            if o not in pos or d not in ln.stops:
                continue
            i = pos[o]
            # destination must come later on the same run
            later = [k for k, c in enumerate(ln.stops) if c == d and k > i]
            if not later:
                continue
            j = later[0]
            ivt = cum[j] - cum[i]
            hw = ln.headways.get(band)
            f, l = ln.first_last.get(o, (None, None))
            if hw is None or not np.isfinite(ivt) or not _in_service(f, l, minute % 1440):
                continue
            out.append((hw, float(ivt), ln.service))
        return out

    def expected(self, o: str, d: str, minute: float) -> dict | None:
        opts = sorted(self.options(o, d, minute), key=lambda x: x[1])
        if not opts:
            return None
        best = None
        fsum = fivt = 0.0
        chosen = []
        for hw, ivt, s in opts:
            f = 1.0 / (hw * 60.0)
            if best is not None and ivt >= best:
                break
            fsum += f
            fivt += f * ivt
            chosen.append(s)
            wait = self.p.kappa / fsum
            best = wait + fivt / fsum
        wait = self.p.kappa / fsum
        return {"wait_s": wait, "ivt_s": fivt / fsum, "total_s": wait + fivt / fsum, "lines": chosen}
