"""One simulated weekday of one service option, as per-ride outcomes on a common boundary.

Every ride of a simulated day (same seed, same requests for every option) gets exactly one
mode:
  bus       carried by today's buses, at Option A's modelled time (A, and C rides not offered);
  shuttle   carried by the shuttle fleet, at its simulated time (B, and C rides offered);
  declined  C: offered, but the best quoted pickup was more than W_max away, so the rider takes
            the bus (default: at Option A's time);
  refused   B: no shuttle could pick the rider up within 45 min (Phase 1's refusal), counted at
            45 min + the direct ride, a lower bound.
Times are stop to stop: request at the boarding stop to alighting (wait + in-vehicle). Bus means
use the expected bus time; distributions (p90, faster/slower shares) use one simulated bus wait
per ride, as in Phase 1. Definitions: docs/phase2/definitions.md.
"""
from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field, replace

import numpy as np
import pandas as pd

from ..experiments import STATIONS, _occupancy, station_of, stop_groups
from ..sim import SimConfig, Simulator
from .assign import offered, offered_rates, ride_gap

PERIODS = {"early": (5, 6), "am_peak": (7, 8), "offpeak": (9, 16), "pm_peak": (17, 19), "evening": (20, 25)}
DIST_BANDS_M = [0, 500, 1000, 1500, 2000, 3000, 1e9]
REFUSED_WAIT_S = 2700.0           # Phase 1: a refused rider waited at least 45 min, then rode direct
DECLINED_EXTRA_S = 300.0          # treatment R3: a declined rider loses 5 min before taking the bus


def period_of(hour: np.ndarray) -> np.ndarray:
    out = np.full(len(hour), "", dtype=object)
    for name, (a, b) in PERIODS.items():
        out[(hour >= a) & (hour <= b)] = name
    return out


@dataclass
class OptionSpec:
    option: str                         # "A" current bus, "B" full replacement, "C" combined
    fleet: int = 0                      # vehicles planned in service (B, C)
    capacity: int = 10
    theta_min: float | None = None      # C: rule C-theta threshold (minutes)
    w_max_s: float = 900.0              # C: declined when the quoted pickup is later than this
    availability: float = 1.0           # stress: share of the planned fleet actually in service
    berths: int | None = None           # stress: shuttles boarding/alighting at once per station
    sim: dict = field(default_factory=dict)   # other SimConfig overrides

    def label(self) -> str:
        if self.option == "A":
            return "A"
        s = f"{self.option}:C{self.capacity}:N{self.fleet}"
        if self.option == "C":
            s += f":th{self.theta_min:g}"
        return s


def ride_frame(M, req: pd.DataFrame) -> pd.DataFrame:
    """Per-ride attributes shared by every option: comparison flag, period, area, distance and
    Option A's times (expected, and with the simulated bus wait)."""
    i = req.o.map(M.stop_index).to_numpy()
    j = req.d.map(M.stop_index).to_numpy()
    r = pd.DataFrame({
        "hour": req.hour.to_numpy(), "o": req.o.to_numpy(), "d": req.d.to_numpy(),
        "cmp": req.b_total.notna().to_numpy(), "hub": req.is_hub_trip.to_numpy(bool),
        "sz": req.o.map(M.stops.SUBZONE_N).fillna("").str.title().to_numpy(),
        "dist_m": M.R.Dm[i, j], "direct_s": M.R.T[i, j],
        "a_wait": req.b_wait.to_numpy(), "a_ivt": req.b_ivt.to_numpy(), "a_total": req.b_total.to_numpy(),
        "a_total_draw": req.b_total_draw.to_numpy(),
    }, index=req.index)
    r["period"] = period_of(r.hour.to_numpy())
    r["band"] = np.digitize(r.dist_m, DIST_BANDS_M[1:-1])
    return r


