"""Who uses the bus-km driven inside Yishun: the basis for sharing bus costs.

Buses inside Yishun also carry riders into, out of and through the town, so their cost cannot be
allocated to internal riders alone. From LTA's full fare-card OD (every Singapore weekday ride,
July + August 2026), each ride on a pair of stops served by a line that runs inside Yishun is
spread over the lines serving the pair in proportion to their published frequency at that hour
(a frequency-weighted line choice, as in common lines but without the attractiveness cut-off).
Its passenger-km on route segments with both end stops inside the planning area are counted. The
same in-area segments define the bus-km of the supply model (supply.py).

Output: data/processed/phase2/bus_allocation.json (committed; DataMall serves OD months for only
three months), with passenger-km shares by rider group, per-service shares, and the services
that carry only internal riders (the only candidates for withdrawal, and only under full
replacement; see docs/phase2/definitions.md section 6).
"""
from __future__ import annotations

import json
import zipfile

import numpy as np
import pandas as pd

from ..busnet import band_for_minute, parse_headway
from ..demand import BASE_MONTHS, weekdays_in_month
from ..paths import PROCESSED, RAW
from ..study_area import study_stops

BANDS = ("AM_Peak_Freq", "AM_Offpeak_Freq", "PM_Peak_Freq", "PM_Offpeak_Freq")


def line_pairs(study: set[str]) -> tuple[dict, pd.DataFrame]:
    """(o, d) -> [(service, direction, in-area km between o and d, frequency per band)] for every
    line with in-area segments, plus one row per such line."""
    routes = pd.DataFrame(json.loads((RAW / "lta" / "bus_routes.json").read_text()))
    svc = pd.DataFrame(json.loads((RAW / "lta" / "bus_services.json").read_text())).set_index(["ServiceNo", "Direction"])
    pairs, lines = {}, []
    for (sno, d), g in routes.groupby(["ServiceNo", "Direction"]):
        if (sno, d) not in svc.index:
            continue
        g = g.sort_values("StopSequence")
        c, km = g.BusStopCode.tolist(), g.Distance.astype(float).tolist()
        seg = [max(km[k] - km[k - 1], 0.0) if (c[k - 1] in study and c[k] in study) else 0.0 for k in range(1, len(c))]
        if sum(seg) <= 0:
            continue
        cum = np.concatenate([[0.0], np.cumsum(seg)])
        row = svc.loc[(sno, d)]
        f = {b: 1.0 / parse_headway(row[b]) if parse_headway(row[b]) else 0.0 for b in BANDS}
        lines.append({"service": sno, "direction": int(d), "category": row.Category, "km_in": float(sum(seg)),
                      "km_route": float(km[-1] - km[0])})
        for pair, km_in in shortest_rides(c, cum).items():
            pairs.setdefault(pair, []).append((sno, int(d), km_in, f))
    return pairs, pd.DataFrame(lines)


def shortest_rides(stops: list[str], cum) -> dict[tuple[str, str], float]:
    """(o, d) -> in-area km of the shortest ride from o to d along one run. Loops revisit the
    interchange, and figure-of-eight feeders (812) pass it mid-route, so a rider boards at whichever
    visit gives the shortest ride (as busnet.BusBaseline.ride)."""
    best: dict = {}
    for i, s in enumerate(stops):
        for j in range(i + 1, len(stops)):
            if stops[j] == s:
                break   # from here on, boarding at this later visit is never longer
            if (s, stops[j]) not in best or cum[j] - cum[i] < best[(s, stops[j])]:
                best[(s, stops[j])] = float(cum[j] - cum[i])
    return best


def full_od(months=BASE_MONTHS) -> pd.DataFrame:
    """Average-weekday rides between every pair of Singapore bus stops by hour (raw DataMall files)."""
    parts = []
    for m in months:
        with zipfile.ZipFile(RAW / "lta" / "pv" / f"origin_destination_bus_{m}.zip") as z:
            name = next(n for n in z.namelist() if n.endswith(".csv"))
            od = pd.read_csv(z.open(name), dtype={"ORIGIN_PT_CODE": str, "DESTINATION_PT_CODE": str})
        parts.append(od.loc[od.DAY_TYPE == "WEEKDAY", ["ORIGIN_PT_CODE", "DESTINATION_PT_CODE", "TIME_PER_HOUR",
                                                        "TOTAL_TRIPS"]])
    od = pd.concat(parts).groupby(["ORIGIN_PT_CODE", "DESTINATION_PT_CODE", "TIME_PER_HOUR"], as_index=False).TOTAL_TRIPS.sum()
    od.columns = ["o", "d", "hour", "trips"]
    od["rides"] = od.trips / sum(weekdays_in_month(m) for m in months)
    return od[od.o != od.d]


