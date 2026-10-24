/* Driverless Yishun, Phase 2: options compared on operating cost and passenger time.
   Reads ./data/phase2.json, exported by pipeline/yishun/phase2/export_web.py from the pipeline's
   summary. Every number on the page comes from that file; nothing is computed here except
   positions on the charts. The charts are drawn with Apache ECharts through the shared set-up in
   charts.js; D3 still formats numbers and builds the tables and legends. */
(function () {
  "use strict";
  const root = document.getElementById("phase2");
  if (!root || typeof d3 === "undefined" || typeof Charts === "undefined") return;
  const { lab, callout, xName, yName } = Charts;

  const css = getComputedStyle(root);
  const tok = (n) => css.getPropertyValue(n).trim();
  const COL = { A: tok("--p2-a"), B: tok("--p2-b"), C: tok("--p2-c"), staff: tok("--p2-staff"), fixed: tok("--p2-fixed"),
                distance: tok("--p2-dist"), surface: tok("--bg-2") || "#fff", rule: tok("--rule"), ink: tok("--fg"),
                mute: tok("--mute"), faint: tok("--faint") };
  const CLASS_ORDER = [["staff", "Staff"], ["fixed", "Fixed (vehicles, depot, software, insurance…)"], ["distance", "Distance (energy, per-km maintenance)"]];
  const fmt = d3.format(",.0f");
  const sgdk = (v) => (v == null ? "—" : `SGD ${d3.format(",.0f")(Math.round(v / 1000))}k`);
  const sgd = (v, nd = 0) => (v == null ? "—" : `SGD ${d3.format(`,.${nd}f`)(v)}`);
  const state = { mode: null, P: null, all: false };
  const BASE_TAG = "base case (same three days)";   // the stress grid's own base runs (phase2/experiments.py)
  // full replacement under C's decline rule (every ride offered, decline to the bus), from the stress grid
  const shortOf = (i, cfg) => (cfg[i] ? cfg[i].short : /^C-\d+-\d+-all$/.test(i) ? "B, C's rule" : i);
  // a hover band across the whole row under the pointer
  const band = { type: "shadow", shadowStyle: { color: COL.rule, opacity: 0.35 } };
  const kfmt = (v) => (v ? `${fmt(v / 1000)}k` : "0");

  // ------------------------------------------------------------------ helpers
  const cfgById = () => Object.fromEntries(state.P.configs.map((c) => [c.id, c]));
  const costOf = (id, mode = state.mode) => ((state.P.costs[mode] || {})[id]) || null;
  const refIds = () => [state.P.refs.B, ...state.P.refs.C].filter(Boolean);
  const familyColor = (c) => COL[c.option] || COL.mute;

  function legend(id, items) {
    const el = d3.select(`#${id}`);
    el.selectAll("*").remove();
    for (const it of items) {
      const s = el.append("span");
      if (it.kind === "line") s.append("i").attr("class", "ln").style("border-top-color", it.color).style("border-top-style", it.dash ? "dashed" : "solid");
      else if (it.kind === "svg") s.append("svg").attr("width", 14).attr("height", 14).attr("viewBox", "-7 -7 14 14").style("vertical-align", "middle").style("margin-right", "6px").html(it.svg);
      else s.append("i").attr("class", "sw").style("background", it.color).style("opacity", it.opacity || 1);
      s.append("span").text(it.label);
    }
  }

  // marker shapes: A square, B diamond, C circle; hollow = variant; cross = not acceptable (as ECharts symbol settings)
  function marker(c) {
    const col = familyColor(c), big = c.option !== "C";
    if (!c.acceptable && c.option !== "A")
      return { symbol: "path://M0,0L10,10M0,10L10,0", symbolSize: big ? 12 : 8, itemStyle: { color: "none", borderColor: col, borderWidth: 2 } };
    const hollow = c.kind && c.kind !== c.option && c.option === "C";
    return { symbol: c.option === "A" ? "rect" : c.option === "B" ? "diamond" : "circle", symbolSize: c.option === "A" ? 11 : c.option === "B" ? 15 : 9,
      itemStyle: { color: hollow ? COL.surface : col, borderColor: hollow ? col : COL.surface, borderWidth: 2, opacity: 1 } };
  }

  // ------------------------------------------------------------------ trade-off chart
  function drawTrade() {
    const P = state.P, mode = state.mode;
    const W = Charts.width("ch-p2-trade"); if (!W) return;
    const narrow = W < 560, H = Math.round(Math.max(340, Math.min(500, W * 0.56)));
    const m = { l: narrow ? 46 : 60, r: 18, t: 30, b: 46 };
    // by default only today, the best-value line and the reference designs; every design on request
    const frIds = new Set((P.frontier[mode] || {}).central || []), refSet = new Set(refIds());
    const pts = [];
    for (const c of P.configs) {
      if (c.option === "A") { pts.push({ c, x: 0, y: 0 }); continue; }
      if (!state.all && !frIds.has(c.id) && !refSet.has(c.id)) continue;
      const e = costOf(c.id); if (!e || e.delta_cost.central == null) continue;
      pts.push({ c, x: e.delta_cost.central, y: c.saved_h, e });
    }
    // the axis ends are fixed here, not left to ECharts, because the rays below need them
    const xMax = Charts.nice(d3.max(pts, (p) => p.x) * 1.04), yMax = Charts.nice(d3.max(pts, (p) => p.y) * 1.06);
    const yMin = Math.min(0, Charts.nice(d3.min(pts, (p) => p.y)));
    const w = W - m.l - m.r;
    // rays of constant cost per passenger-hour saved, each to where it leaves the chart
    const rays = [10, 20, 40, 80].map((c) => { const xe = Math.min(xMax, c * yMax); return { c, xe, ye: xe / c, top: xe < xMax }; })
      .filter((r) => (r.xe / xMax) * w >= 70);   // too close to the axis to label
    const series = [
      Charts.segments(rays.map((r) => ({ value: [0, 0, r.xe, r.ye], itemStyle: { color: COL.rule } })), { width: 1, z: 1 }),
      { type: "scatter", silent: true, symbolSize: 0, z: 1, data: rays.map((r) => ({ value: [r.xe, r.ye], label: { offset: [0, r.top ? 10 : -8] } })),
        label: lab({ show: true, position: "left", distance: 4, formatter: (p) => `SGD ${rays[p.dataIndex].c}/h${narrow ? "" : " saved"}` }) },
    ];
    // the C family: one thin line per coverage level, joining its fleets
    if (state.all) for (const [, ps] of d3.groups(pts.filter((p) => p.c.kind === "C"), (p) => p.c.theta)) {
      ps.sort((a, b) => a.c.fleet - b.c.fleet);
      series.push({ type: "line", silent: true, symbol: "none", z: 2, data: ps.map((p) => [p.x, p.y]), lineStyle: { color: COL.C, opacity: 0.35, width: 1.5 } });
    }
    // frontier
    const fr = ((P.frontier[mode] || {}).central || []).map((i) => pts.find((p) => p.c.id === i)).filter(Boolean).sort((a, b) => a.x - b.x);
    if (fr.length > 1) series.push({ type: "line", silent: true, symbol: "none", z: 3, data: [[0, 0], ...fr.map((p) => [p.x, p.y])], lineStyle: { color: COL.ink, width: 2 } });
    // markers: variants first, then the main family, then B and A on top; the references labelled above and to the left,
    // where no configuration lies (nothing is above-left of the frontier)
    const order = { "C-cap": 0, "C-window": 0, "C-wmax": 0, C: 1, B: 2, A: 3 };
    pts.sort((a, b) => (order[a.c.kind] ?? 1) - (order[b.c.kind] ?? 1));
    const refs = new Set(refIds());
    series.push({
      type: "scatter", z: 4,
      data: pts.map((p) => ({ value: [p.x, p.y], p, ...marker(p.c),
        label: p.c.option === "A" ? lab({ show: true, formatter: "A: today", position: "bottom", align: "left", distance: 6 })
          : refs.has(p.c.id) ? callout({ show: true, formatter: narrow && p.c.option === "C" ? `θ=${p.c.theta}` : p.c.short, position: "top", align: "right", distance: 5 })
          : { show: false } })),
      labelLayout: (q) => (q.labelRect.x < 4 ? { dx: 4 - q.labelRect.x } : {}),   // keep labels inside the chart's left edge
      markLine: yMin < 0 ? { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: COL.mute, width: 1, type: "solid" }, data: [{ yAxis: 0 }] } : undefined,
    });
    Charts.draw("ch-p2-trade", {
      grid: { left: m.l, right: m.r, top: m.t, bottom: m.b },
      xAxis: { type: "value", min: 0, max: xMax, splitNumber: narrow ? 4 : 7, splitLine: { show: false }, axisLabel: { formatter: kfmt },
        ...xName(narrow ? "added cost per weekday vs A (SGD)" : "additional operating cost per weekday against A (SGD)") },
      yAxis: { type: "value", min: yMin, max: yMax, splitNumber: 6, axisLabel: { formatter: (v) => (Math.abs(v) >= 1000 ? kfmt(v) : fmt(v)) },
        ...yName("passenger-hours saved per weekday") },
      tooltip: { trigger: "item", formatter: (q) => {
        const { c, e } = q.data.p, rows = [`<b>${c.label}</b>`];
        if (c.option !== "A") {
          rows.push(`saved ${fmt(c.saved_h)} passenger-h/day <span class="mute">(simulated days: ${fmt(c.saved_h_min)}–${fmt(c.saved_h_max)})</span>`);
          rows.push(`added cost ${sgdk(e.delta_cost.central)}/day <span class="mute">(low–high ${sgdk(e.delta_cost.low)}–${sgdk(e.delta_cost.high)})</span>`);
          rows.push(e.cost_per_hour_saved.central != null ? `${sgd(e.cost_per_hour_saved.central, 1)} per passenger-hour saved` : `<span class="mute">no time saved: no cost per hour saved</span>`);
          rows.push(`<span class="mute">offered ${fmt(c.n_offered)}, declined ${fmt(c.n_declined)}, refused ${fmt(c.n_refused)} rides/day${c.acceptable ? "" : " · service not acceptable"}</span>`);
        } else rows.push(`${fmt(c.pax_h_A)} passenger-hours on ${fmt(c.n)} rides`);
        return rows.join("<br>");
      } },
      series,
    }, H);
    legend("p2-trade-legend", [
      { kind: "svg", svg: `<path d="${d3.symbol(d3.symbolSquare, 110)()}" fill="${COL.A}"/>`, label: "A: today's buses" },
      { kind: "svg", svg: `<path d="${d3.symbol(d3.symbolDiamond, 110)()}" fill="${COL.B}"/>`, label: "B: full replacement" },
      { kind: "svg", svg: `<circle r="4" fill="${COL.C}"/>`, label: state.all ? "C: combined (lines join fleets of one θ)" : "C: combined" },
      ...(state.all ? [
        { kind: "svg", svg: `<circle r="4" fill="${COL.surface}" stroke="${COL.C}" stroke-width="2"/>`, label: "C variant" },
        { kind: "svg", svg: `<path d="M-4,-4L4,4M-4,4L4,-4" stroke="${COL.mute}" stroke-width="2"/>`, label: "service not acceptable" }] : []),
      { kind: "line", color: COL.ink, label: "best saving for the cost" },
    ]);
  }

  // ------------------------------------------------------------------ is it worth it?
  // Value of the riders' time saved per SGD 1 of added operating cost (the summary's social estimate:
  // in-vehicle hours plus weighted waiting hours at the value of time), one row per reference design.
  function drawWorth() {
    const P = state.P, mode = state.mode, cfg = cfgById();
    const key = `benefit_cost_ratio_${mode}`;
    const ids = refIds().filter((i) => ((P.social[i] || {}).central || {})[key] != null);
    const W = Charts.width("ch-p2-worth"); if (!W || !ids.length) return;
    const narrow = W < 560, left = narrow ? 8 : 150, rowH = narrow ? 56 : 44, dy = narrow ? 14 : 6;
    const val = (i, c) => ((P.social[i] || {})[c] || {})[key];
    const hi = Math.ceil(Math.max(1.25, d3.max(ids, (i) => val(i, "high") ?? val(i, "central")) * 1.05) * 5) / 5;   // a multiple of 0.2
    const money = (v) => `SGD ${v.toFixed(2)}`;
    const name = (i) => (cfg[i].option === "B" ? "B: full replacement" : `C: θ ${cfg[i].theta} min, ${cfg[i].fleet}`);
    Charts.draw("ch-p2-worth", {
      grid: { left, right: 24, top: 30, bottom: 42, ...(narrow && { outerBoundsMode: "none" }) },
      xAxis: { type: "value", min: 0, max: hi, interval: narrow ? 0.4 : 0.2, axisLabel: { formatter: (v) => v.toFixed(2) },
        ...xName(narrow ? "SGD of time saved per SGD 1 spent" : "value of riders' time saved per SGD 1 of added cost (SGD)", 24) },
      yAxis: { type: "category", inverse: true, data: ids, axisTick: { show: false }, axisLine: { show: false },
        axisLabel: narrow ? Charts.rowNamesAbove(name, W - 16) : Charts.rowNames(name, left - 8) },
      tooltip: { trigger: "axis", axisPointer: band, formatter: (ps) => {
        const i = ps[0].axisValue, c = cfg[i], lo = val(i, "low"), mid = val(i, "central"), up = val(i, "high");
        return `<b>${c.label}</b><br>riders' time saved worth ${money(mid)} per SGD 1 of added cost` +
          `<br><span class="mute">low value of time ${lo != null ? money(lo) : "—"} · high ${up != null ? money(up) : "—"}</span>` +
          `<br><span class="mute">${fmt(c.saved_h)} passenger-hours saved a day; ${sgd((costOf(i) || {}).cost_per_hour_saved?.central, 1)} per hour saved</span>`;
      } },
      series: [
        Charts.segments(ids.filter((i) => val(i, "low") != null && val(i, "high") != null)
          .map((i) => ({ value: [val(i, "low"), ids.indexOf(i), val(i, "high"), ids.indexOf(i)], itemStyle: { color: familyColor(cfg[i]) } })), { cap: "round", dy }),
        {
          type: "scatter", z: 3, symbolSize: 12, symbolOffset: [0, dy],
          data: ids.map((i, k) => ({ value: [val(i, "central"), k], itemStyle: { color: familyColor(cfg[i]), borderColor: COL.surface, borderWidth: 2 } })),
          label: callout({ show: true, position: "top", distance: 6, formatter: (p) => money(p.value[0]) }),   // moves with symbolOffset
          // break-even: left of this line the time saved is worth less than it costs
          markLine: { silent: true, symbol: "none", lineStyle: { color: COL.ink, type: [4, 4], width: 1 },
            label: lab({ formatter: "worth what it costs", position: "start" }), data: [{ xAxis: 1 }] },
        },
      ],
    }, 30 + 42 + rowH * ids.length);
    legend("p2-worth-legend", [{ kind: "svg", svg: `<circle r="4" fill="${COL.mute}"/>`, label: "central value of time" },
      { kind: "line", color: COL.mute, label: "low to high value of time" }, { kind: "line", color: COL.ink, dash: true, label: "worth what it costs" }]);
  }

  // ------------------------------------------------------------------ cost by class
  // one stacked bar per design (staff, fixed, distance), with the low-to-high cost case as a bracket underneath
  function drawCost() {
    const P = state.P, mode = state.mode, cfg = cfgById();
    const det = P.cost_detail[mode] || {};
    const ids = refIds().filter((i) => det[i]);
    const W = Charts.width("ch-p2-cost"); if (!W || !ids.length) return;
    const bh = 22;
    const xMax = Charts.nice(d3.max(ids, (i) => det[i].total.high || det[i].total.central) * 1.02);
    const series = CLASS_ORDER.map(([k, label], j) => {
      const last = j === CLASS_ORDER.length - 1;
      return {
        type: "bar", name: label, stack: "cost", barWidth: bh, data: ids.map((i) => (det[i].classes || {})[k] || 0),
        itemStyle: { color: COL[k], borderColor: COL.surface, borderWidth: last ? 0 : 1, borderRadius: last ? [0, 4, 4, 0] : 0 },
        label: last ? lab({ show: true, position: "right", distance: 6, formatter: (p) => sgdk(det[ids[p.dataIndex]].total.central) }) : undefined,
      };
    });
    // the low-to-high bracket: a line with an end tick at each side, just under its bar (a custom series draws all three)
    series.push({
      type: "custom", silent: true, z: 3, encode: { x: [0, 2], y: 1 },
      data: ids.map((i, k) => [det[i].total.low, k, det[i].total.high]).filter((v) => v[0] != null && v[2] != null),
      renderItem: (params, api) => {
        const a = api.coord([api.value(0), api.value(1)]), b = api.coord([api.value(2), api.value(1)]), y = a[1] + bh / 2 + 5;
        const style = { stroke: COL.mute, lineWidth: 1.5 };
        return { type: "group", children: [
          { type: "line", shape: { x1: a[0], y1: y, x2: b[0], y2: y }, style },
          { type: "line", shape: { x1: a[0], y1: y - 3, x2: a[0], y2: y + 3 }, style },
          { type: "line", shape: { x1: b[0], y1: y - 3, x2: b[0], y2: y + 3 }, style }] };
      },
    });
    Charts.draw("ch-p2-cost", {
      grid: { left: 100, right: 66, top: 8, bottom: 40 },
      xAxis: { type: "value", min: 0, max: xMax, splitNumber: W < 480 ? 3 : 5, axisLabel: { formatter: kfmt }, ...xName("SGD per weekday", 24) },
      yAxis: { type: "category", inverse: true, data: ids, axisTick: { show: false }, axisLabel: Charts.rowNames((i) => cfg[i].short, 92) },
      tooltip: { trigger: "item", formatter: (p) => {
        const i = ids[p.dataIndex], d = det[i];
        return `<b>${cfg[i].label}</b><br>${p.seriesName}: ${sgdk(p.value)}/day<br><span class="mute">` +
          Object.entries(d.categories || {}).map(([c, v]) => `${P.categories[c] || c} ${sgdk(v)}`).join(" · ") + "</span>";
      } },
      series,
    }, 300);
    legend("p2-cost-legend", CLASS_ORDER.map(([k, label]) => ({ color: COL[k], label })).concat([{ kind: "line", color: COL.mute, label: "low–high cost case" }]));
  }

  // ------------------------------------------------------------------ passenger time
  // waiting (lighter) then in-vehicle hours, stacked, in each design's family colour
  function drawTime() {
    const P = state.P, cfg = cfgById();
    const ids = ["A", ...refIds()].filter((i) => cfg[i]);
    const W = Charts.width("ch-p2-time"); if (!W) return;
    const val = (c) => (c.option === "A" ? [c.wait_h_A, c.ivt_h_A] : [c.wait_h, c.ivt_h]);
    const stat = (c, k) => (c.option === "A" ? c[`${k}_A`] : c[k]);
    const xMax = Charts.nice(d3.max(ids, (i) => d3.sum(val(cfg[i]))) * 1.02);
    const bar = (j, extra) => ({ type: "bar", stack: "time", barWidth: 22,
      data: ids.map((i) => ({ value: val(cfg[i])[j], itemStyle: { color: familyColor(cfg[i]) } })), ...extra });
    Charts.draw("ch-p2-time", {
      grid: { left: 100, right: 58, top: 8, bottom: 40 },
      xAxis: { type: "value", min: 0, max: xMax, splitNumber: W < 480 ? 3 : 5, axisLabel: { formatter: kfmt }, ...xName("passenger-hours per weekday", 24) },
      yAxis: { type: "category", inverse: true, data: ids, axisTick: { show: false },
        axisLabel: Charts.rowNames((i) => (cfg[i].option === "A" ? "A: today" : cfg[i].short), 92) },
      tooltip: { trigger: "axis", axisPointer: band, formatter: (ps) => {
        const c = cfg[ps[0].axisValue], [wt, iv] = val(c), p90 = stat(c, "p90_min");
        return `<b>${c.label}</b><br>waiting ${fmt(wt)} h · in-vehicle ${fmt(iv)} h<br>mean ${stat(c, "mean_min").toFixed(1)} min per ride, 90th percentile ${p90 != null ? p90.toFixed(1) : "—"} min`;
      } },
      series: [
        bar(0, { name: "waiting", itemStyle: { opacity: 0.45, borderColor: COL.surface, borderWidth: 1 } }),
        bar(1, { name: "in-vehicle", itemStyle: { borderRadius: [0, 4, 4, 0] },
          label: lab({ show: true, position: "right", distance: 6, formatter: (p) => fmt(d3.sum(val(cfg[ids[p.dataIndex]]))) }) }),
      ],
    }, 300);
    legend("p2-time-legend", [{ color: COL.mute, opacity: 0.45, label: "waiting (lighter)" }, { color: COL.mute, label: "in-vehicle" },
      { color: COL.A, label: "A" }, { color: COL.B, label: "B" }, { color: COL.C, label: "C" }]);
  }

  // ------------------------------------------------------------------ savings by period
  const PERIOD_SHORT = { early: "early", am_peak: "AM", offpeak: "off-peak", pm_peak: "PM", evening: "late" };
  function drawPeriod() {
    const P = state.P, cfg = cfgById();
    const ids = refIds().filter((i) => (P.periods[i] || []).length);
    const W = Charts.width("ch-p2-period"); if (!W || !ids.length) return;
    const narrow = W < 560;
    const periods = P.periods[ids[0]].map((r) => r.period);
    const cIds = ids.filter((i) => cfg[i].option === "C");
    const ramp = (k) => (cIds.length > 1 ? d3.interpolateRgb("#d9a3d2", "#6b2163")(k / (cIds.length - 1)) : COL.C);
    const colorOf = (i) => (cfg[i].option === "B" ? COL.B : ramp(cIds.indexOf(i)));
    Charts.draw("ch-p2-period", {
      grid: { left: 48, right: narrow ? 14 : 110, top: 14, bottom: 40 },
      xAxis: { type: "category", data: periods, axisTick: { alignWithLabel: true },
        axisLabel: { interval: 0, formatter: (p) => (narrow ? PERIOD_SHORT[p] : (P.period_names || {})[p]) || p } },
      yAxis: { type: "value", splitNumber: 5, axisLabel: { formatter: (v) => (Math.abs(v) >= 1000 ? kfmt(v) : fmt(v)) } },
      // one tooltip for the whole period under the pointer, every design in it
      tooltip: { trigger: "axis", axisPointer: { type: "line", lineStyle: { color: COL.rule } }, formatter: (ps) => {
        const k = ps[0].dataIndex, r0 = P.periods[ids[0]][k];
        return `<b>${(P.period_names || {})[r0.period] || r0.period}</b> <span class="mute">${r0.label}</span><br>` + ps.map((p) => {
          const r = P.periods[ids[p.seriesIndex]][k];
          return `${p.marker}${cfg[ids[p.seriesIndex]].short}: saved ${fmt(r.saved_h)} h <span class="mute">(${fmt(r.n_shuttle)} of ${fmt(r.n)} rides by shuttle)</span>`;
        }).join("<br>");
      } },
      // end labels in text ink at the right of each line, pushed apart by ECharts so none overlap
      series: ids.map((i) => ({
        type: "line", name: cfg[i].short, data: P.periods[i].map((r) => r.saved_h), color: colorOf(i), lineStyle: { width: 2 },
        symbol: "circle", symbolSize: 9, itemStyle: { borderColor: COL.surface, borderWidth: 2 },
        endLabel: lab({ show: !narrow, formatter: "{a}", distance: 8 }), labelLayout: { moveOverlap: "shiftY" },
      })),
    }, 300);
    legend("p2-period-legend", ids.map((i) => ({ color: colorOf(i), label: cfg[i].short })));
  }

  // ------------------------------------------------------------------ tornado
  function drawTornado() {
    const P = state.P, mode = state.mode, cfg = cfgById();
    const t = (P.tornado || {})[mode];
    const W = Charts.width("ch-p2-tornado"); if (!W) return;
    const narrow = W < 560;
    const rows = t && t.rows ? t.rows.slice(0, 10) : [];
    const cap = document.getElementById("p2-tornado-cap");
    if (!rows.length) { if (cap) cap.textContent = "No cost swings for this staffing case."; return; }
    const c0 = rows[0].central_cost_per_hour_saved;
    const lw = d3.max(rows, (r) => r.label.length), left = narrow ? 6 : Math.min(220, 14 + 7.3 * lw);
    const bh = narrow ? 12 : 18, dy = narrow ? 8 : 0;
    Charts.draw("ch-p2-tornado", {
      grid: { left, right: 20, top: 24, bottom: 40, ...(narrow && { outerBoundsMode: "none" }) },
      // scale: true lets the axis start away from zero, at a round number below the smallest swing
      xAxis: { type: "value", scale: true, splitNumber: 5,
        ...xName("SGD per passenger-hour saved", 24) },
      yAxis: { type: "category", inverse: true, data: rows.map((r) => r.param_id), axisTick: { show: false }, axisLine: { show: false },
        axisLabel: narrow ? Charts.rowNamesAbove((id, k) => rows[k].label, W - 16) : Charts.rowNames((id, k) => rows[k].label, left - 8) },
      tooltip: { trigger: "item", formatter: (p) => {
        const r = rows[p.dataIndex];
        return `<b>${r.label}</b><br>low-cost ${r.low.text}: ${sgd(r.low.cost_per_hour_saved, 1)}/h<br>central ${r.central_text}: ${sgd(r.central_cost_per_hour_saved, 1)}/h<br>high-cost ${r.high.text}: ${sgd(r.high.cost_per_hour_saved, 1)}/h` +
          (r.direction_ok ? "" : "<br><span class=\"mute\">acts both ways: its low-cost value does not lower cost here</span>");
      } },
      series: [{
        ...Charts.spans(rows.map((r, k) => ({ value: [Math.min(r.low.cost_per_hour_saved, r.high.cost_per_hour_saved), k, Math.max(r.low.cost_per_hour_saved, r.high.cost_per_hour_saved)],
          itemStyle: { color: COL.C } })), { height: bh, radius: 4, opacity: 0.8, dy }),
        markLine: { silent: true, symbol: "none", lineStyle: { color: COL.ink, width: 1.5, type: "solid" },
          label: callout({ formatter: `central ${sgd(c0, 1)}`, position: "start" }), data: [{ xAxis: c0 }] },
      }],
    }, narrow ? 64 + rows.length * 38 : 376);
    if (cap) cap.textContent = `Cost per passenger-hour saved when one cost parameter at a time moves to its low-cost or high-cost value (the others central), for C with ${cfg[t.id] ? cfg[t.id].phrase : t.id}, ${((P.staff_modes || {})[mode] || {}).short || mode}. The ten widest swings are shown.`;
  }

  // ------------------------------------------------------------------ tables
  function stressTable() {
    const P = state.P, cfg = cfgById();
    const rowsIn = (P.stress || []).filter((r) => r.stress !== BASE_TAG);
    const baseIn = (P.stress || []).filter((r) => r.stress === BASE_TAG);
    const ids = refIds(), extra = [...new Set((P.stress || []).map((r) => r.id))].filter((i) => !ids.includes(i));
    if (extra.length) ids.splice(1, 0, ...extra);
    const tbl = d3.select("#p2-stress");
    tbl.select("thead tr").html("<th>Condition</th>" + ids.map((i) => `<th class="cfg n">${shortOf(i, cfg)}</th>`).join(""));
    // the base row from the stress grid's own three days when it has them, else the configurations' means
    const base = { stress: baseIn.length ? "Base case" : "Base case (all simulated days)", cells: baseIn.length
      ? Object.fromEntries(baseIn.map((r) => [r.id, r]))
      : Object.fromEntries(ids.map((i) => [i, cfg[i] ? { saved_h: cfg[i].saved_h, declined: cfg[i].n_declined, refused: cfg[i].n_refused } : null])) };
    const by = d3.group(rowsIn, (r) => r.stress);
    const order = [...(P.stress_labels || []).filter((k) => by.has(k)), ...[...by.keys()].filter((k) => !(P.stress_labels || []).includes(k))];
    const rows = [base, ...order.map((k) => ({ stress: k, cells: Object.fromEntries((by.get(k) || []).map((r) => [r.id, r])) }))];
    const count = (v) => (v > 0 && v < 0.5 ? "<1" : fmt(v));
    const cell = (r) => {
      if (!r) return "<td class=\"n\">—</td>";
      const notes = [r.declined > 0 ? `${count(r.declined)} declined` : "", r.refused > 0 ? `${count(r.refused)} refused` : ""].filter(Boolean);
      return `<td class="n">${fmt(r.saved_h)}${notes.length ? `<br><span class="mute small">${notes.join(", ")}</span>` : ""}</td>`;
    };
    tbl.select("tbody").html(rows.map((r) => `<tr><td>${r.stress}</td>${ids.map((i) => cell(r.cells[i])).join("")}</tr>`).join(""));
  }

  function budgetTable() {
    const P = state.P, cfg = cfgById();
    const rows = (P.budgets[state.mode] || []).filter((r) => r.central);
    const narrow = document.getElementById("p2-budget").getBoundingClientRect().width < 560;
    const html = rows.length ? rows.map((r) => {
      const b = r.central, c = cfg[b.id];
      const name = !c ? b.id : narrow ? c.short : c.label;
      return `<tr><td class="n" style="text-align:left">${sgd(r.budget)}</td><td>${name}</td><td class="n">${fmt(b.saved_h)}</td><td class="n">${sgd(b.cost_per_hour_saved, 1)}</td></tr>`;
    }).join("") : `<tr><td colspan="4">No configuration with acceptable service fits these budgets in this staffing case.</td></tr>`;
    d3.select("#p2-budget tbody").html(html);
  }

  // ------------------------------------------------------------------ modes and numbers
  function setMode(m) {
    state.mode = m;
    d3.selectAll("#p2-modes button").attr("aria-pressed", function () { return this.dataset.mode === m ? "true" : "false"; });
    const lab = ((state.P.staff_modes || {})[m] || {}).label || m;
    document.getElementById("p2-modenote").textContent = `Costs below: ${lab}. Passenger time does not depend on staffing.`;
    for (const f of [drawWorth, drawTrade, drawCost, drawTornado, budgetTable]) { try { f(); } catch (e) { console.error("phase2", f.name, e); } }
  }

  function fillNumbers() {
    const n = state.P.numbers || {};
    for (const el of root.querySelectorAll("[data-v]")) { const v = n[el.dataset.v]; if (v != null) el.textContent = v; }
  }

  async function init() {
    let P;
    try {
      const r = await fetch("data/phase2.json");
      if (!r.ok) throw new Error(`phase2.json: HTTP ${r.status}`);
      P = await r.json();
    } catch (e) { console.error(e); root.querySelector("#p2-lead").textContent = "The Phase 2 data could not be loaded."; return; }
    state.P = P;
    document.getElementById("p2-banner").hidden = !P.synthetic;
    fillNumbers();
    const box = d3.select("#p2-modes");
    for (const m of P.modes) box.append("button").attr("type", "button").attr("data-mode", m).attr("aria-pressed", "false")
      .text(((P.staff_modes || {})[m] || {}).short || m).on("click", () => setMode(m));
    const drawAll = () => {
      for (const f of [drawTime, drawPeriod]) { try { f(); } catch (e) { console.error("phase2", f.name, e); } }
      setMode(state.mode || P.modes[0]);
    };
    stressTable();
    drawAll();
    const all = document.getElementById("p2-all");
    if (all) all.onclick = () => { state.all = !state.all; all.setAttribute("aria-pressed", String(state.all)); try { drawTrade(); } catch (e) { console.error(e); } };
    // charts inside the closed details have no width yet: draw them when it opens
    const more = document.getElementById("p2-more");
    if (more) more.addEventListener("toggle", () => { if (more.open) drawAll(); });
    let rz = null, lastW = window.innerWidth;
    window.addEventListener("resize", () => {
      clearTimeout(rz);
      rz = setTimeout(() => { if (window.innerWidth !== lastW) { lastW = window.innerWidth; drawAll(); } }, 200);
    });
    root.dataset.ready = "1";
  }
  init();
})();
