"""Turn experiment outputs into results.json + calibration_points.json for the web page.

Definitions (also stated on the page):
  * curves: for each vehicle size and fleet size, mean stop-to-stop time (wait + ride) over the
    whole day and per hour, mean and min/max across demand replicates (fixed fleet all day);
  * all-day parity fleet: smallest simulated fixed fleet that keeps up in every hour;
  * hourly requirement: smallest fleet that keeps up with one hour's demand in steady state
    (hour-window simulations with warm-up; the larger of the replicates);
  * keeps up = no refused riders and mean stop-to-stop time no worse than the bus model.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .paths import PROCESSED, WEB_DATA

HOURS = list(range(5, 26))
EXP = PROCESSED / "experiments"


def _load_fixed() -> tuple[pd.DataFrame, pd.DataFrame]:
    hs, rs = [], []
    for name in ("frontier", "ext"):
        if (EXP / name / "hourly.parquet").exists():
            hs.append(pd.read_parquet(EXP / name / "hourly.parquet"))
            rs.append(pd.read_parquet(EXP / name / "runs.parquet"))
    return pd.concat(hs, ignore_index=True), pd.concat(rs, ignore_index=True)


def curves(h: pd.DataFrame, runs: pd.DataFrame) -> dict:
    out = {}
    for cap, g in runs.groupby("capacity"):
        lst = []
        for n, gr in g.groupby("fleet"):
            hh = h[(h.capacity == cap) & (h.fleet == n)]
            by = hh.groupby("hour").total_mean.agg(["mean", "min", "max"]).reindex(HOURS)
            ref = hh.groupby("hour").refused_share.max().reindex(HOURS)
            lst.append({
                "fleet": int(n),
                "all": {"m": float(gr.total_mean.mean() / 60), "lo": float(gr.total_mean.min() / 60),
                        "hi": float(gr.total_mean.max() / 60)},
                "byHour": {k: [None if pd.isna(v) else round(float(v) / 60, 2) for v in by[c]]
                           for k, c in (("m", "mean"), ("lo", "min"), ("hi", "max"))},
                "refusedByHour": [None if pd.isna(v) else round(float(v), 4) for v in ref],
                "refused": float(gr.refused_share.mean()), "veh_km": float(gr.veh_km.mean()),
                "occupancy": float(gr.occupancy.mean()), "empty_share": float(gr.empty_share.mean()),
            })
        out[str(int(cap))] = sorted(lst, key=lambda d: d["fleet"])
    return out


def all_day_parity(h: pd.DataFrame) -> dict:
    hm = h.groupby(["capacity", "fleet", "hour"]).agg(sh=("total_mean", "mean"), bus=("bus_total_mean", "mean"),
                                                       ref=("refused_share", "max")).reset_index()
    hm["ok"] = (hm.sh <= hm.bus) & (hm.ref <= 0.0)
    out = {}
    for cap, g in hm.groupby("capacity"):
        ok = g.groupby("fleet").ok.all()
        good = ok[ok].index
        out[str(int(cap))] = int(good.min()) if len(good) else None
    return out


def hourly_requirement() -> dict | None:
    p = EXP / "hourly" / "hourly_frontier.parquet"
    if not p.exists():
        return None
    df = pd.read_parquet(p)
    out = {}
    for cap, g in df.groupby("capacity"):
        need = g.groupby("hour").fleet_needed.max().reindex(HOURS)
        out[str(int(cap))] = [None if pd.isna(v) else int(v) for v in need]
    return out


def who_gains(M, cap: int, fleet: int, seed: int = 1) -> dict:
    from .experiments import service_day_requests
    from .sim import SimConfig, Simulator
    req = service_day_requests(M, seed)
    cfg = SimConfig(fleet=fleet, capacity=cap, seed=seed, start_s=4.75 * 3600)
    res = Simulator(M.R, M.study_idx, M.origin_rates, M.hub_idx, cfg).run(req[["t", "o", "d", "hour"]], M.stop_index)
    r = res.requests.join(req[["b_total", "b_wait", "b_ivt", "is_hub_trip"]])
    r = r[~r.refused & r.b_total.notna()]
    geo = M.stops.geometry
    r["dist"] = [geo[a].distance(geo[b]) for a, b in zip(r.o, r.d)]
    bands = [0, 500, 1000, 1500, 2000, 3000]
    r["band"] = pd.cut(r.dist, bands, right=False, labels=False)
    r["faster"] = r.total < r.b_total
    hub = r[r.is_hub_trip].groupby("band").faster.mean().reindex(range(len(bands) - 1))
    est = r[~r.is_hub_trip].groupby("band").faster.mean().reindex(range(len(bands) - 1))
    n_hub = r[r.is_hub_trip].groupby("band").size().reindex(range(len(bands) - 1), fill_value=0)
    n_est = r[~r.is_hub_trip].groupby("band").size().reindex(range(len(bands) - 1), fill_value=0)
    late = r[r.hour >= 20]
    peak = r[r.hour.isin([7, 8])]
    share = float(r.faster.mean())
    gain = float((r.b_total - r.total).mean() / 60)
    text = (f"With {fleet} ten-seat shuttles, {share:.0%} of rides are faster than by bus, saving "
            f"{gain:.1f} minutes on average. Rides of under 1 km to or from a station are faster "
            f"{hub.iloc[:2].mul(n_hub.iloc[:2]).sum() / max(n_hub.iloc[:2].sum(), 1):.0%} of the time, because the bus "
            f"wait dominates a short ride. In the evening after 20:00, when buses run less often, "
            f"{late.faster.mean():.0%} are faster; in the 07:00–09:00 peak, {peak.faster.mean():.0%}. The rides that lose are "
            f"mostly ones that share a vehicle with a detour, or that start where an empty shuttle is far away.")
    # equity view: gains by origin subzone against the subzone's share of residents aged 65+
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
        if not isinstance(sz, str) or sz.upper() not in census.index or len(g) < 200:
            continue
        row = census.loc[sz.upper()]
        by_sz.append({"subzone": sz.title(), "rides": int(len(g)), "share65": float(row[old].sum() / row.Total_Total),
                      "share_faster": float(g.faster.mean()), "mean_gain_min": float((g.b_total - g.total).mean() / 60),
                      "bus_min": float(g.b_total.mean() / 60), "shuttle_min": float(g.total.mean() / 60)})
    return {"bands_m": bands, "hub": [None if pd.isna(v) else round(float(v), 3) for v in hub],
            "estate": [None if pd.isna(v) else round(float(v), 3) for v in est],
            "n_hub": [int(v) for v in n_hub], "n_estate": [int(v) for v in n_est],
            "share_faster": share, "mean_gain_min": gain, "text": text,
            "by_subzone": sorted(by_sz, key=lambda d: -d["rides"])}


def calibration_points(M) -> dict:
    """Observed vs modelled bus running time per stop sequence, with the fitted parameters."""
    import glob

    from .calibrate import load, segment_observations, segment_table
    from .model import build_model
    cal = load()
    M0 = build_model(cal={"mult_arterial": 1.0, "mult_local": 1.0, "sig_s": 0.0})
    files = sorted(glob.glob(str(PROCESSED.parent / "raw" / "lta" / "live" / "bus_arrival_*.csv")))
    files = [f for f in files if any(f.endswith(s.split("/")[-1]) for s in cal["source_files"])]
    obs = pd.concat([segment_observations(f) for f in files], ignore_index=True)
    seg = segment_table(obs, M0.R, M0.stop_index, set(M0.stops.index[M0.stops.is_hub]))
    s = seg[seg.used]
    pred = cal["mult"] * s.t_ff + cal["sig_s"] * s.n_sig + cal["dwell_s"] * s.gap + cal["hub_extra_s"] * s.n_hub
    pts = [[round(float(a), 1), round(float(b), 1), int(c)] for a, b, c in zip(s["median"], pred, s["count"])]
    return {"points": pts, "params": {k: cal[k] for k in ("mult", "sig_s", "dwell_s", "hub_extra_s")}}


def run() -> dict:
    from .model import build_model
    M = build_model()
    h, runs = _load_fixed()
    base = json.loads((WEB_DATA / "baseline.json").read_text())
    cur = curves(h, runs)
    parity = all_day_parity(h)
    hourly = hourly_requirement()
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
            kerb[st] = [None if pd.isna(v) else round(float(v), 1) for v in hh.groupby("hour")[col].mean().reindex(HOURS)]
    staging = {st: [None if pd.isna(v) else round(float(v), 1)
                    for v in hh.groupby("hour")[f"kerb_staging_max_{st}"].mean().reindex(HOURS)]
               for st in ("Yishun", "Khatib", "Springleaf") if f"kerb_staging_max_{st}" in hh}
    ref_run = runs[(runs.capacity == 10) & (runs.fleet == ref_n)]
    # the "cliff": largest simulated fleet whose 07:00 hour is more than twice the bus time
    c10 = {c["fleet"]: c for c in cur["10"]}
    i7 = HOURS.index(7)
    failing = [n for n, c in c10.items() if c["byHour"]["m"][i7] and c["byHour"]["m"][i7] > 2 * base["total_min"][i7]]
    cliff_gap = ref_n - max(failing) if failing else None
    fleets10 = sorted(c10)
    under = max([n for n in fleets10 if n < ref_n and c10[n]["byHour"]["m"][i7] and
                 c10[n]["byHour"]["m"][i7] > base["total_min"][i7] * 1.5], default=fleets10[0])
    out = {
        "hours": HOURS, "capacities": sorted(int(k) for k in cur),
        "bus_total_min": base["total_min"], "bus_day_total_min": base["day_mean"]["total_min"],
        "curves": cur, "all_day_parity": parity, "frontier": frontier, "frontier_kind": "hourly" if hourly else "none",
        "frontier_peak": peak, "cliff_gap": cliff_gap,
        "reference": {"capacity": 10, "fleet": ref_n, "veh_km": float(ref_run.veh_km.mean()),
                      "occupancy": float(ref_run.occupancy.mean()), "empty_share": float(ref_run.empty_share.mean()),
                      "total_min": float(ref_run.total_mean.mean() / 60), "kerb": kerb, "staging": staging},
        "who": who_gains(M, 10, ref_n),
        "anim": {"reference": f"s10_{ref_n}", "undersized": f"s10_{under}"},
        "vehicle_hours": ({k: int(np.nansum([x for x in v if x is not None])) for k, v in frontier.items()}
                          if hourly else None),
        "feeder_bus_hours": int(sum(base["feeder_buses_on_road"])),
    }
    (WEB_DATA / "results.json").write_text(json.dumps(out, separators=(",", ":")))
    (WEB_DATA / "calibration_points.json").write_text(json.dumps(calibration_points(M), separators=(",", ":")))
    print(json.dumps({k: out[k] for k in ("all_day_parity", "frontier_peak", "cliff_gap", "anim", "vehicle_hours",
                                          "feeder_bus_hours")}, indent=1))
    print("reference:", {k: v for k, v in out["reference"].items() if k not in ("kerb", "staging")})
    print("who:", out["who"]["text"])
    return out


if __name__ == "__main__":
    run()
