"""Collect Phase 2 runs into configurations: one row per option setting, over its replicates.

A configuration is everything that defines a run except the demand seed. Its values are the
mean over seeds, with the min and max to show the spread between simulated days. That spread
is random variation between days only, not a confidence interval for real-world performance.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .experiments import OUT

KEY = ["scenario", "option", "capacity", "theta_min", "hours", "fleet", "availability", "berths", "w_max_s", "sim"]
SPREAD = ["saved_h", "saved_h_R2", "saved_h_R3", "pax_h", "pax_h_A", "mean_min", "mean_min_A", "p90_min",
          "p90_min_A", "n_declined", "n_refused", "veh_km", "veh_km_empty"]


def load_runs(names: list[str]) -> pd.DataFrame:
    """Runs of the given grids. A run repeated in a later grid replaces the earlier one."""
    parts = []
    for k, n in enumerate(names):
        p = OUT / n / "runs.parquet"
        if p.exists():
            parts.append(pd.read_parquet(p).assign(grid=n, grid_order=k))
    if not parts:
        return pd.DataFrame()
    r = pd.concat(parts, ignore_index=True).sort_values("grid_order")
    if "hours" not in r:
        r["hours"] = ""
    r["hours"] = r.hours.fillna("")
    r = r.drop_duplicates("run_id", keep="last")
    r["theta_min"] = r.theta_min.astype(float)
    return r


def load_table(names: list[str], table: str) -> pd.DataFrame:
    parts = [pd.read_parquet(OUT / n / f"{table}.parquet").assign(grid=n, grid_order=k)
             for k, n in enumerate(names) if (OUT / n / f"{table}.parquet").exists()]
    if not parts:
        return pd.DataFrame()
    t = pd.concat(parts, ignore_index=True)
    if "hours" not in t:
        t["hours"] = ""
    t["hours"] = t.hours.fillna("")
    last = t.groupby("run_id").grid_order.transform("max")   # same replacement rule as load_runs
    return t[t.grid_order == last]


def configs(runs: pd.DataFrame) -> pd.DataFrame:
    """One row per configuration: means over seeds of every numeric column, plus min/max of the
    main outcomes and the number of seeds."""
    num = [c for c in runs.columns if c not in KEY and c not in ("seed", "grid_order") and
           pd.api.types.is_numeric_dtype(runs[c])]
    k = runs.fillna({"theta_min": -1.0})
    g = k.groupby(KEY, dropna=False)
    out = g[num].mean()
    for c in SPREAD:
        if c in runs:
            out[f"{c}_min"] = g[c].min()
            out[f"{c}_max"] = g[c].max()
    out["n_seeds"] = g.seed.nunique()
    out["seeds"] = g.seed.apply(lambda s: ",".join(str(x) for x in sorted(s)))
    out = out.reset_index()
    out["theta_min"] = out.theta_min.replace(-1.0, np.nan)
    return out


DECLINE_LIMIT = 0.01   # service-level rule: at most 1 % of offered rides declined in any hour


def service_level_fleet(hourly: pd.DataFrame, limit: float = DECLINE_LIMIT) -> pd.DataFrame:
    """Per (scenario, capacity, theta, availability, berths, w_max, sim): the smallest simulated
    fleet whose declined share of offered rides is at most `limit` in every hour of every
    replicate, with every larger simulated fleet also passing (as Phase 1's parity rule), and
    the largest failing fleet below it. Option C runs only."""
    h = hourly[hourly.option == "C"].copy()
    h["fail"] = (h.n_declined > limit * h.n_offered) & (h.n_offered > 0)
    key = [k for k in KEY if k not in ("option", "fleet")]
    rows = []
    for k, g in h.fillna({"theta_min": -1.0}).groupby(key, dropna=False):
        ok = (~g.groupby("fleet").fail.any()).sort_index()
        fleets = list(ok.index)
        par = next((f for i, f in enumerate(fleets) if ok.iloc[i:].all()), None)
        below = max([f for f in fleets if par is not None and f < par], default=None)
        rows.append({**dict(zip(key, k)), "fleet_sl": par, "fleet_below": below, "fleets": fleets,
                     "monotone": bool(ok.is_monotonic_increasing)})
    out = pd.DataFrame(rows)
    if len(out):
        out["theta_min"] = out.theta_min.replace(-1.0, np.nan)
    return out


def acceptable(hourly: pd.DataFrame, limit: float = DECLINE_LIMIT) -> pd.DataFrame:
    """Per configuration: whether its service is acceptable in every hour of every replicate. C: at
    most `limit` of offered rides declined; B: no rider refused (Phase 1's rule). Only acceptable
    configurations enter the cost-time frontier and the budget table."""
    h = hourly.fillna({"theta_min": -1.0}).copy()
    bad = np.where(h.option == "C", (h.n_declined > limit * h.n_offered) & (h.n_offered > 0), h.n_refused > 0)
    h["bad"] = bad
    out = (~h.groupby(KEY, dropna=False).bad.any()).rename("acceptable").reset_index()
    out["theta_min"] = out.theta_min.replace(-1.0, np.nan)
    return out
