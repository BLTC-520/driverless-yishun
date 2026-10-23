/* Driverless Yishun, evidence page: the scorecard tally, the charts behind the checks and the
   provenance of both parts. Reads the same data files as the study page (results.json,
   calibration_points.json, phase2.json); nothing is computed here but positions and counts. */
(function () {
  "use strict";
  if (typeof d3 === "undefined") return;
  const css = getComputedStyle(document.documentElement);
  const tok = (n) => css.getPropertyValue(n).trim();
  const fmt = d3.format(",.0f");
  const tip = document.getElementById("tip");
  const D = {};

  function showTip(evt, html) {
    tip.innerHTML = html; tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
    if (y + h > innerHeight - 8) y = evt.clientY - h - pad;
    tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${Math.max(8, y)}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  // charts are drawn at the container's real pixel width, so labels keep their size on phones
  function frame(id, H, max = 900) {
    const svg = d3.select(`#${id}`); svg.selectAll("*").remove();
    const W = Math.max(300, Math.min(max, Math.round(svg.node().parentNode.getBoundingClientRect().width || 600)));
    svg.attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
    return { svg, W, H };
  }
  const pad2 = (h) => String(h).padStart(2, "0");

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
  function drawCal() {
    const P = D.calpts; if (!P || !P.points) return;
    const { svg, W, H } = frame("ev-cal", 320, 620);
    const m = { t: 16, r: 16, b: 40, l: 44 };
    const mx = Math.ceil(d3.max(P.points, (p) => Math.max(p[0], p[1])) / 60);
    const x = d3.scaleLinear().domain([0, mx]).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([0, mx]).range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("line").attr("x1", x(0)).attr("y1", y(0)).attr("x2", x(mx)).attr("y2", y(mx)).attr("stroke", tok("--mute")).attr("stroke-dasharray", "3 4");
    svg.append("g").selectAll("circle").data(P.points).join("circle")
      .attr("cx", (p) => x(p[0] / 60)).attr("cy", (p) => y(p[1] / 60)).attr("r", (p) => Math.min(4, 1 + Math.sqrt(p[2]) / 6))
      .attr("fill", tok("--bus")).attr("opacity", 0.45);
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(6));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6));
    svg.append("text").attr("class", "lab").attr("x", W - m.r).attr("y", H - 6).attr("text-anchor", "end").text("observed median running time (min)");
    svg.append("text").attr("class", "lab").attr("x", m.l + 6).attr("y", m.t + 4).text("modelled (min)");
  }

  // ------------------------------------------------------------------ GPS check by hour
  function drawGps() {
    const G = D.results.gps_check; if (!G || !G.by_hour) return;
    const rows = Object.entries(G.by_hour).map(([h, b]) => ({ h: +h, ...b })).filter((r) => r.n_pairs >= 20).sort((a, b) => a.h - b.h);
    if (!rows.length) return;
    const { svg, W, H } = frame("ev-gps", 320, 620);
    const m = { t: 30, r: 16, b: 34, l: 44 };
    const hrs = d3.range(10, 20);
    const x = d3.scaleBand().domain(hrs).range([m.l, W - m.r]).padding(0.3);
    const lo = Math.min(0.8, d3.min(rows, (r) => r.pooled_ratio_ci[0])), hi = Math.max(1.2, d3.max(rows, (r) => r.pooled_ratio_ci[1]));
    const y = d3.scaleLinear().domain([lo, hi]).nice().range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("rect").attr("x", x(10) - 4).attr("width", x(12) + x.bandwidth() - x(10) + 8).attr("y", m.t).attr("height", H - m.b - m.t)
      .attr("fill", tok("--bus")).attr("opacity", 0.07);
    svg.append("text").attr("class", "lab").attr("x", x(10)).attr("y", m.t + 12).text("fitted here");
    svg.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(1)).attr("y2", y(1)).attr("stroke", tok("--mute")).attr("stroke-dasharray", "3 4");
    const g = svg.append("g").selectAll("g").data(rows).join("g").attr("transform", (r) => `translate(${x(r.h) + x.bandwidth() / 2},0)`);
    g.append("line").attr("y1", (r) => y(r.pooled_ratio_ci[0])).attr("y2", (r) => y(r.pooled_ratio_ci[1])).attr("stroke", tok("--bus")).attr("stroke-width", 2);
    g.append("circle").attr("cy", (r) => y(r.pooled_ratio)).attr("r", 5).attr("fill", tok("--bus")).attr("stroke", tok("--bg-2")).attr("stroke-width", 2);
    g.append("rect").attr("x", -14).attr("width", 28).attr("y", m.t).attr("height", H - m.b - m.t).attr("fill", "transparent")
      .on("mousemove", (evt, r) => showTip(evt, `<b>${pad2(r.h)}:00</b><br>observed ÷ model ${r.pooled_ratio.toFixed(2)}<br><span class="mute">95 % interval ${r.pooled_ratio_ci[0].toFixed(2)}–${r.pooled_ratio_ci[1].toFixed(2)} · ${fmt(r.n_pairs)} pairs</span>`))
      .on("mouseleave", hideTip);
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickValues(W < 500 ? hrs.filter((h) => h % 2 === 0) : hrs).tickFormat((h) => `${pad2(h)}:00`));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(".2f")));
    svg.append("text").attr("class", "lab").attr("x", 4).attr("y", 12).text("observed ÷ model");
  }

  // ------------------------------------------------------------------ Part 1 sensitivity
  // one row per alternative assumption: a dot at its fleet, a line from the base case, the side it favours in words
  function drawSens() {
    const S = D.results.sensitivity; if (!S || !S.length) return;
    const base = S.find((r) => r.id === "base"), b0 = base ? base.parity_fleet : null;
    const rows = S.filter((r) => r.id !== "base").map((r) => ({ ...r, d: r.parity_fleet == null ? Infinity : r.parity_fleet - b0 }))
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d) || a.label.localeCompare(b.label));
    const short = (s) => s.split(/[:(]/)[0].trim();
    const narrow = (document.getElementById("ev-sens").parentNode.getBoundingClientRect().width || 600) < 640;
    const rowH = narrow ? 44 : 26;
    const m = narrow ? { t: 26, r: 46, b: 40, l: 8 } : { t: 26, r: 46, b: 40, l: 330 };
    const { svg, W, H } = frame("ev-sens", m.t + m.b + rowH * rows.length);
    const known = rows.map((r) => r.parity_fleet).filter((v) => v != null).concat(b0);
    const x = d3.scaleLinear().domain([d3.min(known) - 25, d3.max(known) + 25]).range([m.l, W - m.r]);
    const y = d3.scaleBand().domain(rows.map((r) => r.id)).range([m.t, H - m.b]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(6).tickSize(-(H - m.b - m.t)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(6));
    svg.append("text").attr("class", "lab").attr("x", W - m.r).attr("y", H - 6).attr("text-anchor", "end").text("10-seat shuttles needed all day");
    if (b0 != null) {
      svg.append("line").attr("x1", x(b0)).attr("x2", x(b0)).attr("y1", m.t - 8).attr("y2", H - m.b).attr("stroke", tok("--fg")).attr("stroke-width", 1.5);
      svg.append("text").attr("class", "lab callout").attr("x", x(b0)).attr("y", m.t - 12).attr("text-anchor", "middle").text(`base ${b0}`);
    }
    const fav = { 1: "favours the bus", "-1": "favours the shuttle", 0: "favours either" };
    for (const r of rows) {
      const cy = y(r.id) + (narrow ? rowH - 12 : rowH / 2), v = r.parity_fleet;
      const col = tok("--sodium");   // one series: position, not colour, says more or fewer
      if (v != null && v !== b0) svg.append("line").attr("x1", x(b0)).attr("x2", x(v)).attr("y1", cy).attr("y2", cy).attr("stroke", col).attr("stroke-width", 2);
      svg.append("circle").attr("cx", x(v ?? x.domain()[1])).attr("cy", cy).attr("r", 5).attr("fill", col).attr("stroke", tok("--bg")).attr("stroke-width", 2);
      const lab = short(r.label);
      if (narrow) svg.append("text").attr("class", "lab").attr("x", m.l).attr("y", cy - 11).text(lab.length > 46 ? lab.slice(0, 44) + "…" : lab);
      else svg.append("text").attr("class", "lab").attr("x", m.l - 12).attr("y", cy + 4).attr("text-anchor", "end").text(lab.length > 48 ? lab.slice(0, 46) + "…" : lab);
      svg.append("text").attr("class", "lab").attr("x", x(v ?? x.domain()[1]) + (v == null || v >= b0 ? 10 : -10)).attr("y", cy + 4)
        .attr("text-anchor", v == null || v >= b0 ? "start" : "end").text(v == null ? "> 800" : fmt(v));
      svg.append("rect").attr("x", 0).attr("width", W).attr("y", y(r.id)).attr("height", rowH).attr("fill", "transparent")
        .on("mousemove", (evt) => showTip(evt, `<b>${r.label}</b><br>${v == null ? "more than 800" : fmt(v)} shuttles (base ${b0}) · ${fav[String(r.direction ?? 0)] || ""}${r.bus_day_min != null ? `<br><span class="mute">bus, day mean ${r.bus_day_min.toFixed(1)} min</span>` : ""}`))
        .on("mouseleave", hideTip);
    }
    const ex = D.results.sensitivity_excluded || [];
    const cap = document.getElementById("ev-sens-cap");
    cap.textContent = `Right of the line: more shuttles than the base case; left: fewer. Hover a row for the full assumption, the side it was chosen to favour and the bus's mean time under it.` +
      (ex.length ? ` Not shown: ${ex.map((r) => `${r.name} (${r.parity_fleet ?? "n/a"} vehicles), because ${r.reason}`).join("; ")}.` : "");
  }

  // ------------------------------------------------------------------ Part 2 cost swings, all staffing cases on one axis
  function drawTornado() {
    const P = D.phase2; if (!P || !P.tornado) return;
    const modes = P.modes.filter((m) => (P.tornado[m] || {}).rows && P.tornado[m].rows.length);
    if (!modes.length) return;
    const cfg = Object.fromEntries(P.configs.map((c) => [c.id, c]));
    const narrow = (document.getElementById("ev-tornado").parentNode.getBoundingClientRect().width || 600) < 640;
    const per = 8, rowH = narrow ? 34 : 22, headH = 34;
    const m = narrow ? { t: 8, r: 16, b: 40, l: 8 } : { t: 8, r: 24, b: 40, l: 230 };
    const blocks = modes.map((md) => ({ md, rows: P.tornado[md].rows.slice(0, per), c0: P.tornado[md].rows[0].central_cost_per_hour_saved }));
    const H = m.t + m.b + blocks.reduce((s, b) => s + headH + rowH * b.rows.length, 0);
    const { svg, W } = frame("ev-tornado", H);
    const pct = (v, c0) => 100 * (v / c0 - 1);
    const span = d3.max(blocks, (b) => d3.max(b.rows, (r) => Math.max(Math.abs(pct(r.low.cost_per_hour_saved, b.c0)), Math.abs(pct(r.high.cost_per_hour_saved, b.c0)))));
    const x = d3.scaleLinear().domain([-span * 1.08, span * 1.08]).range([m.l, W - m.r]).nice();
    svg.append("g").attr("class", "grid").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(narrow ? 5 : 8).tickSize(-(H - m.b - m.t)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(narrow ? 5 : 8).tickFormat((v) => (v ? `${v > 0 ? "+" : ""}${v}%` : "0")));
    svg.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", tok("--fg")).attr("stroke-width", 1.5);
    svg.append("text").attr("class", "lab").attr("x", W - m.r).attr("y", H - 6).attr("text-anchor", "end").text("change in cost per passenger-hour saved");
    let top = m.t;
    for (const b of blocks) {
      const name = ((P.staff_modes || {})[b.md] || {}).short || b.md;
      svg.append("text").attr("class", "callout").attr("x", narrow ? m.l : 0).attr("y", top + 22)
        .text(`${name}: central SGD ${b.c0.toFixed(1)} per hour saved`);
      top += headH;
      for (const r of b.rows) {
        const lo = pct(r.low.cost_per_hour_saved, b.c0), hi = pct(r.high.cost_per_hour_saved, b.c0);
        const a = Math.min(lo, hi), z = Math.max(lo, hi), cy = top + (narrow ? rowH - 12 : 4);
        svg.append("rect").attr("x", x(a)).attr("y", cy).attr("width", Math.max(1, x(z) - x(a))).attr("height", 12).attr("rx", 3).attr("fill", tok("--p2-c"));
        if (narrow) svg.append("text").attr("class", "lab").attr("x", m.l).attr("y", cy - 5).text(r.label);
        else svg.append("text").attr("class", "lab").attr("x", m.l - 12).attr("y", cy + 10).attr("text-anchor", "end").text(r.label);
        svg.append("rect").attr("x", 0).attr("width", W).attr("y", top).attr("height", rowH).attr("fill", "transparent")
          .on("mousemove", (evt) => showTip(evt, `<b>${r.label}</b> · ${name}<br>low ${r.low.text}: SGD ${r.low.cost_per_hour_saved.toFixed(1)}/h<br>central ${r.central_text}: SGD ${b.c0.toFixed(1)}/h<br>high ${r.high.text}: SGD ${r.high.cost_per_hour_saved.toFixed(1)}/h`))
          .on("mouseleave", hideTip);
        top += rowH;
      }
    }
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
