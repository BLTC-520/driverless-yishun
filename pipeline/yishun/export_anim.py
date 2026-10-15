"""Animation data for the web explorer: vehicle movements for a full simulated weekday.

Format (JSON, integers only, to stay compact):
  paths.json      {"origin": [lng0, lat0], "paths": [[dx, dy, f, dx, dy, f, ...], ...]}
                  dx/dy: position in 1e-5 degree units relative to origin, delta-encoded
                  along the path; f: cumulative share of the path's travel time (0..1000)
  anim_<id>.json  columnar legs sorted by start time:
                  pid, t0 (delta-encoded s after midnight), dur (s), cut (s after t0, 0 = none),
                  veh, occ (riders on board; -1 = empty repositioning; -2 = bus)
                  + waiting riders per study stop per minute (05:00-26:00) for shuttle runs

Shuttle movements are exactly the simulator's legs; bus movements are *modelled* runs
built from LTA first/last bus times and published headways with the calibrated running
times (LTA does not publish timetables or vehicle traces).
"""
from __future__ import annotations

import base64
import json

import numpy as np
from shapely.geometry import LineString
from shapely.ops import substring
from pyproj import Transformer

from .paths import WEB_DATA
from .routing import node_path_to_stop

T0_MIN, T1_MIN = 5 * 60, 26 * 60
_TO_WGS = Transformer.from_crs(3414, 4326, always_xy=True)


class PathBook:
    """Deduplicated road paths keyed by their marker sequence (start, end)."""

    def __init__(self, R, origin_lnglat):
        self.R = R
        self.origin = origin_lnglat
        self.index: dict = {}
        self.paths: list[list[int]] = []

    def _pieces(self, pts, times):
        R = self.R
        out = []  # list of (LineString, t_start, t_end)
        for (ka, a), (kb, b), ta, tb in zip(pts[:-1], pts[1:], times[:-1], times[1:]):
            if ka == "stop" and kb == "stop":
                g = R.edge_geom[(int(R.stop_u[a]), int(R.stop_v[a]))]
                seg = substring(g, R.stop_frac[a], R.stop_frac[b], normalized=True)
            elif ka == "stop":
                g = R.edge_geom[(int(R.stop_u[a]), int(R.stop_v[a]))]
                seg = substring(g, R.stop_frac[a], 1.0, normalized=True)
            elif kb == "stop":
                g = R.edge_geom[(int(R.stop_u[b]), int(R.stop_v[b]))]
                seg = substring(g, 0.0, R.stop_frac[b], normalized=True)
            else:
                seg = R.edge_geom[(a, b)]
            out.append((seg, ta, tb))
        return out

    def get(self, pts, times) -> int:
        key = (pts[0], pts[-1])
        if key in self.index:
            return self.index[key]
        pieces = self._pieces(pts, times)
        total = max(times[-1] - times[0], 1e-9)
        xy, fr = [], []
        for seg, ta, tb in pieces:
            coords = list(seg.coords) if seg.length > 0 else [seg.coords[0]] if len(seg.coords) else []
            if seg.length > 0:
                seg = seg.simplify(1.5)
                coords = list(seg.coords)
                cum = np.r_[0, np.cumsum(np.hypot(*np.diff(np.array(coords), axis=0).T))]
                share = cum / cum[-1]
            else:
                share = np.zeros(len(coords))
            for (x, y), s in zip(coords, share):
                f = (ta + s * (tb - ta) - times[0]) / total
                if xy and abs(xy[-1][0] - x) < 0.5 and abs(xy[-1][1] - y) < 0.5:
                    fr[-1] = f
                    continue
                xy.append((x, y)); fr.append(f)
        if not xy:
            sx, sy = self.R.stop_xy[pts[0][1]] if pts[0][0] == "stop" else self.R.node_xy[pts[0][1]]
            xy, fr = [(sx, sy), (sx, sy)], [0.0, 1.0]
        lng, lat = _TO_WGS.transform(*np.array(xy).T)
        qx = np.round((lng - self.origin[0]) * 1e5).astype(int)
        qy = np.round((lat - self.origin[1]) * 1e5).astype(int)
        qf = np.clip(np.round(np.array(fr) * 1000), 0, 1000).astype(int)
        flat, px, py = [], 0, 0
        for x, y, f in zip(qx, qy, qf):
            flat += [int(x - px), int(y - py), int(f)]
            px, py = x, y
        self.index[key] = len(self.paths)
        self.paths.append(flat)
        return self.index[key]


