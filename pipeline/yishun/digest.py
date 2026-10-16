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
    n = rs["numbers"]
    ref = rs["reference"]
    par = rs["all_day_parity"]
    who = rs["who"]
    g = rs.get("gps_check") or {}
    lines = [
        "## Findings",
        "",
        f"1. **The demand is short, hub-bound feeder riding.** {n['rides']} rides per average school-term weekday "
        f"(July–August 2026) start and end inside Yishun. The median is {n['median']} in a straight line, and "
        f"{n['hubshare']} start or end at an MRT station or the interchange. Today's buses deliver "
        f"{bl['day_mean']['total_min']:.1f} min stop to stop on average ({bl['day_mean']['wait_min']:.1f} waiting + "
        f"{bl['day_mean']['ivt_min']:.1f} riding).",
        f"2. **There is a sharp capacity threshold.** With 10-seat shuttles, {n['parity']} vehicles keep up with the bus "
        f"in every hour of all three simulated weekdays ({n.get('h8_p', '—')} at 08:00 against the bus's "
        f"{n.get('bus8', '—')}). With {n.get('parity_lo', '—')}, the queue left by the 07:00 rush pushes the 08:00 hour to "
        f"{n.get('h8_lo', '—')} before it clears; with {n.get('f_lo3', '—')}, to {n.get('h8_lo3', '—')}, and "
        f"{n.get('ref_lo3', '—')} of the day's riders are refused. Above the threshold the shuttle is "
        f"{100 * (1 - ref['total_min'] / ref['bus_min']):.0f} % faster stop to stop over the day "
        f"({ref['total_min']:.1f} vs {ref['bus_min']:.1f} min). Bigger vehicles help less than their seats suggest: "
        f"{par.get('4')} four-seat, {par.get('10')} ten-seat or {par.get('20')} twenty-seat vehicles, because at the "
        f"threshold a shuttle carries {n['occ']} riders on average. Matching the bus's 90th-percentile time in every "
        f"hour instead needs {n.get('parity90', '—')} ten-seat shuttles.",
        f"3. **It takes more vehicles than today's buses, and far more driving.** In the model, {n['parity']} shuttles is "
        f"{n.get('vehx', '—')} the {n.get('busesin', '—')} buses of all services inside Yishun at 07:00 "
        f"({n.get('feeders', '—')} of them feeders). Each bus carries about ten times as many people "
        f"(about {n.get('busplaces', '—')} places against {n.get('shplaces', '—')} shuttle seats). The fleet drives "
        f"{n['vkm']} km inside Yishun per weekday, {n['vkmx']} the {n['buskm']} km all buses drive there, carrying "
        f"{n['occ']} riders on average against at least {n['buspaxkm']} per bus-km. Singapore's whole autonomous "
        f"passenger fleet is 16 vehicles (MOT, Sep 2026).",
        f"4. **Feeder theory points the same way.** In a single feeder zone, demand-responsive service beats fixed routes "
        f"only below about 10–50 riders per square mile per hour (Li & Quadrifoglio 2010). Averaged over the town, "
        f"Yishun's internal demand at 07:00 is about {n.get('density', '—')}. If the fleet in service could change every "
        f"hour, the off-peak would need far fewer vehicles (about {n.get('midday', '—')} at midday): "
        f"{n.get('vhlb', '—')} vehicle-hours in service a day instead of {n.get('vh', '—')}. The fixed fleet spends about "
        f"{n.get('shdrive', '—')} of its hours driving, against about {n.get('busdrive', '—')} hours of bus driving inside "
        f"Yishun.",
        f"5. **The MRT kerb becomes a bottleneck.** Up to {n.get('kerbmax', '—')} shuttles board or alight at once at the "
        f"Yishun MRT and interchange stops, and {n.get('kerbkhatib', '—')} at Khatib, before idle vehicles waiting "
        f"for work.",
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
                more = [r for r in kx if r["fleet"] > ref["fleet"] and r["berths"] == fail[0]["berths"]]
                if more and more[0]["h7_total_min"] > fail[0]["h7_total_min"]:
                    s += (f" Adding vehicles makes it worse: {more[0]['fleet']} shuttles with the same kerb take "
                          f"{more[0]['h7_total_min']:.1f} min, because the extra vehicles queue too.")
            lines.append(s)
    sens = rs.get("sensitivity")
    if sens:
        base = next(r for r in sens if r["id"] == "base")
        others = [r for r in sens if r["id"] != "base"]
        vals = [r["parity_fleet"] for r in others if r["parity_fleet"]]
        big = sorted(others, key=lambda r: -abs((r["parity_fleet"] or 900) - base["parity_fleet"]))[:3]
        disp = {r["id"]: r["parity_fleet"] for r in sens}
        if disp.get("widest_search"):
            lines.append(f"8. **The dispatcher is a lever as big as the vehicle.** The simple dispatcher used here considers up to 32 "
                         f"shuttles per request. Considering twice or four times as many lowers the threshold from "
                         f"{base['parity_fleet']} to {disp.get('wider_search')} or {disp['widest_search']}.")
        lines.append(f"9. **Sensitivity.** Across {len(others)} alternative assumptions, pushing both ways, the all-day "
                     f"10-seat fleet ranges {min(vals)}–{max(vals)} (base {base['parity_fleet']}). The largest moves: "
                     + "; ".join(f"{r['label'][0].lower() + r['label'][1:]} ({r['parity_fleet'] or 'over 800'})" for r in big) + ".")
    ho = cal.get("holdout_services", {})
    w = g.get("by_window", {})
    val = (f"*Calibration: {cal['n_obs_used']:,} matched LTA arrival estimates on {cal['n_segments_used']:,} stop "
           f"sequences (10:00–12:59). With whole services held out, error is {100 * ho.get('model', {}).get('mape', 0):.0f} % "
           f"against {100 * ho.get('distance_only', {}).get('mape', 0):.0f} % for distance alone.")
    if w.get("10-12"):
        val += (f" Observed bus GPS movement takes {w['10-12']['pooled_ratio']:.2f}× the modelled time at midday")
        if w.get("17-19"):
            val += f" and {w['17-19']['pooled_ratio']:.2f}× in the evening peak"
            pm = cal.get("holdout_hours", {}).get("17-19")
            if pm:
                val += f", where LTA's estimates imply {pm['obs_over_pred']:.2f}×"
        val += "."
    val += (" Fleets are the smallest simulated on a 25-vehicle grid; demand replicates are Poisson draws around the "
            "observed average weekday.*")
    lines += ["", val, ""]
    return "\n".join(lines)


LIMITS = """## Limitations

- **Morning peak not observed.** The threshold is set in the 07:00–09:00 rush, but live data were
  collected 10:06–14:57 (with a half-hour gap at 12:00) and 17:30–19:30. In the evening peak, LTA's estimates imply buses about 10 % slower than
  the midday model, while chained GPS positions show almost no slowdown. The sensitivity table applies
  the evening-peak calibration all day as the cautious stand-in.
- **One day of live data.** The calibration and the GPS check come from Thursday 15 October 2026.
- **Demand held fixed.** Same riders, stops and times as today. Faster trips would attract riders,
  and a $4 fare (Punggol's announced fare) would deter some; neither is modelled. Rides are fare-card
  stages, so a two-bus trip inside Yishun stays two requests.
- **No congestion feedback.** Hundreds of shuttles do not slow each other or the buses. LTA's open
  traffic-volume data covers only expressways near Yishun, so the added flow could not be compared with
  measured traffic. Kerb space is unlimited in the base case (a limit is tested separately).
- **Bus side.** Running times are calibrated to LTA's real-time *estimates*, checked against GPS
  movement. Crowding and denied boarding are not modelled, which flatters the bus at peaks. Waits
  assume riders arrive at random; riders using live-arrival apps wait less (tested in sensitivity).
- **Dispatcher.** Immediate insertion with exact travel times: neither a batch optimiser (which could
  need fewer vehicles) nor travel-time noise (which would widen tails).
- **Not modelled:** charging and depots, safety operators, breakdowns, fares, costs, emissions, and
  walking to stops (identical in both modes because both serve the same stops).
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
