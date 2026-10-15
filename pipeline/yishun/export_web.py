"""Export compact, browser-ready data for the web experience (web/public/data/).

Every layer drawn on the page comes from here, i.e. from the pipeline's own inputs and
outputs. Coordinates are WGS84 rounded to 5 decimals (~1 m); heights in metres.
"""
from __future__ import annotations

import json
import math

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import box, mapping

from .paths import CRS_METRIC, CRS_WGS84, PROCESSED, RAW, WEB_DATA
from .study_area import boundary, subzones

BBOX = (103.805, 1.390, 103.875, 1.452)   # lon/lat extent shown on the page
STOREY_M = 3.0                            # HDB storey count -> height (m), incl. void deck and roof
OTHER_LEVEL_M = 3.2


def _r(x, nd=5):
    return round(float(x), nd)


def _coords(geom, nd=5):
    """Exterior rings of (multi)polygons as [[lon, lat], ...] lists."""
    out = []
    polys = [geom] if geom.geom_type == "Polygon" else list(getattr(geom, "geoms", []))
    for p in polys:
        if p.geom_type != "Polygon" or p.is_empty:
            continue
        out.append([[_r(x, nd), _r(y, nd)] for x, y in p.exterior.coords])
    return out


def _write(name: str, obj) -> None:
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    p = WEB_DATA / name
    p.write_text(json.dumps(obj, separators=(",", ":")))
    print(f"{name}: {p.stat().st_size / 1e6:.2f} MB")


# ---------------------------------------------------------------------------- base map
def export_town() -> None:
    clip = box(*BBOX)
    lu = gpd.read_file(RAW / "datagov" / "mp2019_land_use.geojson", bbox=BBOX)
    lu = lu.to_crs(CRS_METRIC)
    lu["geometry"] = lu.geometry.simplify(2.0)
    lu = lu.to_crs(CRS_WGS84)
    lu["geometry"] = lu.geometry.intersection(clip)
    kinds = {"WATERBODY": "water", "PARK": "green", "OPEN SPACE": "green", "SPORTS & RECREATION": "green",
             "ROAD": "road"}
    layers = {"water": [], "green": [], "road": []}
    for desc, geom in zip(lu.LU_DESC, lu.geometry):
        k = kinds.get(desc)
        if k and geom is not None and not geom.is_empty:
            layers[k].extend(_coords(geom))
    ys = gpd.GeoSeries([boundary()], crs=CRS_METRIC).simplify(5).to_crs(CRS_WGS84).iloc[0]
    sz = subzones().to_crs(CRS_METRIC)
    sz["geometry"] = sz.geometry.simplify(5)
    sz = sz.to_crs(CRS_WGS84)
    census = pd.read_csv(RAW / "datagov" / "census2020_subzone_age_sex.csv")
    census["Number"] = census.Number.str.strip()
    old = ["Total_65_69", "Total_70_74", "Total_75_79", "Total_80_84", "Total_85_89", "Total_90andOver"]
    for c in ["Total_Total"] + old:
        census[c] = pd.to_numeric(census[c].astype(str).str.replace("-", "0"), errors="coerce").fillna(0)
    census["key"] = census.Number.str.upper()
    cz = census.set_index("key")
    subz = []
    for name, geom in zip(sz.SUBZONE_N, sz.geometry):
        row = cz.loc[name] if name in cz.index else None
        pop = int(row.Total_Total) if row is not None else None
        p65 = float(row[old].sum() / row.Total_Total) if row is not None and row.Total_Total > 0 else None
        subz.append({"name": name.title(), "pop2020": pop, "share65": p65, "rings": _coords(geom)})
    yt = cz.loc["YISHUN - TOTAL"]
    st = cz.loc["TOTAL"]
    rail = []
    els = json.loads((RAW / "osm" / "context.json").read_text())["elements"]
    for e in els:
        t = e.get("tags", {})
        if e["type"] == "way" and t.get("railway") in ("subway", "rail", "light_rail") and "geometry" in e:
            rail.append([[_r(p["lon"]), _r(p["lat"])] for p in e["geometry"]])
    _write("town.json", {
        "bbox": BBOX, "center": [103.836, 1.4235],
        "boundary": _coords(ys), "subzones": subz, "water": layers["water"], "green": layers["green"],
        "roads": layers["road"], "rail": rail,
        "census2020": {"yishun_pop": int(yt.Total_Total), "yishun_share65": float(yt[old].sum() / yt.Total_Total),
                       "national_share65": float(st[old].sum() / st.Total_Total)},
        "source": "URA Master Plan 2019 land use and boundaries; SingStat Census 2020; OSM rail (ODbL)",
    })


