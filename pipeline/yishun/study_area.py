"""Study area: the URA Master Plan 2019 Yishun planning area and the bus stops inside it."""
from __future__ import annotations

import json
from functools import lru_cache

import geopandas as gpd
import pandas as pd
from shapely.geometry.base import BaseGeometry

from .paths import CRS_METRIC, RAW

PLANNING_AREA = "YISHUN"


@lru_cache(maxsize=1)
def boundary() -> BaseGeometry:
    """Yishun planning-area polygon in SVY21 metres."""
    pa = gpd.read_file(RAW / "datagov" / "mp2019_planning_area.geojson").to_crs(CRS_METRIC)
    return pa.loc[pa.PLN_AREA_N == PLANNING_AREA, "geometry"].union_all()


def subzones() -> gpd.GeoDataFrame:
    sz = gpd.read_file(RAW / "datagov" / "mp2019_subzone.geojson").to_crs(CRS_METRIC)
    sz = sz.loc[sz.PLN_AREA_N == PLANNING_AREA, ["SUBZONE_N", "SUBZONE_C", "geometry"]]
    return sz.reset_index(drop=True)


@lru_cache(maxsize=1)
def all_bus_stops() -> gpd.GeoDataFrame:
    stops = pd.DataFrame(json.loads((RAW / "lta" / "bus_stops.json").read_text()))
    g = gpd.GeoDataFrame(stops, geometry=gpd.points_from_xy(stops.Longitude, stops.Latitude), crs=4326)
    return g.to_crs(CRS_METRIC).set_index("BusStopCode", drop=False)


def study_stops() -> gpd.GeoDataFrame:
    """Bus stops located inside the Yishun planning area, with a hub flag.

    A stop is a *hub* if it serves an MRT station or the bus interchange (LTA stop
    descriptions containing 'Stn', plus Yishun Int 59009).
    """
    s = all_bus_stops()
    s = s.loc[s.within(boundary())].reset_index(drop=True)
    desc = s.Description.str.lower()
    s["is_hub"] = desc.str.contains(r"\bstn\b") | (s.BusStopCode == "59009")
    sz = subzones()
    s = gpd.sjoin(s, sz[["SUBZONE_N", "geometry"]], how="left", predicate="within").drop(columns="index_right")
    return s.sort_values("BusStopCode").reset_index(drop=True)
