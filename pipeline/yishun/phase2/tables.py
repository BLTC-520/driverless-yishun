"""Passenger-time tables of Phase 2, built by adding up per-run group sums (never by averaging
subgroup means): by time period, by area, by trip length, and who gains or loses."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .aggregate import KEY
from .runs import DIST_BANDS_M, PERIODS

PERIOD_LABELS = {"early": "05:00–06:59", "am_peak": "07:00–08:59", "offpeak": "09:00–16:59",
                 "pm_peak": "17:00–19:59", "evening": "20:00–01:59"}


def _cfg_mask(df: pd.DataFrame, cfg: dict) -> pd.Series:
    m = pd.Series(True, index=df.index)
    for k, v in cfg.items():
        if k == "theta_min" and (v is None or (isinstance(v, float) and np.isnan(v))):
            m &= df[k].isna()
        else:
            m &= df[k] == v
    return m


def breakdown(groups: pd.DataFrame, cfg: dict, by: list[str]) -> pd.DataFrame:
    """Sums per replicate, then the mean over replicates, for one configuration, by the given
    group columns (any of period, hub, band, sz). Passenger-hours of the option and of Option A
    over the same rides, hours saved, rides offered/declined/refused, and shares faster or slower
    than Option A for the same ride (simulated bus wait)."""
    g = groups[_cfg_mask(groups, cfg)]
    if g.empty:
        return pd.DataFrame()
    cols = ["n", "n_offered", "n_shuttle", "n_declined", "n_refused", "n_faster", "n_slower", "pax_h", "pax_h_A",
            "gain_h"]
    per_seed = g.groupby(["seed"] + by)[cols].sum()
    out = per_seed.groupby(level=by).mean()
    out["n_seeds"] = per_seed.groupby(level=by).size()
    out["saved_h"] = out.pax_h_A - out.pax_h
    out["saved_share"] = out.saved_h / out.pax_h_A
    out["mean_min"] = out.pax_h * 60 / out.n
    out["mean_min_A"] = out.pax_h_A * 60 / out.n
    out["faster_share"] = out.n_faster / out.n
    out["slower_share"] = out.n_slower / out.n
    out["offered_share"] = out.n_offered / out.n
    return out.reset_index()


def band_label(b: int) -> str:
    lo, hi = DIST_BANDS_M[b], DIST_BANDS_M[b + 1]
    return f"{lo / 1000:g}–{hi / 1000:g} km" if hi < 1e8 else f"over {lo / 1000:g} km"


def who_table(groups: pd.DataFrame, cfg: dict) -> dict:
    """Who gains and who loses under one configuration, by period, ride type, length and subzone."""
    out = {}
    for name, by in (("period", ["period"]), ("hub", ["hub"]), ("band", ["band"]), ("subzone", ["sz"])):
        t = breakdown(groups, cfg, by)
        if t.empty:
            continue
        if name == "period":
            t["label"] = t.period.map(PERIOD_LABELS)
            t = t.set_index("period").reindex(list(PERIODS)).reset_index()
        elif name == "band":
            t["label"] = t.band.map(band_label)
        elif name == "hub":
            t["label"] = t.hub.map({True: "to or from a station", False: "within the estates"})
        else:
            t = t[t.sz != ""].sort_values("n", ascending=False)
            t["label"] = t.sz
        out[name] = t
    return out
