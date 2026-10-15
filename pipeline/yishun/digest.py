"""Write the README's findings and limitations from the result files, so the numbers quoted
in prose are exactly the numbers the pipeline produced. Usage: python -m yishun.digest"""
from __future__ import annotations

import json
import re

from .paths import PROCESSED, ROOT, WEB_DATA


def _j(p):
    return json.loads(p.read_text())


def findings() -> str:
    rs, bl, dm = _j(WEB_DATA / "results.json"), _j(WEB_DATA / "baseline.json"), _j(WEB_DATA / "demand.json")
    cal = _j(PROCESSED / "calibration.json")
    H = rs["hours"]
    f10 = rs["frontier"]["10"]
    pk = rs["frontier_peak"]["10"]
    feeders = max(bl["feeder_buses_on_road"])
    ref = rs["reference"]
    par = rs["all_day_parity"]
    midday = f10[H.index(12)]
    late = f10[H.index(23)]
    vh = rs.get("vehicle_hours") or {}
    who = rs["who"]
    kerb_y = max(v for v in ref["kerb"]["Yishun"] if v is not None)
    kerb_k = max(v for v in ref["kerb"].get("Khatib", [0]) if v is not None)
    lines = [
        "## Findings",
        "",
        f"1. **The demand is short, hub-bound feeder riding.** {dm['rides_per_weekday']:,} rides per average weekday "
        f"start and end inside Yishun. The median is {dm['straight_line_pct_m']['50'] / 1000:.2f} km in a straight line, "
        f"and {round(100 * dm['hub_share'])} % start or end at an MRT or the interchange. Today's buses deliver "
        f"{bl['day_mean']['total_min']:.1f} min stop to stop on average ({bl['day_mean']['wait_min']:.1f} waiting + "
        f"{bl['day_mean']['ivt_min']:.1f} riding).",
        f"2. **There is a sharp capacity cliff.** With 10-seat shuttles, {par['10']} vehicles keep up with the bus in "
        f"every hour of the day. A fleet {rs['cliff_gap']} smaller loses the morning peak and builds a queue it "
        f"cannot clear for hours. Above the threshold, shuttles roughly halve the bus's stop-to-stop time "
        f"({ref['total_min']:.1f} vs {bl['day_mean']['total_min']:.1f} min). Vehicle size matters less than vehicle "
        f"count: {par['4']} four-seat, {par['10']} ten-seat or {par['20']} twenty-seat vehicles.",
        f"3. **Matching the bus costs about {pk['fleet'] / feeders:.0f}× the vehicles at the peak.** In steady state, "
        f"10-seat shuttles need {pk['fleet']} vehicles at {pk['hour']:02d}:00 against about {feeders} feeder buses on "
        f"the road, {midday} around midday and {late} after 23:00. Over a day that is {vh.get('10', 0):,} shuttle-hours "
        f"against about {rs['feeder_bus_hours']:,} feeder bus-hours. Singapore's whole autonomous passenger fleet is "
        f"16 vehicles (MOT, Sep 2026).",
        f"4. **Vehicle-kilometres grow about {ref['veh_km'] / bl['bus_km_inside_day']:.1f}×.** The all-day fleet drives "
        f"{ref['veh_km']:,.0f} km inside Yishun per weekday against {bl['bus_km_inside_day']:,} km by all buses "
        f"({bl['feeder_bus_km_inside_day']:,} km by feeders). Average load is {ref['occupancy']:.1f} riders per "
        f"shuttle-km, and {100 * ref['empty_share']:.0f} % of shuttle-km are empty.",
        f"5. **The MRT kerb becomes the scarce infrastructure.** Up to {kerb_y:.0f} shuttles are stopped at once at the "
        f"Yishun MRT and interchange stops, and {kerb_k:.0f} at Khatib, before idle vehicles waiting for work.",
        f"6. **Who gains.** {who['text']}",
    ]
    kx = rs.get("kerb_experiment")
    if kx:
        rows = [r for r in kx if r["fleet"] == ref["fleet"] and r["berths"] != -1]
        fail = sorted([r for r in rows if not r["h7_ok"]], key=lambda r: -r["berths"])
        ok = sorted([r for r in rows if r["h7_ok"]], key=lambda r: r["berths"])
        if ok or fail:
            s = "7. **Kerb capacity is a hard constraint.**"
            if ok:
                s += (f" Limiting each station to {ok[0]['berths']} shuttles boarding at once still keeps up at 07:00 "
                      f"({ok[0]['h7_total_min']:.1f} min).")
            if fail:
                s += (f" At {fail[0]['berths']}, kerb queues push the 07:00 hour to {fail[0]['h7_total_min']:.1f} min "
                      f"and the fleet no longer matches the bus.")
            lines.append(s)
    sens = rs.get("sensitivity")
    if sens:
        base = next(r for r in sens if r["id"] == "base")
        vals = [r["parity_fleet"] for r in sens if r["parity_fleet"]]
        lines.append(f"8. **Sensitivity.** Across {len(sens) - 1} alternative assumptions, the all-day 10-seat fleet ranges "
                     f"{min(vals)}–{max(vals)} (base {base['parity_fleet']}). It is most sensitive to "
                     + ", ".join(f"{r['label'].lower()} ({r['parity_fleet'] or '>700'})" for r in sorted(
                         [r for r in sens if r['id'] != 'base'],
                         key=lambda r: -abs((r['parity_fleet'] or 800) - base['parity_fleet']))[:3]) + ".")
    lines += ["", f"*Calibration: {cal['n_obs_used']:,} matched observations on {cal['n_segments_used']:,} stop sequences "
              f"(r = {cal['segment_r']:.2f}). Fleets are the smallest simulated on a 25-vehicle grid; demand replicates "
              f"are Poisson draws around the observed average weekday.*", ""]
    return "\n".join(lines)


LIMITS = """## Limitations

- **Peak congestion.** Speeds are calibrated on late-morning data (10:00–13:00). If peak roads are slower, both
  modes slow and the shuttle fleet needed rises; see the sensitivity table.
- **Demand held fixed.** Same riders, stops and times as today. Halving stop-to-stop times would attract riders,
  and a $4 fare (Punggol's announced fare) would deter some; neither is modelled.
- **No congestion feedback or kerb limit in the base case.** Hundreds of shuttles do not slow each other or the
  buses. LTA's open traffic-volume data covers only expressways near Yishun, so the added flow could not be
  compared with measured traffic.
- **Bus side.** Running times are LTA's real-time *estimates*. Crowding and denied boarding are not modelled,
  which flatters the bus at peaks. Waits assume riders arrive at random; riders using live-arrival apps wait less
  (tested in sensitivity).
- **Dispatcher.** A standard insertion heuristic, not an optimiser; a better dispatcher could need fewer vehicles.
- **Not modelled:** charging and depots, safety operators, breakdowns, fares, costs, emissions, walking to stops
  (identical in both modes because both serve the same stops).
"""


def main() -> None:
    p = ROOT / "README.md"
    s = p.read_text()
    s = re.sub(r"<!-- FINDINGS -->.*?(?=## Why this question)", "<!-- FINDINGS -->\n" + findings() + "\n", s, flags=re.S)
    s = re.sub(r"<!-- LIMITATIONS -->.*?(?=## Credits)", "<!-- LIMITATIONS -->\n" + LIMITS + "\n", s, flags=re.S)
    p.write_text(s)
    print(findings())


if __name__ == "__main__":
    main()
