"""Phase 2 report charts: static PNGs of the comparison, drawn from the same page data as the website.

Usage (from pipeline/):
    python -m yishun.phase2.charts [--summary PATH] [--out DIR]

Input:  data/processed/phase2/summary.json (default), read through export_web.build, so the charts,
        the page and the report quote the same rounded numbers.
Output: docs/phase2/img/*.png (light background, 200 dpi) and docs/phase2/img/captions.md.

Colours are the page's: options A/B/C #1f9fb4/#c98500/#d55181 and cost classes #3987e5/#199e70/#9085e9,
both sets validated for colour-vision deficiency on the light chart surface and on the page's dark
ground (the dataviz palette validator). Yellow sits just under 3:1 contrast on white, so identity
never rests on colour alone: marker shapes, direct labels and legends carry it too, and every
value is also in the report's tables.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

from ..paths import ROOT  # noqa: E402
from . import export_web  # noqa: E402

OUT = ROOT / "docs" / "phase2" / "img"
COL = {"A": "#1f9fb4", "B": "#c98500", "C": "#d55181", "staff": "#3987e5", "fixed": "#199e70", "distance": "#9085e9"}
INK = {"surface": "#fcfcfb", "text": "#0b0b0b", "secondary": "#52514e", "muted": "#898781", "grid": "#e1e0d9",
       "axis": "#c3c2b7"}
MODE_RAMP = {"onboard": "#184f95", "remote_with_attendant": "#2a78d6", "remote": "#86b6ef"}  # ordinal: staff on board -> none
CLASS_ORDER = [("staff", "Staff"), ("fixed", "Fixed (vehicles, depot, software, insurance…)"),
               ("distance", "Distance (energy, per-km maintenance)")]
MARK = {"A": "s", "B": "D", "C": "o"}


def _style() -> None:
    plt.rcParams.update({
        "figure.facecolor": INK["surface"], "axes.facecolor": INK["surface"], "savefig.facecolor": INK["surface"],
        "font.family": "DejaVu Sans", "font.size": 8.5, "axes.titlesize": 9, "axes.titleweight": "bold",
        "axes.titlelocation": "left", "axes.edgecolor": INK["axis"], "axes.linewidth": 0.8,
        "axes.labelcolor": INK["secondary"], "axes.titlecolor": INK["text"], "text.color": INK["text"],
        "xtick.color": INK["muted"], "ytick.color": INK["muted"], "xtick.labelcolor": INK["secondary"],
        "ytick.labelcolor": INK["secondary"], "axes.grid": True, "grid.color": INK["grid"], "grid.linewidth": 0.8,
        "axes.spines.top": False, "axes.spines.right": False, "legend.frameon": False, "legend.fontsize": 8,
        "lines.solid_capstyle": "round", "lines.solid_joinstyle": "round",
    })


def _k(v: float) -> str:
    """Thousands as "7.5k", never rounded to "8k"; whole thousands as "8k"."""
    if abs(v) < 1000:
        return f"{v:,.0f}"
    t = v / 1000
    return f"{t:,.0f}k" if abs(t - round(t)) < 1e-9 else f"{t:,.1f}k"


kfmt = FuncFormatter(lambda v, _: _k(v))


def _save(fig, out: Path, name: str) -> Path:
    path = out / name
    fig.savefig(path, dpi=200, bbox_inches="tight", pad_inches=0.12)
    plt.close(fig)
    return path


def _refs(P: dict) -> list[str]:
    return [i for i in [P["refs"].get("B"), *P["refs"].get("C", [])] if i]


def _ref_labels(fig, ax, items) -> None:
    """Reference labels sit above-left of their points (nothing lies above-left of the frontier). A label
    that would cross the axes' left edge, or overlap a label already placed, moves right and up, with a
    leader line to its point."""
    r = fig.canvas.get_renderer()
    to_pt = 72 / fig.dpi
    left = ax.get_window_extent(r).x0 + 4
    placed = []
    for t, xy in sorted(items, key=lambda it: it[1][0], reverse=True):   # right to left
        dx, dy = -6.0, 6.0
        for _ in range(30):
            a = ax.annotate(t, xy, xytext=(dx, dy), textcoords="offset points", ha="right", fontsize=7.5)
            bb = a.get_window_extent(r)
            a.remove()
            if bb.x0 < left:
                dx += (left - bb.x0) * to_pt
                dy += 0.9 * (left - bb.x0) * to_pt + 8
                continue
            hit = [q for q in placed if q.overlaps(bb)]
            if not hit:
                break
            dy += (max(q.y1 for q in hit) - bb.y0) * to_pt + 2
        placed.append(bb)
        lead = {} if (dx, dy) == (-6.0, 6.0) else {"arrowprops": dict(arrowstyle="-", color=INK["secondary"], lw=0.6, shrinkA=1, shrinkB=4)}
        ax.annotate(t, xy, xytext=(dx, dy), textcoords="offset points", ha="right", fontsize=7.5, color=INK["text"], zorder=7, **lead)


def _cloud(P: dict, m: str) -> list[tuple[dict, dict]]:
    return [(c, P["costs"][m][c["id"]]) for c in P["configs"] if c["option"] != "A" and c["id"] in P["costs"].get(m, {})
            and P["costs"][m][c["id"]]["delta_cost"]["central"] is not None]


def _rays(ax, xmax: float, ymax: float) -> None:
    for rate in (10, 20, 40, 80):        # constant cost per passenger-hour saved
        xe = min(xmax, rate * ymax)
        ax.plot([0, xe], [0, xe / rate], color=INK["grid"], lw=1, zorder=1)
        ax.annotate(f"SGD {rate}/h", (xe, xe / rate), xytext=(-3, -10 if xe < xmax else 3), textcoords="offset points",
                    ha="right", fontsize=7, color=INK["muted"])


def _origin(ax, ymin: float, ymax: float) -> None:
    ax.scatter([0], [0], marker="s", s=36, color=COL["A"], edgecolor=INK["surface"], lw=1.4, zorder=6)
    ax.annotate("A: today", (0, 0), xytext=(6, -11), textcoords="offset points", fontsize=7.5, color=INK["secondary"])
    ax.set_ylim(min(-0.06 * ymax, ymin * 1.05), ymax)
    ax.axhline(0, color=INK["axis"], lw=0.8, zorder=1)
    ax.xaxis.set_major_formatter(kfmt)
    ax.yaxis.set_major_formatter(kfmt)


def tradeoff(P: dict, out: Path) -> Path:
    """Additional cost against passenger-hours saved, every configuration, current pilot staffing (the first case)."""
    cfg = {c["id"]: c for c in P["configs"]}
    m = P["modes"][0]
    pts = _cloud(P, m)
    fig, ax = plt.subplots(figsize=(6.4, 4.4))
    xmax = max(e["delta_cost"]["central"] for _, e in pts) * 1.05
    ymax = max(c["saved_h"] for c, _ in pts) * 1.08
    _rays(ax, xmax, ymax)
    for theta in sorted({c["theta"] for c, _ in pts if c["kind"] == "C"}):
        fam = sorted([(c, e) for c, e in pts if c["kind"] == "C" and c["theta"] == theta], key=lambda t: t[0]["fleet"])
        ax.plot([e["delta_cost"]["central"] for _, e in fam], [c["saved_h"] for c, _ in fam], color=COL["C"], alpha=0.35, lw=1.2, zorder=2)
    fr = sorted((cfg[i] for i in P["frontier"][m]["central"] if i in cfg), key=lambda c: P["costs"][m][c["id"]]["delta_cost"]["central"])
    ax.plot([0] + [P["costs"][m][c["id"]]["delta_cost"]["central"] for c in fr], [0] + [c["saved_h"] for c in fr],
            color=INK["text"], lw=1.6, zorder=3)
    refs, items = set(_refs(P)), []
    for c, e in pts:
        x, y, col = e["delta_cost"]["central"], c["saved_h"], COL[c["option"]]
        variant = c["kind"] not in ("B", "C") or (c["option"] == "B" and c["capacity"] != 10)
        if not c["acceptable"]:
            ax.scatter(x, y, marker="x", s=22, color=col, lw=1.3, zorder=4)
        else:
            ax.scatter(x, y, marker=MARK[c["option"]], s=30 if c["option"] == "C" else 42, zorder=5,
                       facecolor=INK["surface"] if variant else col, edgecolor=col if variant else INK["surface"], lw=1.4)
        if c["id"] in refs:
            items.append((c["short"], (x, y)))
    ax.set_xlim(0, xmax)
    _origin(ax, min(c["saved_h"] for c, _ in pts), ymax)
    _ref_labels(fig, ax, items)
    ax.set_xlabel("additional operating cost per weekday against A (SGD, central case, all buses kept)")
    ax.set_ylabel("passenger-hours saved per weekday")
    ax.set_title(f"Staffing: {P['staff_modes'][m]['label']}")
    handles = [Line2D([], [], marker="s", ls="", color=COL["A"], label="A: today's buses"),
               Line2D([], [], marker="D", ls="", color=COL["B"], label="B: full replacement"),
               Line2D([], [], marker="o", ls="", color=COL["C"], label="C: combined (thin lines join fleets of one θ)"),
               Line2D([], [], marker="o", ls="", mfc=INK["surface"], mec=COL["C"], label="variant (seats, evening only, decline limit)"),
               Line2D([], [], marker="x", ls="", color=INK["muted"], label="service not acceptable"),
               Line2D([], [], color=INK["text"], lw=1.6, label="best saving for the cost")]
    fig.legend(handles=handles, loc="lower center", ncol=2, bbox_to_anchor=(0.5, -0.13))
    return _save(fig, out, "tradeoff.png")


def tradeoff_staffing(P: dict, out: Path) -> Path:
    """The best saving for the cost under each staffing case, with the references marked on each."""
    cfg = {c["id"]: c for c in P["configs"]}
    fig, ax = plt.subplots(figsize=(6.4, 4.0))
    xmax = max(P["costs"][m][i]["delta_cost"]["central"] for m in P["modes"] for i in P["frontier"][m]["central"]) * 1.05
    ymax = max(c["saved_h"] for c in P["configs"]) * 1.08
    _rays(ax, xmax, ymax)
    refs = _refs(P)
    for i in refs:                     # one reference across the staffing cases: same time saved, cost moves
        xs = [P["costs"][m][i]["delta_cost"]["central"] for m in P["modes"] if i in P["costs"].get(m, {})]
        ax.plot([min(xs), max(xs)], [cfg[i]["saved_h"]] * 2, color=INK["axis"], lw=1, zorder=2)
    for k, m in enumerate(P["modes"]):   # the first case wide underneath: one that coincides with it stays visible
        col = MODE_RAMP.get(m, INK["secondary"])
        fr = sorted((cfg[i] for i in P["frontier"][m]["central"] if i in cfg), key=lambda c: P["costs"][m][c["id"]]["delta_cost"]["central"])
        ax.plot([0] + [P["costs"][m][c["id"]]["delta_cost"]["central"] for c in fr], [0] + [c["saved_h"] for c in fr],
                color=col, lw=3.6 if k == 0 else 1.6, zorder=3 + k, label=P["staff_modes"][m]["short"])
        for i in refs:
            c = cfg[i]
            ax.scatter(P["costs"][m][i]["delta_cost"]["central"], c["saved_h"], marker=MARK[c["option"]], s=34, color=col,
                       edgecolor=INK["surface"], lw=1.2, zorder=4)
    ax.set_xlim(0, xmax)
    _origin(ax, 0, ymax)
    m0 = P["modes"][0]
    _ref_labels(fig, ax, [(cfg[i]["short"], (P["costs"][m0][i]["delta_cost"]["central"], cfg[i]["saved_h"])) for i in refs])
    ax.set_xlabel("additional operating cost per weekday against A (SGD, central case, all buses kept)")
    ax.set_ylabel("passenger-hours saved per weekday")
    h, _ = ax.get_legend_handles_labels()
    h += [Line2D([], [], marker="D", ls="", color=INK["secondary"], label="B reference"),
          Line2D([], [], marker="o", ls="", color=INK["secondary"], label="C references (labels at the first staffing case)")]
    ax.legend(handles=h, loc="lower right")
    return _save(fig, out, "tradeoff_staffing.png")


def cost_classes(P: dict, out: Path) -> Path:
    """Shuttle cost per weekday by class for the references, central case, one row per staffing case."""
    cfg = {c["id"]: c for c in P["configs"]}
    ids, modes = _refs(P), P["modes"]
    fig, axes = plt.subplots(len(modes), 1, figsize=(6.4, 1.75 * len(modes) + 0.5), sharex=True, squeeze=False)
    xmax = max(P["cost_detail"][m][i]["total"]["high"] for m in modes for i in ids if i in P["cost_detail"][m]) * 1.04
    for ax, m in zip(axes[:, 0], modes):
        det = P["cost_detail"][m]
        for k, i in enumerate(ids):
            d, y0 = det[i], len(ids) - 1 - k
            left = 0.0
            for cls, _ in CLASS_ORDER:
                v = d["classes"].get(cls, 0)
                ax.barh(y0, v, left=left, height=0.5, color=COL[cls], edgecolor=INK["surface"], lw=1, zorder=3)
                left += v
            lo, hi = d["total"]["low"], d["total"]["high"]
            ax.plot([lo, hi], [y0 - 0.36] * 2, color=INK["secondary"], lw=0.9, zorder=4)
            for v in (lo, hi):
                ax.plot([v, v], [y0 - 0.43, y0 - 0.29], color=INK["secondary"], lw=0.9, zorder=4)
            ax.annotate(f"{d['total']['central'] / 1000:,.0f}k", (d["total"]["central"], y0), xytext=(4, -3),
                        textcoords="offset points", fontsize=7.5, color=INK["secondary"])
        ax.set_yticks(range(len(ids)))
        ax.set_yticklabels([cfg[i]["short"] for i in reversed(ids)])
        ax.set_xlim(0, xmax)
        ax.xaxis.set_major_formatter(kfmt)
        ax.grid(axis="y", visible=False)
        ax.set_title(f"Staffing: {P['staff_modes'][m]['short']}")
    axes[-1][0].set_xlabel("SGD per weekday (bar: central case by class; line: low to high case)")
    handles = [plt.Rectangle((0, 0), 1, 1, color=COL[k], label=lab) for k, lab in CLASS_ORDER]
    fig.legend(handles=handles, loc="lower center", ncol=2, bbox_to_anchor=(0.5, -0.06))
    fig.tight_layout()
    return _save(fig, out, "cost_classes.png")


def passenger_time(P: dict, out: Path) -> Path:
    """Passenger-hours per weekday on the same rides: waiting and in-vehicle, A and the references."""
    cfg = {c["id"]: c for c in P["configs"]}
    ids = ["A", *_refs(P)]
    fig, ax = plt.subplots(figsize=(6.4, 2.8))
    for k, i in enumerate(ids):
        c, y0 = cfg[i], len(ids) - 1 - k
        wt, iv = (c["wait_h_A"], c["ivt_h_A"]) if c["option"] == "A" else (c["wait_h"], c["ivt_h"])
        col = COL[c["option"]]
        ax.barh(y0, wt, height=0.55, color=col, alpha=0.45, edgecolor=INK["surface"], lw=1, zorder=3)
        ax.barh(y0, iv, left=wt, height=0.55, color=col, edgecolor=INK["surface"], lw=1, zorder=3)
        ax.annotate(f"{wt + iv:,.0f}", (wt + iv, y0), xytext=(4, -3), textcoords="offset points", fontsize=7.5, color=INK["secondary"])
    ax.set_yticks(range(len(ids)))
    ax.set_yticklabels([("A: today" if i == "A" else cfg[i]["short"]) for i in reversed(ids)])
    ax.xaxis.set_major_formatter(kfmt)
    ax.grid(axis="y", visible=False)
    ax.set_xlabel("passenger-hours per weekday, stop to stop (lighter: waiting; full: in-vehicle)")
    return _save(fig, out, "passenger_time.png")


def periods(P: dict, out: Path) -> Path:
    """Passenger-hours saved by the period in which the ride is requested."""
    cfg = {c["id"]: c for c in P["configs"]}
    ids = [i for i in _refs(P) if P["periods"].get(i)]
    c_ids = [i for i in ids if cfg[i]["option"] == "C"]
    ramp = ["#f2a9c6", "#e87ba4", "#d55181", "#a33461", "#7a2348"]
    fig, ax = plt.subplots(figsize=(6.4, 3.0))
    names = [r["period"] for r in P["periods"][ids[0]]]
    for i in ids:
        rows = P["periods"][i]
        col = COL["B"] if cfg[i]["option"] == "B" else ramp[min(len(ramp) - 1, round(c_ids.index(i) * (len(ramp) - 1) / max(1, len(c_ids) - 1)))]
        ax.plot(range(len(rows)), [r["saved_h"] for r in rows], color=col, lw=2, marker="o", ms=5, mec=INK["surface"], mew=1.2,
                label=cfg[i]["short"], zorder=3)
    ax.set_xticks(range(len(names)))
    ax.set_xticklabels([f"{P['period_names'].get(n, n)}\n{P['period_labels'].get(n, '')}" for n in names])
    ax.yaxis.set_major_formatter(kfmt)
    ax.set_ylabel("passenger-hours saved per weekday")
    ax.legend(loc="upper left", ncol=1)
    return _save(fig, out, "periods.png")


def tornado(P: dict, out: Path) -> Path:
    """Cost per passenger-hour saved as one cost parameter moves to its low or high value, per staffing case."""
    cfg = {c["id"]: c for c in P["configs"]}
    modes = [m for m in P["modes"] if (P["tornado"].get(m) or {}).get("rows")]
    # one shared axis, in % of each staffing case's central value, so bar lengths compare across panels
    fig, axes = plt.subplots(len(modes), 1, figsize=(6.4, 2.7 * len(modes)), sharex=True, squeeze=False)
    pct = lambda r, c0: 100 * (r["cost_per_hour_saved"] / c0 - 1)
    span = max(abs(pct(r[side], t["rows"][0]["central_cost_per_hour_saved"]))
               for t in (P["tornado"][m] for m in modes) for r in t["rows"][:10] for side in ("low", "high"))
    for ax, m in zip(axes[:, 0], modes):
        t = P["tornado"][m]
        rows = t["rows"][:10]
        c0 = rows[0]["central_cost_per_hour_saved"]
        for k, r in enumerate(rows):
            a, b = sorted([pct(r["low"], c0), pct(r["high"], c0)])
            ax.barh(len(rows) - 1 - k, b - a, left=a, height=0.6, color=COL["C"], zorder=3)
        ax.set_xlim(-1.08 * span, 1.08 * span)
        ax.axvline(0, color=INK["text"], lw=1.2, zorder=4)
        ax.annotate(f"central SGD {c0:.1f} per hour saved", (0, len(rows) - 0.4), xytext=(4, 0),
                    textcoords="offset points", fontsize=7.5)
        ax.set_yticks(range(len(rows)))
        ax.set_yticklabels([r["label"] for r in reversed(rows)])
        ax.grid(axis="y", visible=False)
        ax.set_title(f"{P['staff_modes'][m]['short']}: C with {cfg[t['id']]['phrase']}")
    axes[-1, 0].xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:+.0f} %" if v else "0"))
    axes[-1, 0].set_xlabel("change in cost per passenger-hour saved, low to high value of one parameter")
    fig.tight_layout()
    return _save(fig, out, "tornado.png")


def budget(P: dict, out: Path) -> Path:
    """What a daily budget buys: the most passenger-hours saved by a configuration with acceptable service
    whose additional cost (central case) is within the budget. The curve steps up at each configuration on
    the frontier, so it is exact between the budgets the report's table lists."""
    cfg = {c["id"]: c for c in P["configs"]}
    fig, ax = plt.subplots(figsize=(6.4, 3.3))
    xmax = max(P["costs"][m][i]["delta_cost"]["central"] for m in P["modes"] for i in P["frontier"][m]["central"]) * 1.08
    for k, m in enumerate(P["modes"]):
        fr = sorted(((P["costs"][m][i]["delta_cost"]["central"], cfg[i]) for i in P["frontier"][m]["central"] if i in cfg),
                    key=lambda t: t[0])
        col = MODE_RAMP.get(m, INK["secondary"])
        ax.step([0] + [x for x, _ in fr] + [xmax], [0] + [c["saved_h"] for _, c in fr] + [fr[-1][1]["saved_h"]], where="post",
                color=col, lw=3.6 if k == 0 else 1.6, zorder=3 + k, label=P["staff_modes"][m]["short"])
        bx = [(x, c["saved_h"]) for x, c in fr if c["option"] == "B"]
        if bx:
            ax.scatter(*zip(*bx), marker="D", s=30, color=col, edgecolor=INK["surface"], lw=1.0, zorder=7 + k)
    for b in sorted({r["budget"] for m in P["modes"] for r in P["budgets"].get(m, [])}):
        if b <= xmax:
            ax.axvline(b, color=INK["grid"], lw=0.6, zorder=1)
    ax.set_xlim(0, xmax)
    ax.set_ylim(0, max(c["saved_h"] for c in P["configs"]) * 1.06)
    ax.xaxis.set_major_formatter(kfmt)
    ax.yaxis.set_major_formatter(kfmt)
    ax.grid(axis="x", visible=False)
    ax.set_xlabel("additional operating budget per weekday (SGD, central case, all buses kept)")
    ax.set_ylabel("most passenger-hours saved per weekday")
    h, _ = ax.get_legend_handles_labels()
    h += [Line2D([], [], marker="D", ls="", color=INK["secondary"], label="the best within the budget is a B configuration")]
    ax.legend(handles=h, loc="lower right")
    return _save(fig, out, "budget.png")


