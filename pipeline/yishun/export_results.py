"""Turn experiment outputs into results.json + calibration_points.json for the web page.

Definitions (also stated on the page):
  * riders compared: rides for which the bus model has an option (the excluded share, mostly
    pairs with no direct service in LTA's route data, is reported); refusals count all riders;
  * curves: for each vehicle size and fleet size, mean stop-to-stop time (wait + ride) over the
    whole day and per hour, mean and min/max across demand replicates (fixed fleet all day).
    `lb` counts each refused rider at 45 min + direct ride, a lower bound on what they face;
  * all-day parity fleet: smallest simulated fixed fleet that keeps up in every hour on every
    replicate, with every larger simulated fleet also keeping up (rule "mean"); rule "p90"
    asks the same of the 90th-percentile time, using one simulated bus wait per ride;
  * hourly requirement: smallest fleet that keeps up with one hour's demand in steady state
    (hour-window simulations with warm-up; the larger of the replicates). It assumes the fleet
    in service can change every hour and no backlog carries over from earlier hours, so it is a
    lower bound, below the all-day fixed fleet;
  * keeps up = no refused riders and mean stop-to-stop time no worse than the bus model.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .paths import PROCESSED, WEB_DATA

HOURS = list(range(5, 26))
EXP = PROCESSED / "experiments"
# sensitivity cases computed but not shown as plausible alternatives, with the reason
SENS_EXCLUDED = {
    "gps_calibration": ("a robust fit to bus GPS movement",
                        "it tracks typical rather than average speeds: on 5-minute GPS pairs it underpredicts mean bus "
                        "times by about a quarter, so it is too optimistic to simulate with"),
}


def _load_fixed() -> tuple[pd.DataFrame, pd.DataFrame]:
    hs, rs = [], []
    for name in ("frontier", "ext"):
        if (EXP / name / "hourly.parquet").exists():
            hs.append(pd.read_parquet(EXP / name / "hourly.parquet"))
            rs.append(pd.read_parquet(EXP / name / "runs.parquet"))
    return pd.concat(hs, ignore_index=True), pd.concat(rs, ignore_index=True)


def _num(v, nd=2):
    return None if v is None or pd.isna(v) else round(float(v), nd)


def curves(h: pd.DataFrame, runs: pd.DataFrame) -> dict:
    out = {}
    for cap, g in runs.groupby("capacity"):
        lst = []
        for n, gr in g.groupby("fleet"):
            hh = h[(h.capacity == cap) & (h.fleet == n)]
            by = hh.groupby("hour").total_mean.agg(["mean", "min", "max"]).reindex(HOURS)
            lb = hh.groupby("hour").total_mean_lb.mean().reindex(HOURS)
            ref = hh.groupby("hour").refused_share.max().reindex(HOURS)
            p90 = hh.groupby("hour").total_p90.mean().reindex(HOURS)
            lst.append({
                "fleet": int(n),
                "all": {"m": float(gr.total_mean.mean() / 60), "lo": float(gr.total_mean.min() / 60),
                        "hi": float(gr.total_mean.max() / 60), "lb": float(gr.total_mean_lb.mean() / 60)},
                "byHour": {k: [_num(v / 60) for v in by[c]] for k, c in (("m", "mean"), ("lo", "min"), ("hi", "max"))},
                "lbByHour": [_num(v / 60) for v in lb], "p90ByHour": [_num(v / 60) for v in p90],
                "refusedByHour": [_num(v, 4) for v in ref],
                "refused": float(gr.refused_share.mean()), "refused_cap": float(gr.refused_cap_share.mean()),
                "veh_km": float(gr.veh_km.mean()),
                "occupancy": float(gr.occupancy.mean()), "empty_share": float(gr.empty_share.mean()),
            })
        out[str(int(cap))] = sorted(lst, key=lambda d: d["fleet"])
    return out


def parity_table(h: pd.DataFrame, rule: str = "mean") -> dict:
    """Per capacity: the parity fleet, the largest simulated fleet below it that fails, and the
    first failing hour of that fleet. A fleet passes when every (replicate, hour) passes."""
    sh, bus = ("total_mean", "bus_total_mean") if rule == "mean" else ("total_p90", "bus_total_p90")
    x = h.assign(ok=((h[sh] <= h[bus]) | h[bus].isna()) & (h.refused_share <= 0.0))
    out = {}
    for cap, g in x.groupby("capacity"):
        ok = g.groupby("fleet").ok.all().sort_index()
        fleets = list(ok.index)
        # smallest fleet from which every larger simulated fleet also passes
        par = next((f for i, f in enumerate(fleets) if ok.iloc[i:].all()), None)
        below = max([f for f in fleets if par is not None and f < par], default=None)
        fail_h = None
        if below is not None:
            gb = g[(g.fleet == below) & ~g.ok]
            fail_h = int(gb.hour.min()) if len(gb) else None
        out[str(int(cap))] = {"fleet": None if par is None else int(par), "below": None if below is None else int(below),
                              "below_first_failing_hour": fail_h, "monotone": bool(ok.is_monotonic_increasing)}
    return out


def all_day_parity(h: pd.DataFrame, rule: str = "mean") -> dict:
    return {k: v["fleet"] for k, v in parity_table(h, rule).items()}


def hourly_requirement() -> tuple[dict | None, dict]:
    """Hour-window requirement per capacity, plus an audit of the bisection's monotonicity
    assumption over every fleet that was evaluated."""
    p = EXP / "hourly" / "hourly_frontier.parquet"
    if not p.exists():
        return None, {}
    df = pd.read_parquet(p)
    out = {}
    for cap, g in df.groupby("capacity"):
        need = []
        for hr in HOURS:
            v = g[g.hour == hr].fleet_needed
            # a replicate with no feasible fleet on the grid makes the hour infeasible on the grid
            need.append(None if v.empty or v.isna().any() else int(v.max()))
        out[str(int(cap))] = need
    audit = {"checked": 0, "violations": 0}
    ev = EXP / "hourly" / "evaluated.json"
    if ev.exists():
        rows = json.loads(ev.read_text())
        rows = rows["rows"] if isinstance(rows, dict) else rows
        for r in rows:
            e = sorted((int(k), v[0]) for k, v in r["evaluated"].items())
            audit["checked"] += 1
            audit["violations"] += int(any(a and not b for (_, a), (_, b) in zip(e[:-1], e[1:])))
    return out, audit


def who_gains(M, cap: int, fleet: int, seeds=(1, 2, 3)) -> dict:
    """Ride-by-ride comparison pooled over the demand replicates used in the experiments.

    Each shuttle ride (simulated) is compared with one simulated bus wait plus the bus's
    expected in-vehicle time for the same ride (`faster`), and with the bus's expected time
    (`faster_exp`)."""
    from scipy.stats import spearmanr

    from .experiments import service_day_requests
    from .sim import SimConfig, Simulator
    parts = []
    for seed in seeds:
        req = service_day_requests(M, seed)
        cfg = SimConfig(fleet=fleet, capacity=cap, seed=seed, start_s=4.75 * 3600)
        res = Simulator(M.R, M.study_idx, M.origin_rates, M.hub_idx, cfg).run(req[["t", "o", "d", "hour"]],
                                                                              M.stop_index)
        parts.append(res.requests.join(req[["b_total", "b_wait", "b_ivt", "b_wait_draw", "b_total_draw",
                                            "is_hub_trip"]]).assign(seed=seed))
    r = pd.concat(parts, ignore_index=True)
    refused_share = float(r.refused.mean())
    r = r[~r.refused & r.b_total.notna()].copy()
    geo = M.stops.geometry
    r["dist"] = [geo[a].distance(geo[b]) for a, b in zip(r.o, r.d)]
    bands = [0, 500, 1000, 1500, 2000, 3000]
    nb = len(bands) - 1
    r["band"] = pd.cut(r.dist, bands, right=False, labels=False)
    r["faster"] = r.total < r.b_total_draw
    r["faster_exp"] = r.total < r.b_total
    hub = r[r.is_hub_trip].groupby("band").faster.mean().reindex(range(nb))
    est = r[~r.is_hub_trip].groupby("band").faster.mean().reindex(range(nb))
    n_hub = r[r.is_hub_trip].groupby("band").size().reindex(range(nb), fill_value=0)
    n_est = r[~r.is_hub_trip].groupby("band").size().reindex(range(nb), fill_value=0)
    late, peak = r[r.hour >= 20], r[r.hour.isin([7, 8])]
    share, share_exp = float(r.faster.mean()), float(r.faster_exp.mean())
    gain = float((r.b_total - r.total).mean() / 60)
    all_band = r.groupby("band").faster.mean().reindex(range(nb))
    short, longb = float(all_band.iloc[0]), float(all_band.iloc[-2:].mean())
    sp90, bp90 = float(r.total.quantile(0.9) / 60), float(r.b_total_draw.quantile(0.9) / 60)
    pk_sp90, pk_bp90 = float(peak.total.quantile(0.9) / 60), float(peak.b_total_draw.quantile(0.9) / 60)
    pk7 = r[r.hour == 7]
    waits = {"shuttle_mean_min": float(r.wait.mean() / 60), "bus_mean_min": float(r.b_wait.mean() / 60),
             "shuttle_mean_79_min": float(peak.wait.mean() / 60), "bus_mean_79_min": float(peak.b_wait.mean() / 60),
             "shuttle_p90_7_min": float(pk7.wait.quantile(0.9) / 60), "bus_p90_7_min": float(pk7.b_wait_draw.quantile(0.9) / 60),
             "shuttle_ride_min": float(r.ride.mean() / 60), "bus_ride_min": float(r.b_ivt.mean() / 60)}
    lose = r[~r.faster]
    wait_worse = float((lose.wait > lose.b_wait_draw).mean()) if len(lose) else 0.0
    ride_worse = float((lose.ride > lose.b_ivt).mean()) if len(lose) else 0.0
    short_share_lose = float((lose.dist < 500).mean()) if len(lose) else 0.0
    if longb > short:
        headline = "Longer rides inside the town gain most; the shortest hops gain least"
        dist_txt = (f"Longer rides gain more: {short:.0%} of all rides under 0.5 km are faster, against {longb:.0%} of all "
                    f"rides over 1.5 km, where bus routes loop and stop more often than a direct shuttle.")
    else:
        headline = "The shortest hops gain most"
        dist_txt = (f"Short rides gain more: {short:.0%} of all rides under 0.5 km are faster, against {longb:.0%} of all "
                    f"rides over 1.5 km.")
    tail_txt = (f"The slowest tenth of shuttle rides take more than {sp90:.1f} min, against {bp90:.1f} min by bus "
                f"({pk_sp90:.1f} against {pk_bp90:.1f} min in the 07:00–09:00 peak).")
    text = (f"With {fleet} ten-seat shuttles, pooled over {len(seeds)} simulated weekdays, {share:.0%} of rides "
            f"reach their stop sooner than by bus, comparing each ride with one simulated bus wait "
            f"({share_exp:.0%} beat the bus's average time for that trip). The average saving is {gain:.1f} minutes. "
            f"{dist_txt} After 20:00, when buses run less often, {late.faster.mean():.0%} are faster; in the "
            f"07:00–09:00 peak, {peak.faster.mean():.0%}. {tail_txt} Of the rides that are slower by shuttle, "
            f"{short_share_lose:.0%} are under 0.5 km; in {wait_worse:.0%} the shuttle wait is longer than the "
            f"bus wait, and in {ride_worse:.0%} the shuttle ride is longer than the bus ride.")
    # gains by origin subzone, with the subzone's census share of residents aged 65+ for context
    # (the fare-card data has no rider ages, so this is an area-level view only)
    from .paths import RAW
    census = pd.read_csv(RAW / "datagov" / "census2020_subzone_age_sex.csv")
    census["key"] = census.Number.str.strip().str.upper()
    old = ["Total_65_69", "Total_70_74", "Total_75_79", "Total_80_84", "Total_85_89", "Total_90andOver"]
    for c in ["Total_Total"] + old:
        census[c] = pd.to_numeric(census[c].astype(str).str.replace("-", "0"), errors="coerce").fillna(0)
    census = census.set_index("key")
    r["sz"] = r.o.map(M.stops.SUBZONE_N)
    by_sz = []
    for sz, g in r.groupby("sz"):
        if not isinstance(sz, str) or sz.upper() not in census.index or len(g) < 200 * len(seeds):
            continue
        row = census.loc[sz.upper()]
        by_sz.append({"subzone": sz.title(), "rides_per_day": round(len(g) / len(seeds)),
                      "share65": float(row[old].sum() / max(row.Total_Total, 1)),
                      "share_faster": float(g.faster.mean()), "mean_gain_min": float((g.b_total - g.total).mean() / 60),
                      "bus_min": float(g.b_total.mean() / 60), "shuttle_min": float(g.total.mean() / 60)})
    rho = rho_p = None
    if len(by_sz) >= 6:
        sr = spearmanr([d["share65"] for d in by_sz], [d["mean_gain_min"] for d in by_sz])
        rho, rho_p = float(sr.statistic), float(sr.pvalue)
    return {"bands_m": bands, "hub": [_num(v, 3) for v in hub], "estate": [_num(v, 3) for v in est],
            "n_hub": [int(v) for v in n_hub], "n_estate": [int(v) for v in n_est],
            "share_faster": share, "share_faster_exp": share_exp, "mean_gain_min": gain,
            "p90_min": {"shuttle": sp90, "bus": bp90, "shuttle_peak": pk_sp90, "bus_peak": pk_bp90}, "waits": waits,
            "text": text, "headline": headline, "refused_share": refused_share, "replicates": len(seeds),
            "losers": {"share": float(1 - share), "under_500m": short_share_lose, "wait_worse": wait_worse,
                       "ride_worse": ride_worse},
            "by_subzone": sorted(by_sz, key=lambda d: -d["rides_per_day"]), "subzone_rho_65": rho, "subzone_rho_p": rho_p}


def shuttle_km_inside_share(M, fleet: int, cap: int = 10) -> float:
    """Share of shuttle-km driven inside the planning-area boundary (morning-peak sample),
    to check the comparison with bus-km, which counts only in-area route segments."""
    from shapely.geometry import LineString

    from .experiments import service_day_requests
    from .paths import CRS_METRIC
    from .sim import SimConfig, Simulator
    from .study_area import boundary
    b = boundary()
    B = b.to_crs(CRS_METRIC).geometry.union_all() if hasattr(b, "to_crs") else b
    req = service_day_requests(M, 1)
    win = req[(req.t >= 6.25 * 3600) & (req.t < 9.0 * 3600)].reset_index(drop=True)
    cfg = SimConfig(fleet=fleet, capacity=cap, seed=1, start_s=6.25 * 3600, record_legs=True)
    res = Simulator(M.R, M.study_idx, M.origin_rates, M.hub_idx, cfg).run(win[["t", "o", "d", "hour"]], M.stop_index)
    R = M.R
    xy = lambda p: R.node_xy[p[1]] if p[0] == "node" else R.stop_xy[p[1]]
    tot = ins = 0.0
    cache = {}
    for lg in res.legs:
        k = len(lg.t) - 1 if lg.cut_t is None else int(np.searchsorted(lg.t, lg.cut_t))
        for a in range(min(k, len(lg.pts) - 1)):
            key = (lg.pts[a], lg.pts[a + 1])
            if key not in cache:
                seg = LineString([xy(lg.pts[a]), xy(lg.pts[a + 1])])
                cache[key] = seg.intersection(B).length / seg.length if seg.length > 0 else 1.0
            dd = lg.dist[a + 1] - lg.dist[a]
            tot += dd
            ins += dd * cache[key]
    return ins / tot if tot else float("nan")


def shuttle_driving_hours(M, fleet: int, cap: int = 10, seed: int = 1) -> dict:
    """Hours the fixed fleet spends driving (with riders or empty), from one recorded day."""
    from .experiments import service_day_requests
    from .sim import SimConfig, Simulator
    req = service_day_requests(M, seed)
    cfg = SimConfig(fleet=fleet, capacity=cap, seed=seed, start_s=4.75 * 3600, record_legs=True)
    res = Simulator(M.R, M.study_idx, M.origin_rates, M.hub_idx, cfg).run(req[["t", "o", "d", "hour"]], M.stop_index)
    moving = sum(((lg.cut_t if lg.cut_t is not None else lg.t[-1]) - lg.t[0]) for lg in res.legs)
    loaded = sum(((lg.cut_t if lg.cut_t is not None else lg.t[-1]) - lg.t[0]) for lg in res.legs if lg.onboard > 0)
    return {"driving_h": moving / 3600, "loaded_h": loaded / 3600}


def calibration_points(M) -> dict:
    """Observed vs modelled bus running time per stop sequence, with the fitted parameters."""
    import glob

    from .calibrate import load, segment_observations, segment_table
    from .model import build_model
    cal = load()
    M0 = build_model(cal={"mult_arterial": 1.0, "mult_local": 1.0, "sig_s": 0.0})
    files = sorted(glob.glob(str(PROCESSED.parent / "raw" / "lta" / "live" / "bus_arrival_*.csv")))
    files = [f for f in files if any(f.endswith(s.split("/")[-1]) for s in cal["source_files"])]
    if not files:  # live logs are not in the repository; keep the committed points
        p = WEB_DATA / "calibration_points.json"
        return json.loads(p.read_text()) if p.exists() else {"points": [], "params": {}}
    obs = pd.concat([segment_observations(f) for f in files], ignore_index=True)
    obs = obs[obs.hour.isin(cal["hours_sgt"])]
    seg = segment_table(obs, M0.R, M0.stop_index, set(M0.stops.index[M0.stops.is_hub]))
    s = seg[seg.used]
    pred = cal["mult"] * s.t_ff + cal["sig_s"] * s.n_sig + cal["dwell_s"] * s.gap + cal["hub_extra_s"] * s.n_hub
    pts = [[round(float(a), 1), round(float(b), 1), int(c)] for a, b, c in zip(s["median"], pred, s["count"])]
    return {"points": pts, "params": {k: cal[k] for k in ("mult", "sig_s", "dwell_s", "hub_extra_s")}}


def _pct(x, nd=0):
    return None if x is None else f"{100 * x:.{nd}f}%"


def numbers(out: dict, base: dict, demand: dict, cal: dict, gps: dict | None, pm: dict | None) -> dict:
    """Every number quoted in the page text, formatted once (used by app.js and web/build.py)."""
    from .demand import internal_od
    from .sim import SimConfig
    R, ps, ref = out, out["peak_supply"], out["reference"]
    H = out["hours"]
    f = lambda v: None if v is None else f"{v:,.0f}"
    i7 = H.index(7)
    par = R["all_day_parity"].get("10")
    det = R["parity_detail"].get("10", {})
    fh = det.get("below_first_failing_hour")
    sep7 = internal_od("202609").query("hour == 7").rides_per_weekday.sum()
    term7 = demand["rides_by_hour"][demand["hours"].index(7)]
    area_mi2 = 21.011 / 2.58999
    w = (gps or {}).get("by_window", {})
    mid = w.get("10-12") or (gps or {}).get("all")
    pmw = w.get("17-19")
    hc = cal.get("holdout_services", {})
    n = {
        "rides": f(demand["rides_per_weekday"]), "pairs": f(demand["od_pairs"]),
        "median": f"{demand['straight_line_pct_m']['50'] / 1000:.2f} km", "hubshare": _pct(demand["hub_share"]),
        "sep7": _pct(1 - sep7 / term7) if term7 else None,
        "parity": f(par), "parity_lo": f(det.get("below")), "parity90": f(R["parity_p90"].get("10", {}).get("fleet")) or "more than the largest fleet simulated",
        "failhour": None if fh is None else f"{fh % 24:02d}:00",
        "cliffgap": f(R["cliff_gap"]), "nobus": _pct(base.get("no_bus_share_day"), 1), "occ": f"{ref['occupancy']:.1f}",
        "busesin": f(ps.get("buses_inside_all")), "feeders": f(ps.get("feeders_on_road")),
        "vehx": f"{par / ps['buses_inside_all']:.1f} times" if par and ps.get("buses_inside_all") else None,
        "vehxf": f"{par / ps['feeders_on_road']:.1f} times" if par and ps.get("feeders_on_road") else None,
        "busplaces": f(round(ps["bus_places"], -2)) if ps.get("bus_places") else None,
        "shplaces": f(ps.get("shuttle_places")),
        "vkm": f(ref["veh_km"]), "buskm": f(base["bus_km_inside_day"]), "feederkm": f(base["feeder_bus_km_inside_day"]),
        "vkmx": f"{ref['veh_km'] / base['bus_km_inside_day']:.1f} times",
        "buspaxkm": f"{R['bus_pax_per_km_lower']:.0f}", "empty": _pct(ref["empty_share"]),
        "density": f"{round(term7 / area_mi2, -2):,.0f} riders per square mile per hour",
        "midday": f((R["frontier"].get("10") or [None] * len(H))[H.index(12)]),
        "vhlb": f((R.get("vehicle_hours") or {}).get("10")), "vh": f(R["fixed_fleet_vehicle_hours"]),
        "bush": f(base.get("bus_hours_inside_day")), "busdrive": f(base.get("bus_driving_hours_inside_day")),
        "shdrive": f((R.get("shuttle_hours") or {}).get("driving_h")),
        "shkmin": _pct(R.get("shuttle_km_inside_share"), 1),
        "kerbmax": f(max([v for v in ref["kerb"].get("Yishun", []) if v is not None], default=None)),
        "kerbkhatib": f(max([v for v in ref["kerb"].get("Khatib", []) if v is not None], default=None)),
        "calobs": f(cal["n_obs_used"]),
        "calhours": f"{cal['hours_sgt'][0]:02d}:00–{cal['hours_sgt'][-1] + 1:02d}:00",
        "sig": f"{cal['sig_s']:.0f}", "dwell": f"{cal['dwell_s']:.0f}", "hubx": f"{cal['hub_extra_s']:.0f}",
        "kappa": f"{cal['kappa']:.2f}", "d0": f"{SimConfig().d0:.0f}",
        "gpsn": f((gps or {}).get("all", {}).get("n_pairs")),
        "gpsratio": f"{mid['pooled_ratio']:.2f}" if mid else None,
        "pm_gps": f"{pmw['pooled_ratio']:.2f}" if pmw else None,
        "pm_gps_ci": f"{pmw['pooled_ratio_ci'][0]:.2f}–{pmw['pooled_ratio_ci'][1]:.2f}" if pmw else None,
        "pm_eta": (f"{cal['holdout_hours']['17-19']['obs_over_pred']:.2f}"
                   if cal.get("holdout_hours", {}).get("17-19") else None),
        "ho_mape": _pct(hc.get("model", {}).get("mape")), "ho_dist_mape": _pct(hc.get("distance_only", {}).get("mape")),
        "in_mape": _pct(cal.get("in_sample", {}).get("mape")),
        "share_faster": _pct(R["who"]["share_faster"]), "gain": f"{R['who']['mean_gain_min']:.1f} min",
    }
    wt = R["who"].get("waits", {})
    for k, key in (("shwait", "shuttle_mean_min"), ("buswait", "bus_mean_min"), ("shwait79", "shuttle_mean_79_min"),
                   ("buswait79", "bus_mean_79_min"), ("shwait90", "shuttle_p90_7_min"),
                   ("buswait90", "bus_p90_7_min"), ("shride", "shuttle_ride_min"), ("busride", "bus_ride_min")):
        if key in wt:
            n[k] = f"{wt[key]:.1f} min"
    if pm:
        n["pm_mult"] = f"{pm['mult']:.2f}"
    # threshold detail: 08:00 means and refusals around the parity fleet
    h8, h7, rf = R.get("h8", {}), R.get("h7", {}), R.get("refused10", {})
    lo = det.get("below")
    for key, fl in (("p", par), ("lo", lo), ("lo2", (lo - 25) if lo else None), ("lo3", (lo - 50) if lo else None)):
        if fl is None or str(fl) not in h8:
            continue
        n[f"f_{key}"] = f(fl)
        n[f"h8_{key}"] = f"{h8[str(fl)]:.1f} min" if h8.get(str(fl)) is not None else None
        n[f"h7_{key}"] = f"{h7[str(fl)]:.1f} min" if h7.get(str(fl)) is not None else None
        n[f"ref_{key}"] = _pct(rf.get(str(fl)), 1)
    n["bus8"] = f"{R['bus_total_min'][H.index(8)]:.1f} min"
    n["bus7"] = f"{R['bus_total_min'][H.index(7)]:.1f} min"
    sizes = R["all_day_parity"]
    if all(sizes.get(k) for k in ("4", "20")):
        n["par4"], n["par20"] = f(sizes["4"]), f(sizes["20"])
    s = R.get("sensitivity") or []
    byid = {r["id"]: r["parity_fleet"] for r in s}
    if byid.get("wider_search"):
        n["disp2"] = f(byid["wider_search"])
    if byid.get("widest_search"):
        n["disp4"] = f(byid["widest_search"])
    if byid.get("pm_peak_roads"):
        n["pmfleet"] = f(byid["pm_peak_roads"])
    vals = [r["parity_fleet"] for r in s if r.get("parity_fleet") and r["id"] != "base"]
    if vals:
        n["sens_lo"], n["sens_hi"] = f(min(vals)), f(max(vals))
        n["sens_n"] = f(len([r for r in s if r["id"] != "base"]))
    return {k: v for k, v in n.items() if v is not None}


def run() -> dict:
    from .model import build_model
    M = build_model()
    h, runs = _load_fixed()
    base = json.loads((WEB_DATA / "baseline.json").read_text())
    cur = curves(h, runs)
    ptab = parity_table(h, "mean")
    ptab90 = parity_table(h, "p90")
    parity = {k: v["fleet"] for k, v in ptab.items()}
    hourly, audit = hourly_requirement()
    frontier = hourly if hourly else {k: [None] * len(HOURS) for k in cur}
    peak = {}
    for k, v in frontier.items():
        vals = [(x, HOURS[i]) for i, x in enumerate(v) if x is not None and HOURS[i] <= 24]
        if vals:
            f, hr = max(vals)
            peak[k] = {"fleet": int(f), "hour": int(hr)}
    ref_n = parity["10"]
    hh = h[(h.capacity == 10) & (h.fleet == ref_n)]
    kerb = {}
    for st in ("Yishun", "Khatib", "Springleaf"):
        col = f"kerb_dwell_max_{st}"
        if col in hh:
            kerb[st] = [_num(v, 1) for v in hh.groupby("hour")[col].mean().reindex(HOURS)]
    staging = {st: [_num(v, 1) for v in hh.groupby("hour")[f"kerb_staging_max_{st}"].mean().reindex(HOURS)]
               for st in ("Yishun", "Khatib", "Springleaf") if f"kerb_staging_max_{st}" in hh}
    ref_run = runs[(runs.capacity == 10) & (runs.fleet == ref_n)]
    # the "cliff": the parity fleet minus the largest simulated fleet whose 07:00 hour takes
    # more than twice the bus time
    c10 = {c["fleet"]: c for c in cur["10"]}
    i7 = HOURS.index(7)
    failing = [n for n, c in c10.items() if c["byHour"]["m"][i7] and c["byHour"]["m"][i7] > 2 * base["total_min"][i7]]
    cliff_gap = ref_n - max(failing) if failing else None
    fleets10 = sorted(c10)
    under = max([n for n in fleets10 if n < ref_n and c10[n]["byHour"]["m"][i7] and
                 c10[n]["byHour"]["m"][i7] > base["total_min"][i7] * 1.5], default=fleets10[0])
    # internal riders per bus-km inside Yishun: a lower bound (direct network distance between the
    # boarding and alighting stops; buses also carry riders to and from other towns)
    od, idx = M.od, M.stop_index
    pax_km = float(sum(r.rides_per_weekday * M.R.Dm[idx[r.o], idx[r.d]] for r in od.itertuples()) / 1000)
    i7b = base["hours"].index(7)
    out = {
        "hours": HOURS, "capacities": sorted(int(k) for k in cur),
        "parity_rule": "mean", "parity_detail": ptab, "parity_p90": ptab90,
        "parity_below": {k: v["below"] for k, v in ptab.items()},
        "bus_pax_per_km_lower": pax_km / base["bus_km_inside_day"], "internal_pax_km_direct": pax_km,
        "bus_total_min": base["total_min"], "bus_day_total_min": base["day_mean"]["total_min"],
        "curves": cur, "all_day_parity": parity, "frontier": frontier,
        "frontier_kind": "hourly" if hourly else "none", "frontier_audit": audit,
        "frontier_peak": peak, "cliff_gap": cliff_gap,
        "reference": {"capacity": 10, "fleet": ref_n, "veh_km": float(ref_run.veh_km.mean()),
                      "occupancy": float(ref_run.occupancy.mean()), "empty_share": float(ref_run.empty_share.mean()),
                      "total_min": float(ref_run.total_mean.mean() / 60),
                      "bus_min": float(ref_run.bus_total_mean.mean() / 60), "kerb": kerb, "staging": staging},
        "peak_supply": {"hour": 7, "shuttles": ref_n, "shuttle_places": ref_n * 10,
                        "buses_inside_all": base.get("buses_inside_all", [None] * len(HOURS))[i7b],
                        "feeders_on_road": base["feeder_buses_on_road"][i7b],
                        "places_per_bus": base.get("places_per_bus")},
        "who": who_gains(M, 10, ref_n),
        "shuttle_km_inside_share": shuttle_km_inside_share(M, ref_n),
        "shuttle_hours": shuttle_driving_hours(M, ref_n),
        "h8": {str(n): _num(c10[n]["byHour"]["m"][HOURS.index(8)]) for n in c10},
        "h7": {str(n): _num(c10[n]["byHour"]["m"][HOURS.index(7)]) for n in c10},
        "refused10": {str(n): c10[n]["refused"] for n in c10},
        "anim": {"reference": f"s10_{ref_n}", "undersized": f"s10_{under}"},
        "vehicle_hours": ({k: int(np.nansum([x for x in v if x is not None])) for k, v in frontier.items()}
                          if hourly else None),
        "fixed_fleet_vehicle_hours": int(ref_n * (len(HOURS))),
        "feeder_bus_hours": int(sum(base["feeder_buses_on_road"])),
        "bus_hours_inside_day": base.get("bus_hours_inside_day"),
    }
    ps = out["peak_supply"]
    if ps["buses_inside_all"] and ps["places_per_bus"]:
        ps["bus_places"] = round(ps["buses_inside_all"] * ps["places_per_bus"])
    kp = EXP / "kerb" / "kerb.parquet"
    if kp.exists():
        k = pd.read_parquet(kp)
        agg = k.groupby(["fleet", "berths"]).agg(
            h7_total_min=("h7_total_min", "mean"), h7_bus_min=("h7_bus_min", "mean"), h7_ok=("h7_ok", "all"),
            day_total_min=("day_total_min", "mean"), refused=("refused", "mean"),
            peak_queued_share=("peak_queued_share", "mean"), peak_queue_wait_mean_s=("peak_queue_wait_mean_s", "mean"),
            peak_queue_wait_p95_s=("peak_queue_wait_p95_s", "mean")).reset_index()
        out["kerb_experiment"] = json.loads(agg.to_json(orient="records"))
    sp = PROCESSED / "sensitivity.json"
    if sp.exists():
        sj = json.loads(sp.read_text())
        rows = sj["variants"] if isinstance(sj, dict) else sj
        keep = ("id", "label", "direction", "parity_fleet", "parity_below", "bus_day_min", "shuttle_day_min_at_parity")
        out["sensitivity"] = [{k: r.get(k) for k in keep} for r in rows if r["id"] not in SENS_EXCLUDED]
        out["sensitivity_excluded"] = [{**{k: r.get(k) for k in keep}, "name": SENS_EXCLUDED[r["id"]][0],
                                        "reason": SENS_EXCLUDED[r["id"]][1]}
                                       for r in rows if r["id"] in SENS_EXCLUDED]
    cal = json.loads((PROCESSED / "calibration.json").read_text())
    gp, pmp = PROCESSED / "gps_check.json", PROCESSED / "calibration_pm_peak.json"
    gps = json.loads(gp.read_text()) if gp.exists() else None
    pm = json.loads(pmp.read_text()) if pmp.exists() else None
    if gps:
        out["gps_check"] = {k: gps.get(k) for k in ("all", "by_window", "by_hour", "fit", "n_fixes_on_route", "n_tracks",
                                                    "speedbands", "distance_design")}
    if pm:
        out["calibration_pm_peak"] = {k: pm.get(k) for k in ("mult", "sig_s", "dwell_s", "hub_extra_s", "kappa",
                                                              "n_obs_used", "hours_sgt", "holdout_hours")}
    demand = json.loads((WEB_DATA / "demand.json").read_text())
    out["numbers"] = numbers(out, base, demand, cal, gps, pm)
    # what the page's numbers were computed from, per experiment grid (commit, model key, clean tree),
    # so the evidence page can say so
    out["provenance"] = {}
    for g in ("frontier", "ext", "kerb"):
        cfg = PROCESSED / "experiments" / g / "config.json"
        if cfg.exists():
            pv = json.loads(cfg.read_text()).get("provenance") or {}
            out["provenance"][g] = {k: pv.get(k) for k in ("git", "pipeline_modified", "model_key", "demand_months")}
    (WEB_DATA / "results.json").write_text(json.dumps(out, separators=(",", ":")))
    (WEB_DATA / "calibration_points.json").write_text(json.dumps(calibration_points(M), separators=(",", ":")))
    print(json.dumps({k: out[k] for k in ("all_day_parity", "parity_below", "frontier_peak", "cliff_gap", "anim",
                                          "vehicle_hours", "feeder_bus_hours", "peak_supply",
                                          "shuttle_km_inside_share", "frontier_audit")}, indent=1, default=str))
    print("p90 rule:", {k: v["fleet"] for k, v in ptab90.items()})
    print("reference:", {k: v for k, v in out["reference"].items() if k not in ("kerb", "staging")})
    print("who:", out["who"]["text"])
    return out


if __name__ == "__main__":
    run()
