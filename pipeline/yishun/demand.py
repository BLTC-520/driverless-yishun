"""Observed weekday bus demand inside Yishun, from LTA DataMall fare-card OD volumes.

Source: "Passenger Volume by Origin Destination Bus Stops" (PV/ODBus), which reports, for a
calendar month, the number of bus rides (tap-in at the origin stop, tap-out at the
destination stop) per day type and hour of tap-in. We keep WEEKDAY rides whose origin AND
destination stop both lie in the Yishun planning area, and convert monthly totals to an
average-weekday rate by dividing by the number of weekdays in the month(s).

Base months: July and August 2026, both full school-term months (43 weekdays). September
2026 contains the one-week September school holidays and Teachers' Day, and its internal
rides at 07:00 are 9 % lower; it is kept as a sensitivity case. Each record is one bus ride
(a journey stage): a trip with a transfer inside Yishun appears as two rides.
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
PUBLIC_HOLIDAY_WEEKDAYS = {"202607": [], "202608": ["2026-08-10"], "202609": []}  # 10 Aug: National Day (observed)
BASE_MONTHS = ("202607", "202608")


def weekdays_in_month(month: str) -> int:
    start = pd.Timestamp(f"{month[:4]}-{month[4:]}-01")
    days = pd.bdate_range(start, start + pd.offsets.MonthEnd(0))
    return len(days) - len(PUBLIC_HOLIDAY_WEEKDAYS.get(month, []))


def _month_od(month: str) -> pd.DataFrame:
    zpath = RAW / "lta" / "pv" / f"origin_destination_bus_{month}.zip"
    with zipfile.ZipFile(zpath) as z:
        name = next(n for n in z.namelist() if n.endswith(".csv"))
        od = pd.read_csv(z.open(name), dtype={"ORIGIN_PT_CODE": str, "DESTINATION_PT_CODE": str})
    codes = set(study_stops().BusStopCode)
    keep = (od.DAY_TYPE == "WEEKDAY") & od.ORIGIN_PT_CODE.isin(codes) & od.DESTINATION_PT_CODE.isin(codes)
    od = od.loc[keep, ["ORIGIN_PT_CODE", "DESTINATION_PT_CODE", "TIME_PER_HOUR", "TOTAL_TRIPS"]]
    od.columns = ["o", "d", "hour", "rides_month"]
    return od.loc[od.o != od.d]  # same-stop tap-in/tap-out is not a movement


def internal_od(months: str | tuple[str, ...] = BASE_MONTHS) -> pd.DataFrame:
    """Average-weekday rides by (origin stop, destination stop, hour), both ends in Yishun.

    The filtered table is small and is kept in data/processed so that experiments can be
    reproduced after DataMall stops serving these months (it serves the last three)."""
    from .paths import PROCESSED
    months = (months,) if isinstance(months, str) else tuple(months)
    tag = "_".join(months)
    keep = PROCESSED / f"internal_od_{tag}.csv.gz"
    if keep.exists():
        return pd.read_csv(keep, dtype={"o": str, "d": str})
    cache = INTERIM / f"internal_od_{tag}.parquet"
    if cache.exists():
        od = pd.read_parquet(cache)
    else:
        parts = [_month_od(m) for m in months]
        od = pd.concat(parts).groupby(["o", "d", "hour"], as_index=False).rides_month.sum()
        days = sum(weekdays_in_month(m) for m in months)
        od["rides_per_weekday"] = od.rides_month / days
        od = od.sort_values(["hour", "o", "d"]).reset_index(drop=True)
        od.to_parquet(cache)
    keep.parent.mkdir(parents=True, exist_ok=True)
    od.to_csv(keep, index=False)
    return od


def sample_requests(od: pd.DataFrame, hours: range | list[int], seed: int,
                    scale: float = 1.0) -> pd.DataFrame:
    """Draw one synthetic weekday of ride requests from the observed hourly OD rates.

    Counts per (o, d, hour) are Poisson with mean = scale * rides_per_weekday; request times
    are uniform within the hour (the data has hourly resolution only), or within the part of
    the hour given by optional columns win_a/win_b (seconds after the hour; used for the hours
    in which bus service starts or ends, since every recorded rider boarded a running bus).
    Times are seconds after midnight.
    """
    rng = np.random.default_rng(seed)
    sub = od.loc[od.hour.isin(list(hours))]
    counts = rng.poisson(sub.rides_per_weekday.to_numpy() * scale)
    idx = np.repeat(np.arange(len(sub)), counts)
    hrs = sub.hour.to_numpy()[idx]
    u = rng.uniform(0.0, 1.0, size=len(idx))
    if "win_a" in sub:
        a, b = sub.win_a.to_numpy()[idx], sub.win_b.to_numpy()[idx]
        t = hrs * 3600.0 + a + u * (b - a)
    else:
        t = hrs * 3600.0 + u * 3600.0
    req = pd.DataFrame({"t": t, "o": sub.o.to_numpy()[idx], "d": sub.d.to_numpy()[idx], "hour": hrs})
    req = req.sort_values("t", kind="stable").reset_index(drop=True)
    req.index.name = "rid"
    return req


if __name__ == "__main__":
    for m in ("202607", "202608", "202609"):
        print(m, f"{internal_od(m).rides_per_weekday.sum():.0f} rides per weekday")
    od = internal_od()
    print(f"{len(od)} OD-hour cells; {od.rides_per_weekday.sum():.0f} rides per average weekday")
