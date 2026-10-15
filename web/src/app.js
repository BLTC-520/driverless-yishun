/* Driverless Yishun: explorer and charts.
   All data is read from ./data/*.json, exported by the Python pipeline (pipeline/yishun/export_*.py). */
(function () {
  "use strict";

  const CSS = getComputedStyle(document.documentElement);
  const tok = (n) => CSS.getPropertyValue(n).trim();
  const hexRgb = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const C = {
    sodium: hexRgb(tok("--sodium")), sodiumDim: hexRgb(tok("--sodium-dim")), bus: hexRgb(tok("--bus")),
    nsl: hexRgb(tok("--nsl")), rider: hexRgb(tok("--rider")), chalk: hexRgb(tok("--chalk")), mute: hexRgb(tok("--mute")),
  };
  const fmtInt = d3.format(",.0f");
  const pad = (n) => String(n).padStart(2, "0");
  const clockOf = (min) => { const m = Math.floor(min) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = {
    t: 7.5 * 60, playing: false, speed: 120, scenario: null,
    showWait: true, showFlows: false, showAge: false, hover: null,
  };
  const D = {};          // loaded datasets
  const anim = {};       // decoded animation per scenario id
  let deckgl = null;

  // ------------------------------------------------------------------ loading
  async function getJSON(name) {
    const r = await fetch(`data/${name}`);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json();
  }

  function decodePaths(raw) {
    const [lng0, lat0] = raw.origin;
    return raw.paths.map((flat) => {
      const n = flat.length / 3, pts = new Array(n), fr = new Float32Array(n);
      let x = 0, y = 0;
      for (let i = 0; i < n; i++) {
        x += flat[3 * i]; y += flat[3 * i + 1];
        pts[i] = [lng0 + x / 1e5, lat0 + y / 1e5];
        fr[i] = flat[3 * i + 2] / 1000;
      }
      return { pts, fr };
    });
  }

  function decodeLegs(t) {
    const n = t.pid.length, t0 = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += t.t0[i]; t0[i] = acc; }
    return { n, pid: t.pid, t0, dur: t.dur, cut: t.cut, veh: t.veh, occ: t.occ, maxDur: Math.max(...t.dur.slice(0, 50000), 1800) };
  }

  function decodeWaiting(w) {
    const out = {};
    for (const [code, b64] of Object.entries(w || {})) {
      const bin = atob(b64), a = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      out[code] = a;
    }
    return out;
  }

  async function loadScenario(id) {
    if (anim[id]) return anim[id];
    const raw = await getJSON(`anim_${id}.json`);
    anim[id] = { legs: decodeLegs(raw.legs), waiting: decodeWaiting(raw.waiting), kind: raw.kind, summary: raw.summary };
    return anim[id];
  }

  // ------------------------------------------------------------------ geometry helpers
  function posAt(path, f) {
    const { pts, fr } = path;
    if (f <= 0) return pts[0];
    if (f >= 1) return pts[pts.length - 1];
    let lo = 0, hi = fr.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fr[mid] <= f) lo = mid; else hi = mid; }
    const span = fr[hi] - fr[lo] || 1, u = (f - fr[lo]) / span;
    return [pts[lo][0] + u * (pts[hi][0] - pts[lo][0]), pts[lo][1] + u * (pts[hi][1] - pts[lo][1])];
  }

  // first leg index with t0 >= time (legs sorted by t0)
  function lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }

  const TRAIL = 150;     // seconds of trail behind each vehicle
  const BASE = 5 * 3600; // timestamps are stored relative to 05:00 for float precision
  let tripCache = { id: null, from: -1, to: -1, trips: [] };

  function legEnd(L, i) { return L.t0[i] + (L.cut[i] > 0 ? L.cut[i] : L.dur[i]); }

  function buildTrips(id, tSec) {
    const A = anim[id]; const L = A.legs; const P = D.paths;
    const from = tSec - 600, to = tSec + 1800;
    const i0 = lowerBound(L.t0, from - L.maxDur), i1 = lowerBound(L.t0, to);
    const trips = [];
    for (let i = i0; i < i1; i++) {
      const end = legEnd(L, i);
      if (end < from) continue;
      const path = P[L.pid[i]]; const dur = L.dur[i] || 1;
      const cutF = L.cut[i] > 0 ? L.cut[i] / dur : 1;
      const pts = [], ts = [];
      for (let k = 0; k < path.pts.length; k++) {
        if (path.fr[k] > cutF) { pts.push(posAt(path, cutF)); ts.push(L.t0[i] - BASE + cutF * dur); break; }
        pts.push(path.pts[k]); ts.push(L.t0[i] - BASE + path.fr[k] * dur);
      }
      if (pts.length < 2) continue;
      trips.push({ path: pts, timestamps: ts, occ: L.occ[i], veh: L.veh[i] });
    }
    tripCache = { id, from, to, trips };
  }

  function activeVehicles(id, tSec) {
    const A = anim[id]; const L = A.legs; const P = D.paths;
    const i0 = lowerBound(L.t0, tSec - L.maxDur), i1 = lowerBound(L.t0, tSec + 1e-6);
    const heads = [], seen = new Set();
    for (let i = i0; i < i1; i++) {
      const end = legEnd(L, i);
      if (end <= tSec) continue;
      const f = (tSec - L.t0[i]) / (L.dur[i] || 1);
      heads.push({ p: posAt(P[L.pid[i]], f), occ: L.occ[i] });
      seen.add(L.veh[i]);
    }
    return { heads, vehicles: seen.size };
  }

  // ------------------------------------------------------------------ map layers
  function vehColor(occ, alpha) {
    if (occ === -2) return [...C.bus, alpha];
    if (occ <= 0) return [...C.sodiumDim, Math.round(alpha * 0.8)];
    return [...C.sodium, alpha];
  }

  function hdbColor(b) {
    if (b.k !== "hdb") return [58, 64, 76];
    const y = Math.max(1975, Math.min(2025, b.y || 1985));
    const u = (y - 1975) / 50; // old blocks warm concrete, newer cooler
    return [Math.round(150 - 28 * u), Math.round(144 - 10 * u), Math.round(134 + 14 * u)];
  }

  function stopsPos() {
    if (!D._stopIndex) {
      D._stopIndex = {};
      for (const s of D.stops.stops) D._stopIndex[s.c] = s;
    }
    return D._stopIndex;
  }

  function layers() {
    const tSec = state.t * 60;
    const hourIdx = Math.max(0, Math.min(D.stops.hours.length - 1, Math.floor(state.t / 60) - 5));
    const L = [];
    L.push(new deck.SolidPolygonLayer({ id: "water", data: D.town.water, getPolygon: (d) => d, getFillColor: [18, 38, 58], pickable: false }));
    L.push(new deck.SolidPolygonLayer({ id: "green", data: D.town.green, getPolygon: (d) => d, getFillColor: [22, 36, 32], pickable: false }));
    L.push(new deck.SolidPolygonLayer({ id: "roads", data: D.town.roads, getPolygon: (d) => d, getFillColor: [34, 42, 58], pickable: false }));
    if (state.showAge) {
      const ext = d3.extent(D.town.subzones, (s) => s.share65 || 0);
      L.push(new deck.SolidPolygonLayer({
        id: "age", data: D.town.subzones.flatMap((s) => s.rings.map((r) => ({ r, s }))), getPolygon: (d) => d.r,
        getFillColor: (d) => { const u = ((d.s.share65 || 0) - ext[0]) / (ext[1] - ext[0] || 1); return [120 + 110 * u, 70 + 40 * u, 160 - 60 * u, 70 + 90 * u]; },
        pickable: true, updateTriggers: { getFillColor: ext },
      }));
    }
    L.push(new deck.PathLayer({ id: "boundary", data: D.town.boundary, getPath: (d) => d, getColor: [143, 153, 171, 110], widthMinPixels: 1.2, pickable: false }));
    L.push(new deck.PathLayer({ id: "rail", data: D.town.rail, getPath: (d) => d, getColor: [...C.nsl, 200], widthMinPixels: 2, pickable: false }));
    L.push(new deck.SolidPolygonLayer({
      id: "buildings", data: D.buildings.buildings, getPolygon: (d) => d.p, extruded: true, getElevation: (d) => d.h,
      getFillColor: hdbColor, opacity: 0.9, pickable: true, material: { ambient: 0.35, diffuse: 0.6, shininess: 12, specularColor: [40, 40, 40] },
    }));
    const sc = state.scenario && anim[state.scenario.id];
    const stopIdx = stopsPos();
    if (state.showWait && sc) {
      const minute = Math.floor(state.t) - 300;
      const data = [];
      if (sc.kind === "shuttle") {
        for (const s of D.stops.stops) { const a = sc.waiting[s.c]; const w = a && minute >= 0 && minute < a.length ? a[minute] : 0; if (w > 0) data.push({ s, w }); }
      } else {
        // expected riders waiting under the bus model: arrival rate x mean bus wait (Little's law)
        const busWait = D.baseline.wait_min[hourIdx] || 3.5;
        for (const s of D.stops.stops) { const w = (s.o[hourIdx] / 60) * busWait; if (w > 0.2) data.push({ s, w }); }
      }
      L.push(new deck.ColumnLayer({
        id: "waiting", data, getPosition: (d) => [d.s.x, d.s.y], getElevation: (d) => d.w, elevationScale: 9, radius: 22,
        diskResolution: 12, extruded: true, getFillColor: [...C.rider, 220], pickable: true,
        updateTriggers: { getElevation: [state.t, state.scenario && state.scenario.id] },
      }));
    }
    L.push(new deck.ScatterplotLayer({
      id: "stops", data: D.stops.stops, getPosition: (d) => [d.x, d.y], getRadius: (d) => (d.hub ? 22 : 10), radiusMinPixels: 1.5,
      getFillColor: (d) => (d.hub ? [...C.nsl, 230] : [200, 205, 215, 150]), pickable: true,
    }));
    if (state.showFlows) {
      const flows = D.demand.top_flows[hourIdx] || [];
      L.push(new deck.ArcLayer({
        id: "flows", data: flows.filter((f) => stopIdx[f[0]] && stopIdx[f[1]]),
        getSourcePosition: (f) => [stopIdx[f[0]].x, stopIdx[f[0]].y], getTargetPosition: (f) => [stopIdx[f[1]].x, stopIdx[f[1]].y],
        getWidth: (f) => Math.max(0.6, f[2] / 25), getHeight: 0.6, getSourceColor: [...C.rider, 60], getTargetColor: [...C.rider, 220], greatCircle: false,
      }));
    }
    if (sc) {
      if (tripCache.id !== state.scenario.id || tSec < tripCache.from + 300 || tSec > tripCache.to - 300) buildTrips(state.scenario.id, tSec);
      L.push(new deck.TripsLayer({
        id: "trails", data: tripCache.trips, getPath: (d) => d.path, getTimestamps: (d) => d.timestamps,
        getColor: (d) => vehColor(d.occ, 210), widthMinPixels: 2.2, trailLength: TRAIL, currentTime: tSec - BASE,
        fadeTrail: true, capRounded: true, jointRounded: true, updateTriggers: { getColor: state.scenario.id },
      }));
      const act = activeVehicles(state.scenario.id, tSec);
      state._active = act.vehicles;
      L.push(new deck.ScatterplotLayer({
        id: "heads", data: act.heads, getPosition: (d) => d.p, getRadius: 9, radiusMinPixels: 1.6, radiusMaxPixels: 4,
        getFillColor: (d) => vehColor(d.occ, 255),
      }));
    }
    return L;
  }

  function redraw() { if (deckgl) deckgl.setProps({ layers: layers() }); updateHud(); }

  // ------------------------------------------------------------------ HUD
  function hourResult(sc, hour) {
    const R = D.results; if (!R || !sc || sc.kind !== "shuttle") return null;
    const curve = (R.curves[String(sc.capacity)] || []).find((c) => c.fleet === sc.fleet);
    const i = R.hours.indexOf(hour);
    return curve && i >= 0 ? curve.byHour.m[i] : null;
  }

  function updateHud() {
    const sc = state.scenario; if (!sc) return;
    const minute = Math.floor(state.t);
    document.getElementById("clock").textContent = clockOf(minute);
    document.getElementById("time").value = String(minute);
    const hour = Math.floor(minute / 60);
    const hi = D.stops.hours.indexOf(hour);
    const busMin = hi >= 0 ? D.baseline.total_min[hi] : null;
    document.getElementById("r-rides").textContent = hi >= 0 ? fmtInt(D.demand.rides_by_hour[hi]) : "—";
    document.getElementById("r-veh").innerHTML = state._active != null ? `<span class="${sc.kind === "bus" ? "bu" : "sh"}">${fmtInt(state._active)}</span>` : "—";
    const A = anim[sc.id];
    let waiting = "—";
    if (A && A.kind === "shuttle") {
      let s = 0; const m = minute - 300;
      for (const k in A.waiting) { const a = A.waiting[k]; if (m >= 0 && m < a.length) s += a[m]; }
      waiting = fmtInt(s);
    } else if (A) { waiting = "n/a"; }
    document.getElementById("r-wait").textContent = waiting;
    const pill = document.getElementById("status");
    if (sc.kind === "bus") {
      document.getElementById("r-d2d").innerHTML = busMin != null ? `<span class="bu">${busMin.toFixed(1)} min</span>` : "—";
      pill.className = "pill bus"; pill.textContent = "today's buses";
    } else {
      const sh = hourResult(sc, hour);
      document.getElementById("r-d2d").innerHTML = sh != null && busMin != null
        ? `<span class="sh">${sh.toFixed(1)}</span> vs <span class="bu">${busMin.toFixed(1)}</span> min` : "—";
      const ok = sh != null && busMin != null && sh <= busMin;
      pill.className = `pill ${ok ? "ok" : "behind"}`; pill.textContent = sh == null ? "—" : ok ? "keeping up" : "falling behind";
    }
  }

  function setLegend() {
    const sc = state.scenario;
    const el = document.getElementById("legend");
    const items = sc.kind === "bus"
      ? [["--bus", "bus (modelled)"], ["--rider", "riders waiting (expected)"], ["--nsl", "MRT / interchange stop"]]
      : [["--sodium", "shuttle with riders"], ["--sodium-dim", "empty shuttle"], ["--rider", "riders waiting"], ["--nsl", "MRT / interchange stop"]];
    el.innerHTML = items.map(([v, l]) => `<span><i style="background:var(${v})"></i>${l}</span>`).join("");
  }

  async function selectScenario(sc) {
    state.scenario = sc;
    for (const b of document.querySelectorAll("#scenarios button")) b.setAttribute("aria-pressed", String(b.dataset.id === sc.id));
    setLegend();
    document.getElementById("loading").hidden = false;
    document.getElementById("loading").textContent = `Loading ${sc.label}…`;
    await loadScenario(sc.id);
    document.getElementById("loading").hidden = true;
    tripCache.id = null;
    redraw();
  }

  // ------------------------------------------------------------------ playback
  let last = null;
  function tick(ts) {
    if (state.playing) {
      if (last != null) {
        state.t += ((ts - last) / 1000) * state.speed / 60;
        if (state.t >= 1559) state.t = 300;
      }
      last = ts;
      redraw();
    } else last = null;
    requestAnimationFrame(tick);
  }

  function setPlaying(p) {
    state.playing = p;
    const b = document.getElementById("play");
    b.textContent = p ? "❚❚" : "▶"; b.setAttribute("aria-label", p ? "Pause" : "Play");
  }

  function flyTo(view) {
    if (!deckgl) return;
    deckgl.setProps({ initialViewState: { ...view, transitionDuration: reduceMotion ? 0 : 1800, transitionInterpolator: new deck.FlyToInterpolator() } });
  }

  const HOME = { longitude: 103.8352, latitude: 1.4215, zoom: 13.35, pitch: 52, bearing: -22 };

  function show(what) {
    const R = D.results;
    const byId = (id) => D.anim_index.scenarios.find((s) => s.id === id);
    document.getElementById("explore").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    if (what === "flows") {
      state.t = 7.5 * 60; state.showFlows = true; document.getElementById("t-flows").checked = true;
      selectScenario(byId("bus") || D.anim_index.scenarios[0]); flyTo(HOME);
    } else if (what === "cliff") {
      state.t = 6.75 * 60; setPlaying(true);
      selectScenario(byId(R.anim.undersized) || D.anim_index.scenarios[1]); flyTo(HOME);
    } else if (what === "kerb") {
      state.t = 7.75 * 60; selectScenario(byId(R.anim.reference) || D.anim_index.scenarios[1]);
      flyTo({ longitude: 103.8355, latitude: 1.4295, zoom: 16.4, pitch: 58, bearing: -35 });
    }
  }

  // ------------------------------------------------------------------ tooltip
  function onHover(info) {
    const tip = document.getElementById("tip");
    const o = info && info.object;
    if (!o) { tip.hidden = true; return; }
    let html = null;
    if (info.layer.id === "buildings") {
      html = o.k === "hdb"
        ? `HDB Blk ${o.b}<br>${o.f} storeys · completed ${o.y}<br>${o.u ? fmtInt(o.u) + " flats" : "non-residential"}`
        : `Building (OpenStreetMap)<br>height ${o.s === "default" ? "not mapped, shown as context" : "≈ " + Math.round(o.h) + " m"}`;
    } else if (info.layer.id === "stops") {
      const hi = Math.max(0, Math.floor(state.t / 60) - 5);
      html = `${o.c} · ${o.n}<br>${o.sz || ""}<br>rides starting here, ${clockOf(Math.floor(state.t / 60) * 60)}h: ${fmtInt(o.o[hi] || 0)}`;
    } else if (info.layer.id === "waiting") {
      html = `${o.s.c} · ${o.s.n}<br>${state.scenario.kind === "shuttle" ? fmtInt(o.w) + " riders waiting (simulated)" : "≈ " + o.w.toFixed(1) + " riders waiting (arrival rate × mean bus wait)"}`;
    } else if (info.layer.id === "age") {
      html = `${o.s.name}<br>${fmtInt(o.s.pop2020)} residents (2020)<br>${(100 * o.s.share65).toFixed(1)}% aged 65+`;
    }
    if (!html) { tip.hidden = true; return; }
    tip.innerHTML = html; tip.hidden = false;
    const r = document.getElementById("stage").getBoundingClientRect();
    tip.style.left = `${Math.min(info.x + 14, r.width - 270)}px`; tip.style.top = `${Math.max(8, info.y - 10)}px`;
  }

  // ------------------------------------------------------------------ charts
  function axis(g, ax, cls) { g.attr("class", `axis ${cls || ""}`).call(ax); }

  function chartDemand() {
    const svg = d3.select("#ch-demand"); const W = 640, H = 300, m = { t: 16, r: 12, b: 34, l: 52 };
    const hrs = D.demand.hours, v = D.demand.rides_by_hour;
    const x = d3.scaleBand().domain(hrs).range([m.l, W - m.r]).padding(0.18);
    const y = d3.scaleLinear().domain([0, d3.max(v) * 1.08]).nice().range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("g").selectAll("rect").data(hrs).join("rect").attr("x", (h) => x(h)).attr("width", x.bandwidth())
      .attr("y", (h, i) => y(v[i])).attr("height", (h, i) => y(0) - y(v[i])).attr("fill", tok("--rider")).attr("opacity", 0.82);
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).tickValues(hrs.filter((h) => h % 3 === 0)).tickFormat((h) => pad(h % 24)));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5).tickFormat(d3.format("~s")));
    const pk = d3.maxIndex(v);
    svg.append("text").attr("class", "callout").attr("x", x(hrs[pk]) + x.bandwidth() + 6).attr("y", y(v[pk]) + 10).text(`${fmtInt(v[pk])} rides, ${pad(hrs[pk])}:00–${pad(hrs[pk] + 1)}:00`);
  }

  function chartCliff(mode) {
    const R = D.results; const svg = d3.select("#ch-cliff"); svg.selectAll("*").remove();
    const W = 640, H = 340, m = { t: 16, r: 16, b: 40, l: 52 };
    const caps = R.capacities; const hi = (h) => R.hours.indexOf(h);
    const pick = (c) => (mode === "all" ? c.all : { m: c.byHour.m[hi(mode)], lo: c.byHour.lo[hi(mode)], hi: c.byHour.hi[hi(mode)] });
    const allF = caps.flatMap((k) => R.curves[k].map((c) => c.fleet));
    const x = d3.scaleLinear().domain(d3.extent(allF)).nice().range([m.l, W - m.r]);
    const ymax = 45;
    const y = d3.scaleLinear().domain([0, ymax]).range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(W - m.l - m.r)).tickFormat(""));
    const bus = mode === "all" ? R.bus_day_total_min : R.bus_total_min[hi(mode)];
    svg.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(bus)).attr("y2", y(bus)).attr("stroke", tok("--bus")).attr("stroke-width", 2);
    svg.append("text").attr("class", "callout").attr("x", W - m.r).attr("y", y(bus) - 6).attr("text-anchor", "end").attr("fill", tok("--bus")).text(`bus ${bus.toFixed(1)} min`);
    const dash = { 4: "5 4", 10: null, 20: "1.5 4" };
    for (const k of caps) {
      const pts = R.curves[k].map((c) => ({ f: c.fleet, ...pick(c) })).filter((p) => p.m != null);
      svg.append("path").datum(pts).attr("fill", tok("--sodium")).attr("opacity", k === 10 ? 0.16 : 0.08)
        .attr("d", d3.area().x((p) => x(p.f)).y0((p) => y(Math.min(ymax, p.lo))).y1((p) => y(Math.min(ymax, p.hi))));
      svg.append("path").datum(pts).attr("fill", "none").attr("stroke", tok("--sodium")).attr("stroke-width", k === 10 ? 2.4 : 1.6)
        .attr("stroke-dasharray", dash[k]).attr("d", d3.line().x((p) => x(p.f)).y((p) => y(Math.min(ymax, p.m))));
      svg.append("g").selectAll("circle").data(pts).join("circle").attr("cx", (p) => x(p.f)).attr("cy", (p) => y(Math.min(ymax, p.m)))
        .attr("r", k === 10 ? 3 : 2.2).attr("fill", tok("--sodium"));
      const lastP = pts[pts.length - 1];
      svg.append("text").attr("class", "lab").attr("x", x(lastP.f) + 4).attr("y", y(lastP.m) + (k === 4 ? -6 : k === 20 ? 12 : 3)).text(`${k} seats`);
    }
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).ticks(7));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(6).tickFormat((d) => `${d}`));
    svg.append("text").attr("class", "lab").attr("x", W - m.r).attr("y", H - 6).attr("text-anchor", "end").text("vehicles in the fleet");
    svg.append("text").attr("class", "lab").attr("x", m.l - 44).attr("y", m.t - 4).text("min");
  }

  function chartFrontier() {
    const R = D.results; const svg = d3.select("#ch-frontier"); const W = 640, H = 320, m = { t: 16, r: 16, b: 34, l: 52 };
    const hrs = R.hours.filter((h) => h <= 24);
    const x = d3.scaleLinear().domain([hrs[0], hrs[hrs.length - 1]]).range([m.l, W - m.r]);
    const vals = [...Object.values(R.frontier).flat(), ...D.baseline.feeder_buses_on_road].filter((v) => v != null);
    const y = d3.scaleLinear().domain([0, d3.max(vals) * 1.1]).nice().range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    const line = d3.line().defined((d) => d.v != null).x((d) => x(d.h)).y((d) => y(d.v)).curve(d3.curveStepAfter);
    const fb = hrs.map((h) => ({ h, v: D.baseline.feeder_buses_on_road[D.baseline.hours.indexOf(h)] }));
    svg.append("path").datum(fb).attr("fill", "none").attr("stroke", tok("--bus")).attr("stroke-width", 2.2).attr("d", line);
    const dash = { 4: "5 4", 10: null, 20: "1.5 4" };
    for (const k of R.capacities) {
      const d = hrs.map((h) => ({ h, v: R.frontier[k][R.hours.indexOf(h)] }));
      svg.append("path").datum(d).attr("fill", "none").attr("stroke", tok("--sodium")).attr("stroke-width", k === 10 ? 2.4 : 1.5).attr("stroke-dasharray", dash[k]).attr("d", line);
    }
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).tickValues(hrs.filter((h) => h % 3 === 0)).tickFormat((h) => pad(h % 24)));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5));
    const pk = R.frontier_peak["10"];
    svg.append("text").attr("class", "callout").attr("x", x(pk.hour) + 6).attr("y", y(pk.fleet) - 6).text(`${pk.fleet} shuttles at ${pad(pk.hour)}:00`);
    const fbmax = d3.max(fb, (d) => d.v);
    svg.append("text").attr("class", "callout").attr("fill", tok("--bus")).attr("x", x(hrs[1])).attr("y", y(fbmax) - 6).text(`≈ ${fbmax} feeder buses`);
  }

  function chartKerb() {
    const R = D.results.reference; const svg = d3.select("#ch-kerb"); const W = 640, H = 300, m = { t: 16, r: 90, b: 34, l: 44 };
    const hrs = D.results.hours.filter((h) => h <= 24);
    const x = d3.scaleBand().domain(hrs).range([m.l, W - m.r]).padding(0.15);
    const st = Object.keys(R.kerb);
    const y = d3.scaleLinear().domain([0, d3.max(st.flatMap((s) => R.kerb[s])) * 1.1]).nice().range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    const colors = { Yishun: tok("--sodium"), Khatib: tok("--rider"), Springleaf: tok("--mute") };
    for (const s of st) {
      const d = hrs.map((h) => ({ h, v: R.kerb[s][D.results.hours.indexOf(h)] }));
      svg.append("path").datum(d).attr("fill", "none").attr("stroke", colors[s] || tok("--chalk")).attr("stroke-width", s === "Yishun" ? 2.4 : 1.6)
        .attr("d", d3.line().x((p) => x(p.h) + x.bandwidth() / 2).y((p) => y(p.v || 0)));
      const lp = d[d.length - 1];
      svg.append("text").attr("class", "lab").attr("x", W - m.r + 6).attr("y", y(lp.v || 0) + 4).text(`${s} MRT`);
    }
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).tickValues(hrs.filter((h) => h % 3 === 0)).tickFormat((h) => pad(h % 24)));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5));
  }

  function chartWho() {
    const R = D.results.who; const svg = d3.select("#ch-who"); const W = 640, H = 300, m = { t: 16, r: 16, b: 46, l: 52 };
    const labels = R.bands_m.slice(0, -1).map((b, i) => `${b / 1000}–${R.bands_m[i + 1] / 1000} km`);
    const x0 = d3.scaleBand().domain(labels).range([m.l, W - m.r]).padding(0.22);
    const x1 = d3.scaleBand().domain(["hub", "estate"]).range([0, x0.bandwidth()]).padding(0.08);
    const y = d3.scaleLinear().domain([0, 1]).range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    const col = { hub: tok("--sodium"), estate: tok("--rider") };
    labels.forEach((lab, i) => {
      for (const k of ["hub", "estate"]) {
        const v = R[k][i]; if (v == null) continue;
        svg.append("rect").attr("x", x0(lab) + x1(k)).attr("width", x1.bandwidth()).attr("y", y(v)).attr("height", y(0) - y(v)).attr("fill", col[k]).attr("opacity", 0.85);
      }
    });
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x0));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5).tickFormat(d3.format(".0%")));
    svg.append("text").attr("class", "lab").attr("x", m.l).attr("y", H - 8).text("■ to or from a station").attr("fill", tok("--sodium"));
    svg.append("text").attr("class", "lab").attr("x", m.l + 150).attr("y", H - 8).text("■ within the estates").attr("fill", tok("--rider"));
  }

  function chartCal() {
    const P = D.calpts; const svg = d3.select("#ch-cal"); const W = 640, H = 300, m = { t: 16, r: 16, b: 40, l: 52 };
    const mx = d3.max(P.points, (p) => Math.max(p[0], p[1])) / 60;
    const x = d3.scaleLinear().domain([0, Math.ceil(mx)]).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([0, Math.ceil(mx)]).range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("line").attr("x1", x(0)).attr("y1", y(0)).attr("x2", x(Math.ceil(mx))).attr("y2", y(Math.ceil(mx))).attr("stroke", tok("--mute")).attr("stroke-dasharray", "3 4");
    svg.append("g").selectAll("circle").data(P.points).join("circle").attr("cx", (p) => x(p[0] / 60)).attr("cy", (p) => y(p[1] / 60))
      .attr("r", (p) => Math.min(4, 1 + Math.sqrt(p[2]) / 6)).attr("fill", tok("--bus")).attr("opacity", 0.45);
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).ticks(6));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(6));
    svg.append("text").attr("class", "lab").attr("x", W - m.r).attr("y", H - 6).attr("text-anchor", "end").text("observed median running time (min)");
    svg.append("text").attr("class", "lab").attr("x", m.l + 6).attr("y", m.t + 4).text("modelled (min)");
  }

  // ------------------------------------------------------------------ numbers in text
  function fillNumbers() {
    const R = D.results, B = D.baseline, cal = B.calibration;
    const v = {
      rides: fmtInt(D.demand.rides_per_weekday), pairs: fmtInt(D.demand.od_pairs),
      median: `${(D.demand.straight_line_pct_m["50"] / 1000).toFixed(2)} km`, hubshare: `${Math.round(100 * D.demand.hub_share)}%`,
      frontier: fmtInt(R.frontier_peak["10"].fleet), feeders: fmtInt(d3.max(B.feeder_buses_on_road)),
      vkm: fmtInt(R.reference.veh_km), buskm: fmtInt(B.bus_km_inside_day), feederkm: fmtInt(B.feeder_bus_km_inside_day),
      vkmx: `${(R.reference.veh_km / B.bus_km_inside_day).toFixed(1)}×`,
      kerbmax: fmtInt(d3.max(R.reference.kerb.Yishun)), kerbkhatib: fmtInt(d3.max(R.reference.kerb.Khatib || [0])),
      calobs: fmtInt(cal.n_obs_used), calhours: `${pad(cal.hours_sgt[0])}:00–${pad(cal.hours_sgt[cal.hours_sgt.length - 1] + 1)}:00`,
      sig: cal.sig_s.toFixed(0), dwell: cal.dwell_s.toFixed(0), hubx: cal.hub_extra_s.toFixed(0), kappa: cal.kappa.toFixed(2),
      cliffgap: fmtInt(R.cliff_gap),
    };
    for (const el of document.querySelectorAll("[data-v]")) { const k = el.dataset.v; if (v[k] != null) el.textContent = v[k]; }
    document.getElementById("who-text").textContent = R.who.text;
    document.getElementById("cal-cap").textContent = `Calibration on ${fmtInt(cal.n_segments_used)} stop sequences of one to six stops, ${fmtInt(cal.n_obs_used)} matched observations: correlation ${cal.segment_r.toFixed(2)}, mean absolute error ${Math.round(cal.segment_mae_s)} s. Each dot is the median of one sequence; dashed line is perfect agreement.`;
  }

  // ------------------------------------------------------------------ init
  async function init() {
    try {
      const [town, buildings, stops, demand, baseline, results, idx, paths, calpts] = await Promise.all(
        ["town.json", "buildings.json", "stops.json", "demand.json", "baseline.json", "results.json", "anim_index.json", "paths.json", "calibration_points.json"].map(getJSON));
      Object.assign(D, { town, buildings, stops, demand, baseline, results, anim_index: idx, calpts });
      D.paths = decodePaths(paths);
    } catch (e) {
      document.getElementById("loading").textContent = `Could not load the data (${e.message}). The page needs its data files next to it.`;
      return;
    }
    fillNumbers();
    chartDemand(); chartFrontier(); chartKerb(); chartWho(); chartCal();
    const tabs = document.getElementById("cliff-tabs");
    const modes = [["7", "07:00–08:00"], ["12", "12:00–13:00"], ["18", "18:00–19:00"], ["all", "whole day"]];
    for (const [k, lab] of modes) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = lab; b.dataset.mode = k;
      b.setAttribute("aria-pressed", String(k === "7"));
      b.onclick = () => { for (const x of tabs.children) x.setAttribute("aria-pressed", String(x === b)); chartCliff(k === "all" ? "all" : +k); };
      tabs.appendChild(b);
    }
    chartCliff(7);

    const el = document.getElementById("scenarios");
    for (const sc of D.anim_index.scenarios) {
      const b = document.createElement("button"); b.type = "button"; b.dataset.id = sc.id; b.dataset.kind = sc.kind;
      b.textContent = sc.kind === "bus" ? "Today's buses" : `${sc.fleet} × ${sc.capacity}-seat`;
      b.title = sc.label; b.onclick = () => selectScenario(sc); el.appendChild(b);
    }
    deckgl = new deck.Deck({
      parent: document.getElementById("map"), initialViewState: HOME, controller: { dragRotate: true, touchRotate: true },
      views: new deck.MapView({ repeat: false }), layers: [], onHover,
      effects: [new deck.LightingEffect({
        ambient: new deck.AmbientLight({ color: [255, 255, 255], intensity: 1.0 }),
        moon: new deck.DirectionalLight({ color: [255, 236, 214], intensity: 1.4, direction: [-1.2, -2, -3] }),
      })],
      parameters: { clearColor: [0, 0, 0, 0] },
    });
    const ref = D.anim_index.scenarios.find((s) => s.id === D.results.anim.reference) || D.anim_index.scenarios[0];
    await selectScenario(ref);

    document.getElementById("play").onclick = () => setPlaying(!state.playing);
    document.getElementById("time").oninput = (e) => { state.t = +e.target.value; redraw(); };
    document.getElementById("speed").onchange = (e) => { state.speed = +e.target.value; };
    document.getElementById("t-wait").onchange = (e) => { state.showWait = e.target.checked; redraw(); };
    document.getElementById("t-flows").onchange = (e) => { state.showFlows = e.target.checked; redraw(); };
    document.getElementById("t-age").onchange = (e) => { state.showAge = e.target.checked; redraw(); };
    for (const b of document.querySelectorAll("[data-show]")) b.onclick = () => show(b.dataset.show);
    if (!reduceMotion) setPlaying(true);
    requestAnimationFrame(tick);
  }
  init();
})();