def run(months=BASE_MONTHS) -> dict:
    study = set(study_stops().BusStopCode)
    pairs, lines = line_pairs(study)
    od = full_od(months)
    od["group"] = np.select([od.o.isin(study) & od.d.isin(study), od.o.isin(study), od.d.isin(study)],
                            ["internal", "outbound", "inbound"], "through")
    rides_by_group = od.groupby("group").rides.sum()
    use = od[[(a, b) in pairs for a, b in zip(od.o, od.d)]]
    svc_pk: dict = {}
    pk = np.zeros(len(use))
    for k, r in enumerate(use.itertuples()):
        lst = pairs[(r.o, r.d)]
        band = band_for_minute((r.hour * 60 + 30) % 1440)
        f = np.array([x[3][band] for x in lst])
        if f.sum() <= 0:     # no headway published for the band: the line's best band
            f = np.array([max(x[3].values()) for x in lst])
        if f.sum() <= 0:
            continue
        w = f / f.sum()
        for wi, x in zip(w, lst):
            v = r.rides * wi * x[2]
            pk[k] += v
            svc_pk[(x[0], x[1], r.group)] = svc_pk.get((x[0], x[1], r.group), 0.0) + v
    use = use.assign(pax_km_in=pk)
    tot = use.groupby("group").pax_km_in.sum()
    riding = use[use.pax_km_in > 0].groupby("group").rides.sum()
    s = pd.Series(svc_pk).rename_axis(["service", "direction", "group"]).unstack("group").fillna(0.0)
    s = s.reindex(columns=["internal", "outbound", "inbound", "through"], fill_value=0.0)
    s["total"] = s.sum(axis=1)
    s["internal_share"] = s.internal / s.total
    s = s.reset_index().merge(lines, on=["service", "direction"], how="left")
    only_internal = s[(s.internal_share > 0.9999) & (s.km_in >= s.km_route - 0.05)]
    out = {
        "months": list(months),
        "method": ("frequency-weighted line choice over every line serving the stop pair; passenger-km on route "
                   "segments with both end stops inside the planning area"),
        "rides_per_weekday": {g: round(float(v)) for g, v in rides_by_group.items()},
        "rides_using_in_area_buses": {g: round(float(v)) for g, v in riding.items()},
        "pax_km_in_area": {g: round(float(v)) for g, v in tot.items()},
        "pax_km_share": {g: round(float(v / tot.sum()), 4) for g, v in tot.items()},
        "ride_share": {g: round(float(v / riding.sum()), 4) for g, v in riding.items()},
        "internal_only_services": sorted(only_internal.service.unique().tolist()),
        "by_service": json.loads(s.round(4).to_json(orient="records")),
    }
    out_path = PROCESSED / "phase2" / "bus_allocation.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=1))
    print(json.dumps({k: out[k] for k in ("pax_km_share", "ride_share", "internal_only_services")}, indent=1))
    return out


def internal_only_supply(M, services: list[str]) -> dict:
    """Bus-km, bus-hours (running + dwell) and buses on the road at 07:00 inside Yishun of the
    given services, from the Phase 1 supply model (published headways)."""
    from ..supply import bus_supply, feeder_cycle_minutes, inside_minutes
    study = set(M.stops.index[M.stops.in_study])
    sup = bus_supply(study, feeder_cycle_minutes(M.baseline, None), inside_minutes(M.baseline, study),
                     inside_minutes(M.baseline, study, driving_only=True))
    sub = sup[sup.service.isin(services)]
    return {"bus_km": float(sub.km_inside.sum()), "bus_hours": float(sub.buses_inside.sum()),
            "buses_07": float(sub[sub.hour == 7].buses_inside.sum()),
            "all_bus_km": float(sup.km_inside.sum()), "all_bus_hours": float(sup.buses_inside.sum()),
            "all_buses_07": float(sup[sup.hour == 7].buses_inside.sum())}


if __name__ == "__main__":
    run()