def export_buildings() -> None:
    clip = box(*BBOX)
    hdb = gpd.read_file(RAW / "datagov" / "hdb_existing_building.geojson", bbox=BBOX)
    prop = pd.read_csv(RAW / "datagov" / "hdb_property_information.csv")
    prop = prop[prop.bldg_contract_town == "YS"].set_index("blk_no")
    ys = gpd.GeoSeries([boundary()], crs=CRS_METRIC).to_crs(CRS_WGS84).iloc[0]
    out, hdb_polys = [], []
    for blk, geom in zip(hdb.BLK_NO, hdb.geometry):
        if geom is None or not geom.intersects(clip):
            continue
        rec = prop.loc[blk] if (blk in prop.index and geom.representative_point().within(ys.buffer(0.002))) else None
        if rec is None:
            continue  # HDB blocks of neighbouring towns are drawn from OSM below
        floors = int(rec.max_floor_lvl)
        for ring in _coords(geom):
            out.append({"p": ring, "h": round(floors * STOREY_M, 1), "k": "hdb", "f": floors,
                        "y": int(rec.year_completed), "u": int(rec.total_dwelling_units),
                        "b": str(blk), "r": rec.residential == "Y"})
        hdb_polys.append(geom)
    hdb_union = gpd.GeoSeries(hdb_polys, crs=CRS_WGS84).union_all() if hdb_polys else None
    els = json.loads((RAW / "osm" / "context.json").read_text())["elements"]
    n_osm = n_lv = 0
    for e in els:
        t = e.get("tags", {})
        if e["type"] != "way" or "building" not in t or "geometry" not in e or len(e["geometry"]) < 4:
            continue
        ring = [[_r(p["lon"]), _r(p["lat"])] for p in e["geometry"]]
        cx = sum(p[0] for p in ring) / len(ring); cy = sum(p[1] for p in ring) / len(ring)
        if hdb_union is not None:
            from shapely.geometry import Point
            if hdb_union.contains(Point(cx, cy)):
                continue  # already drawn from HDB's own footprint
        h, src = None, "default"
        try:
            if "height" in t:
                h = float(str(t["height"]).split()[0]); src = "osm_height"
            elif "building:levels" in t:
                h = float(t["building:levels"]) * OTHER_LEVEL_M; src = "osm_levels"
        except ValueError:
            h = None
        if h is None:
            h = {"house": 9, "semidetached_house": 9, "terrace": 9, "bungalow": 7, "roof": 4}.get(t["building"], 10)
        n_osm += 1; n_lv += src != "default"
        out.append({"p": ring, "h": round(h, 1), "k": "other", "s": src})
    print(f"buildings: {sum(1 for b in out if b['k'] == 'hdb')} HDB footprints, {n_osm} OSM ({n_lv} with height/levels)")
    _write("buildings.json", {"buildings": out, "storey_m": STOREY_M,
                              "source": "HDB Existing Building + HDB Property Information (data.gov.sg); OSM (ODbL)"})