def run_option(M, req: pd.DataFrame, spec: OptionSpec, seed: int, plan_gap: np.ndarray | None = None,
               plan_M=None) -> dict:
    """Simulate one option on one day of requests. Returns per-ride outcomes and resources.

    plan_gap: timetable gaps from the planning model (default: from M itself). Rule C-theta is
    evaluated on it, so a stress test keeps the eligibility planned on the base case."""
    t0 = time.time()
    r = ride_frame(M, req)
    r["mode"] = "bus"
    r["wait"], r["ivt"] = r.a_wait, r.a_ivt
    r["s_wait"] = r["s_ivt"] = np.nan
    res, fleet_in_service, offer = None, 0, np.zeros(len(r), bool)
    if spec.option in ("B", "C"):
        if spec.option == "B":
            offer = np.ones(len(r), bool)
            rates = M.origin_rates
            w_max = SimConfig().max_wait_reject
        else:
            gap = ride_gap(M, req) if plan_gap is None else plan_gap
            offer = offered(gap, spec.theta_min)
            rates = offered_rates(plan_M or M, spec.theta_min)
            w_max = spec.w_max_s
        fleet_in_service = max(1, int(round(spec.fleet * spec.availability)))
        cfg = replace(SimConfig(**spec.sim), fleet=fleet_in_service, capacity=spec.capacity, seed=seed,
                      start_s=4.75 * 3600, max_wait_reject=w_max, berths=spec.berths)
        sub = req.loc[offer, ["t", "o", "d", "hour"]]
        sim = Simulator(M.R, M.study_idx, rates, M.hub_idx, cfg,
                        stop_group=stop_groups(M) if spec.berths is not None else None)
        res = sim.run(sub.reset_index(drop=True), M.stop_index)
        out = res.requests.set_index(sub.index)
        served = ~out.refused.to_numpy()
        idx_s, idx_x = sub.index[served], sub.index[~served]
        r.loc[idx_s, "mode"] = "shuttle"
        r.loc[idx_s, "s_wait"] = out.wait.to_numpy()[served]
        r.loc[idx_s, "s_ivt"] = out.ride.to_numpy()[served]
        r.loc[idx_s, "wait"] = r.loc[idx_s, "s_wait"]
        r.loc[idx_s, "ivt"] = r.loc[idx_s, "s_ivt"]
        if spec.option == "B":       # refused: 45 min + direct ride (lower bound), no bus fallback
            r.loc[idx_x, "mode"] = "refused"
            r.loc[idx_x, "wait"] = REFUSED_WAIT_S
            r.loc[idx_x, "ivt"] = r.loc[idx_x, "direct_s"]
        else:                        # declined: the rider takes the bus at Option A's time
            r.loc[idx_x, "mode"] = "declined"
    r["offered"] = offer
    r["total"] = r.wait + r.ivt
    # distribution basis: bus legs with the simulated wait; shuttle legs as simulated
    bus_leg = r["mode"].isin(["bus", "declined"]).to_numpy()
    r["total_draw"] = np.where(bus_leg, r.a_total_draw, r.total)
    resources = resources_of(M, res, spec, fleet_in_service, offer) if res is not None else {}
    resources["runtime_s"] = time.time() - t0
    return {"rides": r, "resources": resources, "spec": asdict(spec), "seed": seed}


