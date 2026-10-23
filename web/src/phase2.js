/* Driverless Yishun, Phase 2: options compared on operating cost and passenger time.
   Reads ./data/phase2.json, exported by pipeline/yishun/phase2/export_web.py from the pipeline's
   summary. Every number on the page comes from that file; nothing is computed here except
   positions on the charts. */
(function () {
  "use strict";
  const root = document.getElementById("phase2");
  if (!root || typeof d3 === "undefined") return;

  const css = getComputedStyle(root);
  const tok = (n) => css.getPropertyValue(n).trim();
  const COL = { A: tok("--p2-a"), B: tok("--p2-b"), C: tok("--p2-c"), staff: tok("--p2-staff"), fixed: tok("--p2-fixed"),
                distance: tok("--p2-dist"), surface: tok("--bg-2") || "#fff", rule: tok("--rule"), chalk: tok("--fg"),
                mute: tok("--mute") };
  const CLASS_ORDER = [["staff", "Staff"], ["fixed", "Fixed (vehicles, depot, software, insurance…)"], ["distance", "Distance (energy, per-km maintenance)"]];
  const fmt = d3.format(",.0f");
  const sgdk = (v) => (v == null ? "—" : `SGD ${d3.format(",.0f")(Math.round(v / 1000))}k`);
  const sgd = (v, nd = 0) => (v == null ? "—" : `SGD ${d3.format(`,.${nd}f`)(v)}`);
  const state = { mode: null, P: null };
  const tip = document.getElementById("p2-tip");

  // ------------------------------------------------------------------ tooltip
  function showTip(evt, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = evt.clientY - h - pad;
    tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${Math.max(8, y)}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  // ------------------------------------------------------------------ helpers
  const cfgById = () => Object.fromEntries(state.P.configs.map((c) => [c.id, c]));
  const costOf = (id, mode = state.mode) => ((state.P.costs[mode] || {})[id]) || null;
  const refIds = () => [state.P.refs.B, ...state.P.refs.C].filter(Boolean);
  const familyColor = (c) => COL[c.option] || COL.mute;

  // charts are drawn at the container's real pixel width, as in Phase 1, so labels keep their size on phones
  const widthOf = (id, max = 760) => Math.max(320, Math.min(max, Math.round(document.getElementById(id).parentNode.getBoundingClientRect().width || 640)));
  function svgFrame(id, W, H, margin) {
    const svg = d3.select(`#${id}`);
    svg.selectAll("*").remove();
    svg.attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
    const g = svg.append("g").attr("transform", `translate(${margin.l},${margin.t})`);
    return { svg, g, w: W - margin.l - margin.r, h: H - margin.t - margin.b };
  }

  // end-of-line labels pushed apart so none overlap (y positions in pixels, minimum gap in pixels)
  function spread(items, gap, lo, hi) {
    items.sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) items[i].y = Math.max(items[i].y, items[i - 1].y + gap);
    const over = items.length ? items[items.length - 1].y - hi : 0;
    if (over > 0) for (const it of items) it.y -= over;
    for (let i = items.length - 2; i >= 0; i--) items[i].y = Math.min(items[i].y, items[i + 1].y - gap);
    if (items.length && items[0].y < lo) { const d = lo - items[0].y; for (const it of items) it.y += d; }
    return items;
  }

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

  // marker shapes: A square, B diamond, C circle; hollow = variant; cross = not acceptable
  function marker(sel, c, r) {
    const col = familyColor(c);
    const hollow = c.kind && c.kind !== c.option && c.option === "C";
    if (!c.acceptable && c.option !== "A") {
      sel.append("path").attr("d", `M${-r},${-r}L${r},${r}M${-r},${r}L${r},${-r}`).attr("stroke", col).attr("stroke-width", 2).attr("fill", "none");
      return;
    }
    const shape = c.option === "A" ? d3.symbolSquare : c.option === "B" ? d3.symbolDiamond : d3.symbolCircle;
    sel.append("path").attr("d", d3.symbol(shape, Math.PI * r * r * (c.option === "B" ? 1.3 : 1))())
      .attr("fill", hollow ? COL.surface : col).attr("stroke", hollow ? col : COL.surface).attr("stroke-width", 2);
  }

  // ------------------------------------------------------------------ trade-off chart
  function drawTrade() {
    const P = state.P, mode = state.mode;
    const W = widthOf("ch-p2-trade", 1040), narrow = W < 560;
    const H = Math.round(Math.max(340, Math.min(500, W * 0.56)));
    const m = { l: narrow ? 46 : 60, r: 18, t: 26, b: 46 };
    const { g, w, h } = svgFrame("ch-p2-trade", W, H, m);
    const pts = [];
    for (const c of P.configs) {
      if (c.option === "A") { pts.push({ c, x: 0, y: 0 }); continue; }
      const e = costOf(c.id); if (!e || e.delta_cost.central == null) continue;
      pts.push({ c, x: e.delta_cost.central, y: c.saved_h, e });
    }
    const xMax = d3.max(pts, (p) => p.x) * 1.04, yMax = d3.max(pts, (p) => p.y) * 1.06, yMin = Math.min(0, d3.min(pts, (p) => p.y));
    const x = d3.scaleLinear().domain([0, xMax]).range([0, w]).nice();
    const y = d3.scaleLinear().domain([yMin, yMax]).range([h, 0]).nice();
    g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(6).tickSize(-w).tickFormat(""));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(narrow ? 4 : 7).tickFormat((v) => `${fmt(v / 1000)}k`));
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(6).tickFormat((v) => (Math.abs(v) >= 1000 ? `${fmt(v / 1000)}k` : fmt(v))));
    g.append("text").attr("class", "lab").attr("x", w).attr("y", h + 38).attr("text-anchor", "end")
      .text(narrow ? "added cost per weekday vs A (SGD)" : "additional operating cost per weekday against A (SGD)");
    g.append("text").attr("class", "lab").attr("x", -m.l + 2).attr("y", -12).text("passenger-hours saved per weekday");
    if (yMin < 0) g.append("line").attr("x1", 0).attr("x2", w).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", COL.mute).attr("stroke-width", 1);
    // rays of constant cost per passenger-hour saved
    for (const c of [10, 20, 40, 80]) {
      const xe = Math.min(x.domain()[1], c * y.domain()[1]), ye = xe / c, top = xe < x.domain()[1];
      if (x(xe) < 70) continue;   // too close to the axis to label
      g.append("line").attr("x1", x(0)).attr("y1", y(0)).attr("x2", x(xe)).attr("y2", y(ye)).attr("stroke", COL.rule).attr("stroke-width", 1);
      g.append("text").attr("class", "lab").attr("x", x(xe) - 4).attr("y", y(ye) + (top ? 13 : -5)).attr("text-anchor", "end").text(narrow ? `SGD ${c}/h` : `SGD ${c}/h saved`);
    }
    // the C family: one thin line per coverage level, joining its fleets
    for (const [, ps] of d3.groups(pts.filter((p) => p.c.kind === "C"), (p) => p.c.theta)) {
      ps.sort((a, b) => a.c.fleet - b.c.fleet);
      g.append("path").attr("d", d3.line().x((p) => x(p.x)).y((p) => y(p.y))(ps)).attr("fill", "none").attr("stroke", COL.C).attr("stroke-opacity", 0.35).attr("stroke-width", 1.5);
    }
    // frontier
    const fr = ((P.frontier[mode] || {}).central || []).map((i) => pts.find((p) => p.c.id === i)).filter(Boolean).sort((a, b) => a.x - b.x);
    if (fr.length > 1) g.append("path").attr("d", d3.line().x((p) => x(p.x)).y((p) => y(p.y))([{ x: 0, y: 0 }, ...fr])).attr("fill", "none").attr("stroke", COL.chalk).attr("stroke-width", 2);
    // markers: variants first, then the main family, then B and A on top
    const order = { "C-cap": 0, "C-window": 0, "C-wmax": 0, C: 1, B: 2, A: 3 };
    pts.sort((a, b) => (order[a.c.kind] ?? 1) - (order[b.c.kind] ?? 1));
    g.append("g").selectAll("g").data(pts).join("g").attr("transform", (p) => `translate(${x(p.x)},${y(p.y)})`)
      .each(function (p) { marker(d3.select(this), p.c, p.c.option === "C" ? 4 : 6); });
    // labels for the references, above and to the left: no configuration lies above-left of the frontier
    const refs = new Set(refIds());
    for (const p of pts) {
      if (!refs.has(p.c.id)) continue;
      const text = narrow && p.c.option === "C" ? `θ=${p.c.theta}` : p.c.short;
      const xr = Math.max(x(p.x) - 9, -m.l + 4 + 7.3 * text.length);
      g.append("text").attr("class", "lab callout").attr("x", xr).attr("y", y(p.y) - 9).attr("text-anchor", "end").text(text);
    }
    g.append("text").attr("class", "lab").attr("x", 10).attr("y", y(0) + (h - y(0) > 18 ? 15 : -8)).text("A: today");
    // hover: nearest marker within 14 px
    g.append("rect").attr("width", w).attr("height", h).attr("fill", "transparent").on("mousemove", (evt) => {
      const [mx, my] = d3.pointer(evt);
      let best = null, bd = 196;
      for (const p of pts) { const d = (x(p.x) - mx) ** 2 + (y(p.y) - my) ** 2; if (d < bd) { bd = d; best = p; } }
      if (!best) return hideTip();
      const c = best.c, e = best.e;
      const rows = [`<b>${c.label}</b>`];
      if (c.option !== "A") {
        rows.push(`saved ${fmt(c.saved_h)} passenger-h/day <span class="mute">(simulated days: ${fmt(c.saved_h_min)}–${fmt(c.saved_h_max)})</span>`);
        rows.push(`added cost ${sgdk(e.delta_cost.central)}/day <span class="mute">(low–high ${sgdk(e.delta_cost.low)}–${sgdk(e.delta_cost.high)})</span>`);
        rows.push(e.cost_per_hour_saved.central != null ? `${sgd(e.cost_per_hour_saved.central, 1)} per passenger-hour saved` : `<span class="mute">no time saved: no cost per hour saved</span>`);
        rows.push(`<span class="mute">offered ${fmt(c.n_offered)}, declined ${fmt(c.n_declined)}, refused ${fmt(c.n_refused)} rides/day${c.acceptable ? "" : " · service not acceptable"}</span>`);
      } else rows.push(`${fmt(c.pax_h_A)} passenger-hours on ${fmt(c.n)} rides`);
      showTip(evt, rows.join("<br>"));
    }).on("mouseleave", hideTip);
    legend("p2-trade-legend", [
      { kind: "svg", svg: `<path d="${d3.symbol(d3.symbolSquare, 110)()}" fill="${COL.A}"/>`, label: "A: today's buses" },
      { kind: "svg", svg: `<path d="${d3.symbol(d3.symbolDiamond, 110)()}" fill="${COL.B}"/>`, label: "B: full replacement" },
      { kind: "svg", svg: `<circle r="4" fill="${COL.C}"/>`, label: "C: combined (lines join fleets of one θ)" },
      { kind: "svg", svg: `<circle r="4" fill="${COL.surface}" stroke="${COL.C}" stroke-width="2"/>`, label: "C variant" },
      { kind: "svg", svg: `<path d="M-4,-4L4,4M-4,4L4,-4" stroke="${COL.mute}" stroke-width="2"/>`, label: "service not acceptable" },
      { kind: "line", color: COL.chalk, label: "best saving for the cost" },
    ]);
  }

  // ------------------------------------------------------------------ cost by class
  function drawCost() {
    const P = state.P, mode = state.mode, cfg = cfgById();
    const det = P.cost_detail[mode] || {};
    const ids = refIds().filter((i) => det[i]);
    const W = widthOf("ch-p2-cost"), m = { l: 100, r: 66, t: 8, b: 40 };
    const { g, w, h } = svgFrame("ch-p2-cost", W, 300, m);
    if (!ids.length) return;
    const xMax = d3.max(ids, (i) => det[i].total.high || det[i].total.central);
    const x = d3.scaleLinear().domain([0, xMax * 1.02]).range([0, w]).nice();
    const yb = d3.scaleBand().domain(ids).range([0, h]).padding(0.35);
    const bh = Math.min(22, yb.bandwidth());
    g.append("g").attr("class", "grid").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(W < 480 ? 3 : 5).tickSize(-h).tickFormat(""));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(W < 480 ? 3 : 5).tickFormat((v) => `${fmt(v / 1000)}k`));
    g.append("text").attr("class", "lab").attr("x", w).attr("y", h + 34).attr("text-anchor", "end").text("SGD per weekday");
    for (const i of ids) {
      const d = det[i], cy = yb(i) + (yb.bandwidth() - bh) / 2;
      let x0 = 0;
      CLASS_ORDER.forEach(([k], j) => {
        const v = (d.classes || {})[k] || 0;
        const last = j === CLASS_ORDER.length - 1;
        const wv = Math.max(0, x(x0 + v) - x(x0) - (last ? 0 : 2));
        g.append("rect").attr("x", x(x0)).attr("y", cy).attr("width", wv).attr("height", bh).attr("rx", last ? 4 : 0).attr("fill", COL[k])
          .on("mousemove", (evt) => showTip(evt, `<b>${cfg[i].label}</b><br>${CLASS_ORDER[j][1]}: ${sgdk(v)}/day<br><span class="mute">` +
            Object.entries(d.categories || {}).map(([c, val]) => `${P.categories[c] || c} ${sgdk(val)}`).join(" · ") + "</span>"))
          .on("mouseleave", hideTip);
        x0 += v;
      });
      const lo = d.total.low, hi = d.total.high;
      if (lo != null && hi != null) {
        const ly = cy + bh + 5;
        g.append("line").attr("x1", x(lo)).attr("x2", x(hi)).attr("y1", ly).attr("y2", ly).attr("stroke", COL.mute).attr("stroke-width", 1.5);
        for (const v of [lo, hi]) g.append("line").attr("x1", x(v)).attr("x2", x(v)).attr("y1", ly - 3).attr("y2", ly + 3).attr("stroke", COL.mute).attr("stroke-width", 1.5);
      }
      g.append("text").attr("class", "lab").attr("x", -8).attr("y", cy + bh / 2 + 4).attr("text-anchor", "end").text(cfg[i].short);
      g.append("text").attr("class", "lab").attr("x", x(d.total.central) + 6).attr("y", cy + bh / 2 + 4).text(sgdk(d.total.central));
    }
    legend("p2-cost-legend", CLASS_ORDER.map(([k, label]) => ({ color: COL[k], label })).concat([{ kind: "line", color: COL.mute, label: "low–high cost case" }]));
  }

  // ------------------------------------------------------------------ passenger time
  function drawTime() {
    const P = state.P, cfg = cfgById();
    const ids = ["A", ...refIds()].filter((i) => cfg[i]);
    const W = widthOf("ch-p2-time"), m = { l: 100, r: 58, t: 8, b: 40 };
    const { g, w, h } = svgFrame("ch-p2-time", W, 300, m);
    const val = (c) => (c.option === "A" ? [c.wait_h_A, c.ivt_h_A] : [c.wait_h, c.ivt_h]);
    const x = d3.scaleLinear().domain([0, d3.max(ids, (i) => d3.sum(val(cfg[i]))) * 1.02]).range([0, w]).nice();
    const yb = d3.scaleBand().domain(ids).range([0, h]).padding(0.35);
    const bh = Math.min(22, yb.bandwidth());
    g.append("g").attr("class", "grid").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(W < 480 ? 3 : 5).tickSize(-h).tickFormat(""));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(W < 480 ? 3 : 5).tickFormat((v) => `${fmt(v / 1000)}k`));
    g.append("text").attr("class", "lab").attr("x", w).attr("y", h + 34).attr("text-anchor", "end").text("passenger-hours per weekday");
    for (const i of ids) {
      const c = cfg[i], [wt, iv] = val(c), cy = yb(i) + (yb.bandwidth() - bh) / 2, col = familyColor(c);
      g.append("rect").attr("x", 0).attr("y", cy).attr("width", Math.max(0, x(wt) - 2)).attr("height", bh).attr("fill", col).attr("fill-opacity", 0.45);
      g.append("rect").attr("x", x(wt)).attr("y", cy).attr("width", Math.max(0, x(wt + iv) - x(wt))).attr("height", bh).attr("rx", 4).attr("fill", col);
      g.append("rect").attr("x", 0).attr("y", cy).attr("width", x(wt + iv)).attr("height", bh).attr("fill", "transparent")
        .on("mousemove", (evt) => showTip(evt, `<b>${c.label}</b><br>waiting ${fmt(wt)} h · in-vehicle ${fmt(iv)} h<br>mean ${(c.option === "A" ? c.mean_min_A : c.mean_min).toFixed(1)} min per ride, 90th percentile ${(c.option === "A" ? c.p90_min_A : c.p90_min) != null ? (c.option === "A" ? c.p90_min_A : c.p90_min).toFixed(1) : "—"} min`))
        .on("mouseleave", hideTip);
      g.append("text").attr("class", "lab").attr("x", -8).attr("y", cy + bh / 2 + 4).attr("text-anchor", "end").text(c.option === "A" ? "A: today" : c.short);
      g.append("text").attr("class", "lab").attr("x", x(wt + iv) + 6).attr("y", cy + bh / 2 + 4).text(fmt(wt + iv));
    }
    legend("p2-time-legend", [{ color: COL.mute, opacity: 0.45, label: "waiting (lighter)" }, { color: COL.mute, label: "in-vehicle" },
      { color: COL.A, label: "A" }, { color: COL.B, label: "B" }, { color: COL.C, label: "C" }]);
  }

  // ------------------------------------------------------------------ savings by period
  const PERIOD_SHORT = { early: "early", am_peak: "AM peak", offpeak: "off-peak", pm_peak: "PM peak", evening: "late" };
  function drawPeriod() {
    const P = state.P, cfg = cfgById();
    const ids = refIds().filter((i) => (P.periods[i] || []).length);
    const W = widthOf("ch-p2-period"), narrow = W < 560, m = { l: 48, r: narrow ? 14 : 96, t: 14, b: 40 };
    const { g, w, h } = svgFrame("ch-p2-period", W, 300, m);
    if (!ids.length) return;
    const periods = P.periods[ids[0]].map((r) => r.period);
    const x = d3.scalePoint().domain(periods).range([0, w]).padding(0.3);
    const all = ids.flatMap((i) => P.periods[i].map((r) => r.saved_h));
    const y = d3.scaleLinear().domain([Math.min(0, d3.min(all)), d3.max(all) * 1.1]).range([h, 0]).nice();
    g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(""));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).tickFormat((p) => (narrow ? PERIOD_SHORT[p] : (P.period_names || {})[p]) || p));
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat((v) => (Math.abs(v) >= 1000 ? `${fmt(v / 1000)}k` : fmt(v))));
    const cIds = ids.filter((i) => cfg[i].option === "C");
    const ramp = (k) => (cIds.length > 1 ? d3.interpolateRgb("#d9a3d2", "#6b2163")(k / (cIds.length - 1)) : COL.C);
    const colorOf = (i) => (cfg[i].option === "B" ? COL.B : ramp(cIds.indexOf(i)));
    const items = [], ends = [];
    for (const i of ids) {
      const rows = P.periods[i], col = colorOf(i);
      g.append("path").attr("d", d3.line().x((r) => x(r.period)).y((r) => y(r.saved_h))(rows)).attr("fill", "none").attr("stroke", col).attr("stroke-width", 2);
      g.selectAll(null).data(rows).join("circle").attr("cx", (r) => x(r.period)).attr("cy", (r) => y(r.saved_h)).attr("r", 4)
        .attr("fill", col).attr("stroke", COL.surface).attr("stroke-width", 2)
        .on("mousemove", (evt, r) => showTip(evt, `<b>${cfg[i].label}</b><br>${(P.period_names || {})[r.period] || r.period} (${r.label}): saved ${fmt(r.saved_h)} passenger-h<br><span class="mute">${fmt(r.n)} rides, ${fmt(r.n_shuttle)} by shuttle</span>`))
        .on("mouseleave", hideTip);
      const last = rows[rows.length - 1];
      ends.push({ y: y(last.saved_h), y0: y(last.saved_h), x: x(last.period), text: cfg[i].short, col });
      items.push({ color: col, label: cfg[i].short });
    }
    // end labels in text ink; a leader in the series colour ties each to its line when they are pushed apart
    if (!narrow) for (const e of spread(ends, 13, 0, h)) {
      g.append("path").attr("d", `M${e.x + 6},${e.y0}L${e.x + 14},${e.y0}L${e.x + 20},${e.y}L${e.x + 24},${e.y}`).attr("fill", "none").attr("stroke", e.col).attr("stroke-width", 1.5);
      g.append("text").attr("class", "lab").attr("x", e.x + 28).attr("y", e.y + 4).text(e.text);
    }
    legend("p2-period-legend", items);
  }

  // ------------------------------------------------------------------ tornado
  function drawTornado() {
    const P = state.P, mode = state.mode, cfg = cfgById();
    const t = (P.tornado || {})[mode];
    const W = widthOf("ch-p2-tornado"), narrow = W < 560;
    const rows = t && t.rows ? t.rows.slice(0, 10) : [];
    const lw = rows.length ? d3.max(rows, (r) => r.label.length) : 0;
    // on phones the parameter names go above their bars
    const m = narrow ? { l: 6, r: 16, t: 24, b: 40 } : { l: Math.min(220, 14 + 7.3 * lw), r: 20, t: 24, b: 40 };
    const H = narrow ? 64 + rows.length * 38 : 376;
    const { g, w, h } = svgFrame("ch-p2-tornado", W, H, m);
    const cap = document.getElementById("p2-tornado-cap");
    if (!rows.length) { if (cap) cap.textContent = "No cost swings for this staffing case."; return; }
    const c0 = rows[0].central_cost_per_hour_saved;
    const lo = d3.min(rows, (r) => Math.min(r.low.cost_per_hour_saved, r.high.cost_per_hour_saved));
    const hi = d3.max(rows, (r) => Math.max(r.low.cost_per_hour_saved, r.high.cost_per_hour_saved));
    const x = d3.scaleLinear().domain([Math.min(lo, c0) * 0.95, Math.max(hi, c0) * 1.03]).range([0, w]).nice();
    const yb = d3.scaleBand().domain(rows.map((r) => r.param_id)).range([0, h]).padding(narrow ? 0.15 : 0.3);
    const bh = Math.min(narrow ? 12 : 18, yb.bandwidth());
    g.append("g").attr("class", "grid").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(5).tickSize(-h).tickFormat(""));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(5).tickFormat((v) => `${v}`));
    g.append("text").attr("class", "lab").attr("x", w).attr("y", h + 34).attr("text-anchor", "end").text("SGD per passenger-hour saved");
    g.append("line").attr("x1", x(c0)).attr("x2", x(c0)).attr("y1", -6).attr("y2", h).attr("stroke", COL.chalk).attr("stroke-width", 1.5);
    for (const r of rows) {
      const a = Math.min(r.low.cost_per_hour_saved, r.high.cost_per_hour_saved), b = Math.max(r.low.cost_per_hour_saved, r.high.cost_per_hour_saved);
      const cy = yb(r.param_id) + yb.bandwidth() - bh - (narrow ? 2 : (yb.bandwidth() - bh) / 2);
      g.append("rect").attr("x", x(a)).attr("y", cy).attr("width", Math.max(1, x(b) - x(a))).attr("height", bh).attr("rx", 4).attr("fill", COL.C).attr("fill-opacity", 0.8)
        .on("mousemove", (evt) => showTip(evt, `<b>${r.label}</b><br>low-cost ${r.low.text}: ${sgd(r.low.cost_per_hour_saved, 1)}/h<br>central ${r.central_text}: ${sgd(r.central_cost_per_hour_saved, 1)}/h<br>high-cost ${r.high.text}: ${sgd(r.high.cost_per_hour_saved, 1)}/h${r.direction_ok ? "" : "<br><span class=\"mute\">acts both ways: its low-cost value does not lower cost here</span>"}`))
        .on("mouseleave", hideTip);
      if (narrow) g.append("text").attr("class", "lab").attr("x", 0).attr("y", cy - 5).text(r.label);
      else g.append("text").attr("class", "lab").attr("x", -8).attr("y", cy + bh / 2 + 4).attr("text-anchor", "end").text(r.label);
    }
    g.append("text").attr("class", "lab callout").attr("x", x(c0)).attr("y", -11).attr("text-anchor", "middle").text(`central ${sgd(c0, 1)}`);
    if (cap) cap.textContent = `Cost per passenger-hour saved when one cost parameter at a time moves to its low-cost or high-cost value (the others central), for C with ${cfg[t.id] ? cfg[t.id].phrase : t.id}, ${((P.staff_modes || {})[mode] || {}).short || mode}. The ten widest swings are shown.`;
  }

  // ------------------------------------------------------------------ tables
  function stressTable() {
    const P = state.P, cfg = cfgById();
    const ids = refIds(), extra = [...new Set((P.stress || []).map((r) => r.id))].filter((i) => !ids.includes(i));
    if (extra.length) ids.splice(1, 0, ...extra);
    const tbl = d3.select("#p2-stress");
    tbl.select("thead tr").html("<th>Condition</th>" + ids.map((i) => `<th class="cfg">${cfg[i] ? cfg[i].short : i}</th>`).join(""));
    const base = { stress: "Base case", cells: Object.fromEntries(ids.map((i) => [i, cfg[i] ? { saved_h: cfg[i].saved_h, declined: cfg[i].n_declined, refused: cfg[i].n_refused } : null])) };
    const by = d3.group(P.stress || [], (r) => r.stress);
    const order = [...(P.stress_labels || []).filter((k) => by.has(k)), ...[...by.keys()].filter((k) => !(P.stress_labels || []).includes(k))];
    const rows = [base, ...order.map((k) => ({ stress: k, cells: Object.fromEntries((by.get(k) || []).map((r) => [r.id, r])) }))];
    const cell = (r) => {
      if (!r) return "<td class=\"n\">—</td>";
      const lost = (r.declined || 0) + (r.refused || 0);
      const note = r.refused ? `${fmt(r.refused)} refused` : r.declined ? `${fmt(r.declined)} declined` : "";
      return `<td class="n">${fmt(r.saved_h)}${lost ? `<br><span class="mute small">${note}</span>` : ""}</td>`;
    };
    tbl.select("tbody").html(rows.map((r) => `<tr><td>${r.stress}</td>${ids.map((i) => cell(r.cells[i])).join("")}</tr>`).join(""));
  }

  function budgetTable() {
    const P = state.P, cfg = cfgById();
    const rows = (P.budgets[state.mode] || []).filter((r) => r.central);
    const html = rows.length ? rows.map((r) => {
      const b = r.central, c = cfg[b.id];
      return `<tr><td class="n" style="text-align:left">${sgd(r.budget)}</td><td>${c ? c.label : b.id}</td><td class="n">${fmt(b.saved_h)}</td><td class="n">${sgd(b.cost_per_hour_saved, 1)}</td></tr>`;
    }).join("") : `<tr><td colspan="4">No configuration with acceptable service fits these budgets in this staffing case.</td></tr>`;
    d3.select("#p2-budget tbody").html(html);
  }

  // ------------------------------------------------------------------ modes and numbers
  function setMode(m) {
    state.mode = m;
    d3.selectAll("#p2-modes button").attr("aria-pressed", function () { return this.dataset.mode === m ? "true" : "false"; });
    const lab = ((state.P.staff_modes || {})[m] || {}).label || m;
    document.getElementById("p2-modenote").textContent = `Costs below: ${lab}. Passenger time does not depend on staffing.`;
    for (const f of [drawTrade, drawCost, drawTornado, budgetTable]) { try { f(); } catch (e) { console.error("phase2", f.name, e); } }
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
    let rz = null, lastW = window.innerWidth;
    window.addEventListener("resize", () => {
      clearTimeout(rz);
      rz = setTimeout(() => { if (window.innerWidth !== lastW) { lastW = window.innerWidth; drawAll(); } }, 200);
    });
    root.dataset.ready = "1";
  }
  init();
})();