# ---------------------------------------------------------------------------- demand + baseline
def export_stops_and_demand(M) -> None:
    from .demand import internal_od
    od = M.od.copy()
    od["h"] = np.where(od.hour < 4, od.hour + 24, od.hour)
    R = M.R
    sxy = gpd.GeoSeries(gpd.points_from_xy(R.stop_xy[:, 0], R.stop_xy[:, 1]), crs=CRS_METRIC).to_crs(CRS_WGS84)
    from .experiments import station_of
    hours = list(range(5, 26))
    o = od.groupby(["o", "h"]).rides_per_weekday.sum().unstack(fill_value=0).reindex(columns=hours, fill_value=0)
    d = od.groupby(["d", "h"]).rides_per_weekday.sum().unstack(fill_value=0).reindex(columns=hours, fill_value=0)
    stops = []
    for code in M.stops.index[M.stops.in_study]:
        i = M.stop_index[code]
        s = M.stops.loc[code]
        stops.append({"c": code, "n": s.Description, "x": _r(sxy.iloc[i].x), "y": _r(sxy.iloc[i].y),
                      "hub": bool(s.is_hub), "st": station_of(s.Description) if s.is_hub else None,
                      "sz": (s.SUBZONE_N or "").title(),
                      "o": [round(float(v), 1) for v in (o.loc[code] if code in o.index else [0] * len(hours))],
                      "d": [round(float(v), 1) for v in (d.loc[code] if code in d.index else [0] * len(hours))]})
    # straight-line lengths and hub share
    xy = M.stops[["geometry"]]
    dist = np.array([M.stops.geometry[a].distance(M.stops.geometry[b]) for a, b in zip(od.o, od.d)])
    w = od.rides_per_weekday.to_numpy()
    order = np.argsort(dist)
    cw = np.cumsum(w[order]) / w.sum()
    pct = {str(q): float(dist[order][np.searchsorted(cw, q / 100)]) for q in (25, 50, 75, 90)}
    hist_edges = list(range(0, 3001, 250))
    hist = np.histogram(np.clip(dist, 0, 2999), bins=hist_edges, weights=w)[0]
    hub_codes = set(M.stops.index[M.stops.is_hub])
    hub_share = float(w[(od.o.isin(hub_codes) | od.d.isin(hub_codes)).to_numpy()].sum() / w.sum())
    flows = []
    for h in hours:
        sub = od[od.h == h].nlargest(160, "rides_per_weekday")
        flows.append([[r.o, r.d, round(float(r.rides_per_weekday), 1)] for r in sub.itertuples()])
    by_hour = od.groupby("h").rides_per_weekday.sum().reindex(hours, fill_value=0)
    from .demand import weekdays_in_month
    months = list(M.months)
    label = " + ".join(f"{m[4:]}/{m[:4]}" for m in months)
    _write("stops.json", {"hours": hours, "stops": stops,
                          "source": f"LTA DataMall PV/ODBus {label} (average weekday, rides with both ends in Yishun)"})
    _write("demand.json", {"hours": hours, "rides_by_hour": [round(float(v)) for v in by_hour],
                           "rides_per_weekday": round(float(w.sum())), "od_pairs": int(len(od.groupby(["o", "d"]))),
                           "straight_line_pct_m": pct, "hist_edges_m": hist_edges,
                           "hist_rides": [round(float(v)) for v in hist], "hub_share": hub_share,
                           "top_flows": flows, "months": months, "weekdays": sum(weekdays_in_month(m) for m in months),
                           "by_month": {m: round(float(internal_od(m).rides_per_weekday.sum())) for m in ("202607", "202608", "202609")},
                           "by_month_7am": {m: round(float(internal_od(m).query("hour == 7").rides_per_weekday.sum()))
                                            for m in ("202607", "202608", "202609")}})


DECK_PLACES = {"SD": 90, "DD": 125, "BD": 120}  # approx. riders incl. standing; secondary sources, see docs/data.md