def resources_of(M, res, spec: OptionSpec, fleet_in_service: int, offer: np.ndarray) -> dict:
    """Vehicle resources of one simulated day: fleet, vehicle-km, vehicle-hours, kerb use."""
    rq = res.requests
    t_end = float(np.nanmax(rq.t_drop)) if rq.t_drop.notna().any() else 4.75 * 3600
    service_h = (t_end - 4.75 * 3600) / 3600
    vkm = res.veh_km_loaded + res.veh_km_empty
    out = {"fleet_planned": spec.fleet, "fleet_in_service": fleet_in_service, "capacity": spec.capacity,
           "service_hours": service_h, "veh_hours_in_service": fleet_in_service * service_h,
           "veh_km": vkm, "veh_km_empty": res.veh_km_empty, "pax_km_onboard": res.pax_km,
           "occupancy": res.pax_km / max(vkm, 1e-9),
           "moving_h": float(res.moving_h_by_hour.sum()), "dwell_h": float(res.dwell_h_by_hour.sum()),
           "moving_h_by_hour": [float(x) for x in res.moving_h_by_hour],
           "dwell_h_by_hour": [float(x) for x in res.dwell_h_by_hour],
           "veh_km_by_hour": [float(x) for x in res.veh_km_by_hour],
           "n_requests": int(len(rq)), "n_refused_sim": int(rq.refused.sum()),
           "refused_cap": int((rq.refuse_reason == 2).sum())}
    # MRT/interchange kerb: shuttles stopped at once per station (sampled each minute)
    groups = pd.Series({i: station_of(M.stops.Description.iloc[i]) for i in M.hub_idx})
    dw = _occupancy(res.hub_visits, "t_arrive", "t_depart", groups, 5 * 3600, 26 * 3600)
    hr = (dw.index // 3600).astype(int)
    for st in STATIONS:
        if st in dw:
            out[f"kerb_max_{st}"] = int(dw[st].max())
            out[f"kerb_max_by_hour_{st}"] = [int(x) for x in dw[st].groupby(hr).max().reindex(range(5, 26), fill_value=0)]
    if res.hub_queue is not None and len(res.hub_queue):
        q = res.hub_queue
        out["kerb_queued"] = int(len(q))
        out["kerb_queue_wait_mean_s"] = float((q.t_berth - q.t_arrive).mean())
    return out


# ---------------------------------------------------------------------------- metrics
def _p90(x: pd.Series) -> float:
    return float(x.quantile(0.9)) if len(x) else float("nan")


def treatment_totals(r: pd.DataFrame, treatment: str = "R1") -> pd.Series:
    """Stop-to-stop time per ride (s) under a refused/declined-ride treatment:
    R1 (default) C declined -> bus time, B refused -> 45 min + direct; R2 every refused or
    declined ride -> 45 min + direct; R3 C declined -> bus time + 5 min."""
    tot = r.total.copy()
    dec = r["mode"] == "declined"
    if treatment == "R2":
        tot[dec] = REFUSED_WAIT_S + r.direct_s[dec]
    elif treatment == "R3":
        tot[dec] = r.a_total[dec] + DECLINED_EXTRA_S
    return tot


def summarise(r: pd.DataFrame) -> dict:
    """Day totals over the comparison set (rides with a bus option): passenger-hours of the
    option and of Option A for the same rides, waits, in-vehicle, refusals, distribution."""
    c = r[r.cmp]
    sh = c[c["mode"] == "shuttle"]
    out = {
        "n": int(len(c)), "n_all": int(len(r)), "n_no_bus": int((~r.cmp).sum()),
        "n_offered": int(c.offered.sum()), "n_shuttle": int(len(sh)),
        "n_declined": int((c["mode"] == "declined").sum()), "n_refused": int((c["mode"] == "refused").sum()),
        "n_bus": int((c["mode"] == "bus").sum()),
        "pax_h": float(c.total.sum() / 3600), "pax_h_A": float(c.a_total.sum() / 3600),
        "wait_h": float(c.wait.sum() / 3600), "ivt_h": float(c.ivt.sum() / 3600),
        "wait_h_A": float(c.a_wait.sum() / 3600), "ivt_h_A": float(c.a_ivt.sum() / 3600),
        "mean_min": float(c.total.mean() / 60), "mean_min_A": float(c.a_total.mean() / 60),
        "p90_min": _p90(c.total_draw) / 60, "p90_min_A": _p90(c.a_total_draw) / 60,
        "pax_km_direct": float(c.dist_m.sum() / 1000),
        "shuttle_pax_km_direct": float(sh.dist_m.sum() / 1000),
    }
    for t in ("R2", "R3"):
        out[f"pax_h_{t}"] = float(treatment_totals(c, t).sum() / 3600)
    out["saved_h"] = out["pax_h_A"] - out["pax_h"]
    for t in ("R2", "R3"):
        out[f"saved_h_{t}"] = out["pax_h_A"] - out[f"pax_h_{t}"]
    if len(sh):
        out["shuttle_faster_share"] = float((sh.total < sh.a_total_draw).mean())
        out["shuttle_mean_min"] = float(sh.total.mean() / 60)
        out["shuttle_mean_min_A"] = float(sh.a_total.mean() / 60)
        out["shuttle_wait_mean_min"] = float(sh.s_wait.mean() / 60)
        out["shuttle_ivt_mean_min"] = float(sh.s_ivt.mean() / 60)
        out["shuttle_p90_min"] = _p90(sh.total) / 60
        out["shuttle_p90_min_A"] = _p90(sh.a_total_draw) / 60
    return out


def by_hour(r: pd.DataFrame) -> pd.DataFrame:
    """Per request hour over the comparison set."""
    c = r[r.cmp]
    rows = []
    for h, g in c.groupby("hour"):
        sh = g[g["mode"] == "shuttle"]
        rows.append({"hour": int(h), "n": len(g), "n_offered": int(g.offered.sum()), "n_shuttle": len(sh),
                     "n_declined": int((g["mode"] == "declined").sum()), "n_refused": int((g["mode"] == "refused").sum()),
                     "pax_h": g.total.sum() / 3600, "pax_h_A": g.a_total.sum() / 3600,
                     "mean_min": g.total.mean() / 60, "mean_min_A": g.a_total.mean() / 60,
                     "p90_min": _p90(g.total_draw) / 60, "p90_min_A": _p90(g.a_total_draw) / 60,
                     "shuttle_mean_min": sh.total.mean() / 60 if len(sh) else np.nan,
                     "shuttle_mean_min_A": sh.a_total.mean() / 60 if len(sh) else np.nan,
                     "offered_mean_min": g[g.offered].total.mean() / 60 if g.offered.any() else np.nan,
                     "offered_mean_min_A": g[g.offered].a_total.mean() / 60 if g.offered.any() else np.nan})
    return pd.DataFrame(rows)


def by_group(r: pd.DataFrame) -> pd.DataFrame:
    """Sums by (period, hub ride, distance band, origin subzone) over the comparison set, so any
    breakdown can be rebuilt by adding rows (passenger-hours, never means of means). `faster`
    and `slower` compare each ride with its Option A time using the simulated bus wait."""
    c = r[r.cmp].assign(
        shuttle=lambda x: x["mode"] == "shuttle", declined=lambda x: x["mode"] == "declined",
        refused=lambda x: x["mode"] == "refused",
        faster=lambda x: x.total_draw < x.a_total_draw - 1e-9, slower=lambda x: x.total_draw > x.a_total_draw + 1e-9,
        pax_s=lambda x: x.total, pax_s_A=lambda x: x.a_total, gain_s=lambda x: x.a_total - x.total)
    g = c.groupby(["period", "hub", "band", "sz"], observed=True)
    out = g.agg(n=("cmp", "size"), n_offered=("offered", "sum"), n_shuttle=("shuttle", "sum"),
                n_declined=("declined", "sum"), n_refused=("refused", "sum"), n_faster=("faster", "sum"),
                n_slower=("slower", "sum"), pax_s=("pax_s", "sum"), pax_s_A=("pax_s_A", "sum"),
                gain_s=("gain_s", "sum")).reset_index()
    out["pax_h"] = out.pop("pax_s") / 3600
    out["pax_h_A"] = out.pop("pax_s_A") / 3600
    out["gain_h"] = out.pop("gain_s") / 3600
    return out
