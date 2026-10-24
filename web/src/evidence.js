/* Driverless Yishun, evidence page: the scorecard tally, the charts behind the checks and the
   provenance of both parts. Reads the same data files as the study page (results.json,
   calibration_points.json, phase2.json); nothing is computed here but positions and counts.
   The charts are drawn with Apache ECharts through the shared set-up in charts.js. */
(function () {
  "use strict";
  const hasCharts = typeof Charts !== "undefined";   // without ECharts the page still shows its numbers and tables
  const { T, tok, lab, callout, xName, yName } = hasCharts ? Charts : { T: {} };
  const fmt = (v) => Math.round(v).toLocaleString("en-US");
  const D = {};
  const pad2 = (h) => String(h).padStart(2, "0");
  const max = (a, f) => Math.max(...a.map(f)), min = (a, f) => Math.min(...a.map(f));
  // a hover band across the whole row or column under the pointer
  const band = { type: "shadow", shadowStyle: { color: T.rule, opacity: 0.35 } };

  // ------------------------------------------------------------------ numbers and tally
  function fill() {
    const n = { ...(D.results.numbers || {}), ...((D.phase2 || {}).numbers || {}) };
    const a = D.results.frontier_audit;
    if (a) { n.audit_checked = fmt(a.checked); n.audit_viol = a.violations === 0 ? "no" : fmt(a.violations); }
    for (const el of document.querySelectorAll("[data-v]")) { const v = n[el.dataset.v]; if (v != null) el.textContent = v; }
  }

  function tally() {
    const rows = [...document.querySelectorAll("#scorecard tbody tr, #review tbody tr")];
    const count = (k) => rows.filter((r) => r.querySelector(`.st.${k}`)).length;
    const items = [["pass", "checks met their criterion"], ["fixed", "review findings fixed and re-run"], ["bounded", "open questions with their size tested"],
      ["open", "open questions without the evidence"]];
    document.getElementById("tally").innerHTML = items.map(([k, label]) => `<div><b>${count(k)}</b><span><span class="st ${k}">${k}</span><span>${label}</span></span></div>`).join("");
  }

  // ------------------------------------------------------------------ calibration
  // one point per stop sequence: observed against modelled median running time, area by observations
  function drawCal() {
    const P = D.calpts; if (!P || !P.points) return;
    const mx = 2 * Math.ceil(max(P.points, (p) => Math.max(p[0], p[1])) / 120);   // whole minutes, even, so ticks every 2
    Charts.draw("ev-cal", {
      grid: { left: 44, right: 16, top: 30, bottom: 44 },
      xAxis: { type: "value", min: 0, max: mx, interval: 2, splitLine: { show: false }, ...xName("observed median running time (min)") },
      yAxis: { type: "value", min: 0, max: mx, interval: 2, ...yName("modelled (min)") },
      tooltip: { trigger: "item", formatter: (p) => `observed ${p.value[0].toFixed(1)} min<br>modelled ${p.value[1].toFixed(1)} min<br><span class="mute">${fmt(p.value[2])} observation${p.value[2] === 1 ? "" : "s"}</span>` },
      series: [{
        type: "scatter", data: P.points.map((p) => [p[0] / 60, p[1] / 60, p[2]]),
        symbolSize: (v) => 2 * Math.min(4, 1 + Math.sqrt(v[2]) / 6),
        itemStyle: { color: tok("--bus"), opacity: 0.45 }, emphasis: { scale: 1.6 },
        // the dashed line where modelled equals observed
        markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: T.mute, type: [3, 4], width: 1 },
          data: [[{ coord: [0, 0] }, { coord: [mx, mx] }]] },
      }],
    }, 320);
  }

  // ------------------------------------------------------------------ GPS check by hour
  // observed ÷ modelled time between GPS positions, pooled by hour, with its 95 % interval
  function drawGps() {
    const G = D.results.gps_check; if (!G || !G.by_hour) return;
    const rows = Object.entries(G.by_hour).map(([h, b]) => ({ h: +h, ...b })).filter((r) => r.n_pairs >= 20).sort((a, b) => a.h - b.h);
    if (!rows.length) return;
    const narrow = Charts.width("ev-gps") < 500, hrs = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const lo = Math.floor(Math.min(0.8, min(rows, (r) => r.pooled_ratio_ci[0])) * 10) / 10;
    const hi = Math.ceil(Math.max(1.2, max(rows, (r) => r.pooled_ratio_ci[1])) * 10) / 10;
    const bus = tok("--bus");
    Charts.draw("ev-gps", {
      grid: { left: 44, right: 16, top: 34, bottom: 34 },
      // hours as numbers, so the shading can cover whole hours (09:30 to 12:30 is "fitted here"); ticks on the hours themselves
      xAxis: { type: "value", min: 9.5, max: 19.5, splitLine: { show: false },
        axisTick: { customValues: hrs }, axisLabel: { customValues: narrow ? hrs.filter((h) => h % 2 === 0) : hrs, formatter: (h) => `${pad2(h)}:00` } },
      yAxis: { type: "value", min: lo, max: hi, interval: hi - lo > 0.6 ? 0.2 : 0.1, axisLabel: { formatter: (v) => v.toFixed(2) }, ...yName("observed ÷ model") },
      tooltip: { trigger: "axis", axisPointer: { type: "none" }, formatter: (ps) => {
        const r = rows.find((x) => x.h === ps[0].value[0]); if (!r) return "";
        return `<b>${pad2(r.h)}:00</b><br>observed ÷ model ${r.pooled_ratio.toFixed(2)}<br><span class="mute">95 % interval ${r.pooled_ratio_ci[0].toFixed(2)}–${r.pooled_ratio_ci[1].toFixed(2)} · ${fmt(r.n_pairs)} pairs</span>`;
      } },
      series: [
        Charts.segments(rows.map((r) => ({ value: [r.h, r.pooled_ratio_ci[0], r.h, r.pooled_ratio_ci[1]], itemStyle: { color: bus } }))),
        {
          type: "scatter", z: 3, data: rows.map((r) => [r.h, r.pooled_ratio]), symbolSize: 10,
          itemStyle: { color: bus, borderColor: T.surface, borderWidth: 2, opacity: 1 },
          markArea: { silent: true, itemStyle: { color: bus, opacity: 0.07 }, label: lab({ position: "insideTopLeft", textBorderWidth: 0 }),
            data: [[{ xAxis: 9.6, name: "fitted here" }, { xAxis: 12.4 }]] },
          markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: T.mute, type: [3, 4], width: 1 }, data: [{ yAxis: 1 }] },
        },
      ],
    }, 320);
  }

  // ------------------------------------------------------------------ Part 1 sensitivity
  // one row per alternative assumption: a dot at its fleet, a line from the base case, the side it favours in words
  function drawSens() {
    const S = D.results.sensitivity; if (!S || !S.length) return;
    const base = S.find((r) => r.id === "base"), b0 = base ? base.parity_fleet : null;
    const rows = S.filter((r) => r.id !== "base").map((r) => ({ ...r, d: r.parity_fleet == null ? Infinity : r.parity_fleet - b0 }))
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d) || a.label.localeCompare(b.label));
    const short = (s) => s.split(/[:(]/)[0].trim();
    const W = Charts.width("ev-sens"), narrow = W < 640, rowH = narrow ? 44 : 26, left = narrow ? 8 : 330;
    const known = rows.map((r) => r.parity_fleet).filter((v) => v != null).concat(b0);
    const x0 = Math.floor((Math.min(...known) - 25) / 50) * 50, x1 = Math.ceil((Math.max(...known) + 25) / 50) * 50;
    const at = (r) => r.parity_fleet ?? x1;   // more than the largest fleet searched: drawn at the right edge
    const col = tok("--sodium");   // one series: position, not colour, says more or fewer
    const fav = { 1: "favours the bus", "-1": "favours the shuttle", 0: "favours either" };
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    Charts.draw("ev-sens", {
      grid: { left, right: 46, top: 30, bottom: 40, ...(narrow && { outerBoundsMode: "none" }) },
      xAxis: { type: "value", min: x0, max: x1, ...xName("10-seat shuttles needed all day", 24) },
      yAxis: { type: "category", inverse: true, data: rows.map((r) => r.id), axisTick: { show: false }, axisLine: { show: false },
        axisLabel: narrow ? Charts.rowNamesAbove((id) => short(byId[id].label), W - 16) : Charts.rowNames((id) => short(byId[id].label), left - 16) },
      tooltip: { trigger: "axis", axisPointer: band, formatter: (ps) => {
        const r = byId[ps[0].axisValue], v = r.parity_fleet;
        return `<b>${r.label}</b><br>${v == null ? "more than 800" : fmt(v)} shuttles (base ${b0}) · ${fav[String(r.direction ?? 0)] || ""}` +
          (r.bus_day_min != null ? `<br><span class="mute">bus, day mean ${r.bus_day_min.toFixed(1)} min</span>` : "");
      } },
      series: [
        Charts.segments(rows.map((r, i) => ({ value: [b0, i, at(r), i], itemStyle: { color: col } })).filter((s) => s.value[2] !== b0), { dy: narrow ? 8 : 0 }),
        {
          type: "scatter", z: 3, symbolSize: 10, itemStyle: { color: col, borderColor: T.bg, borderWidth: 2, opacity: 1 },
          data: rows.map((r, i) => ({ value: [at(r), i], label: { position: at(r) >= b0 ? "right" : "left" } })),
          label: lab({ show: true, distance: 8, formatter: (p) => (rows[p.dataIndex].parity_fleet == null ? "> 800" : fmt(p.value[0])) }),
          symbolOffset: [0, narrow ? 8 : 0],
          // the base case: a vertical line through every row
          markLine: b0 == null ? undefined : { silent: true, symbol: "none", lineStyle: { color: T.fg, width: 1.5, type: "solid" },
            label: callout({ formatter: `base ${b0}`, position: "start" }), data: [{ xAxis: b0 }] },
        },
      ],
    }, 30 + 40 + rowH * rows.length);
    const ex = D.results.sensitivity_excluded || [];
    document.getElementById("ev-sens-cap").textContent = `Right of the line: more shuttles than the base case; left: fewer. Hover a row for the full assumption, the side it was chosen to favour and the bus's mean time under it.` +
      (ex.length ? ` Not shown: ${ex.map((r) => `${r.name} (${r.parity_fleet ?? "n/a"} vehicles), because ${r.reason}`).join("; ")}.` : "");
  }

  // ------------------------------------------------------------------ Part 2 cost swings, all staffing cases on one axis
  function drawTornado() {
    const P = D.phase2; if (!P || !P.tornado) return;
    const modes = P.modes.filter((m) => (P.tornado[m] || {}).rows && P.tornado[m].rows.length);
    if (!modes.length) return;
    const cfg = Object.fromEntries(P.configs.map((c) => [c.id, c]));
    const W = Charts.width("ev-tornado"), narrow = W < 640, per = 8, rowH = narrow ? 34 : 24, left = narrow ? 8 : 230;
    const pct = (v, c0) => 100 * (v / c0 - 1);
    // one category per row, with a heading row before each staffing case
    const cats = [], heads = [], bars = [];
    for (const md of modes) {
      const t = P.tornado[md], c0 = t.rows[0].central_cost_per_hour_saved, name = ((P.staff_modes || {})[md] || {}).short || md;
      heads.push({ value: [0, cats.length], text: `${name}: central SGD ${c0.toFixed(1)} per hour saved` });
      cats.push({ id: `h|${md}`, label: "" });
      for (const r of t.rows.slice(0, per)) {
        const lo = pct(r.low.cost_per_hour_saved, c0), hi = pct(r.high.cost_per_hour_saved, c0);
        bars.push({ value: [Math.min(lo, hi), cats.length, Math.max(lo, hi)], r, name, c0 });
        cats.push({ id: `${md}|${r.param_id}`, label: r.label });
      }
    }
    const span = Charts.nice(Math.max(...bars.map((b) => Math.max(Math.abs(b.value[0]), Math.abs(b.value[2])))) * 1.08);
    Charts.draw("ev-tornado", {
      grid: { left, right: 24, top: 8, bottom: 40, ...(narrow && { outerBoundsMode: "none" }) },
      xAxis: { type: "value", min: -span, max: span, splitNumber: narrow ? 4 : 8, axisLabel: { formatter: (v) => (v ? `${v > 0 ? "+" : ""}${v}%` : "0") },
        ...xName("change in cost per passenger-hour saved", 24) },
      yAxis: { type: "category", inverse: true, data: cats.map((c) => c.id), axisTick: { show: false }, axisLine: { show: false },
        axisLabel: narrow ? Charts.rowNamesAbove((id, i) => cats[i].label, W - 16) : Charts.rowNames((id, i) => cats[i].label, left - 16) },
      tooltip: { trigger: "item", formatter: (p) => {
        const { r, name, c0 } = p.data;
        return `<b>${r.label}</b> · ${name}<br>low ${r.low.text}: SGD ${r.low.cost_per_hour_saved.toFixed(1)}/h<br>central ${r.central_text}: SGD ${c0.toFixed(1)}/h<br>high ${r.high.text}: SGD ${r.high.cost_per_hour_saved.toFixed(1)}/h`;
      } },
      series: [
        Charts.spans(bars.map((b) => ({ ...b, itemStyle: { color: tok("--p2-c") } })), { height: 12, dy: narrow ? 8 : 0 }),
        // the staffing-case headings: labels on invisible points, moved left to the chart's edge
        { type: "scatter", silent: true, symbolSize: 0, data: heads.map((h) => ({ value: [-span, h.value[1]], text: h.text })),
          label: callout({ show: true, position: "right", distance: 0, offset: [-left + 2, 2], formatter: (p) => p.data.text, width: W - 8, overflow: "truncate", ellipsis: "…" }),
          markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: T.fg, width: 1.5, type: "solid" }, data: [{ xAxis: 0 }] } },
      ],
    }, 8 + 40 + rowH * cats.length);
    const id = (P.tornado[modes[0]] || {}).id;
    document.getElementById("ev-tornado-cap").textContent = `For the combined design with ${cfg[id] ? cfg[id].phrase : id}. The ${per} widest swings per staffing case are shown; hover a bar for the parameter's low, central and high values.`;
  }

  // ------------------------------------------------------------------ provenance
  function provenance() {
    const box = document.getElementById("prov"); if (!box) return;
    const p1 = D.results.provenance || {}, p2 = (D.phase2 || {}).provenance || {};
    const one = (pv) => pv && pv.git ? `commit <code>${pv.git}</code>${pv.pipeline_modified ? " (modified tree)" : ""}, model key <code>${pv.model_key}</code>` : "not recorded";
    const g1 = Object.entries(p1).map(([g, pv]) => `${g}: ${one(pv)}`).join("<br>") || "not recorded in this build";
    const runs = p2.grid_runs || {};
    const commits = [...new Set(Object.values(runs).map((v) => v.git))], keys = [...new Set(Object.values(runs).map((v) => v.model_key))];
    const clean = Object.values(runs).every((v) => v.pipeline_modified === false);
    const n = Object.values(runs).reduce((s, v) => s + (v.runs || 0), 0);
    const g2 = commits.length ? `${fmt(n)} simulated days in ${Object.keys(runs).length} grids, from commit${commits.length > 1 ? "s" : ""} ${commits.map((c) => `<code>${c}</code>`).join(", ")}` +
      `${clean ? " on a clean tree" : ""}, model key ${keys.map((k) => `<code>${k}</code>`).join(", ")}; summary built at <code>${p2.git}</code>` : "not recorded";
    box.innerHTML = `<div><b>Part 1</b><span>${g1}</span></div><div><b>Part 2</b><span>${g2}</span></div>`;
  }

  function drawAll() {
    if (!hasCharts) return;
    for (const f of [drawCal, drawGps, drawSens, drawTornado]) { try { f(); } catch (e) { console.error(f.name, e); } }
  }

  async function init() {
    const get = (f) => fetch(`data/${f}`).then((r) => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); });
    try {
      [D.results, D.calpts] = await Promise.all([get("results.json"), get("calibration_points.json")]);
    } catch (e) { console.error(e); return; }
    try { D.phase2 = await get("phase2.json"); } catch (e) { console.error(e); }
    for (const f of [fill, tally, provenance, drawAll]) { try { f(); } catch (e) { console.error(f.name, e); } }
    let rz = null, lastW = innerWidth;
    addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (innerWidth !== lastW) { lastW = innerWidth; drawAll(); } }, 200); });
    document.documentElement.dataset.ready = "1";
  }
  init();
})();
