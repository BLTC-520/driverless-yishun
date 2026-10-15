"""Observed weekday bus demand inside Yishun, from LTA DataMall fare-card OD volumes.

Source: "Passenger Volume by Origin Destination Bus Stops" (PV/ODBus), which reports, for a
calendar month, the number of bus rides (tap-in at the origin stop, tap-out at the
destination stop) per day type and hour of tap-in. We keep WEEKDAY rides whose origin AND
destination stop both lie in the Yishun planning area, and convert monthly totals to an
average-weekday rate by dividing by the number of weekdays in the month.
"""
from __future__ import annotations

import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

from .paths import INTERIM, RAW
from .study_area import study_stops

# Singapore gazetted public holidays falling on weekdays, by month (YYYYMM). LTA's WEEKDAY
# day type excludes them, so they must not count toward the divisor.
PUBLIC_HOLIDAY_WEEKDAYS = {"202609": []}


def weekdays_in_month(month: str) -> int:
    start = pd.Timestamp(f"{month[:4]}-{month[4:]}-01")
    days = pd.bdate_range(start, start + pd.offsets.MonthEnd(0))
    return len(days) - len(PUBLIC_HOLIDAY_WEEKDAYS.get(month, []))


def internal_od(month: str = "202609") -> pd.DataFrame:
    """Average-weekday rides by (origin stop, destination stop, hour), both ends in Yishun."""
    cache = INTERIM / f"internal_od_{month}.parquet"
    if cache.exists():
        return pd.read_parquet(cache)
    zpath = RAW / "lta" / "pv" / f"origin_destination_bus_{month}.zip"
    with zipfile.ZipFile(zpath) as z:
        name = next(n for n in z.namelist() if n.endswith(".csv"))
        od = pd.read_csv(z.open(name), dtype={"ORIGIN_PT_CODE": str, "DESTINATION_PT_CODE": str})
    codes = set(study_stops().BusStopCode)
    keep = (od.DAY_TYPE == "WEEKDAY") & od.ORIGIN_PT_CODE.isin(codes) & od.DESTINATION_PT_CODE.isin(codes)
    od = od.loc[keep, ["ORIGIN_PT_CODE", "DESTINATION_PT_CODE", "TIME_PER_HOUR", "TOTAL_TRIPS"]]
    od.columns = ["o", "d", "hour", "rides_month"]
    od = od.loc[od.o != od.d].copy()  # same-stop tap-in/tap-out is not a movement
    od["rides_per_weekday"] = od.rides_month / weekdays_in_month(month)
    od = od.sort_values(["hour", "o", "d"]).reset_index(drop=True)
    od.to_parquet(cache)
    return od


def sample_requests(od: pd.DataFrame, hours: range | list[int], seed: int,
                    scale: float = 1.0) -> pd.DataFrame:
    """Draw one synthetic weekday of ride requests from the observed hourly OD rates.

    Counts per (o, d, hour) are Poisson with mean = scale * rides_per_weekday; request times
    are uniform within the hour (the data has hourly resolution only). Times are seconds
    after midnight.
    """
    rng = np.random.default_rng(seed)
    sub = od.loc[od.hour.isin(list(hours))]
    counts = rng.poisson(sub.rides_per_weekday.to_numpy() * scale)
    idx = np.repeat(np.arange(len(sub)), counts)
    hrs = sub.hour.to_numpy()[idx]
    t = hrs * 3600.0 + rng.uniform(0.0, 3600.0, size=len(idx))
    req = pd.DataFrame({"t": t, "o": sub.o.to_numpy()[idx], "d": sub.d.to_numpy()[idx], "hour": hrs})
    req = req.sort_values("t", kind="stable").reset_index(drop=True)
    req.index.name = "rid"
    return req


if __name__ == "__main__":
    od = internal_od()
    print(f"{len(od)} OD-hour cells; {od.rides_per_weekday.sum():.0f} rides per average weekday")
