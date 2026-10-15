"""Assemble the shared model inputs once: routing tables, study stops, demand rates, baseline."""
from __future__ import annotations

import pickle
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .busnet import BaselineParams, BusBaseline, load_lines
from .demand import internal_od
from .network import DEFAULT_KMH, stop_network
from .paths import INTERIM
from .routing import Routing, build_routing


@dataclass
class Model:
    R: Routing
    stops: pd.DataFrame          # network stops (index = code) with in_study / is_hub / SUBZONE_N
    stop_index: dict
    study_idx: np.ndarray
    hub_idx: np.ndarray
    od: pd.DataFrame             # observed average-weekday OD rates
    origin_rates: np.ndarray     # (24, S) requests per second by hour and origin stop
    baseline: BusBaseline
    kmh: dict
    key: str = ""                # cache key of the inputs (calibration, bus parameters, demand months)
    months: tuple = ()


def default_cal() -> dict | None:
    """Calibrated network parameters if a calibration has been run, else None (free-flow)."""
    from .calibrate import as_network_cal, load
    try:
        return as_network_cal(load())
    except FileNotFoundError:
        return None


def build_model(kmh: dict | None = None, baseline_params: BaselineParams | None = None,
                cal: dict | None = None, cache: bool = True, months: tuple[str, ...] | None = None) -> Model:
    """Model inputs. `cal` = network calibration (defaults to data/processed/calibration.json);
    baseline bus dwell defaults to the calibrated bus dwell; `months` = fare-card months
    averaged for demand (default: demand.BASE_MONTHS)."""
    import hashlib
    import json as _json

    from .demand import BASE_MONTHS

    kmh = kmh or DEFAULT_KMH
    if cal is None:
        cal = default_cal()
    if baseline_params is None:
        baseline_params = default_baseline_params()
    months = tuple(months or BASE_MONTHS)
    sig = _json.dumps([sorted(kmh.items()), cal, baseline_params.__dict__, months], sort_keys=True, default=str)
    digest = hashlib.sha1(sig.encode()).hexdigest()[:12]
    key = INTERIM / f"model_{digest}.pkl"
    if cache and key.exists():
        return pickle.loads(key.read_bytes())
    net = stop_network(kmh, cal)
    R = build_routing(net)
    st = net.stops
    stop_index = {c: i for i, c in enumerate(R.codes)}
    study_idx = np.array([stop_index[c] for c in st.index[st.in_study]])
    hub_idx = np.array([stop_index[c] for c in st.index[st.is_hub]])
    baseline = BusBaseline(R.codes, R.T, load_lines(set(R.codes)), baseline_params,
                           hub_codes=set(st.index[st.is_hub]))
    od = internal_od(months)
    # request times are drawn only within the part of each hour when a bus serving the pair runs
    win = [baseline.service_window(o, d, int(h)) for o, d, h in zip(od.o, od.d, od.hour)]
    od["win_a"] = [w[0] if w else 0.0 for w in win]
    od["win_b"] = [w[1] if w else 3600.0 for w in win]
    rates = np.zeros((24, len(R.codes)))
    g = od.groupby(["hour", "o"]).rides_per_weekday.sum()
    for (h, o), v in g.items():
        rates[h, stop_index[o]] = v / 3600.0
    m = Model(R, st, stop_index, study_idx, hub_idx, od, rates, baseline, kmh, key=digest, months=months)
    if cache:
        key.write_bytes(pickle.dumps(m))
    return m


def default_baseline_params() -> BaselineParams:
    from .calibrate import load
    try:
        c = load()
        return BaselineParams(dwell_s=c["dwell_s"], hub_extra_s=c["hub_extra_s"],
                              kappa=c.get("kappa", BaselineParams.kappa))
    except FileNotFoundError:
        return BaselineParams()