CAPTIONS = {
    "tradeoff.png": "Every simulated configuration: additional operating cost per weekday against Option A (central cost case, "
                    "all buses kept) and passenger-hours saved per weekday on the same rides (mean of the simulated days), with a "
                    "safety operator on board (the current pilot requirement). The black line joins the configurations that save more than every cheaper one; grey "
                    "rays mark constant cost per passenger-hour saved. Crosses: service not acceptable (more than 1 % of offered "
                    "rides declined in some hour, or riders refused). Costs are modelled from the parameter register; times are "
                    "simulated (shuttles) and modelled (buses).",
    "tradeoff_staffing.png": "The best saving for the cost under each staffing case (central cost case, all buses kept). "
                             "Passenger time does not depend on staffing, so each reference configuration keeps its height "
                             "and moves left as staffing falls (grey lines).",
    "cost_classes.png": "Shuttle operating cost per weekday by class for the reference configurations, central case (bar) and "
                        "low-to-high cost cases (line), for each staffing case.",
    "passenger_time.png": "Passenger-hours per weekday on the same rides, stop to stop: waiting (lighter) and in-vehicle "
                          "(full). Bus times are modelled; shuttle times are simulated.",
    "periods.png": "Passenger-hours saved per weekday against Option A, by the period in which the ride is requested "
                   "(sums over the period).",
    "tornado.png": "Cost per passenger-hour saved when one cost parameter at a time moves to its low-cost or high-cost value "
                   "(the others central), for the focus C configuration of each staffing case; the ten widest swings.",
    "budget.png": "The most passenger-hours saved per weekday by any configuration with acceptable service whose additional "
                  "cost (central case, all buses kept) is within the budget, for each staffing case; diamonds mark where the "
                  "best is a B configuration (elsewhere it is a C configuration). Faint vertical lines: the budgets of the "
                  "report's budget table. There is no single acceptable cost.",
}


def run(summary: Path = export_web.SUMMARY, out: Path = OUT) -> list[Path]:
    _style()
    P = export_web.build(json.loads(Path(summary).read_text()))
    out.mkdir(parents=True, exist_ok=True)
    paths = [f(P, out) for f in (tradeoff, tradeoff_staffing, cost_classes, passenger_time, periods, tornado, budget)]
    lines = ["# Phase 2 charts", "", "Written by `python -m yishun.phase2.charts` from `data/processed/phase2/summary.json`.", ""]
    lines += [f"## {p.name}\n\n![{p.stem}]({p.name})\n\n{CAPTIONS[p.name]}\n" for p in paths]
    (out / "captions.md").write_text("\n".join(lines))
    return paths


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--summary", type=Path, default=export_web.SUMMARY)
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args(argv)
    for p in run(a.summary, a.out):
        print(f"wrote {p}")


if __name__ == "__main__":
    main()