def _legs_table(rows: list[tuple]) -> dict:
    rows.sort(key=lambda r: r[1])
    pid, t0, dur, cut, veh, occ = (list(c) for c in zip(*rows)) if rows else ([],) * 6
    t0i = [int(round(x)) for x in t0]
    dt0 = [t0i[0]] + [b - a for a, b in zip(t0i[:-1], t0i[1:])] if t0i else []
    return {"pid": [int(x) for x in pid], "t0": dt0, "dur": [int(round(x)) for x in dur],
            "cut": [int(round(x)) for x in cut], "veh": [int(x) for x in veh], "occ": [int(x) for x in occ]}


def shuttle_legs(book: PathBook, legs) -> list[tuple]:
    rows = []
    for lg in legs:
        pid = book.get(lg.pts, lg.t)
        dur = lg.t[-1] - lg.t[0]
        cut = (lg.cut_t - lg.t[0]) if lg.cut_t is not None else 0.0
        if lg.cut_t is not None and cut <= 0:
            continue
        occ = -1 if (lg.onboard == 0 and lg.rebal) else int(lg.onboard)
        rows.append((int(pid), float(lg.t[0]), float(dur), float(cut), int(lg.v), occ))
    return rows


def waiting_by_minute(req, study_codes, stop_index) -> dict:
    """Riders waiting at each study stop, per minute (05:00-26:00), as base64 uint8."""
    n_min = T1_MIN - T0_MIN
    out = {}
    o = req.o.to_numpy(); t = req.t.to_numpy(); tp = req.t_pick.to_numpy()
    for code in study_codes:
        m = o == code
        a = np.clip((t[m] / 60 - T0_MIN).astype(int), 0, n_min)
        b = np.clip((np.nan_to_num(tp[m], nan=T1_MIN * 60) / 60 - T0_MIN).astype(int), 0, n_min)
        diff = np.zeros(n_min + 1, int)
        np.add.at(diff, a, 1); np.add.at(diff, b, -1)
        cnt = np.clip(np.cumsum(diff)[:n_min], 0, 255).astype(np.uint8)
        out[code] = base64.b64encode(cnt.tobytes()).decode()
    return out


def bus_runs(book: PathBook, M) -> list[tuple]:
    """Modelled bus movements: departures every published headway between first and last bus,
    stop-to-stop running times from the calibrated model, calibrated dwell at each stop."""
    from .busnet import band_for_minute
    R, bb = M.R, M.baseline
    idx = M.stop_index
    hubs = set(M.stops.index[M.stops.is_hub])
    rows, vid = [], 0
    for ln, pos, cum in bb.segments:
        f, l = ln.first_last.get(ln.stops[0], (None, None))
        if f is None or l is None:
            continue
        end = l + 1440 if l < f else l
        t = float(f)
        while t <= end:
            hw = ln.headways.get(band_for_minute(t % 1440))
            if hw is None:
                t += 15
                continue
            tt = t * 60.0
            for k in range(1, len(ln.stops)):
                a, b = ln.stops[k - 1], ln.stops[k]
                run = bb.T[idx[a], idx[b]] if (a in idx and b in idx) else None
                dwell = bb.p.dwell_s + (bb.p.hub_extra_s if a in hubs else 0.0)
                if run is not None and a != b:
                    ia, ib = idx[a], idx[b]
                    dep = tt + dwell
                    path = [("stop", ia)]
                    times = [dep]
                    same = (R.stop_u[ia] == R.stop_u[ib] and R.stop_v[ia] == R.stop_v[ib]
                            and R.stop_frac[ib] >= R.stop_frac[ia])
                    if not same:
                        tn = dep + (1 - R.stop_frac[ia]) * R.stop_edge_tt[ia]
                        nodes = node_path_to_stop(R, int(R.stop_v[ia]), ib)
                        path.append(("node", nodes[0])); times.append(tn)
                        for x, y in zip(nodes[:-1], nodes[1:]):
                            tn += R.edge_tt[(x, y)]
                            path.append(("node", y)); times.append(tn)
                    path.append(("stop", ib)); times.append(dep + run)
                    if T0_MIN * 60 <= dep <= T1_MIN * 60:
                        rows.append((book.get(path, times), dep, run, 0.0, vid, -2))
                    tt = dep + run
                else:
                    tt += dwell + max(ln.km[k] - ln.km[k - 1], 0) * 1000 / (bb.p.fallback_kmh / 3.6)
            vid += 1
            t += hw
    return rows


