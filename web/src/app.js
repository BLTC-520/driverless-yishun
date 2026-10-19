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
    ion: hexRgb(tok("--ion")),
  };
  const fmtInt = d3.format(",.0f");
  const pad = (n) => String(n).padStart(2, "0");
  const clockOf = (min) => { const m = Math.floor(min) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = location.hash === "#still"; // no autoplay (thumbnails, screenshots)

  const state = {
    t: 7.5 * 60, playing: false, speed: 120, scenario: null,
    showWait: true, showFlows: false, showAge: false, showSky: true, hover: null,
    view: null,          // last view state, for zoom-dependent model scale
    orbit: false,        // slow attract-mode orbit until the visitor touches the map
    follow: null,        // ride-along camera: { veh, bearing, lost }
  };
  // Vehicle models built in Blender by tools/blender/build_models.py (metres, facing +x).
  const MODELS = { robovan: "models/robovan.glb", robotaxi: "models/robotaxi.glb", bus: "models/bus.glb", skytruck: "models/skytruck.glb" };
  const modelFor = (sc) => (sc.kind === "bus" ? "bus" : sc.capacity <= 4 ? "robotaxi" : "robovan");
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
    let maxDur = 1800;
    for (let i = 0; i < n; i++) if (t.dur[i] > maxDur) maxDur = t.dur[i];
    return { n, pid: t.pid, t0, dur: t.dur, cut: t.cut, veh: t.veh, occ: t.occ, maxDur };
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

  const M_LAT = 111320, M_LNG = 111320 * Math.cos((1.42 * Math.PI) / 180); // metres per degree here

  // position plus heading (degrees counter-clockwise from east) at fraction f along a path
  function poseAt(path, f) {
    const { pts, fr } = path;
    let lo = 0, hi = fr.length - 1;
    const g = Math.max(0, Math.min(1, f));
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fr[mid] <= g) lo = mid; else hi = mid; }
    const span = fr[hi] - fr[lo] || 1, u = Math.max(0, Math.min(1, (g - fr[lo]) / span));
    const a = pts[lo], b = pts[hi];
    const h = (Math.atan2((b[1] - a[1]) * M_LAT, (b[0] - a[0]) * M_LNG) * 180) / Math.PI;
    return { p: [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])], h };
  }

  function pathLength(path) {
    if (path.len == null) {
      let d = 0;
      for (let k = 1; k < path.pts.length; k++) {
        const a = path.pts[k - 1], b = path.pts[k];
        d += Math.hypot((b[0] - a[0]) * M_LNG, (b[1] - a[1]) * M_LAT);
      }
      path.len = d;
    }
    return path.len;
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
      const pose = poseAt(P[L.pid[i]], f);
      heads.push({ p: pose.p, h: pose.h, occ: L.occ[i], veh: L.veh[i] });
      seen.add(L.veh[i]);
    }
    return { heads, vehicles: seen.size };
  }

  // where one vehicle is at tSec: on its current leg, or parked where its last leg ended
  function vehiclePose(id, veh, tSec) {
    const L = anim[id].legs, P = D.paths;
    let best = -1;
    const i1 = lowerBound(L.t0, tSec + 1e-6);
    for (let i = i1 - 1, floor = Math.max(0, i1 - 60000); i >= floor; i--) {
      if (L.veh[i] === veh) { best = i; break; }
    }
    if (best < 0) return null;
    const end = legEnd(L, best), dur = L.dur[best] || 1, path = P[L.pid[best]];
    const moving = end > tSec;
    const f = moving ? (tSec - L.t0[best]) / dur : (L.cut[best] > 0 ? L.cut[best] / dur : 1);
    const pose = poseAt(path, f);
    return { ...pose, occ: L.occ[best], moving, idle: moving ? 0 : tSec - end, kmh: moving ? (pathLength(path) / dur) * 3.6 : 0 };
  }

  // ------------------------------------------------------------------ sky traffic (decorative)
  // Flying trucks on looping routes above the town. Not part of the simulation: they run on
  // the wall clock, so they keep flying while the simulated day is paused.
  const SKY = { flights: [], lap: 90 };
  function buildSky() {
    const [lng0, lat0] = D.anim_index.origin;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 14; k++) {
      const cx = lng0 + (rnd() - 0.5) * 0.026, cy = lat0 + (rnd() - 0.5) * 0.02;
      const a = 500 + rnd() * 1100, b = 300 + rnd() * 700, rot = rnd() * Math.PI, alt = 120 + rnd() * 160;
      const eight = k % 3 === 0, dir = rnd() < 0.5 ? 1 : -1, phase = rnd();
      const pts = [];
      for (let i = 0; i <= 360; i++) {      // three laps: the trail behind the head never runs off the start
        const u = (dir * 2 * Math.PI * i) / 120;
        const x0 = a * Math.sin(u), y0 = eight ? b * Math.sin(2 * u) / 1.6 : b * Math.cos(u);
        const x = x0 * Math.cos(rot) - y0 * Math.sin(rot), y = x0 * Math.sin(rot) + y0 * Math.cos(rot);
        pts.push([cx + x / M_LNG, cy + y / M_LAT, alt + 25 * Math.sin(3 * u)]);
      }
      const off = phase * SKY.lap, ts = pts.map((_, i) => (i / 120) * SKY.lap - off);
      SKY.flights.push({ path: pts, timestamps: ts, phase: off });
    }
  }

  function skyPose(fl, t) {
    // same clock as the trails layer: local time (t mod lap) + lap + phase lies in the 2nd-3rd lap
    const x = (((t % SKY.lap) + SKY.lap + fl.phase) / SKY.lap) * 120, i = Math.min(359, Math.floor(x)), u = x - i;
    const a = fl.path[i], b = fl.path[i + 1];
    const h = (Math.atan2((b[1] - a[1]) * M_LAT, (b[0] - a[0]) * M_LNG) * 180) / Math.PI;
    return { p: [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1]), a[2] + u * (b[2] - a[2])], h };
  }

  const skyMoves = !reduceMotion && !still;  // frozen for reduced motion and screenshots
  const skyClock = () => (skyMoves ? performance.now() / 1000 : 20);

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
    if (!D.town) return [];
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
      // see-through while riding, so blocks between the chase camera and the vehicle don't hide it
      // (and not writing depth, or they would still hide the vehicles drawn after them)
      getFillColor: hdbColor, opacity: state.follow ? 0.42 : 0.9, pickable: !state.follow,
      parameters: state.follow ? { depthWriteEnabled: false } : {}, material: { ambient: 0.35, diffuse: 0.6, shininess: 12, specularColor: [40, 40, 40] },
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
      // flat discs whose AREA is proportional to riders waiting (radius = 12 m x sqrt(riders))
      L.push(new deck.ScatterplotLayer({
        id: "waiting", data, getPosition: (d) => [d.s.x, d.s.y], getRadius: (d) => 12 * Math.sqrt(d.w), radiusUnits: "meters",
        radiusMinPixels: 1, stroked: true, lineWidthMinPixels: 1,
        getFillColor: [...C.rider, state.follow ? 40 : 110], getLineColor: [...C.rider, state.follow ? 120 : 230], pickable: true,
        updateTriggers: { getRadius: [state.t, state.scenario && state.scenario.id], getFillColor: !!state.follow, getLineColor: !!state.follow },
      }));
    }
    L.push(new deck.ScatterplotLayer({
      id: "stops", data: D.stops.stops, getPosition: (d) => [d.x, d.y], getRadius: (d) => (d.hub ? 22 : 10), radiusMinPixels: 1.5,
      radiusMaxPixels: 16, getFillColor: (d) => (d.hub ? [...C.nsl, 230] : [200, 205, 215, 150]), pickable: true,
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
      const v = state.view || HOME, zoom = v.zoom;
      // models only once they are big enough to read (dots at town scale), and only those near
      // the camera: instanced models are not culled, so this keeps phones smooth
      const models = zoom >= (window.innerWidth < 640 ? 15.5 : 15);
      let near = act.heads;
      if (models) {
        const r = 1.6 * Math.max(window.innerWidth, 400) * (156543 * Math.cos((1.42 * Math.PI) / 180)) / 2 ** zoom;
        near = act.heads.filter((d) => Math.hypot((d.p[0] - v.longitude) * M_LNG, (d.p[1] - v.latitude) * M_LAT) < r);
      }
      const fp = state.follow && state.follow.pose;  // a parked vehicle has no moving leg: draw it anyway
      if (fp && !fp.moving) near = near.concat([{ p: fp.p, h: fp.h, occ: fp.occ, veh: state.follow.veh }]);
      L.push(new deck.ScatterplotLayer({
        id: "heads", data: act.heads, getPosition: (d) => d.p, getRadius: 9, radiusMinPixels: 1.6, radiusMaxPixels: 4,
        getFillColor: (d) => vehColor(d.occ, 255), pickable: true, visible: !models,
      }));
      // the vehicles themselves: Blender models heading along their routes, drawn larger than
      // life when zoomed out so they stay legible (sizeScale), true-ish size when riding along
      L.push(new deck.ScenegraphLayer({
        // one layer per model: deck.gl does not swap a loaded scenegraph when its URL changes
        id: `models-${modelFor(state.scenario)}`, data: near, scenegraph: MODELS[modelFor(state.scenario)], visible: models,
        getPosition: (d) => [d.p[0], d.p[1], 0], getOrientation: (d) => [0, d.h, 90],
        getColor: (d) => (d.occ === 0 ? [120, 120, 130, 255] : [255, 255, 255, 255]),
        sizeScale: state.follow ? 1 : Math.max(1.4, Math.min(4, 2 ** (18.5 - zoom))),
        _lighting: "pbr", pickable: true,
      }));
      if (state.follow && state.follow.pose) {  // the "player" marker under the vehicle being ridden
        const pulse = 0.75 + 0.25 * Math.sin(performance.now() / 260);
        L.push(new deck.ScatterplotLayer({
          id: "ride-ring", data: [state.follow.pose], getPosition: (d) => [d.p[0], d.p[1], 0.05], getRadius: 7 * pulse,
          radiusUnits: "meters", stroked: true, filled: true, getFillColor: [...C.sodium, 40], getLineColor: [...C.sodium, 230],
          getLineWidth: 0.5, lineWidthUnits: "meters", updateTriggers: { getRadius: pulse },
        }));
      }
    }
    if (state.showSky && SKY.flights.length) {
      const now = skyClock();
      L.push(new deck.TripsLayer({
        id: "sky-trails", data: SKY.flights, getPath: (d) => d.path, getTimestamps: (d) => d.timestamps,
        getColor: [...C.ion, 210], widthMinPixels: 2.5, trailLength: 10, fadeTrail: true, capRounded: true,
        currentTime: (now % SKY.lap) + SKY.lap,
      }));
      L.push(new deck.ScenegraphLayer({
        id: "sky", data: SKY.flights.map((fl) => skyPose(fl, now)), scenegraph: MODELS.skytruck,
        getPosition: (d) => d.p, getOrientation: (d) => [0, d.h, 90], sizeScale: 4, sizeMinPixels: 4,
        _animations: { "*": { speed: reduceMotion ? 0 : 1 } }, _lighting: "pbr", pickable: true,
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
    document.getElementById("l-veh").textContent = sc.kind === "bus" ? "Buses driving now (modelled)" : `Shuttles driving now (of ${fmtInt(sc.fleet)})`;
    document.getElementById("l-wait").textContent = sc.kind === "bus" ? "Riders waiting (expected)" : "Riders waiting (simulated)";
    document.getElementById("r-veh").innerHTML = state._active != null ? `<span class="${sc.kind === "bus" ? "bu" : "sh"}">${fmtInt(state._active)}</span>` : "—";
    const A = anim[sc.id];
    let waiting = "—";
    if (A && A.kind === "shuttle") {
      let s = 0; const m = minute - 300;
      for (const k in A.waiting) { const a = A.waiting[k]; if (m >= 0 && m < a.length) s += a[m]; }
      waiting = fmtInt(s);
    } else if (A) {
      let s = 0; const hw = D.baseline.wait_min[hi] || 0;
      for (const st of D.stops.stops) s += (st.o[hi] || 0) / 60 * hw;
      waiting = `≈ ${fmtInt(s)}`;
    }
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
      ? [["--bus", "bus (modelled)"], ["--rider", "riders waiting, expected (disc area)"], ["--nsl", "MRT / interchange stop"]]
      : [["--sodium", "shuttle with riders"], ["--sodium-dim", "empty shuttle"], ["--rider", "riders waiting (disc area)"], ["--nsl", "MRT / interchange stop"]];
    if (state.showSky) items.push(["--ion", "flying trucks: decorative, not simulated"]);
    el.innerHTML = items.map(([v, l]) => `<span><i style="background:var(${v})"></i>${l}</span>`).join("");
  }

  async function selectScenario(sc) {
    state.scenario = sc;
    for (const b of document.querySelectorAll("#scenarios button")) b.setAttribute("aria-pressed", String(b.dataset.id === sc.id));
    setLegend();
    const ld = document.getElementById("loading");
    ld.hidden = false; ld.textContent = `Loading ${sc.label}…`;
    try {
      await loadScenario(sc.id);
    } catch (e) {
      ld.textContent = `Could not load this scenario (${e.message}).`;
      state.scenario = null;
      return;
    }
    ld.hidden = true;
    tripCache.id = null;
    redraw();
  }

  // ------------------------------------------------------------------ ride along (chase camera)
  const CONTROLLER = { dragRotate: true, touchRotate: true };
  const PHONE = window.innerWidth < 640;
  const RIDE_ZOOM = PHONE ? 19.6 : 20, RIDE_PITCH = PHONE ? 52 : 62;  // phones: shorter map, camera sits lower
  const vehName = (sc) => (sc.kind === "bus" ? "Bus" : sc.capacity <= 4 ? "Robotaxi" : "Shuttle");

  function pickRideVehicle() {
    const act = activeVehicles(state.scenario.id, state.t * 60);
    const busy = act.heads.filter((h) => h.occ > 0 || h.occ === -2);
    const pool = busy.length ? busy : act.heads;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)].veh : null;
  }

  function startRide(veh) {
    if (!state.scenario || !deckgl || !anim[state.scenario.id]) return;
    if (veh == null) veh = pickRideVehicle();
    if (veh == null) return;
    const prev = state.follow ? state.follow.prevSpeed : state.speed;
    state.follow = { veh, bearing: state.view ? state.view.bearing : 0, prevSpeed: prev, last: null };
    state.orbit = false;
    state.speed = 5; document.getElementById("speed").value = "5";
    deckgl.setProps({ controller: false });
    if (!state.playing) setPlaying(true);
    document.getElementById("ride").hidden = false;
    document.getElementById("ride-btn").setAttribute("aria-pressed", "true");
  }

  function stopRide() {
    const f = state.follow; if (!f) return;
    state.follow = null;
    state.speed = f.prevSpeed; document.getElementById("speed").value = String(f.prevSpeed);
    const v = state.view || HOME;
    deckgl.setProps({
      controller: CONTROLLER, viewState: null,
      initialViewState: { ...v, zoom: Math.min(v.zoom, 17), pitch: Math.min(v.pitch, 58), transitionDuration: reduceMotion ? 0 : 900 },
    });
    document.getElementById("ride").hidden = true;
    document.getElementById("ride-btn").setAttribute("aria-pressed", "false");
  }

  function updateRide() {
    const f = state.follow, sc = state.scenario;
    if (!sc || !anim[sc.id]) return;      // a scenario is still loading
    let pose = vehiclePose(sc.id, f.veh, state.t * 60);
    if (!pose || pose.idle > 240) {        // that vehicle's work is done: hop onto a busy one
      const next = pickRideVehicle();
      if (next != null && next !== f.veh) { f.veh = next; pose = vehiclePose(sc.id, next, state.t * 60) || pose; }
      if (!pose) return;
    }
    const now = performance.now(), dt = f.last ? Math.min(0.1, (now - f.last) / 1000) : 0.016;
    f.last = now;
    if (pose.moving) {                      // ease the camera round corners
      const target = (90 - pose.h + 360) % 360, d = ((target - f.bearing + 540) % 360) - 180;
      f.bearing = (f.bearing + d * Math.min(1, dt * 2.2) + 360) % 360;
    }
    f.pose = pose;
    const rad = ((90 - f.bearing) * Math.PI) / 180, ahead = 22;  // look ahead, so the vehicle sits low in frame
    const view = {
      longitude: pose.p[0] + (Math.cos(rad) * ahead) / M_LNG, latitude: pose.p[1] + (Math.sin(rad) * ahead) / M_LAT,
      zoom: RIDE_ZOOM, pitch: RIDE_PITCH, bearing: f.bearing,
    };
    state.view = view;
    deckgl.setProps({ viewState: view });
    document.getElementById("ride-veh").textContent = `${vehName(sc)} #${f.veh}`;
    document.getElementById("ride-occ").textContent = pose.occ === -2 ? "not modelled per bus"
      : pose.occ > 0 ? `${pose.occ} rider${pose.occ > 1 ? "s" : ""}` : pose.moving ? "empty, repositioning" : "empty, waiting for work";
    document.getElementById("ride-kmh").textContent = pose.moving ? `${Math.round(pose.kmh)} km/h` : "stopped";
  }

  // ------------------------------------------------------------------ playback
  let last = null, stageVisible = true;
  function tick(ts) {
    const dt = last != null ? Math.min(0.1, (ts - last) / 1000) : 0;
    last = ts;
    if (state.playing) {
      state.t += dt * state.speed / 60;
      if (state.t >= 1559) state.t = 300;
    }
    if (state.orbit && stageVisible && deckgl) {   // attract mode: drift round the town
      const v = state.view || HOME;
      state.view = { ...v, bearing: (v.bearing + dt * 2.2) % 360 };
      deckgl.setProps({ initialViewState: state.view });
    }
    if (state.follow) updateRide();
    // the sky keeps flying while paused, so keep drawing whenever the stage is on screen
    if (state.playing || state.follow || (stageVisible && ((state.showSky && skyMoves) || state.orbit))) redraw();
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

  const HOME = window.innerWidth < 640
    ? { longitude: 103.8352, latitude: 1.4262, zoom: 12.85, pitch: 45, bearing: -20 }
    : { longitude: 103.8318, latitude: 1.4228, zoom: 13.75, pitch: 54, bearing: -24 };

  function show(what) {
    stopRide(); state.orbit = false;
    const R = D.results;
    const byId = (id) => D.anim_index.scenarios.find((s) => s.id === id);
    document.getElementById("explore").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    if (what === "ride") {
      if (state.scenario && state.scenario.kind === "bus") selectScenario(byId(R.anim.reference) || D.anim_index.scenarios[1]).then(() => startRide());
      else startRide();
    } else if (what === "flows") {
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
    if (/^(models|heads)/.test(info.layer.id)) {
      const sc = state.scenario;
      html = `${vehName(sc)} #${o.veh}${sc.kind === "bus" ? " (modelled)" : o.occ > 0 ? ` · ${o.occ} on board` : " · empty"}<br>click to ride along`;
    } else if (info.layer.id === "sky") {
      html = "Flying truck<br>decorative: not part of the simulation";
    } else if (info.layer.id === "buildings") {
      html = o.k === "hdb"
        ? `HDB Blk ${o.b}<br>${o.f} storeys · completed ${o.y}<br>${o.u ? fmtInt(o.u) + " flats" : "non-residential"}`
        : `Building (OpenStreetMap)<br>height ${o.s === "default" ? "not mapped, shown as context" : "≈ " + Math.round(o.h) + " m"}`;
    } else if (info.layer.id === "stops") {
      const hi = Math.max(0, Math.floor(state.t / 60) - 5);
      html = `${o.c} · ${o.n}<br>${o.sz || ""}<br>rides starting here in the ${clockOf(Math.floor(state.t / 60) * 60)} hour: ${fmtInt(o.o[hi] || 0)}`;
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

  // charts are drawn at the container's real pixel width so labels keep their size on phones
  function frame(id, H) {
    const svg = d3.select(id); svg.selectAll("*").remove();
    const host = svg.node().parentNode;
    const W = Math.max(320, Math.min(760, Math.round(host.getBoundingClientRect().width || 640)));
    svg.attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
    return { svg, W, H };
  }
  const hourLabel = (h) => (h === 24 ? "24" : pad(h % 24));
  function describe(svg, text) { svg.attr("aria-label", text); }

  function chartDemand() {
    const { svg, W, H } = frame("#ch-demand", 300); const m = { t: 16, r: 12, b: 34, l: 52 };
    const hrs = D.demand.hours, v = D.demand.rides_by_hour;
    const x = d3.scaleBand().domain(hrs).range([m.l, W - m.r]).padding(0.18);
    const y = d3.scaleLinear().domain([0, d3.max(v) * 1.08]).nice().range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("g").selectAll("rect").data(hrs).join("rect").attr("x", (h) => x(h)).attr("width", x.bandwidth())
      .attr("y", (h, i) => y(v[i])).attr("height", (h, i) => y(0) - y(v[i])).attr("fill", tok("--rider")).attr("opacity", 0.82);
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).tickValues(hrs.filter((h) => h % 3 === 0)).tickFormat(hourLabel));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5).tickFormat(d3.format("~s")));
    const pk = d3.maxIndex(v);
    describe(svg, `Bar chart of rides per hour inside Yishun: peak ${fmtInt(v[pk])} rides at ${pad(hrs[pk])}:00, evening peak ${fmtInt(v[hrs.indexOf(18)])} at 18:00, ${fmtInt(d3.sum(v))} per weekday.`);
    svg.append("text").attr("class", "callout").attr("x", x(hrs[pk]) + x.bandwidth() + 6).attr("y", y(v[pk]) + 10).text(`${fmtInt(v[pk])} rides, ${pad(hrs[pk])}:00–${pad(hrs[pk] + 1)}:00`);
  }

  function chartCliff(mode) {
    const R = D.results; const { svg, W, H } = frame("#ch-cliff", 340);
    const m = { t: 16, r: 16, b: 40, l: 44 };
    const caps = R.capacities; const hi = (h) => R.hours.indexOf(h);
    const pick = (c) => (mode === "all" ? { ...c.all, ref: c.refused }
      : { m: c.byHour.m[hi(mode)], lo: c.byHour.lo[hi(mode)], hi: c.byHour.hi[hi(mode)], ref: c.refusedByHour[hi(mode)], lb: (c.lbByHour || [])[hi(mode)] });
    const allF = caps.flatMap((k) => R.curves[k].map((c) => c.fleet));
    const x = d3.scaleLinear().domain(d3.extent(allF)).nice().range([m.l, W - m.r]);
    const ymax = 45;
    const y = d3.scaleLinear().domain([0, ymax]).range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(W - m.l - m.r)).tickFormat(""));
    const bus = mode === "all" ? R.bus_day_total_min : R.bus_total_min[hi(mode)];
    svg.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(bus)).attr("y2", y(bus)).attr("stroke", tok("--bus")).attr("stroke-width", 2);
    svg.append("text").attr("class", "callout").attr("x", W - m.r).attr("y", y(bus) - 6).attr("text-anchor", "end").attr("fill", tok("--bus")).text(`bus ${bus.toFixed(1)} min`);
    const dash = { 4: "5 4", 10: null, 20: "1.5 4" };
    const hue = { 4: tok("--sodium-deep"), 10: tok("--sodium"), 20: tok("--sodium-light") };
    for (const k of caps) {
      const pts = R.curves[k].map((c) => ({ f: c.fleet, ...pick(c) })).filter((p) => p.m != null);
      svg.append("path").datum(pts).attr("fill", tok("--sodium")).attr("opacity", k === 10 ? 0.16 : 0.08)
        .attr("d", d3.area().x((p) => x(p.f)).y0((p) => y(Math.min(ymax, p.lo))).y1((p) => y(Math.min(ymax, p.hi))));
      svg.append("path").datum(pts).attr("fill", "none").attr("stroke", hue[k]).attr("stroke-width", k === 10 ? 2.4 : 1.8)
        .attr("stroke-dasharray", dash[k]).attr("d", d3.line().x((p) => x(p.f)).y((p) => y(Math.min(ymax, p.m))));
      // whisker: mean if each refused rider counts as 45 min + a direct ride (a lower bound)
      svg.append("g").selectAll("line").data(pts.filter((p) => p.ref > 0 && p.lb != null && p.lb > p.m)).join("line")
        .attr("x1", (p) => x(p.f)).attr("x2", (p) => x(p.f)).attr("y1", (p) => y(Math.min(ymax, p.m))).attr("y2", (p) => y(Math.min(ymax, p.lb)))
        .attr("stroke", hue[k]).attr("stroke-width", 1).attr("stroke-dasharray", "2 2");
      // filled = no refused riders; open = the fleet also refused riders (waits over 45 min)
      svg.append("g").selectAll("circle").data(pts).join("circle").attr("cx", (p) => x(p.f)).attr("cy", (p) => y(Math.min(ymax, p.m)))
        .attr("r", k === 10 ? 3.4 : 2.6).attr("fill", (p) => (p.ref > 0 ? tok("--night") : hue[k]))
        .attr("stroke", hue[k]).attr("stroke-width", 1.4)
        .append("title").text((p) => `${k} seats, ${p.f} vehicles: ${p.m.toFixed(1)} min${p.ref > 0 ? `, ${(100 * p.ref).toFixed(1)}% refused` + (p.lb != null ? ` (at least ${p.lb.toFixed(1)} min counting them)` : "") : ""}`);
      if (k === 10) {
        const worst = pts.filter((p) => p.ref > 0.005).slice(-1)[0];
        if (worst) {
          // on phones the label takes two lines, which keeps it clear of the 4-seat curve
          const lx = x(worst.f) + 8, pct = `${(100 * worst.ref).toFixed(0)}%`;
          const t = svg.append("text").attr("class", "lab").attr("x", lx).attr("y", y(Math.min(ymax, worst.m)) - 10);
          if (W < 500) { t.append("tspan").text(pct); t.append("tspan").attr("x", lx).attr("dy", "1.15em").text("refused"); }
          else t.text(`${pct} refused`);
        }
      }
    }
    const lg = svg.append("g").attr("transform", `translate(${W - m.r - 150},${m.t + 6})`);
    caps.forEach((k, i) => {
      lg.append("line").attr("x1", 0).attr("x2", 26).attr("y1", i * 16).attr("y2", i * 16).attr("stroke", hue[k])
        .attr("stroke-width", k === 10 ? 2.4 : 1.8).attr("stroke-dasharray", dash[k]);
      lg.append("text").attr("class", "lab").attr("x", 32).attr("y", i * 16 + 4).text(`${k}-seat shuttles`);
    });
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).ticks(W < 500 ? 5 : 7));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(6).tickFormat((d) => `${d}`));
    svg.append("text").attr("class", "lab").attr("x", W - m.r).attr("y", H - 6).attr("text-anchor", "end").text("vehicles in the fleet");
    svg.append("text").attr("class", "lab").attr("x", 4).attr("y", m.t - 4).text("min");
    const p10 = R.curves["10"].map((c) => ({ f: c.fleet, ...pick(c) }));
    describe(svg, `Line chart: mean stop-to-stop minutes against fleet size (${mode === "all" ? "whole day" : pad(mode) + ":00 hour"}). Bus: ${bus.toFixed(1)} min. Ten-seat shuttles: ` + p10.map((p) => `${p.f} vehicles ${p.m.toFixed(1)} min${p.ref > 0 ? " with " + (100 * p.ref).toFixed(0) + "% refused" : ""}`).join("; ") + ".");
  }

  function chartFrontier() {
    const R = D.results, B = D.baseline; const { svg, W, H } = frame("#ch-frontier", 320); const m = { t: 26, r: 16, b: 34, l: 44 };
    const narrow = W < 500; // on phones the two value labels move into the legend below the chart
    const hrs = R.hours.filter((h) => h <= 24);
    const x = d3.scaleLinear().domain([hrs[0], hrs[hrs.length - 1]]).range([m.l, W - m.r]);
    const busAll = B.buses_inside_all || [];
    const fixed = R.all_day_parity && R.all_day_parity["10"];
    const vals = [...Object.values(R.frontier || {}).flat(), ...B.feeder_buses_on_road, ...busAll, fixed || 0].filter((v) => v != null);
    const y = d3.scaleLinear().domain([0, d3.max(vals) * 1.1]).nice().range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    const line = d3.line().defined((d) => d.v != null).x((d) => x(d.h)).y((d) => y(d.v)).curve(d3.curveStepAfter);
    const series = (arr) => hrs.map((h) => ({ h, v: arr[B.hours.indexOf(h)] }));
    const fb = series(B.feeder_buses_on_road), ab = series(busAll);
    if (busAll.length) svg.append("path").datum(ab).attr("fill", "none").attr("stroke", tok("--bus")).attr("stroke-width", 2.2).attr("d", line);
    svg.append("path").datum(fb).attr("fill", "none").attr("stroke", tok("--bus-light")).attr("stroke-width", 1.6).attr("stroke-dasharray", "5 4").attr("d", line);
    if (fixed) {
      svg.append("line").attr("x1", x(hrs[0])).attr("x2", x(hrs[hrs.length - 1])).attr("y1", y(fixed)).attr("y2", y(fixed))
        .attr("stroke", tok("--sodium")).attr("stroke-width", 1).attr("opacity", 0.8);
    }
    const dash = { 4: "5 4", 10: null, 20: "1.5 4" };
    const hue = { 4: "--sodium-deep", 10: "--sodium", 20: "--sodium-light" };
    for (const k of R.capacities) {
      const fr = (R.frontier || {})[k]; if (!fr) continue;
      const d = hrs.map((h) => ({ h, v: fr[R.hours.indexOf(h)] }));
      svg.append("path").datum(d).attr("fill", "none").attr("stroke", tok(hue[k] || "--sodium")).attr("stroke-width", k === 10 ? 2.4 : 1.6).attr("stroke-dasharray", dash[k]).attr("d", line);
    }
    // labels go on top of the lines, so their halo keeps the hourly steps off the text
    if (fixed && !narrow) svg.append("text").attr("class", "callout").attr("x", x(hrs[hrs.length - 1])).attr("y", y(fixed) - 6).attr("text-anchor", "end")
      .text(`fixed fleet: ${fmtInt(fixed)}`);
    svg.append("text").attr("class", "lab").attr("x", 4).attr("y", m.t - 12).text("vehicles");
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).tickValues(hrs.filter((h) => h % 3 === 0)).tickFormat(hourLabel));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5));
    const pk = R.frontier_peak && R.frontier_peak["10"];
    const f10 = (R.frontier || {})["10"] || [];
    describe(svg, `Step chart of vehicles needed by hour if the fleet could change size every hour. Ten-seat shuttles: ` + hrs.map((h) => `${pad(h % 24)}:00 ${f10[R.hours.indexOf(h)] ?? "n/a"}`).join(", ") + `. Fixed fleet all day: ${fixed}. Buses of all services inside Yishun peak at about ${d3.max(ab, (d) => d.v)}; feeder buses on the road at about ${d3.max(fb, (d) => d.v)}.`);
    if (pk && !narrow) svg.append("text").attr("class", "callout").attr("x", x(pk.hour + 2) + 6).attr("y", y(Math.max(pk.fleet, fixed || 0)) - 8).text(`hourly peak: ${pk.fleet} at ${pad(pk.hour)}:00`);
    const leg = document.getElementById("frontier-legend");
    if (leg) {
      const peak = narrow && pk ? ` (peak ${fmtInt(pk.fleet)} at ${pad(pk.hour)}:00)` : "";
      const items = [...R.capacities.map((k) => [hue[k] || "--sodium", k === 10 ? "solid" : k === 4 ? "dashed" : "dotted", `${k}-seat, fleet changes hourly${k === 10 ? peak : ""}`]),
        ["--sodium", "solid thin", `fixed 10-seat fleet, all day${narrow && fixed ? `: ${fmtInt(fixed)}` : ""}`], ["--bus", "solid", "buses inside Yishun"], ["--bus-light", "dashed", "feeder buses on the road"]];
      leg.innerHTML = items.map(([c, st, lab]) => `<span><i style="border-top:${st.includes("thin") ? 1 : 2}px ${st.split(" ")[0]} var(${c})"></i>${lab}</span>`).join("");
    }
  }

  function chartKerb() {
    const R = D.results.reference; const { svg, W, H } = frame("#ch-kerb", 300); const m = { t: 20, r: W < 500 ? 78 : 96, b: 34, l: 40 };
    const hrs = D.results.hours.filter((h) => h <= 24);
    const x = d3.scaleBand().domain(hrs).range([m.l, W - m.r]).padding(0.15);
    const st = Object.keys(R.kerb || {});
    if (!st.length) return;
    const y = d3.scaleLinear().domain([0, d3.max(st.flatMap((s) => R.kerb[s])) * 1.1]).nice().range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    const colors = { Yishun: tok("--sodium"), Khatib: tok("--rider"), Springleaf: tok("--mute") };
    for (const s of st) {
      const d = hrs.map((h) => ({ h, v: R.kerb[s][D.results.hours.indexOf(h)] }));
      svg.append("path").datum(d).attr("fill", "none").attr("stroke", colors[s] || tok("--chalk")).attr("stroke-width", s === "Yishun" ? 2.4 : 1.6)
        .attr("d", d3.line().x((p) => x(p.h) + x.bandwidth() / 2).y((p) => y(p.v || 0)));
    }
    // direct labels at the right, spread so they never overlap
    const ends = st.map((s) => ({ s, v: R.kerb[s][D.results.hours.indexOf(hrs[hrs.length - 1])] || 0 })).sort((a, b) => b.v - a.v);
    let lastY = -1e9;
    for (const e of ends) {
      let yy = Math.max(y(e.v) + 4, lastY + 14); lastY = yy;
      svg.append("text").attr("class", "lab").style("fill", colors[e.s] || tok("--chalk")).attr("x", W - m.r + 6).attr("y", yy).text(W < 500 ? e.s : `${e.s} MRT`);
    }
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).tickValues(hrs.filter((h) => h % 3 === 0)).tickFormat(hourLabel));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5));
    svg.append("text").attr("class", "lab").attr("x", 4).attr("y", m.t - 6).text("shuttles stopped at once");
    describe(svg, "Line chart of the most shuttles stopped at once, by hour: " + st.map((s) => `${s} MRT up to ${d3.max(R.kerb[s])}`).join(", ") + ".");
  }

  function chartWho() {
    const R = D.results.who; const { svg, W, H } = frame("#ch-who", 300);
    const narrow = W < 500; // on phones the unit note gets its own line between the axis and the key
    const m = { t: 16, r: 16, b: narrow ? 64 : 50, l: 44 };
    const labels = R.bands_m.slice(0, -1).map((b, i) => `${b / 1000}–${R.bands_m[i + 1] / 1000}${narrow ? "" : " km"}`);
    if (narrow) svg.append("text").attr("class", "lab").attr("x", W - m.r).attr("y", H - 30).attr("text-anchor", "end").text("straight-line km");
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
    const key = svg.append("g").attr("transform", `translate(${m.l},${H - 10})`);
    [["to or from a station", tok("--sodium")], ["within the estates", tok("--rider")]].forEach(([lab, col], i) => {
      const g = key.append("g").attr("transform", `translate(${i * 170},0)`);
      g.append("rect").attr("x", 0).attr("y", -9).attr("width", 10).attr("height", 10).attr("fill", col);
      g.append("text").attr("class", "lab").attr("x", 15).attr("y", 0).text(lab);
    });
    describe(svg, "Bar chart: share of rides faster by shuttle than by bus, by straight-line length. To or from a station: " + labels.map((l, i) => `${l} ${Math.round(100 * (R.hub[i] || 0))}%`).join(", ") + ". Within estates: " + labels.map((l, i) => `${l} ${Math.round(100 * (R.estate[i] || 0))}%`).join(", ") + ".");
  }

  function chartCal() {
    const P = D.calpts; const { svg, W, H } = frame("#ch-cal", 300); const m = { t: 16, r: 16, b: 40, l: 44 };
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
    describe(svg, `Scatter plot of modelled against observed bus running times for ${P.points.length} stop sequences; points lie close to the diagonal.`);
  }

  function chartGps() {
    const G = D.results.gps_check; if (!G || !G.by_hour) return;
    const rows = Object.entries(G.by_hour).map(([h, b]) => ({ h: +h, ...b })).filter((r) => r.n_pairs >= 20).sort((a, b) => a.h - b.h);
    if (!rows.length) return;
    const { svg, W, H } = frame("#ch-gps", 260); const m = { t: 30, r: 16, b: 34, l: 44 };
    const hrs = d3.range(10, 20);
    const x = d3.scaleBand().domain(hrs).range([m.l, W - m.r]).padding(0.3);
    const lo = Math.min(0.8, d3.min(rows, (r) => r.pooled_ratio_ci[0])), hi = Math.max(1.2, d3.max(rows, (r) => r.pooled_ratio_ci[1]));
    const y = d3.scaleLinear().domain([lo, hi]).nice().range([H - m.b, m.t]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(1)).attr("y2", y(1)).attr("stroke", tok("--mute")).attr("stroke-dasharray", "3 4");
    svg.append("rect").attr("x", x(10) - 4).attr("width", x(12) + x.bandwidth() - x(10) + 8).attr("y", m.t).attr("height", H - m.b - m.t)
      .attr("fill", tok("--bus")).attr("opacity", 0.07);
    svg.append("text").attr("class", "lab").attr("x", x(10)).attr("y", m.t + 12).text("fitted here");
    const g = svg.append("g").selectAll("g").data(rows).join("g").attr("transform", (r) => `translate(${x(r.h) + x.bandwidth() / 2},0)`);
    g.append("line").attr("y1", (r) => y(r.pooled_ratio_ci[0])).attr("y2", (r) => y(r.pooled_ratio_ci[1])).attr("stroke", tok("--bus")).attr("stroke-width", 1.6);
    g.append("circle").attr("cy", (r) => y(r.pooled_ratio)).attr("r", 4).attr("fill", tok("--bus"))
      .append("title").text((r) => `${pad(r.h)}:00: ${r.pooled_ratio.toFixed(2)} (${r.pooled_ratio_ci[0].toFixed(2)}–${r.pooled_ratio_ci[1].toFixed(2)}), ${r.n_pairs} pairs`);
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`),
      d3.axisBottom(x).tickValues(W < 500 ? hrs.filter((h) => h % 2 === 0) : hrs).tickFormat((h) => `${pad(h)}:00`));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5).tickFormat(d3.format(".2f")));
    svg.append("text").attr("class", "lab").attr("x", 4).attr("y", 12).text("observed ÷ model");
    describe(svg, "Dot plot of observed over modelled bus running time by hour: " + rows.map((r) => `${pad(r.h)}:00 ${r.pooled_ratio.toFixed(2)}`).join(", ") + ".");
  }

  function renderSensitivity() {
    const S = D.results.sensitivity; if (!S || !S.length) return;
    const base = S.find((r) => r.id === "base");
    const fav = { 1: "bus", "-1": "shuttle", 0: "either" };
    const tb = document.querySelector("#sens-table tbody");
    tb.innerHTML = S.map((r) => {
      const n = r.parity_fleet == null ? "more than 800" : fmtInt(r.parity_fleet);
      const diff = r.parity_fleet != null && base && base.parity_fleet != null && r.id !== "base"
        ? ` <span style="color:var(--faint)">(${r.parity_fleet - base.parity_fleet >= 0 ? "+" : ""}${r.parity_fleet - base.parity_fleet})</span>` : "";
      const d = r.id === "base" ? "" : fav[String(r.direction ?? 0)] || "either";
      return `<tr><td>${r.label}</td><td>${d}</td><td class="n">${n}${diff}</td><td class="n">${r.bus_day_min != null ? r.bus_day_min.toFixed(1) + " min" : "—"}</td></tr>`;
    }).join("");
    // what moves the threshold and what does not, read from the table itself
    const note = document.getElementById("sens-note");
    if (note && base && base.parity_fleet != null) {
      const bus = S.filter((r) => r.id.startsWith("bus_")), others = S.filter((r) => r.id !== "base" && !r.id.startsWith("bus_"));
      const still = bus.length && bus.every((r) => r.parity_fleet === base.parity_fleet);
      const moved = others.filter((r) => r.parity_fleet !== base.parity_fleet).map((r) => r.parity_fleet).filter((v) => v != null);
      let t = still ? `None of the ${bus.length} bus assumptions moves the threshold: below it, the morning queue builds whatever the bus offers. ` : "";
      if (moved.length) t += `Road speeds, shuttle stop time, the dispatcher and demand do, between ${fmtInt(d3.min(moved))} and ${fmtInt(d3.max(moved))} vehicles.`;
      note.textContent = t;
      const ex = D.results.sensitivity_excluded || [], exEl = document.getElementById("sens-excl");
      if (exEl && ex.length) exEl.textContent = "Not in the table: " + ex.map((r) => `${r.name} (${r.parity_fleet ?? "n/a"} vehicles), because ${r.reason}.`).join(" ");
    }
  }

  function renderSubzones() {
    const W = D.results.who; const rows = (W && W.by_subzone) || [];
    const tb = document.querySelector("#who-sz tbody"); if (!tb || !rows.length) return;
    tb.innerHTML = rows.map((r) => `<tr><td>${r.subzone}</td><td class="n">${fmtInt(r.rides_per_day)}</td><td class="n">${(100 * r.share65).toFixed(0)}%</td>`
      + `<td class="n">${(100 * r.share_faster).toFixed(0)}%</td><td class="n">${r.mean_gain_min.toFixed(1)} min</td></tr>`).join("");
    if (W.subzone_rho_65 != null) {
      const rho = W.subzone_rho_65, p = W.subzone_rho_p;
      const clear = p != null && p < 0.05;
      const word = clear ? (rho > 0 ? "rises with" : "falls with") : "shows no clear relation to";
      document.getElementById("who-sz-note").textContent = `Gains by the subzone where rides start. Across these ${rows.length} subzones the mean gain ${word} the census share of residents aged 65+ (Spearman ρ = ${rho.toFixed(2)}${p != null ? `, p = ${p.toFixed(2)}` : ""}). That share is context only: the fare-card data has no rider ages.`;
    }
  }

  function renderKerbExperiment() {
    const K = D.results.kerb_experiment; if (!K || !K.length) return;
    const ref = D.results.reference.fleet;
    const rows = K.filter((r) => r.fleet === ref).sort((a, b) => (b.berths === -1 ? 1e9 : b.berths) - (a.berths === -1 ? 1e9 : a.berths));
    const free = rows.find((r) => r.berths === -1);
    const tight = rows.filter((r) => r.berths !== -1);
    if (!free || !tight.length) return;
    const fail = tight.filter((r) => !r.h7_ok).sort((a, b) => b.berths - a.berths)[0];
    const pass = tight.filter((r) => r.h7_ok).sort((a, b) => a.berths - b.berths)[0];
    let txt = `Capping the kerb shows how much it matters. With ${fmtInt(ref)} shuttles and no limit, the 07:00 hour averages ${free.h7_total_min.toFixed(1)} min stop to stop (bus ${free.h7_bus_min.toFixed(1)}).`;
    if (pass) txt += ` Limiting each station to ${pass.berths} shuttles boarding at once still keeps up (${pass.h7_total_min.toFixed(1)} min; ${Math.round(100 * pass.peak_queued_share)}% of station stops queue, on average ${Math.round(pass.peak_queue_wait_mean_s)} s).`;
    if (fail) {
      txt += ` With a limit of ${fail.berths}, queues at the kerb push the 07:00 hour to ${fail.h7_total_min.toFixed(1)} min and the fleet no longer matches the bus.`;
      const more = K.find((r) => r.fleet > ref && r.berths === fail.berths);
      if (more && more.h7_total_min > fail.h7_total_min) txt += ` Adding vehicles does not help: ${fmtInt(more.fleet)} shuttles with the same kerb take ${more.h7_total_min.toFixed(1)} min, because the extra vehicles queue too.`;
    }
    document.getElementById("kerb-exp-text").textContent = txt;
  }

  // ------------------------------------------------------------------ numbers in text
  function fillNumbers() {
    const R = D.results, cal = D.baseline.calibration || {}, v = R.numbers || {};
    for (const el of document.querySelectorAll("[data-v]")) { const k = el.dataset.v; if (v[k] != null) el.textContent = v[k]; }
    if (R.who) {
      document.getElementById("who-text").textContent = R.who.text;
      if (R.who.headline) document.getElementById("who-h2").textContent = R.who.headline;
    }
    if (cal.n_obs_used) {
      const ho = cal.holdout_services, g = R.gps_check && R.gps_check.by_window && R.gps_check.by_window["10-12"];
      let t = `Calibration on ${fmtInt(cal.n_segments_used)} stop sequences of one to six stops (${fmtInt(cal.n_obs_used)} matched observations): mean absolute error ${Math.round(cal.segment_mae_s)} s`;
      if (cal.in_sample) t += ` (${Math.round(100 * cal.in_sample.mape)}%)`;
      if (ho) t += `. With whole bus services held out it is ${Math.round(100 * ho.model.mape)}%, against ${Math.round(100 * ho.distance_only.mape)}% for a distance-only model`;
      if (g) t += `. Against observed bus GPS movement at the same hours, buses take ${g.pooled_ratio.toFixed(2)} times the modelled time (95% interval ${g.pooled_ratio_ci[0].toFixed(2)}–${g.pooled_ratio_ci[1].toFixed(2)})`;
      document.getElementById("cal-cap").textContent = t + ". Each dot is the median of one sequence; the dashed line is perfect agreement.";
    }
  }

  let cliffMode = 7;
  function drawCharts() {
    for (const f of [chartDemand, chartFrontier, chartKerb, chartWho, chartCal, chartGps, () => chartCliff(cliffMode)]) {
      try { f(); } catch (e) { console.error(e); }
    }
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
    try { fillNumbers(); } catch (e) { console.error(e); }
    const tabs = document.getElementById("cliff-tabs");
    const modes = [["7", "07:00–08:00"], ["8", "08:00–09:00"], ["12", "12:00–13:00"], ["18", "18:00–19:00"], ["all", "whole day"]];
    for (const [k, lab] of modes) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = lab; b.dataset.mode = k;
      b.setAttribute("aria-pressed", String(k === "7"));
      b.onclick = () => { for (const x of tabs.children) x.setAttribute("aria-pressed", String(x === b)); cliffMode = k === "all" ? "all" : +k; chartCliff(cliffMode); };
      tabs.appendChild(b);
    }
    const safe = (f) => { try { f(); } catch (e) { console.error(e); } };
    safe(drawCharts); safe(renderSensitivity); safe(renderKerbExperiment); safe(renderSubzones);

    const el = document.getElementById("scenarios");
    for (const sc of D.anim_index.scenarios) {
      const b = document.createElement("button"); b.type = "button"; b.dataset.id = sc.id; b.dataset.kind = sc.kind;
      b.textContent = sc.kind === "bus" ? "Today's buses" : `${sc.fleet} × ${sc.capacity}-seat`;
      b.title = sc.label; b.onclick = () => selectScenario(sc); el.appendChild(b);
    }
    buildSky();
    state.view = HOME;
    deckgl = new deck.Deck({
      parent: document.getElementById("map"), initialViewState: HOME, controller: CONTROLLER,
      views: new deck.MapView({ repeat: false }), layers: [], onHover,
      onClick: (info) => { if (info.object && /^(models|heads)/.test(info.layer.id)) startRide(info.object.veh); },
      onViewStateChange: ({ viewState }) => { state.view = viewState; if (!state.playing && !state.showSky) redraw(); },
      effects: [new deck.LightingEffect({
        ambient: new deck.AmbientLight({ color: [255, 255, 255], intensity: 1.0 }),
        moon: new deck.DirectionalLight({ color: [255, 236, 214], intensity: 1.4, direction: [-1.2, -2, -3] }),
      })],
      parameters: { clearColor: [0, 0, 0, 0] },
    });
    document.getElementById("play").onclick = () => setPlaying(!state.playing);
    document.getElementById("time").oninput = (e) => { state.t = +e.target.value; redraw(); };
    document.getElementById("speed").onchange = (e) => { state.speed = +e.target.value; };
    document.getElementById("t-wait").onchange = (e) => { state.showWait = e.target.checked; redraw(); };
    document.getElementById("t-flows").onchange = (e) => { state.showFlows = e.target.checked; redraw(); };
    document.getElementById("t-age").onchange = (e) => { state.showAge = e.target.checked; redraw(); };
    document.getElementById("t-sky").onchange = (e) => { state.showSky = e.target.checked; setLegend(); redraw(); };
    document.getElementById("ride-btn").onclick = () => (state.follow ? stopRide() : startRide());
    document.getElementById("ride-exit").onclick = stopRide;
    const mapEl = document.getElementById("map");
    for (const ev of ["pointerdown", "wheel", "touchstart"]) mapEl.addEventListener(ev, () => { state.orbit = false; }, { passive: true });
    new IntersectionObserver((es) => { stageVisible = es[0].isIntersecting; }).observe(document.getElementById("stage"));
    for (const b of document.querySelectorAll("[data-show]")) b.onclick = () => show(b.dataset.show);
    const ids = new Set(D.anim_index.scenarios.map((x) => x.id));
    const cliffBtn = document.querySelector('[data-show="cliff"]');
    if (cliffBtn && !ids.has(D.results.anim.undersized)) cliffBtn.hidden = true;
    const kerbBtn = document.querySelector('[data-show="kerb"]');
    if (kerbBtn && !ids.has(D.results.anim.reference)) kerbBtn.hidden = true;
    // keyboard: space plays/pauses, arrows step five minutes (when focus is not in a form control)
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.follow) { stopRide(); return; }
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(document.activeElement.tagName)) return;
      const r = document.getElementById("stage").getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      state.orbit = false;
      if (e.key === " ") { e.preventDefault(); setPlaying(!state.playing); }
      else if (e.key === "r" || e.key === "R") { if (state.follow) stopRide(); else startRide(); }
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault(); state.t = Math.max(300, Math.min(1559, state.t + (e.key === "ArrowRight" ? 5 : -5))); redraw();
      }
    });
    const ref = D.anim_index.scenarios.find((s) => s.id === D.results.anim.reference) || D.anim_index.scenarios[0];
    await selectScenario(ref);
    let rz = null;
    window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(drawCharts, 200); });
    if (!reduceMotion && !still) { setPlaying(true); state.orbit = true; }
    requestAnimationFrame(tick);
    document.documentElement.dataset.ready = "1";
  }
  init();
})();
