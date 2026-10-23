/* Driverless Yishun: explorer and charts.
   All data is read from ./data/*.json, exported by the Python pipeline (pipeline/yishun/export_*.py). */
(function () {
  "use strict";

  const CSS = getComputedStyle(document.documentElement);
  const tok = (n) => CSS.getPropertyValue(n).trim();
  const hexRgb = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const fmtInt = d3.format(",.0f");
  const pad = (n) => String(n).padStart(2, "0");
  const clockOf = (min) => { const m = Math.floor(min) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = /(^#|&)still(&|$)/.test(location.hash); // no autoplay (thumbnails, screenshots)

  const state = {
    t: 7.5 * 60, playing: false, speed: 120, scenario: null,
    showWait: true, showFlows: false, showAge: false, showSky: true, hover: null,
    view: null,          // last view state, for zoom-dependent model scale
    orbit: false,        // slow attract-mode orbit until the visitor touches the map
    follow: null,        // ride-along camera: { veh, bearing, lost }
    mapStyle: "street",  // "street" (after busrouter.sg) or "toon" (flat isometric illustration)
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

  // ------------------------------------------------------------------ map styles
  // The colours live in index.html as tokens on .stage[data-map=...], so the layers, HUD and legend
  // switch together; this holds what CSS cannot: camera lens, lighting, material, building fill.
  const TOON_BLOCKS = ["#60c8e2", "#fad75a", "#f7a05f", "#b496e1", "#78cdb4", "#f8bace", "#8cbef0", "#f5ebc8"].map(hexRgb);
  const MAP_STYLES = {
    street: {
      fovy: 50, ambient: 1.0, sun: 1.4, outline: false,
      material: { ambient: 0.35, diffuse: 0.6, shininess: 12, specularColor: [40, 40, 40] },
      block: (b) => {
        if (b.k !== "hdb") return M.bld.map((c) => Math.round(c * 0.8));
        const u = (Math.max(1975, Math.min(2025, b.y || 1985)) - 1975) / 50; // old blocks a touch warmer, newer cooler
        return [M.bld[0] + Math.round(14 - 10 * u), M.bld[1] + Math.round(10 - 2 * u), M.bld[2] + Math.round(4 + 12 * u)];
      },
    },
    toon: {
      fovy: 25, ambient: 1.25, sun: 0.9, outline: true, pitch: 45, bearing: -45,
      material: { ambient: 0.85, diffuse: 0.35, shininess: 0, specularColor: [0, 0, 0] },
      block: (b) => TOON_BLOCKS[Math.abs(Math.round(b.p[0][0] * 91e4 + b.p[0][1] * 37e4)) % TOON_BLOCKS.length],
    },
  };
  let M = {};  // the current style's colours, read from the stage
  function readMapTokens() {
    const cs = getComputedStyle(document.getElementById("stage"));
    const t = (n) => { const v = cs.getPropertyValue(n).trim(); return v.startsWith("#") ? hexRgb(v) : null; };
    M = {
      sodium: t("--sodium"), sodiumDim: t("--sodium-dim"), bus: t("--bus"), nsl: t("--nsl"), rider: t("--rider"), ion: t("--ion"),
      earth: t("--m-earth"), water: t("--m-water"), green: t("--m-green"), road: t("--m-road"), bld: t("--m-bld"),
      line: t("--m-line"), rail: t("--m-rail"), stop: t("--m-stop"), boundary: t("--m-boundary"),
    };
  }
  const mapStyle = () => MAP_STYLES[state.mapStyle];
  const homeView = () => { const s = mapStyle(); return { ...HOME, ...(s.pitch != null && { pitch: s.pitch, bearing: s.bearing }) }; };
  function mapView() { return new deck.MapView({ repeat: false, fovy: mapStyle().fovy }); }
  function mapEffects() {
    const s = mapStyle();
    return [new deck.LightingEffect({
      ambient: new deck.AmbientLight({ color: [255, 255, 255], intensity: s.ambient }),
      moon: new deck.DirectionalLight({ color: [255, 236, 214], intensity: s.sun, direction: [-1.2, -2, -3] }),
    })];
  }
  function setMapStyle(name, { save = true, turn = true } = {}) {
    if (!MAP_STYLES[name]) return;
    state.mapStyle = name;
    document.getElementById("stage").dataset.map = name;
    for (const b of document.querySelectorAll("#mapstyle button")) b.setAttribute("aria-pressed", String(b.dataset.map === name));
    readMapTokens();
    if (save) { try { localStorage.setItem("yishun-map-style", name); } catch (e) { /* private mode: not remembered */ } }
    if (!deckgl) return;
    deckgl.setProps({ views: mapView(), effects: mapEffects() });
    // the cartoon reads as an illustration from the classic isometric corner; ease there, keeping place and zoom
    if (turn && !state.follow) {
      const v = state.view || HOME, h = homeView();
      deckgl.setProps({ initialViewState: { ...v, pitch: h.pitch, bearing: h.bearing, nonce: ++flyCount, transitionDuration: reduceMotion ? 0 : 900 } });
    }
    redraw();
  }

  // ------------------------------------------------------------------ map layers
  function vehColor(occ, alpha) {
    if (occ === -2) return [...M.bus, alpha];
    if (occ <= 0) return [...M.sodiumDim, Math.round(alpha * 0.8)];
    return [...M.sodium, alpha];
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
    const L = [], S = mapStyle(), ink = S.outline && M.line;
    const z = (state.view || HOME).zoom, inkA = z >= 13.5 ? 255 : 120;  // lighter ink at town scale, none on phones, or the blocks turn to soot
    L.push(new deck.SolidPolygonLayer({ id: "earth", data: D.town.boundary, getPolygon: (d) => d, getFillColor: M.earth, pickable: false }));
    L.push(new deck.SolidPolygonLayer({ id: "water", data: D.town.water, getPolygon: (d) => d, getFillColor: M.water, pickable: false }));
    L.push(new deck.SolidPolygonLayer({ id: "green", data: D.town.green, getPolygon: (d) => d, getFillColor: M.green, pickable: false }));
    L.push(new deck.SolidPolygonLayer({ id: "roads", data: D.town.roads, getPolygon: (d) => d, getFillColor: M.road, pickable: false }));
    if (ink) {  // cartoon: ink edges along kerbs and shorelines
      L.push(new deck.PathLayer({ id: "road-ink", data: D.town.roads, getPath: (d) => d, getColor: [...ink, 120], widthMinPixels: 1, pickable: false }));
      L.push(new deck.PathLayer({ id: "water-ink", data: D.town.water, getPath: (d) => d, getColor: [...ink, 170], widthMinPixels: 1.2, pickable: false }));
    }
    if (state.showAge) {
      const ext = d3.extent(D.town.subzones, (s) => s.share65 || 0);
      L.push(new deck.SolidPolygonLayer({
        id: "age", data: D.town.subzones.flatMap((s) => s.rings.map((r) => ({ r, s }))), getPolygon: (d) => d.r,
        getFillColor: (d) => { const u = ((d.s.share65 || 0) - ext[0]) / (ext[1] - ext[0] || 1); return [120 + 110 * u, 70 + 40 * u, 160 - 60 * u, 70 + 90 * u]; },
        pickable: true, updateTriggers: { getFillColor: ext },
      }));
    }
    L.push(new deck.PathLayer({ id: "boundary", data: D.town.boundary, getPath: (d) => d, getColor: [...M.boundary, ink ? 200 : 110], widthMinPixels: ink ? 1.6 : 1.2, pickable: false }));
    L.push(new deck.PathLayer({ id: "rail", data: D.town.rail, getPath: (d) => d, getColor: [...M.rail, ink ? 255 : 200], widthMinPixels: ink ? 4 : 2, pickable: false }));
    L.push(new deck.SolidPolygonLayer({
      id: "buildings", data: D.buildings.buildings, getPolygon: (d) => d.p, extruded: true, getElevation: (d) => d.h,
      // see-through while riding, so blocks between the chase camera and the vehicle don't hide it
      // (and not writing depth, or they would still hide the vehicles drawn after them)
      getFillColor: S.block, opacity: state.follow ? 0.42 : ink ? 1 : 0.9, pickable: !state.follow,
      wireframe: !!ink && !state.follow && z >= 13, getLineColor: ink ? [...ink, inkA] : [0, 0, 0],
      parameters: state.follow ? { depthWriteEnabled: false } : {}, material: S.material,
      updateTriggers: { getFillColor: state.mapStyle, getLineColor: [state.mapStyle, inkA] },
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
        getFillColor: [...M.rider, state.follow ? 40 : 110], getLineColor: [...M.rider, state.follow ? 120 : 230], pickable: true,
        updateTriggers: { getRadius: [state.t, state.scenario && state.scenario.id], getFillColor: [!!state.follow, state.mapStyle], getLineColor: [!!state.follow, state.mapStyle] },
      }));
    }
    L.push(new deck.ScatterplotLayer({
      id: "stops", data: D.stops.stops, getPosition: (d) => [d.x, d.y], getRadius: (d) => (d.hub ? 22 : 10), radiusMinPixels: 1.5,
      radiusMaxPixels: 16, getFillColor: (d) => (d.hub ? [...M.nsl, 230] : [...M.stop, ink ? 255 : 150]), pickable: true,
      stroked: !!ink, getLineColor: ink || [0, 0, 0], lineWidthMinPixels: 1.2, updateTriggers: { getFillColor: state.mapStyle },
    }));
    if (state.showFlows) {
      const flows = D.demand.top_flows[hourIdx] || [];
      L.push(new deck.ArcLayer({
        id: "flows", data: flows.filter((f) => stopIdx[f[0]] && stopIdx[f[1]]),
        getSourcePosition: (f) => [stopIdx[f[0]].x, stopIdx[f[0]].y], getTargetPosition: (f) => [stopIdx[f[1]].x, stopIdx[f[1]].y],
        getWidth: (f) => Math.max(0.6, f[2] / 25), getHeight: 0.6, getSourceColor: [...M.rider, 60], getTargetColor: [...M.rider, 220], greatCircle: false,
      }));
    }
    if (sc) {
      if (tripCache.id !== state.scenario.id || tSec < tripCache.from + 300 || tSec > tripCache.to - 300) buildTrips(state.scenario.id, tSec);
      L.push(new deck.TripsLayer({
        id: "trails", data: tripCache.trips, getPath: (d) => d.path, getTimestamps: (d) => d.timestamps,
        getColor: (d) => vehColor(d.occ, 210), widthMinPixels: 2.2, trailLength: TRAIL, currentTime: tSec - BASE,
        fadeTrail: true, capRounded: true, jointRounded: true, updateTriggers: { getColor: [state.scenario.id, state.mapStyle] },
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
        stroked: !!ink, getLineColor: ink || [0, 0, 0], lineWidthMinPixels: 1, updateTriggers: { getFillColor: state.mapStyle },
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
          radiusUnits: "meters", stroked: true, filled: true, getFillColor: [...M.sodium, 40], getLineColor: [...M.sodium, 230],
          getLineWidth: 0.5, lineWidthUnits: "meters", updateTriggers: { getRadius: pulse },
        }));
      }
    }
    if (state.showSky && SKY.flights.length) {
      const now = skyClock();
      L.push(new deck.TripsLayer({
        id: "sky-trails", data: SKY.flights, getPath: (d) => d.path, getTimestamps: (d) => d.timestamps,
        getColor: [...M.ion, 210], widthMinPixels: 2.5, trailLength: 10, fadeTrail: true, capRounded: true,
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
    view = state.view = { ...v, zoom: Math.min(v.zoom, 17), pitch: Math.min(v.pitch, 58) };
    deckgl.setProps({ controller: CONTROLLER, viewState: null, initialViewState: { ...view, transitionDuration: reduceMotion ? 0 : 900 } });
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
    const cam = {
      longitude: pose.p[0] + (Math.cos(rad) * ahead) / M_LNG, latitude: pose.p[1] + (Math.sin(rad) * ahead) / M_LAT,
      zoom: RIDE_ZOOM, pitch: RIDE_PITCH, bearing: f.bearing,
    };
    view = state.view = cam;
    deckgl.setProps({ viewState: cam });
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
      view = state.view = { ...v, bearing: (v.bearing + dt * 2.2) % 360 };
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

  // "Back to the map": the button pulses once the camera has left Yishun (or zoomed far away from it)
  function updateAway(v) {
    const btn = document.getElementById("home"); if (!btn || !v) return;
    const k = 111320, dx = (v.longitude - HOME.longitude) * k * Math.cos(HOME.latitude * Math.PI / 180), dy = (v.latitude - HOME.latitude) * k;
    btn.classList.toggle("away", Math.hypot(dx, dy) > 3000 || Math.abs(v.zoom - HOME.zoom) > 3);
  }

  let flyCount = 0;
  function flyTo(view) {
    if (!deckgl) return;
    if (state.follow) stopRide();
    state.orbit = false;
    // the nonce makes every call differ: deck.gl ignores an initialViewState that deep-equals the previous one,
    // which would turn a second flight to the same place (after panning by mouse) into a no-op
    deckgl.setProps({ initialViewState: { ...view, nonce: ++flyCount, transitionDuration: reduceMotion ? 0 : 1800, transitionInterpolator: new deck.FlyToInterpolator() } });
  }

  // ------------------------------------------------------------------ WASD flight
  // W/S fly forward/back along the heading, A/D strafe, Q/E turn, R/F climb/descend (zoom); Shift is faster.
  // deck.gl keeps the camera internally, so the latest view is tracked from onViewStateChange and
  // pushed back through initialViewState (no transition) on every frame a key is held.
  const FLY_CODES = { KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d", KeyQ: "q", KeyE: "e", KeyR: "r", KeyF: "f", ShiftLeft: "shift", ShiftRight: "shift" };
  const held = new Set();
  let view = null, flyLast = null, flying = false;

  function flyStep(ts) {
    const moving = [...held].some((k) => k !== "shift");
    if (!moving) { flying = false; flyLast = null; return; }
    state.orbit = false;
    if (state.follow) stopRide();                 // the ride's camera would override the flight
    const dt = flyLast == null ? 0 : Math.min((ts - flyLast) / 1000, 0.05);
    flyLast = ts;
    if (deckgl && view && dt > 0) {
      const boost = held.has("shift") ? 3 : 1;
      const mpp = 156543.03 * Math.cos(view.latitude * Math.PI / 180) / Math.pow(2, view.zoom); // metres per pixel
      const step = 260 * boost * mpp * dt;                                                        // ~260 px/s on screen
      const b = (view.bearing || 0) * Math.PI / 180;
      const fwd = (held.has("w") ? 1 : 0) - (held.has("s") ? 1 : 0);
      const right = (held.has("d") ? 1 : 0) - (held.has("a") ? 1 : 0);
      const east = (Math.sin(b) * fwd + Math.cos(b) * right) * step;
      const north = (Math.cos(b) * fwd - Math.sin(b) * right) * step;
      const next = { ...view };
      next.longitude += east / (111320 * Math.cos(view.latitude * Math.PI / 180));
      next.latitude = Math.max(-85, Math.min(85, view.latitude + north / 110540));
      next.bearing = (view.bearing || 0) + ((held.has("e") ? 1 : 0) - (held.has("q") ? 1 : 0)) * 60 * boost * dt;
      next.zoom = Math.max(11, Math.min(19, view.zoom + ((held.has("r") ? 1 : 0) - (held.has("f") ? 1 : 0)) * 1.2 * boost * dt));
      next.transitionDuration = 0; next.transitionInterpolator = undefined;
      view = next; updateAway(next);
      deckgl.setProps({ initialViewState: next });
    }
    requestAnimationFrame(flyStep);
  }

  function flyKeys() {
    const stageVisible = () => { const r = document.getElementById("stage").getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; };
    // only real text entry blocks flying: a focused slider, checkbox, button or select must not
    const typing = () => {
      const a = document.activeElement; if (!a) return false;
      return a.isContentEditable || a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && !/^(range|checkbox|radio|button|submit|reset)$/.test(a.type));
    };
    document.addEventListener("keydown", (e) => {
      const k = FLY_CODES[e.code];
      if (e.code === "KeyH" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing() && stageVisible()) { held.clear(); flyTo(homeView()); return; }
      if (!k || e.ctrlKey || e.metaKey || e.altKey || typing()) return;
      if (k !== "shift") { if (!stageVisible()) return; e.preventDefault(); }
      held.add(k);
      if (!flying && k !== "shift") { flying = true; flyLast = null; requestAnimationFrame(flyStep); }
    });
    document.addEventListener("keyup", (e) => { const k = FLY_CODES[e.code]; if (k) held.delete(k); });
    window.addEventListener("blur", () => held.clear());
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
      selectScenario(byId("bus") || D.anim_index.scenarios[0]); flyTo(homeView());
    } else if (what === "cliff") {
      state.t = 6.75 * 60; setPlaying(true);
      selectScenario(byId(R.anim.undersized) || D.anim_index.scenarios[1]); flyTo(homeView());
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
  // Each chart is drawn once per width with every mark in place but hidden, and returns a
  // function that moves it to a numbered state: -1 is the empty frame, and each scroll step
  // draws more of it (a line traced, bars grown, points plotted) or picks out part of it.
  const DUR = reduceMotion || still ? 0 : 900;
  const ease = d3.easeCubicOut;
  const tr = (sel, dur, delay) => sel.transition().duration(dur).delay(delay || 0).ease(ease);
  const vis = (sel, on, dur, delay) => { if (sel) tr(sel, on ? dur : dur / 2, on ? delay : 0).attr("opacity", on ? 1 : 0); };

  function axis(g, ax, cls) { g.attr("class", `axis ${cls || ""}`).call(ax); }
  function gridY(svg, y, m, W, n) {
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(n).tickSize(-(W - m.l - m.r)).tickFormat(""));
  }

  // charts are drawn at the container's real pixel width so labels keep their size on phones
  const widthOf = (host) => Math.max(320, Math.min(760, Math.round(host.getBoundingClientRect().width || 640)));
  function frame(id, H) {
    const svg = d3.select(id); svg.selectAll("*").remove();
    const W = widthOf(svg.node().parentNode);
    svg.attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
    return { svg, W, H };
  }
  const hourLabel = (h) => (h === 24 ? "24" : pad(h % 24));
  function describe(svg, text) { svg.attr("aria-label", text); }

  // a clip rectangle that uncovers a group from one side, so lines of any dash style trace in
  let clipN = 0;
  function wipe(svg, g, x0, x1, fromRight) {
    const id = `wipe-${++clipN}`, padX = 14;
    const r = svg.append("clipPath").attr("id", id).append("rect").attr("y", -1000).attr("height", 3000)
      .attr("x", fromRight ? x1 + padX : x0 - padX).attr("width", 0);
    g.attr("clip-path", `url(#${id})`);
    return (p, dur) => {
      const w = (x1 - x0 + 2 * padX) * p;
      tr(r, dur).attr("x", fromRight ? x1 + padX - w : x0 - padX).attr("width", w);
    };
  }

  const CH = {};
  function chart(id, H, draw) {
    let set = null, w = 0, cur = -1;
    const c = {
      get state() { return cur; },
      set(s, dur) {
        const W = widthOf(document.getElementById(id).parentNode);
        if (!set || W !== w) { set = draw(frame(`#${id}`, typeof H === "function" ? H(W) : H)); w = W; }
        cur = s; set(s, dur);
      },
      rebuild(dur) { set = null; const s = cur; c.set(-1, 0); c.set(s, dur); },
    };
    CH[id] = c;
    return c;
  }

  function drawDemand({ svg, W, H }) {
    const m = { t: 28, r: 12, b: 34, l: 52 };
    const hrs = D.demand.hours, v = D.demand.rides_by_hour;
    const x = d3.scaleBand().domain(hrs).range([m.l, W - m.r]).padding(0.18);
    const y = d3.scaleLinear().domain([0, d3.max(v) * 1.1]).nice().range([H - m.b, m.t]);
    gridY(svg, y, m, W, 5);
    const bars = svg.append("g").selectAll("rect").data(hrs).join("rect").attr("x", (h) => x(h)).attr("width", x.bandwidth())
      .attr("y", y(0)).attr("height", 0).attr("fill", tok("--rider")).attr("opacity", 0.82);
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).tickValues(hrs.filter((h) => h % 3 === 0)).tickFormat(hourLabel));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5).tickFormat(d3.format("~s")));
    svg.append("text").attr("class", "lab").attr("x", 4).attr("y", m.t - 14).text("rides per hour");
    const pk = d3.maxIndex(v), pm = hrs.indexOf(18);
    const hot = new Set([pk, pm]);
    const lab = (i, txt, anchor) => (i < 0 ? null : svg.append("text").attr("class", "callout").attr("x", anchor === "start" ? x(hrs[i]) - 2 : x(hrs[i]) + x.bandwidth() / 2)
      .attr("y", y(v[i]) - 8).attr("text-anchor", anchor).attr("opacity", 0).text(txt));
    const labs = [lab(pk, `${fmtInt(v[pk])} at ${pad(hrs[pk])}:00`, "start"), lab(pm, `${fmtInt(v[pm])} at 18:00`, "middle")];
    describe(svg, `Bar chart of rides per hour inside Yishun: peak ${fmtInt(v[pk])} rides at ${pad(hrs[pk])}:00, evening peak ${fmtInt(v[pm])} at 18:00, ${fmtInt(d3.sum(v))} per weekday.`);
    let prev = -1;
    return (s, dur) => {
      const first = prev < 0 && s >= 0; prev = s;
      tr(bars, dur).delay((h, i) => (first ? (i * dur) / 22 : 0))
        .attr("y", (h, i) => (s >= 0 ? y(v[i]) : y(0))).attr("height", (h, i) => (s >= 0 ? y(0) - y(v[i]) : 0))
        .attr("fill", (h, i) => (s >= 1 && hot.has(i) ? tok("--sodium") : tok("--rider")))
        .attr("opacity", (h, i) => (s >= 1 && !hot.has(i) ? 0.28 : 0.82));
      labs.forEach((l) => vis(l, s >= 1, dur, dur * 0.4));
    };
  }

  function drawLength({ svg, W, H }) {
    const m = { t: 28, r: 14, b: 44, l: 52 };
    const E = D.demand.hist_edges_m, v = D.demand.hist_rides, med = D.demand.straight_line_pct_m["50"];
    const x = d3.scaleLinear().domain([0, E[E.length - 1]]).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([0, d3.max(v) * 1.1]).nice().range([H - m.b, m.t]);
    gridY(svg, y, m, W, 5);
    const shade = svg.append("rect").attr("x", x(0)).attr("y", m.t).attr("height", H - m.b - m.t).attr("width", 0).attr("fill", tok("--sodium")).attr("opacity", 0.1);
    const bars = svg.append("g").selectAll("rect").data(v.map((c, i) => i)).join("rect")
      .attr("x", (i) => x(E[i]) + 1).attr("width", (i) => Math.max(1, x(E[i + 1]) - x(E[i]) - 2))
      .attr("y", y(0)).attr("height", 0).attr("fill", tok("--rider")).attr("opacity", 0.82);
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).tickValues(d3.range(0, E[E.length - 1] + 1, 500)).tickFormat((d) => d / 1000));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5).tickFormat(d3.format("~s")));
    svg.append("text").attr("class", "lab").attr("x", 4).attr("y", m.t - 14).text("rides per weekday");
    svg.append("text").attr("class", "lab").attr("x", W - m.r).attr("y", H - 6).attr("text-anchor", "end").text(W < 500 ? "straight-line km (last bar 2.75+)" : "straight-line km between stops (last bar: 2.75 km or more)");
    const ml = svg.append("g").attr("opacity", 0);
    ml.append("line").attr("x1", x(med)).attr("x2", x(med)).attr("y1", y(0)).attr("y2", m.t).attr("stroke", tok("--sodium")).attr("stroke-width", 2);
    ml.append("text").attr("class", "callout").attr("x", x(med) + 8).attr("y", m.t + 12).style("fill", tok("--sodium")).text(`half are under ${(D.results.numbers || {}).median || fmtInt(med) + " m"}`);
    describe(svg, `Histogram of rides by straight-line length: median ${fmtInt(med)} m; ` + v.map((c, i) => `${E[i]}–${E[i + 1]} m: ${fmtInt(c)}`).join(", ") + ".");
    return (s, dur) => {
      tr(bars, dur).delay((i) => (s >= 0 ? (i * dur) / 18 : 0))
        .attr("y", (i) => (s >= 0 ? y(v[i]) : y(0))).attr("height", (i) => (s >= 0 ? y(0) - y(v[i]) : 0));
      tr(shade, dur, s >= 0 ? dur * 0.8 : 0).attr("width", s >= 0 ? x(med) - x(0) : 0);
      vis(ml, s >= 0, dur, dur * 1.2);
    };
  }

  // 100 squares, one per hundred rides, the first `share` of them lit
  const waffleH = (W) => (W < 520 ? 5 * Math.floor((W - 4) / 20) + 118 : 300);
  const drawWaffle = (getShare, onVar, onLines, offLines) => ({ svg, W, H }) => {
    const on = Math.round(100 * getShare());
    const narrow = W < 520, cols = narrow ? 20 : 10, rows = 100 / cols;
    const cell = narrow ? Math.floor((W - 4) / cols) : Math.floor((H - 20) / rows);
    const cells = svg.append("g").attr("transform", "translate(2,8)").selectAll("rect").data(d3.range(100)).join("rect")
      .attr("x", (i) => (i % cols) * cell).attr("y", (i) => Math.floor(i / cols) * cell)
      .attr("width", cell - 3).attr("height", cell - 3).attr("rx", 2)
      .attr("fill", (i) => (i < on ? tok(onVar) : tok("--bg-3"))).attr("stroke", (i) => (i < on ? "none" : tok("--rule")))
      .attr("opacity", 0);
    const tx = narrow ? 2 : cols * cell + 28, ty = narrow ? rows * cell + 52 : 70;
    const t = svg.append("g").attr("transform", `translate(${tx},${ty})`).attr("opacity", 0);
    t.append("text").attr("class", "wbig").attr("y", narrow ? -8 : 0).style("fill", tok(onVar)).style("font-size", narrow ? "34px" : null).text(`${on} in 100`);
    const key = (y0, fill, stroke, lines) => {
      t.append("rect").attr("x", 0).attr("y", y0 - 10).attr("width", 11).attr("height", 11).attr("rx", 2).attr("fill", fill).attr("stroke", stroke);
      lines.forEach((l, i) => t.append("text").attr("class", "lab").attr("x", 18).attr("y", y0 + i * 16).text(l));
    };
    key(narrow ? 18 : 36, tok(onVar), "none", onLines(on));
    key(narrow ? 18 + 18 * onLines(on).length : 44 + 18 * onLines(on).length, tok("--bg-3"), tok("--rule"), offLines(100 - on));
    describe(svg, `Waffle chart: ${on} of every 100 rides ${onLines(on).join(" ")}.`);
    return (s, dur) => {
      tr(cells, dur / 3).delay((i) => (s >= 0 ? (i * dur) / 80 : 0)).attr("opacity", s >= 0 ? 1 : 0);
      vis(t, s >= 0, dur, dur * 0.8);
    };
  };

  let cliffMode = 8;
  function drawCliff({ svg, W, H }) {
    const mode = cliffMode, R = D.results, narrow = W < 500;
    const m = { t: 16, r: 16, b: 40, l: 44 };
    const caps = R.capacities; const hi = (h) => R.hours.indexOf(h);
    const pick = (c) => (mode === "all" ? { ...c.all, ref: c.refused }
      : { m: c.byHour.m[hi(mode)], lo: c.byHour.lo[hi(mode)], hi: c.byHour.hi[hi(mode)], ref: c.refusedByHour[hi(mode)], lb: (c.lbByHour || [])[hi(mode)] });
    const allF = caps.flatMap((k) => R.curves[k].map((c) => c.fleet));
    const x = d3.scaleLinear().domain(d3.extent(allF)).nice().range([m.l, W - m.r]);
    const ymax = 45;
    const y = d3.scaleLinear().domain([0, ymax]).range([H - m.b, m.t]);
    const yc = (v) => y(Math.min(ymax, v));
    gridY(svg, y, m, W, 6);
    const bus = mode === "all" ? R.bus_day_total_min : R.bus_total_min[hi(mode)];
    const band = svg.append("g").attr("opacity", 0);
    const gBus = svg.append("g");
    gBus.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(bus)).attr("y2", y(bus)).attr("stroke", tok("--bus")).attr("stroke-width", 2);
    gBus.append("text").attr("class", "callout").attr("x", W - m.r).attr("y", y(bus) - 6).attr("text-anchor", "end").attr("fill", tok("--bus")).text(`bus ${bus.toFixed(1)} min`);
    const wBus = wipe(svg, gBus, m.l, W - m.r, false);
    const dash = { 4: "5 4", 10: null, 20: "1.5 4" };
    const hue = { 4: tok("--sodium-deep"), 10: tok("--sodium"), 20: tok("--sodium-light") };
    const wipes = {}, curves = {}, tLabs = {};
    for (const k of caps) {
      const pts = R.curves[k].map((c) => ({ f: c.fleet, ...pick(c) })).filter((p) => p.m != null);
      const g = svg.append("g");
      g.append("path").datum(pts).attr("fill", tok("--sodium")).attr("opacity", k === 10 ? 0.16 : 0.08)
        .attr("d", d3.area().x((p) => x(p.f)).y0((p) => yc(p.lo)).y1((p) => yc(p.hi)));
      g.append("path").datum(pts).attr("fill", "none").attr("stroke", hue[k]).attr("stroke-width", k === 10 ? 2.4 : 1.8)
        .attr("stroke-dasharray", dash[k]).attr("d", d3.line().x((p) => x(p.f)).y((p) => yc(p.m)));
      // whisker: mean if each refused rider counts as 45 min + a direct ride (a lower bound)
      g.append("g").selectAll("line").data(pts.filter((p) => p.ref > 0 && p.lb != null && p.lb > p.m)).join("line")
        .attr("x1", (p) => x(p.f)).attr("x2", (p) => x(p.f)).attr("y1", (p) => yc(p.m)).attr("y2", (p) => yc(p.lb))
        .attr("stroke", hue[k]).attr("stroke-width", 1).attr("stroke-dasharray", "2 2");
      // filled = no refused riders; open = the fleet also refused riders (waits over 45 min)
      g.append("g").selectAll("circle").data(pts).join("circle").attr("cx", (p) => x(p.f)).attr("cy", (p) => yc(p.m))
        .attr("r", k === 10 ? 3.4 : 2.6).attr("fill", (p) => (p.ref > 0 ? tok("--bg") : hue[k]))
        .attr("stroke", hue[k]).attr("stroke-width", 1.4)
        .append("title").text((p) => `${k} seats, ${p.f} vehicles: ${p.m.toFixed(1)} min${p.ref > 0 ? `, ${(100 * p.ref).toFixed(1)}% refused` + (p.lb != null ? ` (at least ${p.lb.toFixed(1)} min counting them)` : "") : ""}`);
      wipes[k] = wipe(svg, g, m.l, W - m.r, true);
      // smallest fleet from which every larger fleet matches the bus with nobody refused
      let t = null;
      for (let i = pts.length - 1; i >= 0 && pts[i].m <= bus && !(pts[i].ref > 0); i--) t = i;
      curves[k] = { pts, t };
      if (k !== 10 && t != null) {
        tLabs[k] = svg.append("text").attr("class", "lab").style("fill", hue[k]).attr("x", x(pts[t].f)).attr("y", yc(pts[t].m) - 9)
          .attr("text-anchor", "middle").attr("opacity", 0).text(fmtInt(pts[t].f));
      }
    }
    // rings and labels for the threshold and an undersized fleet
    // dy moves the label above (negative) or below the ring, off the curve
    const mark = (p, color, txt, dy) => {
      const g = svg.append("g").attr("opacity", 0);
      const cx = x(p.f), cy = yc(p.m), right = cx > W * 0.62;
      g.append("circle").attr("cx", cx).attr("cy", cy).attr("r", 8).attr("fill", "none").attr("stroke", color).attr("stroke-width", 1.8);
      g.append("text").attr("class", "callout").attr("x", cx + (right ? -10 : 10)).attr("y", cy + dy).attr("text-anchor", right ? "end" : "start").style("fill", color).text(txt);
      return g;
    };
    const P = curves[10].pts, ti = curves[10].t;
    const lab = (p) => `${p.f}: ${p.m.toFixed(1)} min`;
    const mOk = ti != null ? mark(P[ti], tok("--good"), narrow ? lab(P[ti]) : `${lab(P[ti])}, keeps up`, 22) : null;
    const mLo = ti != null && ti > 0 ? mark(P[ti - 1], tok("--bad"), lab(P[ti - 1]), -14) : null;
    if (ti != null && ti > 0) {
      band.append("rect").attr("x", x(P[ti - 1].f)).attr("width", x(P[ti].f) - x(P[ti - 1].f)).attr("y", m.t).attr("height", H - m.b - m.t)
        .attr("fill", tok("--bad")).attr("opacity", 0.1);
    }
    const p3 = P.find((p) => p.f === +((R.numbers || {}).f_lo3)) || P.filter((p) => p.ref > 0.005).slice(-1)[0];
    const m3 = p3 && p3 !== P[ti - 1] ? mark(p3, tok("--bad"), `${p3.f}: ${p3.m.toFixed(1)} min${p3.ref > 0 ? `, ${(100 * p3.ref).toFixed(1)}% refused${mode === "all" ? "" : narrow ? "" : " this hour"}` : ""}`, -14) : null;
    const lg = svg.append("g").attr("transform", `translate(${W - m.r - 150},${m.t + 6})`);
    const lgItems = {};
    caps.forEach((k, i) => {
      const g = lg.append("g").attr("opacity", 0); lgItems[k] = g;
      g.append("line").attr("x1", 0).attr("x2", 26).attr("y1", i * 16).attr("y2", i * 16).attr("stroke", hue[k])
        .attr("stroke-width", k === 10 ? 2.4 : 1.8).attr("stroke-dasharray", dash[k]);
      g.append("text").attr("class", "lab").attr("x", 32).attr("y", i * 16 + 4).text(`${k}-seat shuttles`);
    });
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).ticks(narrow ? 5 : 7));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(6).tickFormat((d) => `${d}`));
    svg.append("text").attr("class", "lab").attr("x", W - m.r).attr("y", H - 6).attr("text-anchor", "end").text("vehicles in the fleet");
    svg.append("text").attr("class", "lab").attr("x", 4).attr("y", m.t - 4).text("min");
    describe(svg, `Line chart: mean stop-to-stop minutes against fleet size (${mode === "all" ? "whole day" : pad(mode) + ":00 hour"}). Bus: ${bus.toFixed(1)} min. Ten-seat shuttles: ` + P.map((p) => `${p.f} vehicles ${p.m.toFixed(1)} min${p.ref > 0 ? " with " + (100 * p.ref).toFixed(0) + "% refused" : ""}`).join("; ") + ".");
    return (s, dur) => {
      wBus(s >= 0 ? 1 : 0, s >= 0 ? dur : 0);
      wipes[10](s >= 1 ? 1 : 0, s >= 1 ? dur * 1.8 : dur / 2);
      for (const k of caps) if (k !== 10) { wipes[k](s >= 4 ? 1 : 0, s >= 4 ? dur * 1.8 : dur / 2); vis(tLabs[k], s >= 4, dur, dur * 1.6); }
      for (const k of caps) vis(lgItems[k], k === 10 ? s >= 1 : s >= 4, dur);
      vis(mOk, s >= 1, dur, dur * 1.5);
      vis(mLo, s >= 2, dur); vis(band, s >= 2, dur);
      vis(m3, s >= 3, dur);
    };
  }

  const AV_FLEET = 16; // MOT, 18 Sep 2026: "only 16 passenger vehicles, all in Punggol"
  function unitsGeom(W) {
    const cols = W < 520 ? 30 : 45, p = (W - 4) / cols;
    const n = D.results.all_day_parity["10"], nb = D.baseline.buses_inside_all[D.baseline.hours.indexOf(7)];
    const y0 = 26, y1 = y0 + Math.ceil(n / cols) * p + 36;
    return { cols, p, n, nb, y0, y1, H: Math.round(y1 + Math.ceil(nb / cols) * p + 32) };
  }
  function drawUnits({ svg, W, H }) {
    const { cols, p, n, nb, y0, y1 } = unitsGeom(W);
    const r = Math.max(1.8, p * 0.36);
    const cx = (i) => 2 + (i % cols) * p + p / 2, row = (i) => Math.floor(i / cols) * p + p / 2;
    const sh = svg.append("g").selectAll("circle").data(d3.range(n)).join("circle")
      .attr("cx", cx).attr("cy", (i) => y0 + row(i)).attr("r", r).attr("fill", tok("--sodium")).attr("opacity", 0);
    const bu = svg.append("g").selectAll("rect").data(d3.range(nb)).join("rect")
      .attr("x", (i) => cx(i) - r).attr("y", (i) => y1 + row(i) - r).attr("width", 2 * r).attr("height", 2 * r).attr("rx", 1)
      .attr("fill", tok("--bus")).attr("opacity", 0);
    const lSh = svg.append("text").attr("class", "callout").attr("x", 2).attr("y", y0 - 9).style("fill", tok("--sodium")).attr("opacity", 0).text(`${fmtInt(n)} ten-seat shuttles`);
    const lBu = svg.append("text").attr("class", "callout").attr("x", 2).attr("y", y1 - 9).style("fill", tok("--bus")).attr("opacity", 0).text(`${fmtInt(nb)} buses inside Yishun at 07:00`);
    const lAv = svg.append("text").attr("class", "callout").attr("x", 2).attr("y", H - 6).attr("opacity", 0)
      .text(W < 520 ? `white: all ${AV_FLEET} of Singapore's AVs (Sep 2026)` : `white: Singapore's whole autonomous passenger fleet, ${AV_FLEET} vehicles (Sep 2026)`);
    describe(svg, `Unit chart, one mark per vehicle: ${n} ten-seat shuttles against ${nb} buses inside Yishun at 07:00; Singapore's autonomous passenger fleet is ${AV_FLEET} vehicles.`);
    let prev = -1;
    return (s, dur) => {
      const first = prev < 0 && s >= 0, firstBus = prev < 1 && s >= 1; prev = s;
      tr(sh, dur / 2).delay((i) => (first ? (i * dur * 1.4) / n : 0))
        .attr("opacity", (i) => (s < 0 ? 0 : s >= 2 && i >= AV_FLEET ? 0.2 : 1))
        .attr("fill", (i) => (s >= 2 && i < AV_FLEET ? tok("--fg") : tok("--sodium")))
        .attr("r", (i) => (s >= 2 && i < AV_FLEET ? r * 1.25 : r));
      tr(bu, dur / 2).delay((i) => (firstBus ? (i * dur) / nb : 0)).attr("opacity", s >= 1 ? 1 : 0);
      vis(lSh, s >= 0, dur); vis(lBu, s >= 1, dur, dur * 0.5); vis(lAv, s >= 2, dur, dur * 0.3);
    };
  }

  function drawKm({ svg, W, H }) {
    const R = D.results, ref = R.reference, B = D.baseline;
    const m = { l: 2, r: W < 520 ? 74 : 96 };
    const groups = [
      { title: "vehicle-km inside Yishun per weekday", rows: [["10-seat shuttles", ref.veh_km, "--sodium", fmtInt(ref.veh_km)], ["buses, all services", B.bus_km_inside_day, "--bus", fmtInt(B.bus_km_inside_day)]] },
      { title: "riders on board per vehicle-km", rows: [["10-seat shuttles", ref.occupancy, "--sodium", ref.occupancy.toFixed(1)], ["buses (a lower bound)", R.bus_pax_per_km_lower, "--bus", `≥ ${Math.round(R.bus_pax_per_km_lower)}`]] },
    ];
    const gh = (H - 20) / 2;
    const G = groups.map((grp, gi) => {
      const g = svg.append("g").attr("transform", `translate(0,${8 + gi * gh})`).attr("opacity", 0);
      g.append("text").attr("class", "ttl").attr("x", m.l).attr("y", 12).text(grp.title);
      const x = d3.scaleLinear().domain([0, d3.max(grp.rows, (r) => r[1])]).range([0, W - m.l - m.r]);
      const bars = [], vals = [];
      grp.rows.forEach(([lab, v, c, txt], i) => {
        const yy = 30 + i * 44;
        g.append("text").attr("class", "lab").attr("x", m.l).attr("y", yy + 10).text(lab);
        bars.push(g.append("rect").attr("x", m.l).attr("y", yy + 16).attr("height", 18).attr("rx", 2).attr("width", 0).attr("fill", tok(c)).datum(x(v)));
        vals.push(g.append("text").attr("class", "callout").attr("x", m.l + 6).attr("y", yy + 30).style("fill", tok(c)).datum(x(v)).text(txt));
      });
      return { g, bars, vals };
    });
    describe(svg, `Bar chart: shuttles drive ${fmtInt(ref.veh_km)} km inside Yishun per weekday against ${fmtInt(B.bus_km_inside_day)} km by buses; they carry ${ref.occupancy.toFixed(1)} riders per vehicle-km against at least ${Math.round(R.bus_pax_per_km_lower)} for buses.`);
    return (s, dur) => G.forEach(({ g, bars, vals }, gi) => {
      const on = s >= gi;
      vis(g, on, dur / 2);
      bars.forEach((b, i) => tr(b, dur * 1.2, on ? 200 + i * 250 : 0).attr("width", (w) => (on ? w : 0)));
      vals.forEach((t, i) => tr(t, dur * 1.2, on ? 200 + i * 250 : 0).attr("x", (w) => m.l + (on ? w : 0) + 6));
    });
  }

  function drawFrontier({ svg, W, H }) {
    const R = D.results, B = D.baseline; const m = { t: 26, r: 16, b: 34, l: 44 };
    const narrow = W < 500; // on phones the two value labels move into the legend below the chart
    const hrs = R.hours.filter((h) => h <= 24);
    const x = d3.scaleLinear().domain([hrs[0], hrs[hrs.length - 1]]).range([m.l, W - m.r]);
    const busAll = B.buses_inside_all || [];
    const fixed = R.all_day_parity && R.all_day_parity["10"];
    const vals = [...Object.values(R.frontier || {}).flat(), ...B.feeder_buses_on_road, ...busAll, fixed || 0].filter((v) => v != null);
    const y = d3.scaleLinear().domain([0, d3.max(vals) * 1.1]).nice().range([H - m.b, m.t]);
    gridY(svg, y, m, W, 5);
    const line = d3.line().defined((d) => d.v != null).x((d) => x(d.h)).y((d) => y(d.v)).curve(d3.curveStepAfter);
    const series = (arr) => hrs.map((h) => ({ h, v: arr[B.hours.indexOf(h)] }));
    const fb = series(B.feeder_buses_on_road), ab = series(busAll);
    const gBus = svg.append("g");
    if (busAll.length) gBus.append("path").datum(ab).attr("fill", "none").attr("stroke", tok("--bus")).attr("stroke-width", 2.2).attr("d", line);
    gBus.append("path").datum(fb).attr("fill", "none").attr("stroke", tok("--bus-light")).attr("stroke-width", 1.6).attr("stroke-dasharray", "5 4").attr("d", line);
    const wBus = wipe(svg, gBus, m.l, W - m.r, false);
    const gFix = svg.append("g").attr("opacity", 0);
    if (fixed) {
      gFix.append("line").attr("x1", x(hrs[0])).attr("x2", x(hrs[hrs.length - 1])).attr("y1", y(fixed)).attr("y2", y(fixed))
        .attr("stroke", tok("--sodium")).attr("stroke-width", 1).attr("opacity", 0.8);
    }
    const wFix = wipe(svg, gFix, m.l, W - m.r, false);
    const dash = { 4: "5 4", 10: null, 20: "1.5 4" };
    const hue = { 4: "--sodium-deep", 10: "--sodium", 20: "--sodium-light" };
    const gFr = svg.append("g");
    for (const k of R.capacities) {
      const fr = (R.frontier || {})[k]; if (!fr) continue;
      const d = hrs.map((h) => ({ h, v: fr[R.hours.indexOf(h)] }));
      gFr.append("path").datum(d).attr("fill", "none").attr("stroke", tok(hue[k] || "--sodium")).attr("stroke-width", k === 10 ? 2.4 : 1.6).attr("stroke-dasharray", dash[k]).attr("d", line);
    }
    const wFr = wipe(svg, gFr, m.l, W - m.r, false);
    // labels go on top of the lines, so their halo keeps the hourly steps off the text
    const lFix = fixed && !narrow ? svg.append("text").attr("class", "callout").attr("x", x(hrs[hrs.length - 1])).attr("y", y(fixed) - 6).attr("text-anchor", "end")
      .attr("opacity", 0).text(`fixed fleet: ${fmtInt(fixed)}`) : null;
    svg.append("text").attr("class", "lab").attr("x", 4).attr("y", m.t - 12).text("vehicles");
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).tickValues(hrs.filter((h) => h % 3 === 0)).tickFormat(hourLabel));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5));
    const pk = R.frontier_peak && R.frontier_peak["10"];
    const f10 = (R.frontier || {})["10"] || [];
    describe(svg, `Step chart of vehicles needed by hour if the fleet could change size every hour. Ten-seat shuttles: ` + hrs.map((h) => `${pad(h % 24)}:00 ${f10[R.hours.indexOf(h)] ?? "n/a"}`).join(", ") + `. Fixed fleet all day: ${fixed}. Buses of all services inside Yishun peak at about ${d3.max(ab, (d) => d.v)}; feeder buses on the road at about ${d3.max(fb, (d) => d.v)}.`);
    const lPk = pk && !narrow ? svg.append("text").attr("class", "callout").attr("x", x(pk.hour + 2) + 6).attr("y", y(Math.max(pk.fleet, fixed || 0)) - 8).attr("opacity", 0).text(`hourly peak: ${pk.fleet} at ${pad(pk.hour)}:00`) : null;
    const v12 = f10[R.hours.indexOf(12)];
    const lMid = v12 != null ? svg.append("text").attr("class", "callout").attr("x", x(12.5)).attr("y", y(v12) - 8).attr("text-anchor", "middle").attr("opacity", 0).text(`${fmtInt(v12)} at noon`) : null;
    const leg = document.getElementById("frontier-legend");
    if (leg) {
      const peak = narrow && pk ? ` (peak ${fmtInt(pk.fleet)} at ${pad(pk.hour)}:00)` : "";
      const items = [...R.capacities.map((k) => [hue[k] || "--sodium", k === 10 ? "solid" : k === 4 ? "dashed" : "dotted", `${k}-seat, fleet changes hourly${k === 10 ? peak : ""}`]),
        ["--sodium", "solid thin", `fixed 10-seat fleet, all day${narrow && fixed ? `: ${fmtInt(fixed)}` : ""}`], ["--bus", "solid", "buses inside Yishun"], ["--bus-light", "dashed", "feeder buses on the road"]];
      leg.innerHTML = items.map(([c, st, lab]) => `<span><i style="border-top:${st.includes("thin") ? 1 : 2}px ${st.split(" ")[0]} var(${c})"></i>${lab}</span>`).join("");
    }
    return (s, dur) => {
      wBus(s >= 0 ? 1 : 0, s >= 0 ? dur * 1.6 : 0);
      vis(gFix, s >= 0, dur, dur); wFix(s >= 0 ? 1 : 0, s >= 0 ? dur : 0);
      vis(lFix, s >= 0, dur, dur * 1.6);
      wFr(s >= 1 ? 1 : 0, s >= 1 ? dur * 1.8 : dur / 2);
      vis(lPk, s >= 1, dur, dur * 1.2); vis(lMid, s >= 1, dur, dur * 1.6);
    };
  }

  function drawKerb({ svg, W, H }) {
    const R = D.results.reference; const m = { t: 22, r: W < 500 ? 78 : 96, b: 34, l: 40 };
    const hrs = D.results.hours.filter((h) => h <= 24);
    const x = d3.scaleBand().domain(hrs).range([m.l, W - m.r]).padding(0.15);
    const st = Object.keys(R.kerb || {});
    if (!st.length) return () => {};
    const y = d3.scaleLinear().domain([0, d3.max(st.flatMap((s) => R.kerb[s])) * 1.1]).nice().range([H - m.b, m.t]);
    gridY(svg, y, m, W, 5);
    const colors = { Yishun: tok("--sodium"), Khatib: tok("--rider"), Springleaf: tok("--mute") };
    const G = {};
    // direct labels at the right, spread so they never overlap
    const ends = st.map((s) => ({ s, v: R.kerb[s][D.results.hours.indexOf(hrs[hrs.length - 1])] || 0 })).sort((a, b) => b.v - a.v);
    const labY = {}; let lastY = -1e9;
    for (const e of ends) { const yy = Math.max(y(e.v) + 4, lastY + 14); lastY = yy; labY[e.s] = yy; }
    for (const s of st) {
      const d = hrs.map((h) => ({ h, v: R.kerb[s][D.results.hours.indexOf(h)] }));
      const g = svg.append("g");
      g.append("path").datum(d).attr("fill", "none").attr("stroke", colors[s] || tok("--fg")).attr("stroke-width", s === "Yishun" ? 2.4 : 1.6)
        .attr("d", d3.line().x((p) => x(p.h) + x.bandwidth() / 2).y((p) => y(p.v || 0)));
      g.append("text").attr("class", "lab").style("fill", colors[s] || tok("--fg")).attr("x", W - m.r + 6).attr("y", labY[s]).text(W < 500 ? s : `${s} MRT`);
      G[s] = wipe(svg, g, m.l, W, false);
    }
    const ys = R.kerb.Yishun || R.kerb[st[0]], yi = d3.maxIndex(ys);
    const peak = svg.append("g").attr("opacity", 0);
    const px = x(hrs[yi]) + x.bandwidth() / 2, py = y(ys[yi]);
    peak.append("circle").attr("cx", px).attr("cy", py).attr("r", 6).attr("fill", "none").attr("stroke", tok("--sodium")).attr("stroke-width", 1.8);
    peak.append("text").attr("class", "callout").attr("x", px + (px > W * 0.5 ? -10 : 10)).attr("y", py - 10).attr("text-anchor", px > W * 0.5 ? "end" : "start")
      .text(`${Math.round(ys[yi])} at once, ${pad(hrs[yi] % 24)}:00`);
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).tickValues(hrs.filter((h) => h % 3 === 0)).tickFormat(hourLabel));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5));
    svg.append("text").attr("class", "lab").attr("x", 4).attr("y", m.t - 8).text("shuttles stopped at once");
    describe(svg, "Line chart of the most shuttles stopped at once, by hour: " + st.map((s) => `${s} MRT up to ${d3.max(R.kerb[s])}`).join(", ") + ".");
    return (s, dur) => {
      for (const k of st) { const on = k === "Yishun" ? s >= 0 : s >= 1; G[k](on ? 1 : 0, on ? dur * 1.8 : dur / 2); }
      vis(peak, s >= 0, dur, dur * 1.6);
    };
  }

  function drawKerbCap({ svg, W, H }) {
    const K = D.results.kerb_experiment || [], ref = D.results.reference.fleet;
    const key = (r) => (r.berths === -1 ? 1e9 : r.berths);
    const rows = K.filter((r) => r.fleet === ref).sort((a, b) => key(b) - key(a));
    if (!rows.length) return () => {};
    const moreF = d3.min(K.filter((r) => r.fleet > ref), (r) => r.fleet);
    const more = new Map(K.filter((r) => r.fleet === moreF).map((r) => [r.berths, r]));
    const narrow = W < 500, m = { t: 30, r: 12, b: 44, l: 40 };
    const lab = (b) => (b === -1 ? (narrow ? "none" : "no limit") : String(b));
    const x = d3.scaleBand().domain(rows.map((r) => lab(r.berths))).range([m.l, W - m.r]).padding(0.28);
    const ymax = 45, y = d3.scaleLinear().domain([0, ymax]).range([H - m.b, m.t]);
    gridY(svg, y, m, W, 5);
    const bw = moreF ? x.bandwidth() * 0.58 : x.bandwidth();
    const bus = rows[0].h7_bus_min;
    const G = rows.map((r) => {
      const x0 = x(lab(r.berths)), c = r.h7_ok ? tok("--good") : tok("--bad");
      const h = y(0) - y(Math.min(ymax, r.h7_total_min));
      const bar = svg.append("rect").attr("x", x0).attr("width", bw).attr("y", y(0)).attr("height", 0).attr("fill", c).attr("opacity", 0.85).datum(h);
      // values sit inside the bar where it is wide enough, above it on phones
      const val = svg.append("text").attr("x", x0 + bw / 2).attr("y", narrow ? y(0) - h - 5 : y(0) - h + 15).attr("text-anchor", "middle").attr("opacity", 0)
        .attr("class", narrow ? "callout" : null).style("font-size", narrow ? "11px" : "12px")
        .style("fill", narrow ? null : tok("--bg")).style("font-family", "var(--font-data)").style("font-weight", narrow ? null : 600)
        .text(r.h7_total_min > ymax ? `${Math.round(r.h7_total_min)}↑` : r.h7_total_min.toFixed(1));
      const o = more.get(r.berths);
      let ghost = null;
      if (o) {
        const gh = y(0) - y(Math.min(ymax, o.h7_total_min));
        ghost = svg.append("rect").attr("x", x0 + bw + 2).attr("width", x.bandwidth() - bw - 2).attr("y", y(0) - gh).attr("height", gh)
          .attr("fill", "none").attr("stroke", o.h7_ok ? tok("--good") : tok("--bad")).attr("stroke-width", 1.2).attr("opacity", 0);
      }
      return { r, bar, val, ghost };
    });
    const gBus = svg.append("g").attr("opacity", 0);
    gBus.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(bus)).attr("y2", y(bus)).attr("stroke", tok("--bus")).attr("stroke-width", 2);
    gBus.append("text").attr("class", "callout").attr("x", m.l + 4).attr("y", y(bus) - 6).style("fill", tok("--bus")).text(`bus ${bus.toFixed(1)} min`);
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5));
    svg.append("text").attr("class", "lab").attr("x", W - m.r).attr("y", H - 6).attr("text-anchor", "end").text(narrow ? "shuttles allowed at once per station" : "shuttles allowed to board or alight at once, per station");
    svg.append("text").attr("class", "lab").attr("x", 4).attr("y", m.t - 16).text("min, 07:00 hour");
    const kg = svg.append("g").attr("transform", `translate(${W - m.r - (narrow ? 210 : 260)},${m.t - 20})`).attr("opacity", 0);
    if (moreF) {
      kg.append("rect").attr("x", 0).attr("y", -9).attr("width", 10).attr("height", 10).attr("fill", tok("--mute"));
      kg.append("text").attr("class", "lab").attr("x", 15).attr("y", 0).text(`${fmtInt(ref)} shuttles`);
      kg.append("rect").attr("x", narrow ? 105 : 125).attr("y", -9).attr("width", 10).attr("height", 10).attr("fill", "none").attr("stroke", tok("--mute"));
      kg.append("text").attr("class", "lab").attr("x", narrow ? 120 : 140).attr("y", 0).text(`${fmtInt(moreF)} shuttles`);
    }
    describe(svg, `Bar chart of mean 07:00 stop-to-stop minutes by kerb limit with ${ref} shuttles: ` + rows.map((r) => `${lab(r.berths)} ${r.h7_total_min.toFixed(1)} min`).join(", ") + `; bus ${bus.toFixed(1)} min.`);
    return (s, dur) => {
      vis(gBus, s >= 0, dur);
      let k = 0;
      for (const { r, bar, val, ghost } of G) {
        const on = r.h7_ok ? s >= 0 : s >= 1, d = on ? 150 + 140 * k++ : 0;
        tr(bar, dur, d).attr("y", (h) => (on ? y(0) - h : y(0))).attr("height", (h) => (on ? h : 0));
        vis(val, on, dur, d + dur * 0.6);
        vis(ghost, s >= 1, dur, dur * 1.2);
      }
      vis(kg, s >= 1, dur, dur);
    };
  }

  function drawWho({ svg, W, H }) {
    const R = D.results.who;
    const narrow = W < 500; // on phones the unit note gets its own line between the axis and the key
    const m = { t: 22, r: 16, b: narrow ? 64 : 50, l: 44 };
    const labels = R.bands_m.slice(0, -1).map((b, i) => `${b / 1000}–${R.bands_m[i + 1] / 1000}${narrow ? "" : " km"}`);
    if (narrow) svg.append("text").attr("class", "lab").attr("x", W - m.r).attr("y", H - 30).attr("text-anchor", "end").text("straight-line km");
    const x0 = d3.scaleBand().domain(labels).range([m.l, W - m.r]).padding(0.22);
    const x1 = d3.scaleBand().domain(["hub", "estate"]).range([0, x0.bandwidth()]).padding(0.08);
    const y = d3.scaleLinear().domain([0, 1]).range([H - m.b, m.t]);
    gridY(svg, y, m, W, 5);
    const col = { hub: tok("--sodium"), estate: tok("--rider") };
    const bars = [];
    labels.forEach((lab, i) => {
      for (const k of ["hub", "estate"]) {
        const v = R[k][i]; if (v == null) continue;
        bars.push({ i, k, v, el: svg.append("rect").attr("x", x0(lab) + x1(k)).attr("width", x1.bandwidth()).attr("y", y(0)).attr("height", 0).attr("fill", col[k]).attr("opacity", 0.85) });
      }
    });
    // the shortest band, all rides together, for the highlight
    const n0 = (R.n_hub[0] || 0) + (R.n_estate[0] || 0);
    const short = n0 ? ((R.hub[0] || 0) * R.n_hub[0] + (R.estate[0] || 0) * R.n_estate[0]) / n0 : null;
    const hl = short != null ? svg.append("text").attr("class", "callout").attr("x", x0(labels[0]) + x0.bandwidth() / 2).attr("y", y(Math.max(R.hub[0], R.estate[0])) - 8)
      .attr("text-anchor", "middle").attr("opacity", 0).text(`${Math.round(100 * short)}%`) : null;
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x0));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5).tickFormat(d3.format(".0%")));
    svg.append("text").attr("class", "lab").attr("x", 4).attr("y", m.t - 8).text("faster by shuttle");
    const key = svg.append("g").attr("transform", `translate(${m.l},${H - 10})`);
    [["to or from a station", col.hub], ["within the estates", col.estate]].forEach(([lab, c], i) => {
      const g = key.append("g").attr("transform", `translate(${i * 170},0)`);
      g.append("rect").attr("x", 0).attr("y", -9).attr("width", 10).attr("height", 10).attr("fill", c);
      g.append("text").attr("class", "lab").attr("x", 15).attr("y", 0).text(lab);
    });
    describe(svg, "Bar chart: share of rides faster by shuttle than by bus, by straight-line length. To or from a station: " + labels.map((l, i) => `${l} ${Math.round(100 * (R.hub[i] || 0))}%`).join(", ") + ". Within estates: " + labels.map((l, i) => `${l} ${Math.round(100 * (R.estate[i] || 0))}%`).join(", ") + ".");
    let prev = -1;
    return (s, dur) => {
      const first = prev < 0 && s >= 0; prev = s;
      for (const b of bars) {
        tr(b.el, dur, first ? b.i * 140 + (b.k === "estate" ? 70 : 0) : 0)
          .attr("y", s >= 0 ? y(b.v) : y(0)).attr("height", s >= 0 ? y(0) - y(b.v) : 0)
          .attr("opacity", s >= 1 && b.i !== 0 ? 0.25 : 0.85);
      }
      vis(hl, s >= 1, dur, dur * 0.5);
    };
  }

  function drawCal({ svg, W, H }) {
    const P = D.calpts; const m = { t: 16, r: 16, b: 40, l: 44 };
    const mx = Math.ceil(d3.max(P.points, (p) => Math.max(p[0], p[1])) / 60);
    const x = d3.scaleLinear().domain([0, mx]).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([0, mx]).range([H - m.b, m.t]);
    gridY(svg, y, m, W, 5);
    const gd = svg.append("g");
    gd.append("line").attr("x1", x(0)).attr("y1", y(0)).attr("x2", x(mx)).attr("y2", y(mx)).attr("stroke", tok("--mute")).attr("stroke-dasharray", "3 4");
    const wd = wipe(svg, gd, m.l, W - m.r, false);
    const rnd = d3.randomLcg(7);
    const dots = svg.append("g").selectAll("circle").data(P.points.map((p) => ({ p, d: rnd() }))).join("circle")
      .attr("cx", (o) => x(o.p[0] / 60)).attr("cy", (o) => y(o.p[1] / 60)).attr("r", 0).attr("fill", tok("--bus")).attr("opacity", 0.45);
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`), d3.axisBottom(x).ticks(6));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(6));
    svg.append("text").attr("class", "lab").attr("x", W - m.r).attr("y", H - 6).attr("text-anchor", "end").text("observed median running time (min)");
    svg.append("text").attr("class", "lab").attr("x", m.l + 6).attr("y", m.t + 4).text("modelled (min)");
    describe(svg, `Scatter plot of modelled against observed bus running times for ${P.points.length} stop sequences; points lie close to the diagonal.`);
    return (s, dur) => {
      tr(dots, dur / 2).delay((o) => (s >= 0 ? o.d * dur * 1.6 : 0)).attr("r", (o) => (s >= 0 ? Math.min(4, 1 + Math.sqrt(o.p[2]) / 6) : 0));
      wd(s >= 0 ? 1 : 0, s >= 0 ? dur * 2.2 : 0);
    };
  }

  function drawGps({ svg, W, H }) {
    const G = D.results.gps_check; if (!G || !G.by_hour) return () => {};
    const rows = Object.entries(G.by_hour).map(([h, b]) => ({ h: +h, ...b })).filter((r) => r.n_pairs >= 20).sort((a, b) => a.h - b.h);
    if (!rows.length) return () => {};
    const m = { t: 30, r: 16, b: 34, l: 44 };
    const hrs = d3.range(10, 20);
    const x = d3.scaleBand().domain(hrs).range([m.l, W - m.r]).padding(0.3);
    const lo = Math.min(0.8, d3.min(rows, (r) => r.pooled_ratio_ci[0])), hi = Math.max(1.2, d3.max(rows, (r) => r.pooled_ratio_ci[1]));
    const y = d3.scaleLinear().domain([lo, hi]).nice().range([H - m.b, m.t]);
    gridY(svg, y, m, W, 5);
    svg.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(1)).attr("y2", y(1)).attr("stroke", tok("--mute")).attr("stroke-dasharray", "3 4");
    svg.append("rect").attr("x", x(10) - 4).attr("width", x(12) + x.bandwidth() - x(10) + 8).attr("y", m.t).attr("height", H - m.b - m.t)
      .attr("fill", tok("--bus")).attr("opacity", 0.07);
    svg.append("text").attr("class", "lab").attr("x", x(10)).attr("y", m.t + 12).text("fitted here");
    const g = svg.append("g").selectAll("g").data(rows).join("g").attr("transform", (r) => `translate(${x(r.h) + x.bandwidth() / 2},0)`);
    const ci = g.append("line").attr("y1", (r) => y(r.pooled_ratio)).attr("y2", (r) => y(r.pooled_ratio)).attr("stroke", tok("--bus")).attr("stroke-width", 1.6);
    const dot = g.append("circle").attr("cy", y(1)).attr("r", 4).attr("fill", tok("--bus")).attr("opacity", 0);
    dot.append("title").text((r) => `${pad(r.h)}:00: ${r.pooled_ratio.toFixed(2)} (${r.pooled_ratio_ci[0].toFixed(2)}–${r.pooled_ratio_ci[1].toFixed(2)}), ${r.n_pairs} pairs`);
    axis(svg.append("g").attr("transform", `translate(0,${H - m.b})`),
      d3.axisBottom(x).tickValues(W < 500 ? hrs.filter((h) => h % 2 === 0) : hrs).tickFormat((h) => `${pad(h)}:00`));
    axis(svg.append("g").attr("transform", `translate(${m.l},0)`), d3.axisLeft(y).ticks(5).tickFormat(d3.format(".2f")));
    svg.append("text").attr("class", "lab").attr("x", 4).attr("y", 12).text("observed ÷ model");
    describe(svg, "Dot plot of observed over modelled bus running time by hour: " + rows.map((r) => `${pad(r.h)}:00 ${r.pooled_ratio.toFixed(2)}`).join(", ") + ".");
    return (s, dur) => {
      const on = s >= 0;
      tr(dot, dur, 0).delay((r, i) => (on ? i * 110 : 0)).attr("opacity", on ? 1 : 0).attr("cy", (r) => (on ? y(r.pooled_ratio) : y(1)));
      tr(ci, dur, 0).delay((r, i) => (on ? i * 110 + dur * 0.6 : 0))
        .attr("y1", (r) => y(on ? r.pooled_ratio_ci[0] : r.pooled_ratio)).attr("y2", (r) => y(on ? r.pooled_ratio_ci[1] : r.pooled_ratio));
    };
  }

  // ------------------------------------------------------------------ tables
  const numIn = (t) => { const m = t.match(/-?[\d,]*\.?\d+/); return m ? +m[0].replace(/,/g, "") : null; };
  const mbar = (w, c) => `<i class="mbar" style="--w:${Math.max(1.5, w).toFixed(1)}%;background:var(${c})"></i>`;

  function decorateOps() {
    const tb = document.querySelector("#ops tbody"); if (!tb) return;
    [...tb.rows].forEach((row, i) => {
      row.style.setProperty("--i", i);
      const [, a, b] = row.cells, va = numIn(a.textContent), vb = numIn(b.textContent);
      if (va == null || vb == null) return; // bars only where both modes have a figure
      const mx = Math.max(va, vb) || 1;
      a.insertAdjacentHTML("beforeend", mbar((100 * va) / mx, "--sodium"));
      b.insertAdjacentHTML("beforeend", mbar((100 * vb) / mx, "--bus"));
    });
    tb.closest("table").classList.add("reveal");
  }

  function renderSensitivity() {
    const S = D.results.sensitivity; if (!S || !S.length) return;
    const base = S.find((r) => r.id === "base");
    const fav = { 1: "bus", "-1": "shuttle", 0: "either" };
    // each row's fleet on a shared scale; markers start at the base case and slide to their value
    const known = S.map((r) => r.parity_fleet).filter((v) => v != null);
    const lo = d3.min(known) - 25, hi = d3.max(known) + 25, at = (v) => (v == null ? 100 : (100 * (v - lo)) / (hi - lo));
    const b0 = base && base.parity_fleet != null ? at(base.parity_fleet) : 50;
    const tb = document.querySelector("#sens-table tbody");
    tb.innerHTML = S.map((r, i) => {
      const n = r.parity_fleet == null ? "more than 800" : fmtInt(r.parity_fleet);
      const diff = r.parity_fleet != null && base && base.parity_fleet != null && r.id !== "base"
        ? ` <span style="color:var(--faint)">(${r.parity_fleet - base.parity_fleet >= 0 ? "+" : ""}${r.parity_fleet - base.parity_fleet})</span>` : "";
      const d = r.id === "base" ? "" : fav[String(r.direction ?? 0)] || "either";
      const atBase = r.id === "base" || (base && r.parity_fleet === base.parity_fleet);
      const strip = `<span class="strip" aria-hidden="true" style="--b:${b0.toFixed(1)}%;--to:${at(r.parity_fleet).toFixed(1)}%"><i class="base"></i><b class="${atBase ? "at-base" : ""}"></b></span>`;
      return `<tr style="--i:${i}"><td>${r.label}</td><td>${d}</td><td class="n">${n}${diff}${strip}</td><td class="n">${r.bus_day_min != null ? r.bus_day_min.toFixed(1) + " min" : "—"}</td></tr>`;
    }).join("");
    tb.closest("table").classList.add("reveal");
    // what moves the threshold and what does not, read from the table itself
    const note = document.getElementById("sens-note");
    if (note && base && base.parity_fleet != null) {
      const bus = S.filter((r) => r.id.startsWith("bus_")), others = S.filter((r) => r.id !== "base" && !r.id.startsWith("bus_"));
      const allBus = bus.length && bus.every((r) => r.parity_fleet === base.parity_fleet);
      const moved = others.filter((r) => r.parity_fleet !== base.parity_fleet).map((r) => r.parity_fleet).filter((v) => v != null);
      let t = allBus ? `None of the ${bus.length} bus assumptions moves the threshold: below it, the morning queue builds whatever the bus offers. ` : "";
      if (moved.length) t += `Road speeds, shuttle stop time, the dispatcher and demand do, between ${fmtInt(d3.min(moved))} and ${fmtInt(d3.max(moved))} vehicles.`;
      note.textContent = t;
      const ex = D.results.sensitivity_excluded || [], exEl = document.getElementById("sens-excl");
      if (exEl && ex.length) exEl.textContent = "Not in the table: " + ex.map((r) => `${r.name} (${r.parity_fleet ?? "n/a"} vehicles), because ${r.reason}.`).join(" ");
    }
  }

  function renderSubzones() {
    const W = D.results.who; const rows = (W && W.by_subzone) || [];
    const tb = document.querySelector("#who-sz tbody"); if (!tb || !rows.length) return;
    const mr = d3.max(rows, (r) => r.rides_per_day) || 1, mg = d3.max(rows, (r) => r.mean_gain_min) || 1, ma = d3.max(rows, (r) => r.share65) || 1;
    tb.innerHTML = rows.map((r, i) => `<tr style="--i:${i}"><td>${r.subzone}</td><td class="n">${fmtInt(r.rides_per_day)}${mbar((100 * r.rides_per_day) / mr, "--rider")}</td>`
      + `<td class="n">${(100 * r.share65).toFixed(0)}%${mbar((100 * r.share65) / ma, "--mute")}</td>`
      + `<td class="n">${(100 * r.share_faster).toFixed(0)}%${mbar(100 * r.share_faster, "--sodium")}</td>`
      + `<td class="n">${r.mean_gain_min.toFixed(1)} min${mbar((100 * r.mean_gain_min) / mg, "--sodium")}</td></tr>`).join("");
    tb.closest("table").classList.add("reveal");
    if (W.subzone_rho_65 != null) {
      const rho = W.subzone_rho_65, p = W.subzone_rho_p;
      const clear = p != null && p < 0.05;
      const word = clear ? (rho > 0 ? "rises with" : "falls with") : "shows no clear relation to";
      document.getElementById("who-sz-note").textContent = `Gains by the subzone where rides start. Across these ${rows.length} subzones the mean gain ${word} the census share of residents aged 65+ (Spearman ρ = ${rho.toFixed(2)}${p != null ? `, p = ${p.toFixed(2)}` : ""}). That share is context only: the fare-card data has no rider ages.`;
    }
  }

  // the kerb test, read from the experiment rows: the tightest limit that still keeps up and the
  // loosest that does not, plus the larger fleet at that limit
  function kerbFacts() {
    const K = D.results.kerb_experiment; if (!K || !K.length) return null;
    const ref = D.results.reference.fleet;
    const rows = K.filter((r) => r.fleet === ref);
    const free = rows.find((r) => r.berths === -1), tight = rows.filter((r) => r.berths !== -1);
    if (!free || !tight.length) return null;
    const fail = tight.filter((r) => !r.h7_ok).sort((a, b) => b.berths - a.berths)[0];
    const pass = tight.filter((r) => r.h7_ok).sort((a, b) => a.berths - b.berths)[0];
    const more = fail && K.find((r) => r.fleet > ref && r.berths === fail.berths);
    return { ref, free, pass, fail, more: more && more.h7_total_min > fail.h7_total_min ? more : null };
  }

  function renderKerbExperiment() {
    const k = kerbFacts(); if (!k) return;
    const { ref, free, pass, fail, more } = k;
    let txt = `Capping the kerb shows how much it matters. With ${fmtInt(ref)} shuttles and no limit, the 07:00 hour averages ${free.h7_total_min.toFixed(1)} min stop to stop (bus ${free.h7_bus_min.toFixed(1)}).`;
    if (pass) txt += ` Limiting each station to ${pass.berths} shuttles boarding at once still keeps up (${pass.h7_total_min.toFixed(1)} min; ${Math.round(100 * pass.peak_queued_share)}% of station stops queue, on average ${Math.round(pass.peak_queue_wait_mean_s)} s).`;
    if (fail) {
      txt += ` With a limit of ${fail.berths}, queues at the kerb push the 07:00 hour to ${fail.h7_total_min.toFixed(1)} min and the fleet no longer matches the bus.`;
      if (more) txt += ` Adding vehicles does not help: ${fmtInt(more.fleet)} shuttles with the same kerb take ${more.h7_total_min.toFixed(1)} min, because the extra vehicles queue too.`;
    }
    document.getElementById("kerb-exp-text").textContent = txt;
  }

  // ------------------------------------------------------------------ numbers in text
  function fillNumbers() {
    const R = D.results, cal = D.baseline.calibration || {}, v = R.numbers || {};
    for (const el of document.querySelectorAll("[data-v]")) { const k = el.dataset.v; if (v[k] != null) el.textContent = v[k]; }
    // figures the captions quote that the pipeline does not format: read from the same data
    const c = {};
    const hrs = D.demand.hours, rides = D.demand.rides_by_hour, pk = d3.maxIndex(rides);
    c.peak_rides = fmtInt(rides[pk]); c.peak_hour = `${pad(hrs[pk])}:00`;
    if (hrs.includes(18)) c.pm_rides = fmtInt(rides[hrs.indexOf(18)]);
    const w = R.who;
    if (w) {
      const share = (idx) => {
        let n = 0, f = 0;
        for (const i of idx) { n += w.n_hub[i] + w.n_estate[i]; f += w.hub[i] * w.n_hub[i] + w.estate[i] * w.n_estate[i]; }
        return n ? `${Math.round((100 * f) / n)}%` : null;
      };
      c.short_share = share([0]);
      c.long_share = share(w.bands_m.slice(0, -1).map((b, i) => i).filter((i) => w.bands_m[i] >= 1500));
    }
    const k = kerbFacts();
    if (k) {
      c.kerb_bus = `${k.free.h7_bus_min.toFixed(1)} min`;
      if (k.pass) { c.kerb_pass_b = String(k.pass.berths); c.kerb_pass_t = `${k.pass.h7_total_min.toFixed(1)} min`; }
      if (k.fail) { c.kerb_fail_b = String(k.fail.berths); c.kerb_fail_t = `${k.fail.h7_total_min.toFixed(1)} min`; }
      if (k.more) { c.kerb_more_f = fmtInt(k.more.fleet); c.kerb_more_t = `${k.more.h7_total_min.toFixed(1)} min`; }
    }
    for (const el of document.querySelectorAll("[data-c]")) { const x = c[el.dataset.c]; if (x != null) el.textContent = x; }
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

  // a number counts up from zero to the value it already shows, keeping its format
  function countUp(el, dur) {
    const txt = el.dataset.final || el.textContent; el.dataset.final = txt;
    const m = txt.match(/\d[\d,]*(\.\d+)?/);
    if (!m || !dur) { el.textContent = txt; return; }
    const raw = m[0], dec = (raw.split(".")[1] || "").length, target = +raw.replace(/,/g, "");
    const f = d3.format(`${raw.includes(",") ? "," : ""}.${dec}f`);
    d3.select(el).transition().duration(dur).ease(d3.easeCubicOut)
      .tween("text", () => (t) => { el.textContent = txt.slice(0, m.index) + f(target * t) + txt.slice(m.index + raw.length); });
  }

  // ------------------------------------------------------------------ scroll story
  // Each .scrolly holds one pinned graphic and a column of steps. The step whose caption has passed
  // the trigger line names a figure and a state; scrolling back up runs the states in reverse.
  const stories = [];
  function storyIndex(st) {
    const vh = window.innerHeight;
    let line;
    if (window.innerWidth <= 900) {
      // phones: the chart is pinned at the top, so each caption gets the space below it, and
      // takes over once its top is a third of the way up that space
      const gh = st.sc.querySelector(".graphic").offsetHeight;
      st.sc.style.setProperty("--step-h", `${Math.max(0.3 * vh, vh - gh)}px`);
      line = vh - 0.4 * Math.max(0, vh - gh);
    } else line = 0.62 * vh;
    let idx = -1;
    st.steps.forEach((s, i) => {
      const r = (s.firstElementChild || s).getBoundingClientRect();
      if ((window.innerWidth <= 900 ? r.top : r.top + r.height / 2) < line) idx = i;
    });
    return idx;
  }
  function applyStep(st, idx, dur) {
    const step = st.steps[Math.max(0, idx)], fig = step.dataset.fig, s = idx < 0 ? -1 : +step.dataset.s;
    st.steps.forEach((el, i) => { el.classList.toggle("is-active", i === idx); el.classList.toggle("is-past", i < idx); });
    for (const f of st.figs) {
      const on = f.dataset.fig === fig;
      f.classList.toggle("on", on);
      // a figure that has faded out goes back to its empty frame, so it draws again next time
      if (!on && CH[f.dataset.fig] && CH[f.dataset.fig].state !== -1) {
        clearTimeout(f._reset);
        f._reset = setTimeout(() => { if (!f.classList.contains("on")) CH[f.dataset.fig].set(-1, 0); }, 550);
      }
    }
    if (CH[fig]) { clearTimeout(st.figs.find((f) => f.dataset.fig === fig)._reset); CH[fig].set(s, dur); }
    if (idx >= 0 && !step.dataset.counted) {
      step.dataset.counted = "1";
      for (const el of step.querySelectorAll(".big [data-v], .big [data-c]")) countUp(el, dur ? 1100 : 0);
    }
  }
  function onScroll() {
    const phone = window.innerWidth <= 900;
    for (const st of stories) {
      // phones: a caption fades as it reaches the bottom of the pinned chart, so it never covers it
      const gb = phone ? st.sc.querySelector(".graphic").getBoundingClientRect().bottom : -1e9;
      for (const s of st.steps) s.classList.toggle("is-under", phone && (s.firstElementChild || s).getBoundingClientRect().top < gb - 4);
      const i = still ? st.steps.length - 1 : storyIndex(st);
      if (i !== st.cur) { st.cur = i; applyStep(st, i, DUR); }
    }
  }
  function setupStories() {
    for (const sc of document.querySelectorAll(".scrolly")) {
      stories.push({ sc, steps: [...sc.querySelectorAll(".step")], figs: [...sc.querySelectorAll(".stack > figure")], cur: null });
    }
    onScroll();
    let ticking = false;
    window.addEventListener("scroll", () => {
      if (ticking) return; ticking = true;
      requestAnimationFrame(() => { ticking = false; onScroll(); });
    }, { passive: true });
  }

  // charts and tables outside the story draw once, when they first come into view
  function onEnter(el, fn) {
    if (still || !("IntersectionObserver" in window)) { fn(); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); } }, { threshold: 0.25 });
    io.observe(el);
  }

  const CHARTS = [
    ["ch-demand", 300, drawDemand], ["ch-length", 300, drawLength],
    ["ch-hub", waffleH, drawWaffle(() => D.demand.hub_share, "--sodium",
      () => ["start or end at an MRT station", "or the bus interchange"], () => ["neither"])],
    ["ch-cliff", 340, drawCliff], ["ch-units", (W) => unitsGeom(W).H, drawUnits], ["ch-km", 270, drawKm],
    ["ch-frontier", 320, drawFrontier], ["ch-kerb", 300, drawKerb], ["ch-kerbcap", 300, drawKerbCap],
    ["ch-faster", waffleH, drawWaffle(() => D.results.who.share_faster, "--sodium",
      () => ["arrive sooner by shuttle"], () => ["arrive sooner by bus"])],
    ["ch-who", 300, drawWho], ["ch-cal", 300, drawCal], ["ch-gps", 260, drawGps],
  ];
  function drawCharts() {
    for (const [id, H, draw] of CHARTS) {
      if (!document.getElementById(id)) continue;
      try { (CH[id] || chart(id, H, draw)).rebuild(0); } catch (e) { console.error(e); }
    }
  }

  // ------------------------------------------------------------------ init
  async function init() {
    if (DUR === 0) document.documentElement.classList.add("no-motion");
    if (still) document.documentElement.classList.add("still");
    try {
      const [town, buildings, stops, demand, baseline, results, idx, paths, calpts] = await Promise.all(
        ["town.json", "buildings.json", "stops.json", "demand.json", "baseline.json", "results.json", "anim_index.json", "paths.json", "calibration_points.json"].map(getJSON));
      Object.assign(D, { town, buildings, stops, demand, baseline, results, anim_index: idx, calpts });
      D.paths = decodePaths(paths);
    } catch (e) {
      document.getElementById("loading").textContent = `Could not load the data (${e.message}). The page needs its data files next to it.`;
      return;
    }
    const safe = (f) => { try { f(); } catch (e) { console.error(e); } };
    safe(fillNumbers);
    for (const el of document.querySelectorAll(".figs dd > span[data-v]")) countUp(el, DUR ? 1400 : 0);
    const tabs = document.getElementById("cliff-tabs");
    const modes = [["7", "07:00–08:00"], ["8", "08:00–09:00"], ["12", "12:00–13:00"], ["18", "18:00–19:00"], ["all", "whole day"]];
    for (const [k, lab] of modes) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = lab; b.dataset.mode = k;
      b.setAttribute("aria-pressed", String(+k === cliffMode));
      b.onclick = () => {
        for (const x of tabs.children) x.setAttribute("aria-pressed", String(x === b));
        cliffMode = k === "all" ? "all" : +k;
        // redraw at the story's current step, or fully drawn once the reader has scrolled past it
        const c = CH["ch-cliff"]; if (c) { if (c.state < 1) c.set(4, 0); c.rebuild(DUR); }
      };
      tabs.appendChild(b);
    }
    safe(drawCharts); safe(renderSensitivity); safe(renderKerbExperiment); safe(renderSubzones); safe(decorateOps);
    safe(setupStories);
    for (const id of ["ch-cal", "ch-gps"]) { const el = document.getElementById(id); if (el && CH[id]) onEnter(el, () => CH[id].set(0, DUR)); }
    for (const t of document.querySelectorAll("table.reveal")) onEnter(t, () => t.classList.add("in"));

    const el = document.getElementById("scenarios");
    for (const sc of D.anim_index.scenarios) {
      const b = document.createElement("button"); b.type = "button"; b.dataset.id = sc.id; b.dataset.kind = sc.kind;
      b.textContent = sc.kind === "bus" ? "Today's buses" : `${sc.fleet} × ${sc.capacity}-seat`;
      b.title = sc.label; b.onclick = () => selectScenario(sc); el.appendChild(b);
    }
    buildSky();
    // map style: a #style=toon link wins, then the visitor's last choice, then Streetmap
    let saved = null; try { saved = localStorage.getItem("yishun-map-style"); } catch (e) { /* storage blocked */ }
    const linked = (location.hash.match(/(?:^#|&)style=(street|toon)\b/) || [])[1];
    setMapStyle(linked || (MAP_STYLES[saved] ? saved : "street"), { save: false, turn: false });
    state.view = homeView();
    deckgl = new deck.Deck({
      parent: document.getElementById("map"), initialViewState: homeView(), controller: CONTROLLER,
      views: mapView(), layers: [], onHover,
      onClick: (info) => { if (info.object && /^(models|heads)/.test(info.layer.id)) startRide(info.object.veh); },
      onViewStateChange: ({ viewState }) => {
        view = state.view = viewState; updateAway(viewState);
        if (!state.playing && !state.showSky) redraw();
      },
      effects: mapEffects(),
      parameters: { clearColor: [0, 0, 0, 0] },
    });
    view = state.view; flyKeys();
    document.getElementById("home").onclick = () => { held.clear(); flyTo(homeView()); };
    for (const b of document.querySelectorAll("#mapstyle button")) b.onclick = () => setMapStyle(b.dataset.map);
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
      else if (e.key === "g" || e.key === "G") { if (state.follow) stopRide(); else startRide(); }
      else if ((e.key === "m" || e.key === "M") && !e.metaKey && !e.ctrlKey) setMapStyle(state.mapStyle === "toon" ? "street" : "toon");
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault(); state.t = Math.max(300, Math.min(1559, state.t + (e.key === "ArrowRight" ? 5 : -5))); redraw();
      }
    });
    const ref = D.anim_index.scenarios.find((s) => s.id === D.results.anim.reference) || D.anim_index.scenarios[0];
    await selectScenario(ref);
    let rz = null, lastW = window.innerWidth;
    window.addEventListener("resize", () => {
      clearTimeout(rz);
      rz = setTimeout(() => { if (window.innerWidth !== lastW) { lastW = window.innerWidth; drawCharts(); } onScroll(); }, 200);
    });
    if (!reduceMotion && !still) { setPlaying(true); state.orbit = true; }
    requestAnimationFrame(tick);
    document.documentElement.dataset.ready = "1";
  }
  init();
})();