def export(M, scenarios: list[dict], include_buses: bool = True) -> None:
    """scenarios: [{"id", "label", "capacity", "fleet", "seed"}] - each is re-simulated with
    leg recording on the same demand replicate as the experiment."""
    from .experiments import service_day_requests
    from .sim import SimConfig, Simulator
    lng0, lat0 = 103.836, 1.4235
    book = PathBook(M.R, (lng0, lat0))
    study = list(M.stops.index[M.stops.in_study])
    index = {"origin": [lng0, lat0], "t0_min": T0_MIN, "t1_min": T1_MIN, "scenarios": []}
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    if include_buses:
        rows = bus_runs(book, M)
        (WEB_DATA / "anim_bus.json").write_text(json.dumps({"legs": _legs_table(rows), "kind": "bus"},
                                                           separators=(",", ":")))
        index["scenarios"].append({"id": "bus", "label": "Today's buses (modelled from LTA headways)",
                                   "kind": "bus", "vehicles": len({r[4] for r in rows})})
        print(f"anim_bus.json: {(WEB_DATA / 'anim_bus.json').stat().st_size / 1e6:.2f} MB, {len(rows)} legs")
    for sc in scenarios:
        req = service_day_requests(M, sc.get("seed", 1))
        cfg = SimConfig(fleet=sc["fleet"], capacity=sc["capacity"], seed=sc.get("seed", 1),
                        start_s=4.75 * 3600, record_legs=True)
        res = Simulator(M.R, M.study_idx, M.origin_rates, M.hub_idx, cfg).run(req[["t", "o", "d", "hour"]],
                                                                              M.stop_index)
        rows = shuttle_legs(book, res.legs)
        r = res.requests
        payload = {"kind": "shuttle", "legs": _legs_table(rows),
                   "waiting": waiting_by_minute(r, study, M.stop_index),
                   "summary": {"fleet": cfg.fleet, "capacity": cfg.capacity, "refused": float(r.refused.mean()),
                               "total_min": float(r.loc[~r.refused, "total"].mean() / 60)}}
        name = f"anim_{sc['id']}.json"
        (WEB_DATA / name).write_text(json.dumps(payload, separators=(",", ":")))
        index["scenarios"].append({"id": sc["id"], "label": sc["label"], "kind": "shuttle",
                                   "fleet": cfg.fleet, "capacity": cfg.capacity})
        print(f"{name}: {(WEB_DATA / name).stat().st_size / 1e6:.2f} MB, {len(rows)} legs")
    (WEB_DATA / "paths.json").write_text(json.dumps({"origin": [lng0, lat0], "paths": book.paths},
                                                    separators=(",", ":")))
    (WEB_DATA / "anim_index.json").write_text(json.dumps(index, separators=(",", ":")))
    print(f"paths.json: {(WEB_DATA / 'paths.json').stat().st_size / 1e6:.2f} MB, {len(book.paths)} paths")