def deck_mix(study: set[str]) -> dict | None:
    """Share of single-deck / double-deck / bendy buses among GPS-monitored buses observed at
    Yishun stops in the live log (each bus counted once per poll)."""
    import glob
    files = sorted(glob.glob(str(RAW / "lta" / "live" / "bus_arrival_*.csv")))
    if not files:
        return None
    d = pd.concat([pd.read_csv(f, usecols=["poll_ts", "stop", "service", "monitored", "lat", "lon", "type"],
                               dtype={"stop": str, "service": str}) for f in files], ignore_index=True)
    d = d[(d.monitored == 1) & d.stop.isin(study) & d.type.isin(list(DECK_PLACES))]
    d = d.drop_duplicates(["poll_ts", "service", "lat", "lon"])
    share = d.type.value_counts(normalize=True)
    return {k: round(float(share.get(k, 0.0)), 3) for k in DECK_PLACES}


def export_baseline(M, req: pd.DataFrame) -> None:
    from .supply import bus_supply, feeder_cycle_minutes, inside_minutes
    study = set(M.stops.index[M.stops.in_study])
    sup = bus_supply(study, feeder_cycle_minutes(M.baseline, None), inside_minutes(M.baseline, study))
    hours = list(range(5, 26))
    g = req.groupby("hour")
    cal = json.loads((PROCESSED / "calibration.json").read_text())
    mix = deck_mix(study)
    places = sum(DECK_PLACES[k] * v for k, v in mix.items()) / max(sum(mix.values()), 1e-9) if mix else None
    inside = sup.groupby("hour").buses_inside.sum().reindex(hours, fill_value=0)
    _write("baseline.json", {
        "hours": hours,
        "wait_min": [round(float(g.b_wait.mean().get(h, np.nan)) / 60, 2) for h in hours],
        "ivt_min": [round(float(g.b_ivt.mean().get(h, np.nan)) / 60, 2) for h in hours],
        "total_min": [round(float(g.b_total.mean().get(h, np.nan)) / 60, 2) for h in hours],
        "feeder_buses_on_road": [round(float(v)) for v in sup[sup.category == "FEEDER"].groupby("hour")
                                 .buses_on_road.sum().reindex(hours, fill_value=0)],
        "buses_inside_all": [round(float(v)) for v in inside],
        "bus_hours_inside_day": round(float(inside.sum())),
        "deck_mix": mix, "places_per_bus": round(places, 1) if places else None,
        "no_bus_share": [round(float(g.b_total.apply(lambda x: x.isna().mean()).get(h, np.nan)), 4) for h in hours],
        "no_bus_share_day": round(float(req.b_total.isna().mean()), 4),
        "bus_km_inside_by_hour": [round(float(v)) for v in sup.groupby("hour").km_inside.sum().reindex(hours, fill_value=0)],
        "bus_km_inside_day": round(float(sup.km_inside.sum())),
        "feeder_bus_km_inside_day": round(float(sup[sup.category == "FEEDER"].km_inside.sum())),
        "day_mean": {"wait_min": round(float(req.b_wait.mean()) / 60, 2), "ivt_min": round(float(req.b_ivt.mean()) / 60, 2),
                     "total_min": round(float(req.b_total.mean()) / 60, 2)},
        "calibration": {k: cal[k] for k in ("mult", "mult_ci", "sig_s", "sig_s_ci", "dwell_s", "dwell_s_ci",
                                             "hub_extra_s", "hub_extra_s_ci", "kappa", "kappa_iqr", "segment_r",
                                             "segment_mae_s", "n_obs_used", "n_segments_used", "hours_sgt",
                                             "n_services", "in_sample", "holdout_services", "holdout_hours",
                                             "kappa_all_predictions") if k in cal},
    })


def run() -> None:
    from .experiments import service_day_requests
    from .model import build_model
    M = build_model()
    export_town()
    export_buildings()
    export_stops_and_demand(M)
    export_baseline(M, service_day_requests(M, seed=1))


if __name__ == "__main__":
    run()
