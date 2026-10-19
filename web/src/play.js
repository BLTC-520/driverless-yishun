/* Night Shift: a driving game built on the study's data, drawn with WebGPU.
   The city is the study's own: every building footprint and height (HDB + OpenStreetMap), road
   areas, parks, water, the MRT line and the 180 bus stops, read from ./data/*.json. Riders appear
   at each stop at the hourly rate in LTA's fare-card OD and travel to the stops riders really go
   to. The shuttles are the simulator's 450-vehicle fleet and the buses the study's bus model, at
   the same minute. Walkers, private cars, trains and flying trucks are decoration.
   Rendering is three.js's WebGPURenderer (WebGL 2 where WebGPU is missing) with node shaders in
   shaders.js. Vehicles, crashes and people knocked down follow physics.js: rigid boxes trading
   impulses, and ragdolls that fold over a bonnet, lie still, then get up and walk back. */
import * as THREE from "three/webgpu";
import { pass, uniform, screenUV, vec2, vec3, vec4, length, smoothstep, mix, float } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import * as PH from "./physics.js";
import {
  U, skyMaterial, horizonCityMaterial, buildingMaterial, groundMaterial, waterMaterial, poolMaterial,
  crownMaterial, peopleMaterial, puffMaterial, dashMaterial,
} from "./shaders.js";

window.__nsAlive = true; // the 3D engine loaded: the page's watchdog stands down
const $ = (id) => document.getElementById(id);
const fail = (msg) => (window.nsFail ? window.nsFail(msg) : ($("load-text").textContent = msg));
const PHONE = matchMedia("(pointer: coarse)").matches || innerWidth < 640;
const AUTO = location.hash === "#auto"; // start straight away (screenshots, tests)
const QUERY = new URLSearchParams(location.search);
const SHIFT = 300;                       // seconds of play
const pad = (n) => String(n).padStart(2, "0");
const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${pad(Math.floor(Math.max(0, s) % 60))}`;
const clockOf = (h) => { const m = Math.floor(h * 60) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------- geography
// Local metres around the study origin: x east, z south (three.js looks down -z for north), y up.
let LNG0 = 103.836, LAT0 = 1.4235;
const M_LAT = 111320, M_LNG = 111320 * Math.cos((1.4235 * Math.PI) / 180);
const X = (lng) => (lng - LNG0) * M_LNG, Z = (lat) => -(lat - LAT0) * M_LAT;

function ringXZ(ring) {
  const pts = [];
  for (const [lng, lat] of ring) {
    const p = new THREE.Vector2(X(lng), Z(lat));
    if (!pts.length || p.distanceToSquared(pts[pts.length - 1]) > 0.04) pts.push(p);
  }
  if (pts.length > 2 && pts[0].distanceToSquared(pts[pts.length - 1]) < 0.04) pts.pop();
  return pts;
}
const signedArea = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; } return a / 2; };

// ---------------------------------------------------------------- loading
async function getJSON(name, tries = 3) {
  for (let k = 1; ; k++) {
    try {
      const r = await fetch(`data/${name}`);
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (k >= tries) throw e;
      await new Promise((ok) => setTimeout(ok, 1200 * k)); // a flaky connection gets another go
    }
  }
}
const optional = (p) => p.catch((e) => { console.warn("optional part skipped:", e.message || e); return null; });
function progress(f, text) { $("load-bar").style.width = `${Math.round(f * 100)}%`; if (text) $("load-text").textContent = text; }
const breathe = () => new Promise((r) => setTimeout(r, 0)); // let the loading bar paint between heavy steps

// ---------------------------------------------------------------- renderer: WebGPU, else WebGL 2
let renderer;
try {
  renderer = new THREE.WebGPURenderer({ canvas: $("c"), antialias: false, powerPreference: "high-performance", forceWebGL: QUERY.has("webgl") });
  await renderer.init();
} catch (e) {
  fail("This browser or device can't draw the 3D city (it has neither WebGPU nor WebGL 2).");
  throw e; // nothing below can run without a renderer
}
const BACKEND = renderer.backend.isWebGPUBackend ? "WebGPU" : "WebGL 2";
let contextLost = false;
const lost = () => { contextLost = true; G.paused = true; fail("The graphics driver reset the 3D view."); };
renderer.onDeviceLost = lost;
renderer.domElement.addEventListener("webglcontextlost", (e) => { e.preventDefault(); lost(); });
renderer.domElement.addEventListener("webglcontextrestored", () => location.reload());
renderer.setPixelRatio(Math.min(devicePixelRatio, PHONE ? 1.25 : 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = !PHONE;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 9000);
scene.fog = new THREE.Fog(0x2a2436, 350, 4300);

const hemi = new THREE.HemisphereLight(0x9fb4d6, 0x20242b, 0.5);
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.castShadow = !PHONE;
Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 10, far: 1600 });
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.5;
scene.add(hemi, sun, sun.target);

// Post: the scene with MSAA, a chromatic kick on hard knocks, bloom on lamps and windows, a vignette.
const IMPACT = uniform(0);
let pipeline = null, bloomNode = null;
try {
  pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera, { samples: PHONE ? 0 : 4 });
  const col = scenePass.getTextureNode("output");
  const off = screenUV.sub(0.5), k = IMPACT.mul(0.006);
  let rgb = vec3(col.sample(screenUV.add(off.mul(k))).r, col.g, col.sample(screenUV.sub(off.mul(k))).b);
  if (!PHONE) { bloomNode = bloom(col, 0.4, 0.45, 0.9); rgb = rgb.add(bloomNode.rgb); }
  const vig = smoothstep(1.2, 0.3, length(off.mul(vec2(1.2, 1))));
  rgb = rgb.mul(mix(float(0.55), float(1), vig));
  pipeline.outputNode = vec4(rgb, 1);
} catch (e) { console.warn("plain rendering:", e); pipeline = null; bloomNode = null; }
const draw = () => { if (pipeline) pipeline.render(); else renderer.render(scene, camera); };

// Four hours to play, each with its own light. `night` drives lit windows, lamps and headlights;
// `wet` is how much the evening showers left on the roads.
const LOOKS = {
  7.5: { night: 0.1, top: 0x5d93cf, horizon: 0xf0c7a2, glow: 0x000000, sun: 0xffd8a8, sunI: 2.4, sunDir: [0.9, 0.32, 0.25], hemi: 0.9, fog: 0xd2c2b4, fogFar: 5200, exposure: 0.9, bloom: 0.2, env: 0.7, clouds: 0.5, wet: 0.35 },
  13: { night: 0, top: 0x3d7ccc, horizon: 0xbcd4ec, glow: 0x000000, sun: 0xffffff, sunI: 2.8, sunDir: [0.25, 1, 0.35], hemi: 1.0, fog: 0xb8cde0, fogFar: 6000, exposure: 0.95, bloom: 0.12, env: 0.9, clouds: 0.45, wet: 0 },
  19.5: { night: 0.8, top: 0x111a36, horizon: 0x7d4f63, glow: 0x9a5038, sun: 0xff9e6a, sunI: 0.45, sunDir: [-1, 0.1, 0.15], hemi: 0.3, fog: 0x2a2436, fogFar: 4300, exposure: 1.0, bloom: 0.45, env: 0.35, clouds: 0.55, wet: 0.6 },
  23: { night: 1, top: 0x04070d, horizon: 0x172033, glow: 0x6b3a26, sun: 0x9db4ff, sunI: 0.22, sunDir: [0.4, 0.8, -0.3], hemi: 0.18, fog: 0x0d131e, fogFar: 3800, exposure: 1.05, bloom: 0.55, env: 0.22, clouds: 0.4, wet: 0.75 },
};
const skyMat = skyMaterial();
const sky = new THREE.Mesh(new THREE.SphereGeometry(6000, 48, 24), skyMat);
sky.renderOrder = -1; sky.frustumCulled = false;
scene.add(sky);

// The environment map (reflections in paint and glass) is baked from the same sky, a dark ground
// and, at night, a band of lit windows round the horizon.
const envScene = new THREE.Scene();
envScene.add(new THREE.Mesh(new THREE.SphereGeometry(60, 48, 24), skyMat));
const envGround = new THREE.Mesh(new THREE.CircleGeometry(60, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicNodeMaterial({ color: 0x1b1d21 }));
envGround.position.y = -3; envScene.add(envGround);
envScene.add(new THREE.Mesh(new THREE.CylinderGeometry(55, 55, 10, 96, 1, true).translate(0, 2, 0), horizonCityMaterial()));
const pmrem = new THREE.PMREMGenerator(renderer);
let envRT = null;
function bakeEnvironment() {
  U.sunDisk.value = 0.08;
  try {
    envRT = pmrem.fromScene(envScene, 0.02, 0.1, 200, envRT ? { renderTarget: envRT } : {});
    scene.environment = envRT.texture;
  } catch (e) { console.warn("no environment map:", e); }
  U.sunDisk.value = 1;
}

let look = LOOKS[19.5];
function applyLook(hour) {
  look = LOOKS[hour];
  U.night.value = look.night;
  U.top.value.set(look.top); U.horizon.value.set(look.horizon); U.glow.value.set(look.glow);
  U.sunDir.value.set(...look.sunDir).normalize();
  U.sunCol.value.set(look.sun).multiplyScalar(look.night > 0.9 ? 0.3 : 1);
  U.clouds.value = look.clouds; U.wet.value = look.wet;
  sun.color.set(look.sun); sun.intensity = look.sunI;
  hemi.intensity = look.hemi;
  scene.fog.color.set(look.fog); scene.fog.far = look.fogFar;
  renderer.toneMappingExposure = look.exposure;
  scene.environmentIntensity = look.env;
  if (bloomNode) bloomNode.strength.value = look.bloom;
  for (const m of nightMats) m.update(look.night);
  bakeEnvironment();
}
const nightMats = []; // things whose glow follows the hour: { update(night) }

// ---------------------------------------------------------------- flat layers: ground, water, parks, roads
function flatGeometry(rings, y) {
  const pos = [], idx = [];
  for (const ring of rings) {
    const pts = ringXZ(ring);
    if (pts.length < 3) continue;
    let tris = [];
    try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch (e) { continue; }
    const base = pos.length / 3;
    for (const p of pts) pos.push(p.x, y, p.y);
    for (const [a, b, c] of tris) {
      const A = pts[a], B = pts[b], C = pts[c];
      const up = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y) > 0; // face +y?
      idx.push(base + a, up ? base + b : base + c, up ? base + c : base + b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}
function flatLayer(rings, y, mat, offset) {
  mat.polygonOffset = true; mat.polygonOffsetFactor = mat.polygonOffsetUnits = offset;
  const m = new THREE.Mesh(flatGeometry(rings, y), mat);
  m.receiveShadow = true;
  scene.add(m);
  return m;
}

// Ambient occlusion baked from the footprints: a blurred map of where buildings stand, which
// darkens the ground, roads and paving right beside walls.
const AO_RES = 4;
function boxBlur(a, W, H, r) {
  const out = new Float32Array(a.length), n = 2 * r + 1;
  for (let y = 0; y < H; y++) { // rows
    let s = 0; const o = y * W;
    for (let x = -r; x <= r; x++) s += a[o + clamp(x, 0, W - 1)];
    for (let x = 0; x < W; x++) { out[o + x] = s / n; s += a[o + Math.min(W - 1, x + r + 1)] - a[o + Math.max(0, x - r)]; }
  }
  const out2 = new Float32Array(a.length);
  for (let x = 0; x < W; x++) { // columns
    let s = 0;
    for (let y = -r; y <= r; y++) s += out[clamp(y, 0, H - 1) * W + x];
    for (let y = 0; y < H; y++) { out2[y * W + x] = s / n; s += out[Math.min(H - 1, y + r + 1) * W + x] - out[Math.max(0, y - r) * W + x]; }
  }
  return out2;
}
function buildAO(buildings) {
  const W = Math.ceil(8600 / AO_RES), H = Math.ceil(7600 / AO_RES);
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); ctx.fillStyle = "#fff"; ctx.beginPath();
  for (const b of buildings) {
    if (!Array.isArray(b.p)) continue;
    b.p.forEach(([lng, lat], i) => { const x = (X(lng) - MASK.x0) / AO_RES, y = (Z(lat) - MASK.z0) / AO_RES; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
  }
  ctx.fill();
  const img = ctx.getImageData(0, 0, W, H).data;
  let a = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) a[i] = img[i * 4] / 255;
  a = boxBlur(boxBlur(a, W, H, 1), W, H, 2);
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { out[i * 4] = Math.min(255, a[i] * 1.5 * 255); out[i * 4 + 3] = 255; }
  const tex = new THREE.DataTexture(out, W, H, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
  U.aoBox.value.set(MASK.x0, MASK.z0, W * AO_RES, H * AO_RES);
  return tex;
}

// ---------------------------------------------------------------- buildings
// One merged mesh. Walls carry their running length along the facade and height (aWall), the
// facade direction (aTan), and where this wall starts and ends (aSeg) so the shader can paint
// windows into rooms, and HDB block numbers on the blank gable ends (aBlk).
const GLYPHS = "0123456789ABCDEFGH";
function glyphTexture() {
  const c = document.createElement("canvas"); c.width = 64 * GLYPHS.length; c.height = 96;
  const x = c.getContext("2d");
  x.fillStyle = "#000"; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = "#fff"; x.font = "700 84px Archivo, 'Arial Narrow', Arial, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
  for (let i = 0; i < GLYPHS.length; i++) x.fillText(GLYPHS[i], i * 64 + 32, 50, 58);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 4;
  return t;
}
function buildBuildings(list) {
  const pos = [], nor = [], wall = [], info = [], tan = [], seg = [], blk = [], idx = [];
  let seed = 1;
  for (const b of list) {
    const pts = Array.isArray(b.p) ? ringXZ(b.p) : [];
    if (pts.length < 3 || !Number.isFinite(b.h)) continue;
    const h = Math.max(3, b.h), hdb = b.k === "hdb" ? 1 : 0, s = (seed = (seed * 16807) % 2147483647) / 2147483647;
    const ccw = signedArea(pts) > 0;
    const chars = String(hdb && b.b ? b.b : "").toUpperCase().split("").map((ch) => GLYPHS.indexOf(ch)).filter((i) => i >= 0).slice(0, 4);
    const glyph = [0, 1, 2, 3].map((i) => (i < chars.length ? chars[i] : -1));
    let longest = 0;
    for (let i = 0; i < pts.length; i++) longest = Math.max(longest, pts[i].distanceTo(pts[(i + 1) % pts.length]));
    let run = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const dx = q.x - p.x, dz = q.y - p.y, len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const nx = (ccw ? dz : -dz) / len, nz = (ccw ? -dx : dx) / len;
      const base = pos.length / 3;
      // HDB and OpenStreetMap sometimes trace the same wall: a few cm per building keeps them from z-fighting
      const o = s * 0.08, ox = nx * o, oz = nz * o;
      const gable = hdb && len >= 6 && len < 26 && len < 0.45 * longest ? 1 : 0;
      pos.push(p.x + ox, 0, p.y + oz, q.x + ox, 0, q.y + oz, q.x + ox, h, q.y + oz, p.x + ox, h, p.y + oz);
      for (let k = 0; k < 4; k++) { nor.push(nx, 0, nz); info.push(s, hdb, h); tan.push(dx / len, dz / len); seg.push(run, len, gable, ccw ? 1 : 0); blk.push(...glyph); }
      wall.push(run, 0, run + len, 0, run + len, h, run, h);
      if (ccw) idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      run += len;
    }
    let roof = [];
    try { roof = THREE.ShapeUtils.triangulateShape(pts, []); } catch (e) { /* a self-crossing footprint: walls only */ }
    const base = pos.length / 3;
    for (const p of pts) { pos.push(p.x, h + s * 0.06, p.y); nor.push(0, 1, 0); wall.push(0, h); info.push(s, hdb, h); tan.push(0, 0); seg.push(0, 0, 0, 0); blk.push(-1, -1, -1, -1); }
    for (const [a, b2, c] of roof) {
      const A = pts[a], B = pts[b2], C = pts[c];
      const up = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y) > 0;
      idx.push(base + a, up ? base + b2 : base + c, up ? base + c : base + b2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("aWall", new THREE.Float32BufferAttribute(wall, 2));
  g.setAttribute("aInfo", new THREE.Float32BufferAttribute(info, 3));
  g.setAttribute("aTan", new THREE.Float32BufferAttribute(tan, 2));
  g.setAttribute("aSeg", new THREE.Float32BufferAttribute(seg, 4));
  g.setAttribute("aBlk", new THREE.Float32BufferAttribute(blk, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, buildingMaterial(glyphTexture(), GLYPHS.length, PHONE));
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
}
// ---------------------------------------------------------------- the drivable mask
// Roads, buildings, water and parks rasterised once (2.5 m cells): vehicles drive on roads,
// slow on grass, and stop at walls and water.
const MASK = { res: PHONE ? 3 : 2.5, x0: -3800, z0: -3500, w: 0, h: 0, data: null };
const ROAD = 1, BLDG = 2, WATER = 4, PARK = 8;
function buildMask(town, buildings) {
  try { rasterMask(town, buildings); } catch (e) { console.warn("coarser mask:", e); MASK.res *= 2; rasterMask(town, buildings); }
}
function rasterMask(town, buildings) {
  const W = Math.ceil(8600 / MASK.res), H = Math.ceil(7600 / MASK.res);
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const fill = (rings, color) => {
    ctx.fillStyle = color; ctx.beginPath();
    for (const ring of rings) {
      ring.forEach(([lng, lat], i) => { const x = (X(lng) - MASK.x0) / MASK.res, y = (Z(lat) - MASK.z0) / MASK.res; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
    }
    ctx.fill();
  };
  ctx.globalCompositeOperation = "lighter";
  fill(town.green, "rgb(0,0,100)");
  fill(town.water, "rgb(0,0,255)");
  fill(town.roads, "rgb(255,0,0)");
  fill(buildings.filter((b) => Array.isArray(b.p)).map((b) => b.p), "rgb(0,255,0)");
  const img = ctx.getImageData(0, 0, W, H).data, out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = img[i * 4], g = img[i * 4 + 1], b = img[i * 4 + 2];
    out[i] = (r > 127 ? ROAD : 0) | (g > 127 ? BLDG : 0) | (b > 200 ? WATER : b > 50 ? PARK : 0);
  }
  Object.assign(MASK, { w: W, h: H, data: out });
}
// Some stops sit inside a building footprint (the bus interchange is one): for the game their
// pickup point moves to the nearest open road, and the ground right round every stop stays drivable.
function reachable(x, z) {
  if (!(maskAt(x, z) & (BLDG | WATER))) return [x, z];
  for (let r = MASK.res; r < 200; r += MASK.res) {
    for (let k = 0, n = Math.ceil((2 * Math.PI * r) / MASK.res); k < n; k++) {
      const a = (2 * Math.PI * k) / n, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r, f = maskAt(px, pz);
      if (f & ROAD && !(f & (BLDG | WATER))) return [px, pz];
    }
  }
  return [x, z];
}
function clearAroundStops() {
  const r = Math.ceil(10 / MASK.res);
  for (const s of STOPS) {
    const ci = Math.floor((s.x - MASK.x0) / MASK.res), cj = Math.floor((s.z - MASK.z0) / MASK.res);
    for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
      if (i < 0 || j < 0 || i >= MASK.w || j >= MASK.h || (i - ci) ** 2 + (j - cj) ** 2 > r * r) continue;
      MASK.data[j * MASK.w + i] = (MASK.data[j * MASK.w + i] & ~(BLDG | WATER)) | ROAD;
    }
  }
}
function maskAt(x, z) {
  const i = Math.floor((x - MASK.x0) / MASK.res), j = Math.floor((z - MASK.z0) / MASK.res);
  if (i < 0 || j < 0 || i >= MASK.w || j >= MASK.h) return BLDG; // the edge of the world is a wall
  return MASK.data[j * MASK.w + i];
}
const solid = (x, z) => (maskAt(x, z) & (BLDG | WATER)) !== 0;

// Things a vehicle can hit that are not buildings: tree trunks, lamp posts, bus shelters, in a
// 10 m grid so each body only looks at what is near it.
const OB = { cell: 10, map: new Map() };
const obKey = (i, j) => (i + 2000) * 4096 + (j + 2000);
function addObstacle(o) {
  const i = Math.floor(o.x / OB.cell), j = Math.floor(o.z / OB.cell), k = obKey(i, j);
  if (!OB.map.has(k)) OB.map.set(k, []);
  OB.map.get(k).push(o);
}
function obstaclesNear(x, z, r, out = []) {
  out.length = 0;
  const i0 = Math.floor((x - r) / OB.cell), i1 = Math.floor((x + r) / OB.cell), j0 = Math.floor((z - r) / OB.cell), j1 = Math.floor((z + r) / OB.cell);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const l = OB.map.get(obKey(i, j)); if (l) for (const o of l) out.push(o); }
  return out;
}

// ---------------------------------------------------------------- road edges: kerbs, paving, yellow lines
// Road areas are outer rings, so each ring is a kerb; "outward" points off the road.
let EDGES = [];
const EG = { cell: 30, map: new Map() }; // edge segments by grid cell, to find the nearest pavement
function buildEdges(town) {
  EDGES = []; EG.map.clear();
  for (const ring of town.roads) {
    const pts = ringXZ(ring);
    if (pts.length < 3) continue;
    const ccw = signedArea(pts) > 0, n = pts.length;
    const xs = new Float32Array(n + 1), zs = new Float32Array(n + 1), cum = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) { const p = pts[i % n]; xs[i] = p.x; zs[i] = p.y; if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]); }
    if (cum[n] > 1) EDGES.push({ xs, zs, cum, len: cum[n], ccw });
  }
  EDGES.forEach((e, ei) => {
    for (let i = 1; i < e.xs.length; i++) {
      const i0 = Math.floor(Math.min(e.xs[i - 1], e.xs[i]) / EG.cell), i1 = Math.floor(Math.max(e.xs[i - 1], e.xs[i]) / EG.cell);
      const j0 = Math.floor(Math.min(e.zs[i - 1], e.zs[i]) / EG.cell), j1 = Math.floor(Math.max(e.zs[i - 1], e.zs[i]) / EG.cell);
      for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) { const k = obKey(a, b); if (!EG.map.has(k)) EG.map.set(k, []); EG.map.get(k).push(ei, i); }
    }
  });
}
// point at distance s along a ring, pushed `off` metres off the road; also the direction of travel
function alongEdge(e, s, off) {
  s = ((s % e.len) + e.len) % e.len;
  let lo = 0, hi = e.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (e.cum[m] <= s) lo = m; else hi = m; }
  const seg = e.cum[hi] - e.cum[lo] || 1, u = (s - e.cum[lo]) / seg;
  const dx = (e.xs[hi] - e.xs[lo]) / seg, dz = (e.zs[hi] - e.zs[lo]) / seg;
  const nx = e.ccw ? dz : -dz, nz = e.ccw ? -dx : dx;
  return { x: e.xs[lo] + u * (e.xs[hi] - e.xs[lo]) + nx * off, z: e.zs[lo] + u * (e.zs[hi] - e.zs[lo]) + nz * off, dx, dz, nx, nz };
}
// the nearest kerb to a point: { e, s } (null if none within ~60 m)
function nearestEdge(x, z) {
  const ci = Math.floor(x / EG.cell), cj = Math.floor(z / EG.cell);
  let best = null, bd = Infinity;
  for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++) {
    const l = EG.map.get(obKey(a, b)); if (!l) continue;
    for (let k = 0; k < l.length; k += 2) {
      const e = EDGES[l[k]], i = l[k + 1];
      const ax = e.xs[i - 1], az = e.zs[i - 1], vx = e.xs[i] - ax, vz = e.zs[i] - az, l2 = vx * vx + vz * vz || 1;
      const u = clamp(((x - ax) * vx + (z - az) * vz) / l2, 0, 1), d = (ax + u * vx - x) ** 2 + (az + u * vz - z) ** 2;
      if (d < bd) { bd = d; best = { e, s: e.cum[i - 1] + u * Math.sqrt(l2) }; }
    }
  }
  return best;
}

// A strip running along every kerb between offsets a and b (negative: on the road), with mitred
// corners. keep(midX, midZ) can drop pieces, e.g. paving that would land on another road.
function edgeStrips(a, b, y, keep, vertical) {
  const pos = [];
  for (const e of EDGES) {
    const n = e.xs.length - 1, N = [];
    const segN = (k) => { k = ((k % n) + n) % n; const dx = e.xs[k + 1] - e.xs[k], dz = e.zs[k + 1] - e.zs[k], l = Math.hypot(dx, dz) || 1; return e.ccw ? [dz / l, -dx / l] : [-dz / l, dx / l]; };
    for (let i = 0; i <= n; i++) {
      const [ax, az] = segN(i - 1), [bx, bz] = segN(i);
      let mx = ax + bx, mz = az + bz; const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
      const f = 1 / Math.max(0.5, mx * bx + mz * bz);
      N.push([mx * f, mz * f]);
    }
    for (let i = 0; i < n; i++) {
      const p = [e.xs[i], e.zs[i]], q = [e.xs[i + 1], e.zs[i + 1]], np = N[i], nq = N[i + 1];
      if (keep && !keep((p[0] + q[0]) / 2 + (np[0] + nq[0]) * (a + b) / 4, (p[1] + q[1]) / 2 + (np[1] + nq[1]) * (a + b) / 4)) continue;
      const A = [p[0] + np[0] * a, p[1] + np[1] * a], B = [p[0] + np[0] * b, p[1] + np[1] * b];
      const C = [q[0] + nq[0] * b, q[1] + nq[1] * b], D = [q[0] + nq[0] * a, q[1] + nq[1] * a];
      if (vertical) { // a kerb face from the road up to the kerb top, along offset a
        pos.push(A[0], 0.04, A[1], D[0], 0.04, D[1], D[0], y, D[1], A[0], 0.04, A[1], D[0], y, D[1], A[0], y, A[1]);
      } else pos.push(A[0], y, A[1], B[0], y, B[1], C[0], y, C[1], A[0], y, A[1], C[0], y, C[1], D[0], y, D[1]);
    }
  }
  // make every flat triangle face up (kerb faces are drawn double-sided)
  if (!vertical) for (let i = 0; i < pos.length; i += 9) {
    const ux = pos[i + 3] - pos[i], uz = pos[i + 5] - pos[i + 2], vx = pos[i + 6] - pos[i], vz = pos[i + 8] - pos[i + 2];
    if (uz * vx - ux * vz < 0) for (let k = 0; k < 3; k++) [pos[i + 3 + k], pos[i + 6 + k]] = [pos[i + 6 + k], pos[i + 3 + k]];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
function buildKerbs(aoTex) {
  const kerbMat = new THREE.MeshStandardNodeMaterial({ color: 0x8e8d88, roughness: 0.85, side: THREE.DoubleSide });
  const top = new THREE.Mesh(edgeStrips(0, 0.35, 0.15), kerbMat);
  const face = new THREE.Mesh(edgeStrips(0, 0, 0.15, null, true), kerbMat);
  const pave = groundMaterial(aoTex, "pave", PHONE);
  pave.polygonOffset = true; pave.polygonOffsetFactor = pave.polygonOffsetUnits = -2;
  const paving = new THREE.Mesh(edgeStrips(0.35, 4.2, 0.13, (x, z) => !(maskAt(x, z) & (ROAD | BLDG | WATER))), pave);
  const yellow = new THREE.MeshStandardNodeMaterial({ color: 0xd9a21b, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
  const lines = new THREE.Mesh(mergeGeometries([edgeStrips(-0.42, -0.32, 0.065), edgeStrips(-0.62, -0.52, 0.065)]), yellow);
  for (const m of [top, face, paving, lines]) { m.receiveShadow = true; scene.add(m); }
}

// Lane lines along the road centrelines the simulated fleet drives (OpenStreetMap ways), each
// stretch drawn once: dashed white, with traffic keeping left of it.
function buildLaneLines(pathsRaw) {
  const pid = new Map(), seen = new Set(), pos = [], dash = [];
  const P = (x, y) => { const k = (x + 16384) * 32768 + (y + 16384); let v = pid.get(k); if (v === undefined) pid.set(k, (v = pid.size)); return v; };
  const [lng0, lat0] = pathsRaw.origin;
  for (const flat of pathsRaw.paths) {
    let x = 0, y = 0, px = null, py = null, pk = -1;
    for (let i = 0; i < flat.length; i += 3) {
      x += flat[i]; y += flat[i + 1];
      const k = P(x, y);
      if (pk >= 0 && k !== pk) {
        const key = Math.min(k, pk) * 16777216 + Math.max(k, pk);
        if (!seen.has(key)) {
          seen.add(key);
          const ax = X(lng0 + px / 1e5), az = Z(lat0 + py / 1e5), bx = X(lng0 + x / 1e5), bz = Z(lat0 + y / 1e5);
          const len = Math.hypot(bx - ax, bz - az);
          if (len > 4 && maskAt((ax + bx) / 2, (az + bz) / 2) & ROAD) {
            const ux = (bx - ax) / len, uz = (bz - az) / len, wx = -uz * 0.07, wz = ux * 0.07;
            // trim the ends so dashes stop short of junctions
            const a0 = 2, a1 = len - 2, sx = ax + ux * a0, sz = az + uz * a0, ex = ax + ux * a1, ez = az + uz * a1;
            pos.push(sx - wx, 0.07, sz - wz, ex - wx, 0.07, ez - wz, ex + wx, 0.07, ez + wz, sx - wx, 0.07, sz - wz, ex + wx, 0.07, ez + wz, sx + wx, 0.07, sz + wz);
            dash.push(0, a1 - a0, a1 - a0, 0, a1 - a0, 0);
          }
        }
      }
      px = x; py = y; pk = k;
    }
  }
  for (let i = 0; i < pos.length; i += 9) { // face up (the dash coordinate travels with its vertex)
    const ux = pos[i + 3] - pos[i], uz = pos[i + 5] - pos[i + 2], vx = pos[i + 6] - pos[i], vz = pos[i + 8] - pos[i + 2];
    if (uz * vx - ux * vz >= 0) continue;
    for (let k = 0; k < 3; k++) [pos[i + 3 + k], pos[i + 6 + k]] = [pos[i + 6 + k], pos[i + 3 + k]];
    const d = i / 3; [dash[d + 1], dash[d + 2]] = [dash[d + 2], dash[d + 1]];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute("aDash", new THREE.Float32BufferAttribute(dash, 1));
  const m = new THREE.Mesh(g, dashMaterial());
  m.receiveShadow = true;
  scene.add(m);
}

const dummy = new THREE.Object3D();
function radialTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const x = c.getContext("2d"), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.4, "rgba(255,255,255,0.35)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const SOFT = radialTexture();

const unindexed = (g) => (g.index ? g.toNonIndexed() : g);

// ---------------------------------------------------------------- street lamps
// Every lamp has a fake pool of light; the few nearest the player are real point lights that light
// cars, people and walls. A lamp post knocked hard enough falls over and goes dark.
const LAMPS = [];
let lampMesh = null;
const REAL_LAMPS = [];
function buildLamps() {
  if (!EDGES.length) return;
  const total = EDGES.reduce((a, e) => a + e.len, 0);
  const spacing = Math.max(34, total / (PHONE ? 1500 : 3200));
  for (const e of EDGES) for (let s = 0; s < e.len; s += spacing) {
    const p = alongEdge(e, s, 1.0);
    LAMPS.push({ x: p.x, z: p.z, nx: p.nx, nz: p.nz, yaw: Math.atan2(-p.nx, -p.nz), angle: 0, w: 0, ax: 0, az: 0, down: false, falling: false, lit: true, i: LAMPS.length });
  }
  const poleG = mergeGeometries([new THREE.CylinderGeometry(0.1, 0.14, 9, 6).translate(0, 4.5, 0), new THREE.BoxGeometry(0.1, 0.1, 1.8).translate(0, 8.9, 0.9)]);
  const poles = new THREE.InstancedMesh(poleG, new THREE.MeshStandardMaterial({ color: 0x4a5059, roughness: 0.55, metalness: 0.35 }), LAMPS.length);
  const headMat = new THREE.MeshStandardMaterial({ color: 0x332a1c, emissive: 0xffb554, emissiveIntensity: 3 });
  const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.18, 0.9), headMat, LAMPS.length);
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2), poolMaterial(SOFT), LAMPS.length);
  pools.frustumCulled = false;
  lampMesh = { poles, heads, pools };
  LAMPS.forEach((l) => placeLamp(l));
  poles.castShadow = true;
  scene.add(poles, heads, pools);
  for (const l of LAMPS) addObstacle({ type: "lamp", x: l.x, z: l.z, r: 0.22, lamp: l });
  for (let k = 0; k < (PHONE ? 2 : 6); k++) { // spots aimed down: a street lamp lights the road, not its own pole
    const pl = new THREE.SpotLight(0xffb36a, 0, 45, 1.15, 0.6, 1.7);
    pl.userData = { lamp: null };
    REAL_LAMPS.push(pl); scene.add(pl, pl.target);
  }
  nightMats.push({ update: (n) => { headMat.emissiveIntensity = n > 0.3 ? 4 : 0; pools.visible = n > 0.3; } });
}
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _axis = new THREE.Vector3();
function placeLamp(l) {
  _q.setFromAxisAngle(_axis.set(0, 1, 0), l.yaw);
  if (l.angle) _q.premultiply(_q2.setFromAxisAngle(_axis.set(l.ax, 0, l.az), l.angle));
  _m.compose(_v.set(l.x, 0, l.z), _q, _s);
  lampMesh.poles.setMatrixAt(l.i, _m);
  _m2.makeTranslation(0, 8.8, 1.7); lampMesh.heads.setMatrixAt(l.i, _m2.premultiply(_m));
  if (l.lit) { dummy.position.set(l.x - l.nx * 3, 0.16, l.z - l.nz * 3); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); }
  else dummy.scale.set(0, 0, 0);
  dummy.updateMatrix(); lampMesh.pools.setMatrixAt(l.i, dummy.matrix); dummy.scale.set(1, 1, 1);
  for (const k in lampMesh) lampMesh[k].instanceMatrix.needsUpdate = true;
}
function knockLamp(l, dirx, dirz, speed) {
  if (l.falling || l.down) return;
  const d = Math.hypot(dirx, dirz) || 1;
  Object.assign(l, { falling: true, lit: false, ax: dirz / d, az: -dirx / d, w: 0.5 + speed * 0.06 });
  sparks(l.x, 1.0, l.z, 14, dirx / d * 3, dirz / d * 3);
  chime([310, 180], 0.18, 0.08);
}
const fallingLamps = new Set();
function updateLamps(dt) {
  for (const l of LAMPS) if (l.falling) fallingLamps.add(l);
  for (const l of fallingLamps) {
    l.w += 1.635 * Math.sin(Math.max(0.05, l.angle)) * dt;
    l.angle += l.w * dt;
    if (l.angle >= Math.PI / 2 - 0.02) {
      l.angle = Math.PI / 2 - 0.02;
      if (l.w > 0.6) { l.w = -l.w * 0.18; const hx = l.x - l.az * 8.8, hz = l.z + l.ax * 8.8; sparks(hx, 0.3, hz, 18, 0, 0); chime([520, 260], 0.1, 0.05); }
      else { l.falling = false; l.down = true; fallingLamps.delete(l); }
    }
    placeLamp(l);
  }
  // the nearest standing lamps get the real lights
  if (!REAL_LAMPS.length || look.night < 0.3) { for (const pl of REAL_LAMPS) pl.intensity = 0; return; }
  if ((updateLamps.t = (updateLamps.t || 0) + dt) > 0.3) {
    updateLamps.t = 0;
    const near = obstaclesNear(car.x, car.z, 80, updateLamps.buf || (updateLamps.buf = [])).filter((o) => o.type === "lamp" && o.lamp.lit)
      .map((o) => ({ l: o.lamp, d: Math.hypot(o.x - car.x, o.z - car.z) })).sort((a, b) => a.d - b.d).slice(0, REAL_LAMPS.length);
    U.lampR.value = near.length >= REAL_LAMPS.length ? clamp(near[near.length - 1].d + 8, 30, 90) : 90;
    const taken = new Set(near.map((n) => n.l));
    const free = REAL_LAMPS.filter((pl) => !pl.userData.lamp || !taken.has(pl.userData.lamp));
    for (const pl of REAL_LAMPS) if (pl.userData.lamp && taken.has(pl.userData.lamp)) taken.delete(pl.userData.lamp);
    for (const l of taken) {
      const pl = free.pop(); if (!pl) break;
      pl.userData.lamp = l; pl.intensity = 0;
      pl.position.set(l.x - l.nx * 1.8, 8.5, l.z - l.nz * 1.8); pl.target.position.set(l.x - l.nx * 3.5, 0, l.z - l.nz * 3.5);
    }
    for (const pl of free) pl.userData.lamp = null;
  }
  for (const pl of REAL_LAMPS) {
    const want = pl.userData.lamp && pl.userData.lamp.lit ? 700 * look.night : 0;
    pl.intensity += (want - pl.intensity) * Math.min(1, dt * 5);
  }
}

// ---------------------------------------------------------------- trees
const TREES = [];
let treeMesh = null;
function buildTrees() {
  const spots = [];
  for (const e of EDGES) for (let s = 0; s < e.len; s += 21) {
    const p = alongEdge(e, s + rand(-4, 4), rand(4.5, 7));
    if (!(maskAt(p.x, p.z) & (ROAD | BLDG | WATER))) spots.push([p.x, p.z]);
  }
  // parks: a jittered grid, kept where the mask says park
  const step = PHONE ? 34 : 22;
  for (let z = MASK.z0; z < MASK.z0 + MASK.h * MASK.res; z += step) for (let x = MASK.x0; x < MASK.x0 + MASK.w * MASK.res; x += step) {
    const px = x + rand(-7, 7), pz = z + rand(-7, 7);
    if (maskAt(px, pz) === PARK) spots.push([px, pz]);
  }
  const cap = PHONE ? 4000 : 12000;
  for (let i = spots.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [spots[i], spots[j]] = [spots[j], spots[i]]; }
  spots.length = Math.min(spots.length, cap);
  // rain trees: a wide, layered umbrella of foliage
  const crownG = mergeGeometries([
    new THREE.IcosahedronGeometry(2.6, 1).scale(1.45, 0.62, 1.45).translate(0, 5.0, 0),
    new THREE.IcosahedronGeometry(1.9, 1).scale(1.2, 0.7, 1.1).translate(1.2, 5.7, 0.6),
    new THREE.IcosahedronGeometry(1.7, 1).scale(1.1, 0.7, 1.2).translate(-1.1, 5.6, -0.7),
  ].map(unindexed));
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.32, 4.4, 6).translate(0, 2.2, 0), new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 1 }), spots.length);
  const crowns = new THREE.InstancedMesh(crownG, crownMaterial(), spots.length);
  const greens = [0x2f5e34, 0x3b6e3a, 0x26502f, 0x4a7a3c, 0x315a2a].map((c) => new THREE.Color(c));
  spots.forEach(([x, z], i) => {
    const s = rand(0.7, 1.4), yaw = rand(0, 6.3), sy = s * rand(0.85, 1.2);
    TREES.push({ x, z, s, sy, yaw, shake: 0, i });
    dummy.position.set(x, 0, z); dummy.rotation.set(0, yaw, 0); dummy.scale.set(s, sy, s); dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix); crowns.setMatrixAt(i, dummy.matrix);
    crowns.setColorAt(i, greens[i % greens.length]);
    addObstacle({ type: "tree", x, z, r: 0.3 * s, tree: TREES[i] });
  });
  dummy.scale.set(1, 1, 1);
  crowns.castShadow = true; trunks.castShadow = true;
  treeMesh = { trunks, crowns };
  scene.add(trunks, crowns);
}
const shakingTrees = new Set();
function updateTrees(dt) {
  for (const t of shakingTrees) {
    t.shake = Math.max(0, t.shake - dt);
    const a = Math.sin(t.shake * 28) * t.shake * 0.12;
    dummy.position.set(t.x, 0, t.z); dummy.rotation.set(a, t.yaw, a * 0.6); dummy.scale.set(t.s, t.sy, t.s); dummy.updateMatrix();
    treeMesh.trunks.setMatrixAt(t.i, dummy.matrix); treeMesh.crowns.setMatrixAt(t.i, dummy.matrix);
    treeMesh.trunks.instanceMatrix.needsUpdate = treeMesh.crowns.instanceMatrix.needsUpdate = true;
    if (!t.shake) shakingTrees.delete(t);
  }
  dummy.scale.set(1, 1, 1);
}

// ---------------------------------------------------------------- MRT viaduct and trains (decoration)
const trains = [];
function buildRail(town) {
  const lines = town.rail.map((r) => r.map(([lng, lat]) => new THREE.Vector2(X(lng), Z(lat)))).filter((l) => l.length > 1);
  const parts = [];
  for (const l of lines) {
    let since = 0;
    for (let i = 1; i < l.length; i++) {
      const a = l[i - 1], b = l[i], len = a.distanceTo(b);
      if (len < 0.5) continue;
      const mid = a.clone().add(b).multiplyScalar(0.5), yaw = Math.atan2(b.x - a.x, b.y - a.y);
      parts.push(new THREE.BoxGeometry(9, 1.3, len + 0.6).rotateY(yaw).translate(mid.x, 9, mid.y));
      for (since += len; since > 32; since -= 32) {
        const u = 1 - (since - 32) / len;
        parts.push(new THREE.CylinderGeometry(1.1, 1.3, 8.4, 8).translate(a.x + (b.x - a.x) * u, 4.2, a.y + (b.y - a.y) * u));
      }
    }
  }
  if (!parts.length) return;
  const via = new THREE.Mesh(mergeGeometries(parts.map(unindexed)), new THREE.MeshStandardMaterial({ color: 0x8d8f94, roughness: 0.9 }));
  via.castShadow = via.receiveShadow = true;
  scene.add(via);
  // two six-car trains shuttle along the longest stretches
  const withLen = lines.map((l) => { const cum = [0]; for (let i = 1; i < l.length; i++) cum.push(cum[i - 1] + l[i - 1].distanceTo(l[i])); return { l, cum, len: cum[cum.length - 1] }; })
    .sort((a, b) => b.len - a.len).slice(0, 2);
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0xe8eaee, roughness: 0.3, metalness: 0.5, clearcoat: 0.6 });
  const winMat = new THREE.MeshStandardMaterial({ color: 0x111820, emissive: 0xdfe9ff, emissiveIntensity: 1.2 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xd9473a, emissive: 0xd9473a, emissiveIntensity: 0.4 });
  const bodyG = new THREE.BoxGeometry(3.1, 3.3, 22).translate(0, 11.4, 0);
  const winG = new THREE.BoxGeometry(3.16, 0.9, 20).translate(0, 12.2, 0);
  const stripeG = new THREE.BoxGeometry(3.14, 0.25, 22).translate(0, 10.6, 0);
  withLen.forEach((track, k) => {
    const cars = [];
    for (let c = 0; c < 6; c++) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(bodyG, bodyMat), new THREE.Mesh(winG, winMat), new THREE.Mesh(stripeG, stripeMat));
      scene.add(g); cars.push(g);
    }
    trains.push({ track, cars, s: k * track.len * 0.5, dir: k ? -1 : 1, off: k ? 1.9 : -1.9 });
  });
  nightMats.push({ update: (n) => { winMat.emissiveIntensity = 0.4 + 1.6 * n; } });
}
function trackAt(t, s) {
  const { l, cum } = t;
  s = Math.max(0, Math.min(t.len, s));
  let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const a = l[i - 1], b = l[i], u = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return { x: a.x + (b.x - a.x) * u, z: a.y + (b.y - a.y) * u, yaw: Math.atan2(b.x - a.x, b.y - a.y) };
}
function updateTrains(dt) {
  for (const tr of trains) {
    const L = tr.track.len;
    tr.s += tr.dir * 19 * dt;
    if (tr.s > L + 40) { tr.dir = -1; } else if (tr.s < -140) { tr.dir = 1; }
    tr.cars.forEach((car, c) => {
      const p = trackAt(tr.track, tr.s - tr.dir * c * 22.6);
      car.position.set(p.x + Math.cos(p.yaw) * tr.off, 0, p.z - Math.sin(p.yaw) * tr.off);
      car.rotation.y = p.yaw;
    });
  }
}

// ---------------------------------------------------------------- bus stops
let STOPS = [];
function buildStops(stopsData) {
  // orient each stop to its nearest kerb
  STOPS = (stopsData.stops || []).filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y)).map((s, idx) => {
    const [x, z] = reachable(X(s.x), Z(s.y));
    let best = 1e9, bn = { nx: 0, nz: 1, dx: 1, dz: 0 };
    for (const e of EDGES) for (let i = 1; i < e.xs.length; i++) {
      const ax = e.xs[i - 1], az = e.zs[i - 1], bx = e.xs[i], bz = e.zs[i];
      const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2));
      const d = (ax + u * vx - x) ** 2 + (az + u * vz - z) ** 2;
      if (d < best) { best = d; const l = Math.sqrt(l2), dx = vx / l, dz = vz / l; bn = { dx, dz, nx: e.ccw ? dz : -dz, nz: e.ccw ? -dx : dx }; }
    }
    return { idx, code: s.c, name: s.n || s.c, x, z, hub: !!s.hub, o: s.o || [], d: s.d || [], ...bn, queue: [] };
  });
  const frame = new THREE.InstancedMesh(mergeGeometries([
    new THREE.BoxGeometry(4.2, 0.14, 2.0).translate(0, 2.65, -0.2),
    new THREE.BoxGeometry(0.1, 2.6, 0.1).translate(-1.95, 1.3, -1.0), new THREE.BoxGeometry(0.1, 2.6, 0.1).translate(1.95, 1.3, -1.0),
    new THREE.BoxGeometry(3.6, 0.45, 0.5).translate(0, 0.45, -0.75),
  ]), new THREE.MeshStandardMaterial({ color: 0x2f5d46, roughness: 0.6, metalness: 0.3 }), STOPS.length);
  const glass = new THREE.InstancedMesh(new THREE.BoxGeometry(3.8, 1.9, 0.05).translate(0, 1.5, -1.0), new THREE.MeshPhysicalMaterial({ color: 0x9fc4d8, transparent: true, opacity: 0.3, roughness: 0.05, metalness: 0.1 }), STOPS.length);
  const signMat = new THREE.MeshStandardMaterial({ color: 0x223, emissive: 0xd8e4f5, emissiveIntensity: 0.3 });
  const sign = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.6, 0.9).translate(0, 3.0, 0), signMat, STOPS.length);
  const post = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 2.7, 0.08).translate(0, 1.35, 0), frame.material, STOPS.length);
  STOPS.forEach((s, i) => {
    const yaw = Math.atan2(-s.nx, -s.nz); // open side faces the road
    const cx = s.x + s.nx * 3.2, cz = s.z + s.nz * 3.2;
    dummy.position.set(cx, 0, cz); dummy.rotation.set(0, yaw, 0); dummy.updateMatrix();
    frame.setMatrixAt(i, dummy.matrix); glass.setMatrixAt(i, dummy.matrix);
    dummy.position.set(s.x + s.nx * 1.4 + s.dx * 3, 0, s.z + s.nz * 1.4 + s.dz * 3); dummy.updateMatrix(); sign.setMatrixAt(i, dummy.matrix); post.setMatrixAt(i, dummy.matrix);
    // the shelter is solid: a box along the kerb, set back behind its open side
    addObstacle({ type: "box", x: cx + s.nx * 0.6, z: cz + s.nz * 0.6, body: new PH.Body({ x: cx + s.nx * 0.6, z: cz + s.nz * 0.6, yaw: Math.atan2(s.dx, s.dz), hl: 2.1, hw: 0.75, kinematic: true }) });
  });
  frame.castShadow = true;
  scene.add(frame, glass, sign, post);
  nightMats.push({ update: (n) => { signMat.emissiveIntensity = 0.15 + 0.45 * n; } });
}
// ---------------------------------------------------------------- people
// Walkers stroll the pavements and now and then cross the road; riders waiting at a stop stand in
// a cluster beside it. All of them are one mesh animated on the GPU (shaders.js). Anyone a vehicle
// hits becomes a ragdoll (physics.js), lies still for a moment, gets up and walks back.
const SHIRTS = [0xe9e6de, 0x2b3a55, 0xc0392b, 0x2e86c1, 0xf2a53a, 0x7cc58f, 0x8e44ad, 0x34495e, 0xd35400, 0xecf0f1, 0x16a085, 0xf5b7b1, 0x1d1f24, 0x6d8fb3];
const SKINS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xd4a373];
const PANTS = [0x2a2f3a, 0x1c2433, 0x3b3f46, 0x5b5346, 0x23324a, 0x6e6a5e, 0x141518];
const PERSON_G = (() => {
  const parts = [], limb = [];
  const add = (g, id) => { g = unindexed(g); g.deleteAttribute("uv"); parts.push(g); limb.push(...new Array(g.attributes.position.count).fill(id)); };
  add(new THREE.BoxGeometry(0.4, 0.58, 0.24).translate(0, 1.155, 0), 0);
  add(new THREE.SphereGeometry(0.12, 10, 8).translate(0, 1.62, 0), 1);
  add(new THREE.BoxGeometry(0.15, 0.9, 0.17).translate(0.1, 0.45, 0), 2);
  add(new THREE.BoxGeometry(0.15, 0.9, 0.17).translate(-0.1, 0.45, 0), 3);
  add(new THREE.BoxGeometry(0.09, 0.6, 0.1).translate(0.255, 1.13, 0), 4);
  add(new THREE.BoxGeometry(0.09, 0.6, 0.1).translate(-0.255, 1.13, 0), 5);
  add(new THREE.SphereGeometry(0.128, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0, 1.645, -0.01), 6);
  const g = mergeGeometries(parts);
  g.setAttribute("aLimb", new THREE.Float32BufferAttribute(limb, 1));
  return g;
})();
const PEOPLE = { n: 0, pose: null, gait: null, shirt: null, skin: null, pants: null, mesh: null };
const NW = PHONE ? 500 : 1600, QUEUE_SHOWN = 14, NR = 40; // walkers, people drawn per stop, returners
let Q0 = NW, R0 = NW;                                         // first queue slot, first returner slot
function buildPeople() {
  const n = NW + STOPS.length * QUEUE_SHOWN + NR;
  Q0 = NW; R0 = NW + STOPS.length * QUEUE_SHOWN;
  const attr = (k) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(n * k), k); a.setUsage(THREE.DynamicDrawUsage); return a; };
  Object.assign(PEOPLE, { n, pose: attr(4), gait: attr(4), shirt: attr(3), skin: attr(3), pants: attr(3) });
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    c.setHex(SHIRTS[(i * 7 + (i >> 3)) % SHIRTS.length]); PEOPLE.shirt.setXYZ(i, c.r, c.g, c.b);
    c.setHex(SKINS[(i * 3 + (i >> 2)) % SKINS.length]); PEOPLE.skin.setXYZ(i, c.r, c.g, c.b);
    c.setHex(PANTS[(i * 5 + (i >> 4)) % PANTS.length]); PEOPLE.pants.setXYZ(i, c.r, c.g, c.b);
  }
  PEOPLE.mesh = new THREE.Mesh(PERSON_G, peopleMaterial(PEOPLE, PH.HIP_Y, PH.SHOULDER_Y));
  PEOPLE.mesh.count = n; PEOPLE.mesh.frustumCulled = false; PEOPLE.mesh.castShadow = !PHONE;
  scene.add(PEOPLE.mesh);
}
function setPerson(i, x, z, yaw, phase, stride, shown, lean = 0) {
  const P = PEOPLE.pose.array, A = PEOPLE.gait.array, k = i * 4;
  P[k] = x; P[k + 1] = 0; P[k + 2] = z; P[k + 3] = yaw;
  A[k] = phase; A[k + 1] = stride; A[k + 2] = shown ? 1 : 0; A[k + 3] = lean;
}
const lookOf = (i) => ({ shirt: [PEOPLE.shirt.getX(i), PEOPLE.shirt.getY(i), PEOPLE.shirt.getZ(i)], skin: [PEOPLE.skin.getX(i), PEOPLE.skin.getY(i), PEOPLE.skin.getZ(i)], pants: [PEOPLE.pants.getX(i), PEOPLE.pants.getY(i), PEOPLE.pants.getZ(i)] });

const WALK = 0, CROSS = 1, DOWN = 2, BACK = 3, STAND = 4;
let walkers = [];
function buildWalkers() {
  if (!EDGES.length) return;
  // more people on pavements near the HDB town centre
  const weights = EDGES.map((e) => { const cx = e.xs[0], cz = e.zs[0]; return e.len * (0.4 + 3 * Math.exp(-Math.hypot(cx - 200, cz + 300) / 1400)); });
  const total = weights.reduce((a, b) => a + b, 0);
  walkers = [];
  for (let i = 0; i < NW; i++) {
    let r = Math.random() * total, k = 0;
    while (r > weights[k] && k < weights.length - 1) r -= weights[k++];
    const e = EDGES[k];
    walkers.push({ i, e, s: Math.random() * e.len, dir: Math.random() < 0.5 ? 1 : -1, v: rand(1.1, 1.6), off: rand(1.8, 3.2), ph: rand(0, 6.3),
      mode: WALK, x: 0, z: 0, yaw: 0, ox: 0, oz: 0, dvx: 0, dvz: 0, dodge: 0, react: -1, freeze: false, tx: 0, tz: 0 });
  }
}
// Walkers start across the road now and then: straight over to the far kerb, if it is near and the
// player is not bearing down on them.
function startCrossing(w, p) {
  if (Math.hypot(w.x - car.x, w.z - car.z) < 45) return;
  let inRoad = false;
  for (let d = 1; d < 45; d += 1) {
    const x = w.x - p.nx * d, z = w.z - p.nz * d, f = maskAt(x, z);
    if (f & (BLDG | WATER)) return;
    if (f & ROAD) inRoad = true;
    else if (inRoad) {
      if (d < 8) return;
      const tx = x - p.nx * 2, tz = z - p.nz * 2;
      if (maskAt(tx, tz) & (BLDG | WATER | ROAD)) return;
      Object.assign(w, { mode: CROSS, tx, tz, ox: 0, oz: 0 });
      return;
    }
  }
}
function arrive(w) {
  const ne = nearestEdge(w.x, w.z);
  if (ne) {
    w.e = ne.e; w.s = ne.s; w.off = rand(1.8, 3.2); w.dir = Math.random() < 0.5 ? 1 : -1;
    const p = alongEdge(w.e, w.s, w.off);
    w.ox = w.x - p.x; w.oz = w.z - p.z; // ease onto the pavement line
  }
  w.mode = WALK;
}
// a vehicle bearing down: after a moment's reaction, most people jump aside; some freeze
function threat(w, B, sp) {
  const [la, ls] = B.toLocal(w.x, w.z);
  return sp > 4 && la > -B.hl && la < B.hl + sp * 1.3 && Math.abs(ls) < B.hw + 1.1 ? ls : null;
}
function honk() {
  horn();
  for (const w of walkers) {
    if (w.mode === DOWN || w.react >= 0) continue;
    const [la, ls] = car.body.toLocal(w.x, w.z);
    if (la > 0 && la < 32 && Math.abs(ls) < 5) { w.react = rand(0.1, 0.3); w.freeze = false; }
  }
}
function updateWalkers(dt, movers) {
  for (const w of walkers) {
    if (w.mode === DOWN) { setPerson(w.i, w.x, w.z, w.yaw, 0, 0, false); continue; }
    let stride = 1;
    if (w.mode === WALK) {
      w.s += w.dir * w.v * dt; w.ph += w.v * dt * 5.2;
      const p = alongEdge(w.e, w.s, w.off);
      const back = Math.min(1, dt * 0.7);
      w.ox -= w.ox * back; w.oz -= w.oz * back;
      w.x = p.x + w.ox; w.z = p.z + w.oz; w.yaw = Math.atan2(p.dx * w.dir, p.dz * w.dir);
      if (Math.random() < dt * 0.0022 && G.running) startCrossing(w, p);
    } else if (w.mode === STAND) {
      stride = 0;
    } else { // crossing, or walking back after a fall
      const dx = w.tx - w.x, dz = w.tz - w.z, d = Math.hypot(dx, dz), v = w.mode === CROSS ? 1.35 : 1.05;
      if (d < 0.4) arrive(w);
      else { w.x += (dx / d) * v * dt; w.z += (dz / d) * v * dt; w.yaw = Math.atan2(dx, dz); w.ph += v * dt * 5.2; }
    }
    // dodging: a quick sidestep, away from the vehicle's line
    if (w.react < 0) {
      for (const B of movers) {
        const ls = threat(w, B.body, B.sp);
        if (ls !== null) { w.react = rand(0.25, 0.6); w.freeze = Math.random() < 0.22; w.side = ls >= 0 ? 1 : -1; w.from = B.body; break; }
      }
    } else if ((w.react -= dt) <= 0 && w.react > -1) {
      w.react = -1;
      if (!w.freeze && w.from) {
        const sx = Math.cos(w.from.yaw), sz = -Math.sin(w.from.yaw), side = w.side || 1;
        w.dvx = sx * side * 3.4; w.dvz = sz * side * 3.4; w.dodge = 0.55;
      }
    }
    if (w.dodge > 0) {
      w.dodge -= dt; stride = 1.6;
      const mx = w.dvx * dt, mz = w.dvz * dt;
      if (!solid(w.x + mx, w.z + mz)) { w.x += mx; w.z += mz; if (w.mode === WALK) { w.ox += mx; w.oz += mz; } }
    }
    // struck?
    for (const B of movers) {
      const b = B.body, [la, ls] = b.toLocal(w.x, w.z);
      if (Math.abs(la) > b.hl + 0.28 || Math.abs(ls) > b.hw + 0.28) continue;
      const [vx, vz] = b.pointVel(w.x - b.x, w.z - b.z);
      if (Math.hypot(vx, vz) > 1.5) { knockDown(w, B, vx, vz); break; }
      // a nudge at walking pace: they step out of the way
      const push = Math.min(b.hw + 0.3 - Math.abs(ls), b.hl + 0.3 - Math.abs(la));
      const sx = Math.cos(b.yaw), sz = -Math.sin(b.yaw), sg = ls >= 0 ? 1 : -1;
      if (!solid(w.x + sx * sg * push, w.z + sz * sg * push)) { w.x += sx * sg * push; w.z += sz * sg * push; if (w.mode === WALK) { w.ox += sx * sg * push; w.oz += sz * sg * push; } }
    }
    setPerson(w.i, w.x, w.z, w.yaw, w.ph, stride, true);
  }
}

// waiting riders, from the real queues
let queueDirty = true;
const queueSpot = (s, j) => {
  const row = Math.floor(j / 5), col = (j % 5) - 2;
  const off = 3.6 + row * 0.9 + ((j * 37) % 7) / 20, along = col * 0.8 + ((j * 13) % 5) / 10;
  return [s.x + s.nx * off + s.dx * along, s.z + s.nz * off + s.dz * along, Math.atan2(-s.nx, -s.nz) + ((j * 29) % 9 - 4) / 10];
};
function updateQueues() {
  if (!queueDirty) return;
  queueDirty = false;
  STOPS.forEach((s, si) => {
    const k = Math.min(QUEUE_SHOWN, s.queue.length);
    for (let j = 0; j < QUEUE_SHOWN; j++) {
      const [x, z, yaw] = queueSpot(s, j);
      setPerson(Q0 + si * QUEUE_SHOWN + j, x, z, yaw, j * 1.3, 0, j < k, 0);
    }
  });
}
// riders knocked over at a stop walk back and rejoin the queue
const returners = [];
function updateReturners(dt) {
  for (let r = 0; r < NR; r++) {
    const it = returners[r];
    if (!it) { setPerson(R0 + r, 0, 0, 0, 0, 0, false); continue; }
    const dx = it.tx - it.x, dz = it.tz - it.z, d = Math.hypot(dx, dz);
    if (d < 0.4) { returners[r] = null; it.done(); continue; }
    it.x += (dx / d) * 1.05 * dt; it.z += (dz / d) * 1.05 * dt; it.ph += 1.05 * dt * 5.2;
    setPerson(R0 + r, it.x, it.z, Math.atan2(dx, dz), it.ph, 1, true);
  }
}
function queueHits(movers) {
  for (const B of movers) {
    const b = B.body;
    for (const s of STOPS) {
      if (!s.queue.length || Math.abs(s.x - b.x) > 14 || Math.abs(s.z - b.z) > 14) continue;
      for (let j = Math.min(QUEUE_SHOWN, s.queue.length) - 1; j >= 0; j--) {
        const [x, z, yaw] = queueSpot(s, j), [la, ls] = b.toLocal(x, z);
        if (Math.abs(la) > b.hl + 0.28 || Math.abs(ls) > b.hw + 0.28) continue;
        const [vx, vz] = b.pointVel(x - b.x, z - b.z);
        if (Math.hypot(vx, vz) < 1.2) continue;
        const rider = s.queue.splice(j, 1)[0]; queueDirty = true;
        const slot = Q0 + s.idx * QUEUE_SHOWN + j;
        spawnRagdoll(x, z, yaw, 0, lookOf(slot), B, vx, vz, (rx, rz) => {
          const r = returners.findIndex((q) => !q);
          const back = () => { if (G.running && rider.t0 + rider.patience > G.t) { s.queue.push(rider); queueDirty = true; } };
          if (r < 0) return back();
          const [tx, tz] = queueSpot(s, Math.min(QUEUE_SHOWN - 1, s.queue.length));
          returners[r] = { x: rx, z: rz, tx, tz, ph: 0, done: back };
          PEOPLE.shirt.setXYZ(R0 + r, ...lookOf(slot).shirt); PEOPLE.skin.setXYZ(R0 + r, ...lookOf(slot).skin); PEOPLE.pants.setXYZ(R0 + r, ...lookOf(slot).pants);
          PEOPLE.shirt.needsUpdate = PEOPLE.skin.needsUpdate = PEOPLE.pants.needsUpdate = true;
        });
      }
    }
  }
}
function knockDown(w, B, vx, vz) {
  w.mode = DOWN;
  spawnRagdoll(w.x, w.z, w.yaw, Math.sin(w.ph) * 0.5, lookOf(w.i), B, vx, vz, (rx, rz) => {
    w.x = rx; w.z = rz;
    const p = alongEdge(w.e, w.s, w.off);
    Object.assign(w, { mode: BACK, tx: p.x, tz: p.z, ox: 0, oz: 0, react: -1, dodge: 0 });
  });
}

// ---------------------------------------------------------------- ragdolls
const RD_CAP = PHONE ? 10 : 20;
const ragdolls = [];
let rdMesh = null;
function buildRagdollMeshes() {
  const box = (w, d) => new THREE.BoxGeometry(w, 1, d).translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
  const mk = (g, n) => { const m = new THREE.InstancedMesh(g, mat, n); m.count = 0; m.frustumCulled = false; m.castShadow = !PHONE; scene.add(m); for (let i = 0; i < n; i++) m.setColorAt(i, new THREE.Color(1, 1, 1)); return m; };
  rdMesh = {
    torso: mk(box(0.4, 0.24), RD_CAP), head: mk(new THREE.SphereGeometry(0.12, 10, 8), RD_CAP),
    hair: mk(new THREE.SphereGeometry(0.128, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0, 0.025, -0.01), RD_CAP),
    upper: mk(box(0.09, 0.1), RD_CAP * 2), fore: mk(box(0.085, 0.095), RD_CAP * 2),
    thigh: mk(box(0.15, 0.17), RD_CAP * 2), shin: mk(box(0.14, 0.16), RD_CAP * 2),
  };
}
const _c = new THREE.Color();
// Turn a person into a ragdoll at (x, z). B: the vehicle that hit them (or null); vx, vz: its
// speed where it struck. onUp(x, z) runs once they are back on their feet.
function spawnRagdoll(x, z, yaw, swing, lk, B, vx, vz, onUp) {
  if (ragdolls.length >= RD_CAP) { const old = ragdolls.shift(); finishRagdoll(old); }
  const rd = new PH.Ragdoll(PH.standingPose(x, z, yaw, swing));
  // a shove from the bumper before the shapes take over, a little lift at speed
  const sp = Math.hypot(vx, vz);
  rd.kick(vx * 0.35, Math.min(2.5, sp * 0.12), vz * 0.35, 1 / 120);
  Object.assign(rd, { lk, onUp, state: "fall", t: 0, from: B ? B.body : null, by: B ? B.who : null, x0: x, z0: z });
  ragdolls.push(rd);
  if (B && B.who === "player") pedestrianIncident(rd, sp);
  thud(Math.min(1, sp / 12));
  return rd;
}
function finishRagdoll(rd) { const [px, , pz] = rd.pelvis(); rd.onUp(px, pz); }
function updateRagdolls(dt, boxes) {
  const sub = Math.max(1, Math.ceil(dt * 120)), h = dt / sub; // about 120 steps a second, whatever the frame rate
  for (let k = ragdolls.length - 1; k >= 0; k--) {
    const rd = ragdolls[k];
    if (rd.state === "fall") {
      for (let s = 0; s < sub; s++) {
        const near = boxes.filter((b) => Math.abs(b.x - rd.p[6]) < 12 && Math.abs(b.z - rd.p[8]) < 12);
        const push = rd.step(h, { boxes: near, solid });
        if (rd.from && (push[0] || push[1])) rd.from.applyImpulse(-push[0] * 0.8, -push[1] * 0.8, 0, 0);
      }
      if ((rd.still > 1.0 && rd.age > 2.2) || rd.age > 9) { rd.state = "lie"; rd.t = 0; }
    } else if (rd.state === "lie") {
      if ((rd.t += dt) > 1.6) {
        rd.state = "rise"; rd.t = 0; rd.from0 = Float32Array.from(rd.p);
        const [px, , pz] = rd.pelvis();
        rd.to = PH.standingPose(px, pz, Math.atan2(rd.x0 - px, rd.z0 - pz) || 0, 0);
      }
    } else if (rd.state === "rise") {
      rd.t += dt / 1.2;
      const u = Math.min(1, rd.t);
      for (let j = 0; j < PH.NJ; j++) {
        const lag = j <= PH.RSH || j === PH.LEL || j === PH.REL || j === PH.LHA || j === PH.RHA ? 0.25 : 0; // the body comes up after the legs
        const e = clamp((u - lag) / (1 - lag), 0, 1), s = e * e * (3 - 2 * e);
        for (let c = 0; c < 3; c++) rd.p[j * 3 + c] = rd.from0[j * 3 + c] + (rd.to[j * 3 + c] - rd.from0[j * 3 + c]) * s;
      }
      if (u >= 1) { ragdolls.splice(k, 1); finishRagdoll(rd); }
    }
  }
  drawRagdolls();
}
const _X = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3(), _A = new THREE.Vector3();
function segment(mesh, i, p, a, b, hint, w, d, extra = 0) {
  _A.set(p[a * 3], p[a * 3 + 1], p[a * 3 + 2]);
  _Y.set(p[b * 3] - _A.x, p[b * 3 + 1] - _A.y, p[b * 3 + 2] - _A.z);
  const len = _Y.length() + extra; _Y.normalize();
  _X.copy(hint).addScaledVector(_Y, -hint.dot(_Y));
  if (_X.lengthSq() < 1e-6) _X.set(1, 0, 0).addScaledVector(_Y, -_Y.x);
  _X.normalize(); _Z.crossVectors(_X, _Y);
  _A.addScaledVector(_Y, -extra * 0.5);
  _m.set(_X.x * w, _Y.x * len, _Z.x * d, _A.x, _X.y * w, _Y.y * len, _Z.y * d, _A.y, _X.z * w, _Y.z * len, _Z.z * d, _A.z, 0, 0, 0, 1);
  mesh.setMatrixAt(i, _m);
}
const _hint = new THREE.Vector3();
function drawRagdolls() {
  if (!rdMesh) return;
  ragdolls.forEach((rd, i) => {
    const p = rd.p, J = PH;
    _hint.set(p[J.LSH * 3] - p[J.RSH * 3], p[J.LSH * 3 + 1] - p[J.RSH * 3 + 1], p[J.LSH * 3 + 2] - p[J.RSH * 3 + 2]);
    segment(rdMesh.torso, i, p, J.PELVIS, J.NECK, _hint, 1, 1, 0.07);
    segment(rdMesh.hair, i, p, J.NECK, J.HEAD, _hint, 1, 1);
    // head and hair: placed at the head joint, turned with the neck
    _m.decompose(_v, _q, _s); _v.set(p[J.HEAD * 3], p[J.HEAD * 3 + 1], p[J.HEAD * 3 + 2]); _s.set(1, 1, 1);
    _m.compose(_v, _q, _s); rdMesh.head.setMatrixAt(i, _m); rdMesh.hair.setMatrixAt(i, _m);
    segment(rdMesh.upper, i * 2, p, J.LSH, J.LEL, _hint, 1, 1); segment(rdMesh.upper, i * 2 + 1, p, J.RSH, J.REL, _hint, 1, 1);
    segment(rdMesh.fore, i * 2, p, J.LEL, J.LHA, _hint, 1, 1, 0.04); segment(rdMesh.fore, i * 2 + 1, p, J.REL, J.RHA, _hint, 1, 1, 0.04);
    segment(rdMesh.thigh, i * 2, p, J.LHIP, J.LKN, _hint, 1, 1); segment(rdMesh.thigh, i * 2 + 1, p, J.RHIP, J.RKN, _hint, 1, 1);
    segment(rdMesh.shin, i * 2, p, J.LKN, J.LFT, _hint, 1, 1, 0.06); segment(rdMesh.shin, i * 2 + 1, p, J.RKN, J.RFT, _hint, 1, 1, 0.06);
    const L = rd.lk;
    rdMesh.torso.setColorAt(i, _c.setRGB(...L.shirt)); rdMesh.head.setColorAt(i, _c.setRGB(...L.skin)); rdMesh.hair.setColorAt(i, _c.setRGB(0.05, 0.04, 0.035));
    for (const k of [i * 2, i * 2 + 1]) { rdMesh.upper.setColorAt(k, _c.setRGB(...L.shirt)); rdMesh.fore.setColorAt(k, _c.setRGB(...L.skin)); rdMesh.thigh.setColorAt(k, _c.setRGB(...L.pants)); rdMesh.shin.setColorAt(k, _c.setRGB(...L.pants)); }
  });
  for (const k in rdMesh) {
    const m = rdMesh[k], per = k === "torso" || k === "head" || k === "hair" ? 1 : 2;
    m.count = ragdolls.length * per; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}
// ---------------------------------------------------------------- vehicles on the road
// The study's simulated fleet (450 ten-seat shuttles) and its bus model, at the same minute, plus
// decorative private cars. They keep left of the road centreline, stop for whatever is in their
// way (the player, a wreck, someone lying in the road), and a hard enough knock takes one out of
// the simulation: it becomes a wreck that slides, spins and dents like the player's vehicle.
const NPC = {
  van: { hl: 3.3, hw: 1.15, mass: 2600, shape: { roof: 2.38 }, name: "a robovan" },
  bus: { hl: 6.0, hw: 1.27, mass: 12000, shape: { roof: 3.4 }, name: "a bus" },
  car: { hl: 2.25, hw: 0.9, mass: 1350, shape: { cabin: 1.35, bonnet: 0.95, roof: 1.45 }, name: "a car" },
};
const LANE = 1.7;
let PATHS = null;
const FLEETS = [];
function decodePaths(pathsRaw) {
  const [lng0, lat0] = pathsRaw.origin;
  PATHS = pathsRaw.paths.map((flat) => {
    const n = flat.length / 3, xs = new Float32Array(n), zs = new Float32Array(n), fr = new Float32Array(n);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) { x += flat[3 * i]; y += flat[3 * i + 1]; xs[i] = X(lng0 + x / 1e5); zs[i] = Z(lat0 + y / 1e5); fr[i] = flat[3 * i + 2] / 1000; }
    return { xs, zs, fr, cum: null };
  });
}
function decodeLegs(anim) {
  const t = anim.legs, n = t.pid.length, t0 = new Float64Array(n);
  let acc = 0, maxDur = 1800;
  for (let i = 0; i < n; i++) { acc += t.t0[i]; t0[i] = acc; if (t.dur[i] > maxDur) maxDur = t.dur[i]; }
  return { n, pid: t.pid, t0, dur: t.dur, cut: t.cut, maxDur };
}
function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
function poseOn(path, f) {
  const { xs, zs, fr } = path; let lo = 0, hi = fr.length - 1;
  f = Math.max(0, Math.min(1, f));
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (fr[m] <= f) lo = m; else hi = m; }
  const u = Math.max(0, Math.min(1, (f - fr[lo]) / (fr[hi] - fr[lo] || 1)));
  return { x: xs[lo] + u * (xs[hi] - xs[lo]), z: zs[lo] + u * (zs[hi] - zs[lo]), yaw: Math.atan2(xs[hi] - xs[lo], zs[hi] - zs[lo]) };
}
function instancedModel(root, cap) {
  const meshes = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const im = new THREE.InstancedMesh(o.geometry.clone().applyMatrix4(o.matrixWorld), o.material, cap);
    im.count = 0; im.frustumCulled = false; im.castShadow = !PHONE;
    scene.add(im); meshes.push(im);
  });
  return meshes;
}
function addFleet(kind, anim, model, cap) {
  FLEETS.push({ kind, legs: decodeLegs(anim), inst: instancedModel(model, cap), cap, seen: [], delay: new Map(), crashed: new Set(), spec: NPC[kind], model });
}
// Something within a short stopping distance ahead, in this vehicle's lane?
function gapAhead(x, z, yaw, spec, obstacles, self) {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  let gap = Infinity;
  for (const o of obstacles) {
    if (self && o.self === self) continue;
    const dx = o.x - x, dz = o.z - z, la = dx * s + dz * c;
    if (la < spec.hl - 0.6 || la > spec.hl + 30 + o.r) continue;
    if (Math.abs(dx * c - dz * s) < spec.hw + o.r + 0.35) gap = Math.min(gap, la - spec.hl - o.r);
  }
  return gap;
}
function updateFleets(simSec, dt, obstacles) {
  for (const F of FLEETS) {
    const L = F.legs, i0 = lowerBound(L.t0, simSec - L.maxDur - 600), i1 = lowerBound(L.t0, simSec);
    let n = 0;
    F.seen.length = 0;
    for (let i = i0; i < i1 && n < F.cap; i++) {
      if (F.crashed.has(i)) continue;
      const delay = F.delay.get(i) || 0, t = simSec - L.t0[i] - delay, dur = L.dur[i] || 1;
      if (t >= (L.cut[i] > 0 ? L.cut[i] : dur)) { if (delay) F.delay.delete(i); continue; }
      if (t < 0) continue;
      const path = PATHS[L.pid[i]];
      if (!path || path.xs.length < 2) continue;
      const p = poseOn(path, t / dur);
      if (Math.abs(p.x - car.x) > 900 || Math.abs(p.z - car.z) > 900) continue;
      const q = poseOn(path, (t + 0.5) / dur);
      const x = p.x + Math.cos(p.yaw) * LANE, z = p.z - Math.sin(p.yaw) * LANE;
      let vx = (q.x - p.x) * 2, vz = (q.z - p.z) * 2;
      if (dt > 0 && Math.abs(x - car.x) < 120 && Math.abs(z - car.z) < 120 && gapAhead(x, z, p.yaw, F.spec, obstacles) < 6) {
        F.delay.set(i, delay + dt); vx = vz = 0;
      }
      F.seen.push({ F, i, x, z, yaw: p.yaw, vx, vz });
      dummy.position.set(x, 0, z); dummy.rotation.set(0, p.yaw - Math.PI / 2, 0); dummy.updateMatrix();
      for (const im of F.inst) im.setMatrixAt(n, dummy.matrix);
      n++;
    }
    for (const im of F.inst) { im.count = n; im.instanceMatrix.needsUpdate = true; }
  }
}

// private cars: a simple saloon built here, in a range of paint colours; a quarter are taxis
const CAR_COLOURS = [0xe8e8e8, 0x1b1d22, 0x9aa1a8, 0x5d6670, 0x8b1e24, 0x1f3f73, 0xf2f2ee, 0x31463a, 0xb8a27a, 0x2c2f35];
const TAXI_COLOURS = [0x1f63c4, 0xf2c94c, 0x101215, 0xd8dde3];
function carGeometries() {
  const shape = (pts) => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const extrude = (pts, w, bevel) => new THREE.ExtrudeGeometry(shape(pts), { depth: w, bevelEnabled: !!bevel, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4 }).translate(0, 0, -w / 2);
  const paint = mergeGeometries([
    extrude([[-2.18, 0.34], [2.16, 0.34], [2.22, 0.56], [2.15, 0.8], [1.15, 0.94], [0.92, 0.97], [-1.92, 0.99], [-2.2, 0.9], [-2.24, 0.58]], 1.72, 0.05),
    extrude([[0.28, 1.36], [0.2, 1.42], [-1.1, 1.45], [-1.18, 1.37]], 1.5, 0.03),
  ].map(unindexed));
  const glass = extrude([[0.94, 0.95], [0.26, 1.38], [-1.12, 1.4], [-1.88, 0.98]], 1.56, 0);
  const dark = mergeGeometries([
    ...[[1.38, 0.82], [1.38, -0.82], [-1.38, 0.82], [-1.38, -0.82]].map(([x, z]) => new THREE.CylinderGeometry(0.33, 0.33, 0.24, 14).rotateX(Math.PI / 2).translate(x, 0.33, z)).map(unindexed),
    unindexed(new THREE.BoxGeometry(0.08, 0.16, 1.5).translate(2.2, 0.48, 0)),
    unindexed(new THREE.BoxGeometry(0.08, 0.16, 1.5).translate(-2.24, 0.48, 0)),
  ]);
  const head = mergeGeometries([new THREE.BoxGeometry(0.06, 0.12, 0.36).translate(2.17, 0.7, 0.6), new THREE.BoxGeometry(0.06, 0.12, 0.36).translate(2.17, 0.7, -0.6)]);
  const tail = mergeGeometries([new THREE.BoxGeometry(0.06, 0.12, 0.42).translate(-2.21, 0.8, 0.6), new THREE.BoxGeometry(0.06, 0.12, 0.42).translate(-2.21, 0.8, -0.6)]);
  const sign = new THREE.BoxGeometry(0.28, 0.17, 0.72).translate(-0.45, 1.54, 0);
  return { paint, glass, dark, head, tail, sign };
}
const CARG = carGeometries();
const CARM = {
  paint: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.45, clearcoat: 1, clearcoatRoughness: 0.08 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x0b1117, roughness: 0.05, metalness: 0.2 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.8 }),
  head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d8, emissiveIntensity: 2 }),
  tail: new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2a1a, emissiveIntensity: 1.5 }),
  sign: new THREE.MeshStandardMaterial({ color: 0x0c3, emissive: 0x2bd46a, emissiveIntensity: 2 }),
};
const AMB = { list: [], cap: PHONE ? 12 : 34, mesh: null };
function buildAmbient() {
  AMB.mesh = {};
  for (const k of Object.keys(CARG)) {
    const m = new THREE.InstancedMesh(CARG[k], CARM[k], AMB.cap);
    m.count = 0; m.frustumCulled = false; m.castShadow = !PHONE && (k === "paint" || k === "glass");
    if (k === "paint") for (let i = 0; i < AMB.cap; i++) m.setColorAt(i, new THREE.Color(1, 1, 1));
    AMB.mesh[k] = m; scene.add(m);
  }
}
function pathCum(path) {
  if (path.cum) return path.cum;
  const c = new Float32Array(path.xs.length);
  for (let i = 1; i < c.length; i++) c[i] = c[i - 1] + Math.hypot(path.xs[i] - path.xs[i - 1], path.zs[i] - path.zs[i - 1]);
  return (path.cum = c);
}
function ambPose(a) {
  const path = PATHS[a.pid], c = pathCum(path), s = clamp(a.s, 0, c[c.length - 1]);
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
  const u = (s - c[lo]) / (c[hi] - c[lo] || 1), dx = path.xs[hi] - path.xs[lo], dz = path.zs[hi] - path.zs[lo];
  const yaw = Math.atan2(dx, dz);
  a.x = path.xs[lo] + u * dx + Math.cos(yaw) * LANE; a.z = path.zs[lo] + u * dz - Math.sin(yaw) * LANE;
  if (Math.abs(dx) + Math.abs(dz) > 1e-3) a.yaw = yaw;
}
function placeAmbient(a) {
  for (let tries = 0; tries < 30; tries++) {
    const pid = Math.floor(Math.random() * PATHS.length), c = pathCum(PATHS[pid]), L = c[c.length - 1];
    if (L < 150) continue;
    Object.assign(a, { pid, s: rand(0, L * 0.7), L });
    ambPose(a);
    const d = Math.hypot(a.x - car.x, a.z - car.z);
    if (d > 140 && d < 480 && !(maskAt(a.x, a.z) & (BLDG | WATER))) return true;
  }
  return false;
}
function updateAmbient(dt, obstacles) {
  if (!PATHS || !AMB.mesh) return;
  while (AMB.list.length < AMB.cap) {
    const taxi = Math.random() < 0.25;
    const a = { v: 0, vmax: rand(9, 14), x: 0, z: 0, yaw: 0, taxi, colour: taxi ? TAXI_COLOURS[Math.floor(Math.random() * TAXI_COLOURS.length)] : CAR_COLOURS[Math.floor(Math.random() * CAR_COLOURS.length)] };
    if (!placeAmbient(a)) break;
    a.v = a.vmax * 0.7;
    AMB.list.push(a);
  }
  let n = 0, ns = 0;
  for (let k = AMB.list.length - 1; k >= 0; k--) {
    const a = AMB.list[k];
    if (dt > 0) {
      const gap = gapAhead(a.x, a.z, a.yaw, NPC.car, obstacles, a);
      const want = Math.min(a.vmax, Math.sqrt(2 * 5 * Math.max(0, gap - 3)));
      a.v += clamp(want - a.v, -8 * dt, 2.6 * dt);
      a.v = Math.max(0, a.v);
      a.s += a.v * dt;
      ambPose(a);
    }
    if (a.s >= a.L - 1 || Math.hypot(a.x - car.x, a.z - car.z) > 650) { if (!placeAmbient(a)) { AMB.list.splice(k, 1); continue; } }
  }
  for (const a of AMB.list) {
    dummy.position.set(a.x, 0, a.z); dummy.rotation.set(0, a.yaw - Math.PI / 2, 0); dummy.updateMatrix();
    for (const k of ["paint", "glass", "dark", "head", "tail"]) AMB.mesh[k].setMatrixAt(n, dummy.matrix);
    AMB.mesh.paint.setColorAt(n, _c.setHex(a.colour));
    if (a.taxi) AMB.mesh.sign.setMatrixAt(ns++, dummy.matrix);
    n++;
  }
  for (const k in AMB.mesh) { const m = AMB.mesh[k]; m.count = k === "sign" ? ns : n; m.instanceMatrix.needsUpdate = true; }
  if (AMB.mesh.paint.instanceColor) AMB.mesh.paint.instanceColor.needsUpdate = true;
}

// ---------------------------------------------------------------- wrecks and dents
const WRECKS = [];
let MODELS = {}; // name -> loaded scene graph (robotaxi, robovan, bus)
// Give every mesh under obj its own geometry in obj's frame, so dents stay on this one vehicle.
function dentable(obj) {
  obj.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const meshes = [];
  obj.traverse((m) => { if (m.isMesh) meshes.push(m); });
  for (const m of meshes) {
    const g = m.geometry.clone().applyMatrix4(_m.multiplyMatrices(inv, m.matrixWorld));
    m.geometry = g; m.position.set(0, 0, 0); m.rotation.set(0, 0, 0); m.scale.set(1, 1, 1);
    if (m.parent !== obj) { obj.add(m); }
    m.userData.orig = Float32Array.from(g.attributes.position.array);
    m.castShadow = true;
  }
  return obj;
}
function upgradeMaterials(root) {
  const paint = /paint|cover|cream|white|steel/;
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const m = o.material, name = m.name || "";
    if (paint.test(name)) o.material = Object.assign(new THREE.MeshPhysicalMaterial({ color: m.color, roughness: 0.3, metalness: 0.4, clearcoat: 1, clearcoatRoughness: 0.08 }), { name });
    else if (name === "glass") o.material = Object.assign(new THREE.MeshPhysicalMaterial({ color: 0x0a1218, roughness: 0.04, metalness: 0.25 }), { name });
  });
}
const nz3 = (x, y, z) => { const v = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453; return v - Math.floor(v); };
// Push the panels in where (px, pz) was struck, along (inx, inz) pointing into the vehicle.
function dent(obj, b, px, pz, inx, inz, dv, hy = 0.7) {
  if (!obj || dv < 1.2) return;
  const s = Math.sin(b.yaw), c = Math.cos(b.yaw), dx = px - b.x, dz = pz - b.z;
  const lx = dx * s + dz * c, lz = -dx * c + dz * s;             // model frame: x ahead, z to the right
  const ix = inx * s + inz * c, iz = -inx * c + inz * s;
  const R = 0.6 + Math.min(1.1, dv * 0.09), depth = Math.min(0.3, 0.03 + dv * 0.022);
  obj.traverse((m) => {
    if (!m.isMesh || !m.userData.orig) return;
    const P = m.geometry.attributes.position, O = m.userData.orig;
    let moved = false;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      const d = Math.hypot(x - lx, (y - hy) * 0.8, z - lz);
      if (d >= R) continue;
      const f = (1 - d / R) ** 2 * depth * (0.7 + 0.6 * nz3(O[i * 3], O[i * 3 + 1], O[i * 3 + 2]));
      let nx = x + ix * f, ny = y - f * 0.3, nzz = z + iz * f;
      const ox = O[i * 3], oy = O[i * 3 + 1], oz = O[i * 3 + 2], off = Math.hypot(nx - ox, ny - oy, nzz - oz);
      if (off > 0.4) { const k = 0.4 / off; nx = ox + (nx - ox) * k; ny = oy + (ny - oy) * k; nzz = oz + (nzz - oz) * k; }
      P.setXYZ(i, nx, ny, nzz); moved = true;
    }
    if (moved) { P.needsUpdate = true; m.geometry.computeVertexNormals(); }
  });
}
function wreckModel(kind, colour) {
  let obj;
  if (kind === "car") {
    obj = new THREE.Group();
    const paint = CARM.paint.clone(); paint.color.setHex(colour);
    for (const k of ["paint", "glass", "dark", "head", "tail"]) obj.add(new THREE.Mesh(CARG[k], k === "paint" ? paint : CARM[k]));
  } else obj = (MODELS[kind === "van" ? "robovan" : "bus"] || new THREE.Group()).clone(true);
  dentable(obj);
  // hazard lights
  const spec = NPC[kind], hz = new THREE.MeshBasicNodeMaterial({ color: 0xffa31a });
  for (const [x, z] of [[spec.hl - 0.1, spec.hw - 0.1], [spec.hl - 0.1, -spec.hw + 0.1], [-spec.hl + 0.1, spec.hw - 0.1], [-spec.hl + 0.1, -spec.hw + 0.1]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.16), hz); m.position.set(x, 0.85, z); m.userData.hazard = true; obj.add(m);
  }
  scene.add(obj);
  return obj;
}
function spawnWreck(kind, n, colour) {
  const spec = NPC[kind];
  const body = new PH.Body({ x: n.x, z: n.z, yaw: n.yaw, vx: n.vx || 0, vz: n.vz || 0, hl: spec.hl, hw: spec.hw, mass: spec.mass, e: 0.2, mu: 0.6 });
  const wk = { body, obj: wreckModel(kind, colour), kind, spec, age: 0, dmg: 0 };
  WRECKS.push(wk);
  if (WRECKS.length > (PHONE ? 6 : 12)) removeWreck(WRECKS[0]);
  placeWreck(wk);
  return wk;
}
function removeWreck(wk) {
  const k = WRECKS.indexOf(wk); if (k >= 0) WRECKS.splice(k, 1);
  scene.remove(wk.obj);
  wk.obj.traverse((m) => { if (m.isMesh && m.userData.orig) m.geometry.dispose(); });
}
function placeWreck(wk) {
  const b = wk.body;
  wk.obj.position.set(b.x, wk.sink || 0, b.z); wk.obj.rotation.set(0, b.yaw - Math.PI / 2, 0);
}
// Two bodies touching: trade the impulse, dent both, throw sparks; returns the change of speed of a.
function crash(a, b, objA, objB, c, onA, onB) {
  const j = PH.resolve(a, b, c);
  if (j <= 0) return 0;
  const dva = j / a.mass, dvb = j / b.mass;
  dent(objA, a, c.px, c.pz, -c.nx, -c.nz, dva * 1.4);
  dent(objB, b, c.px, c.pz, c.nx, c.nz, dvb * 1.4);
  const rel = dva + dvb;
  if (rel > 1.5) {
    sparks(c.px, 0.7, c.pz, Math.min(40, 6 + rel * 3), (a.vx + b.vx) / 2, (a.vz + b.vz) / 2);
    if (rel > 6) glassBurst(c.px, 1.0, c.pz, Math.min(30, rel * 2));
    crashSound(rel, c.px, c.pz);
  }
  if (onA) onA(dva, c); if (onB) onB(dvb, c);
  return dva;
}
// a vehicle touching the simulation's vans and buses or the private cars
function hitTraffic(B, objB, isPlayer, onB) {
  for (const F of FLEETS) for (const n of F.seen) {
    if (Math.abs(n.x - B.x) > 16 || Math.abs(n.z - B.z) > 16 || F.crashed.has(n.i)) continue;
    const k = new PH.Body({ x: n.x, z: n.z, yaw: n.yaw, vx: n.vx, vz: n.vz, hl: F.spec.hl, hw: F.spec.hw, kinematic: true });
    const c = PH.collide(B, k);
    if (!c) continue;
    const closing = (B.vx - n.vx) * c.nx + (B.vz - n.vz) * c.nz;
    if (closing < 2.2 && isPlayer) { PH.resolve(B, k, c); continue; } // a nudge: it waits for you
    F.crashed.add(n.i);
    const wk = spawnWreck(F.kind, n);
    const c2 = PH.collide(B, wk.body);
    if (c2) crash(B, wk.body, objB, wk.obj, c2, onB, (dv) => { wk.dmg += dv; });
    if (isPlayer) vehicleIncident(F.spec.name, closing);
  }
  for (let k = AMB.list.length - 1; k >= 0; k--) {
    const a = AMB.list[k];
    if (Math.abs(a.x - B.x) > 12 || Math.abs(a.z - B.z) > 12) continue;
    const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
    const kb = new PH.Body({ x: a.x, z: a.z, yaw: a.yaw, vx: fx * a.v, vz: fz * a.v, hl: NPC.car.hl, hw: NPC.car.hw, kinematic: true });
    const c = PH.collide(B, kb);
    if (!c) continue;
    const closing = (B.vx - kb.vx) * c.nx + (B.vz - kb.vz) * c.nz;
    if (closing < 1.5 && isPlayer) { PH.resolve(B, kb, c); a.v = 0; continue; }
    AMB.list.splice(k, 1);
    const wk = spawnWreck("car", { x: a.x, z: a.z, yaw: a.yaw, vx: kb.vx, vz: kb.vz }, a.colour);
    const c2 = PH.collide(B, wk.body);
    if (c2) crash(B, wk.body, objB, wk.obj, c2, onB, (dv) => { wk.dmg += dv; });
    if (isPlayer) vehicleIncident("a car", closing);
  }
}
// trees, lamp posts and bus shelters near a body
const _near = [];
function hitStatic(b, obj, onHit) {
  for (const o of obstaclesNear(b.x, b.z, b.hl + 2, _near)) {
    if (o.type === "box") {
      const c = PH.collide(b, o.body); if (!c) continue;
      const j = PH.resolve(b, o.body, c);
      if (j > 0) { dent(obj, b, c.px, c.pz, -c.nx, -c.nz, j / b.mass * 1.3); if (j / b.mass > 2) { glassBurst(c.px, 1.4, c.pz, 12); crashSound(j / b.mass, c.px, c.pz); } onHit(j / b.mass, c, "a bus shelter"); }
    } else if (o.type === "lamp") {
      const l = o.lamp; if (l.falling || l.down) continue;
      const c = PH.circleContact(b, o.x, o.z, o.r); if (!c) continue;
      const sp = b.speed();
      if (sp > 3.5) { knockLamp(l, b.vx, b.vz, sp); b.vx *= 0.84; b.vz *= 0.84; dent(obj, b, c.px, c.pz, c.nx, c.nz, sp * 0.3); onHit(sp * 0.16, c, "a lamp post"); }
      else { const j = PH.resolveStatic(b, c.px, c.pz, c.nx, c.nz, c.depth); onHit(j / b.mass, c, "a lamp post"); }
    } else if (o.type === "tree") {
      const c = PH.circleContact(b, o.x, o.z, o.r); if (!c) continue;
      const j = PH.resolveStatic(b, c.px, c.pz, c.nx, c.nz, c.depth, 0.2, 0.4), dv = j / b.mass;
      if (dv > 1) { o.tree.shake = Math.min(1.2, 0.3 + dv * 0.1); shakingTrees.add(o.tree); leaves(o.x, o.z, Math.min(30, dv * 4)); dent(obj, b, c.px, c.pz, c.nx, c.nz, dv * 1.3); crashSound(dv * 0.7, c.px, c.pz); }
      onHit(dv, c, "a tree");
    }
  }
}
function updateWrecks(dt) {
  for (let k = WRECKS.length - 1; k >= 0; k--) {
    const wk = WRECKS[k], b = wk.body;
    wk.age += dt;
    if (wk.age > 70 && Math.hypot(b.x - car.x, b.z - car.z) > 140) { removeWreck(wk); continue; }
    if (wk.age > 120) { wk.sink = (wk.sink || 0) - dt * 0.6; if (wk.sink < -3) { removeWreck(wk); continue; } }
    PH.coast(b, dt);
    b.integrate(dt);
    const hit = PH.collideWalls(b, solid);
    if (hit.j > 0) { const dv = hit.j / b.mass; wk.dmg += dv; dent(wk.obj, b, hit.x, hit.z, hit.nx, hit.nz, dv * 1.3); if (dv > 2) { sparks(hit.x, 0.6, hit.z, 10 + dv * 2, 0, 0); crashSound(dv, hit.x, hit.z); } }
    hitStatic(b, wk.obj, (dv) => { wk.dmg += dv; });
    for (let j = 0; j < k; j++) {
      const o = WRECKS[j], c = PH.collide(b, o.body);
      if (c) crash(b, o.body, wk.obj, o.obj, c, (dv) => { wk.dmg += dv; }, (dv) => { o.dmg += dv; });
    }
    if (b.speed() > 2) hitTraffic(b, wk.obj, false, (dv) => { wk.dmg += dv; });
    placeWreck(wk);
    const on = Math.floor(wk.age * 2) % 2 === 0;
    wk.obj.traverse((m) => { if (m.userData.hazard) m.visible = on; });
    if (wk.dmg > 6 && Math.random() < dt * (wk.dmg > 12 ? 9 : 4)) {
      const f = Math.sin(b.yaw), g = Math.cos(b.yaw);
      smoke(b.x + f * b.hl * 0.7, wk.spec.shape.cabin ? 1.0 : 1.4, b.z + g * b.hl * 0.7, wk.dmg > 12);
    }
  }
}

// ---------------------------------------------------------------- effects: smoke, sparks, glass, skid marks
class Puffs {
  constructor(cap, additive) {
    this.cap = cap; this.list = [];
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1); this.alpha.setUsage(THREE.DynamicDrawUsage);
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), puffMaterial(this.alpha, SOFT, additive), cap);
    this.mesh.count = 0; this.mesh.frustumCulled = false;
    for (let i = 0; i < cap; i++) this.mesh.setColorAt(i, new THREE.Color(1, 1, 1));
    scene.add(this.mesh);
  }
  emit(p) { if (this.list.length >= this.cap) this.list.shift(); this.list.push({ life: p.life, max: p.life, drag: 0.98, grav: 0, grow: 0, a: 1, ...p }); }
  update(dt) {
    const L = this.list;
    for (let i = L.length - 1; i >= 0; i--) {
      const p = L[i];
      if ((p.life -= dt) <= 0) { L.splice(i, 1); continue; }
      p.vy -= p.grav * dt; const d = Math.pow(p.drag, dt * 60);
      p.vx *= d; p.vy *= d; p.vz *= d;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.size += p.grow * dt;
      if (p.y < 0.05) { p.y = 0.05; p.vy = Math.abs(p.vy) * 0.3; }
    }
    const n = L.length;
    for (let i = 0; i < n; i++) {
      const p = L[i], u = p.life / p.max;
      _m.compose(_v.set(p.x, p.y, p.z), camera.quaternion, _A.set(p.size, p.size, p.size));
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, _c.setRGB(p.r, p.g, p.b));
      this.alpha.array[i] = p.a * (p.fadeIn ? Math.min(1, (1 - u) * 6) * u : u);
    }
    this.mesh.count = n; this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }
  clear() { this.list.length = 0; }
}
let smokeFx = null, glowFx = null;
function sparks(x, y, z, n, vx = 0, vz = 0) {
  for (let i = 0; i < n; i++) glowFx.emit({ x, y, z, vx: vx * 0.4 + rand(-5, 5), vy: rand(1, 6), vz: vz * 0.4 + rand(-5, 5), life: rand(0.25, 0.6), size: rand(0.06, 0.14), grav: 14, r: 1, g: rand(0.55, 0.8), b: 0.25, a: 1, drag: 0.96 });
}
function smoke(x, y, z, dark) {
  const g = dark ? rand(0.06, 0.12) : rand(0.45, 0.6);
  smokeFx.emit({ x: x + rand(-0.3, 0.3), y, z: z + rand(-0.3, 0.3), vx: rand(-0.3, 0.3) + 0.4, vy: rand(1.0, 2.0), vz: rand(-0.3, 0.3), life: rand(2.2, 3.6), size: rand(0.5, 0.9), grow: 1.1, r: g, g, b: g * 1.04, a: dark ? 0.55 : 0.35, fadeIn: true, drag: 0.99 });
  if (dark && Math.random() < 0.5) glowFx.emit({ x, y: y - 0.1, z, vx: 0, vy: rand(0.8, 1.6), vz: 0, life: rand(0.25, 0.45), size: rand(0.4, 0.8), grow: -0.6, r: 1, g: rand(0.35, 0.55), b: 0.1, a: 0.9, drag: 0.98 });
}
// debris: glass, plastic, leaves; small tumbling boxes that bounce and settle
const DEB = { cap: 260, list: [], mesh: null };
function buildDebris() {
  DEB.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0.1 }), DEB.cap);
  DEB.mesh.count = 0; DEB.mesh.frustumCulled = false;
  for (let i = 0; i < DEB.cap; i++) DEB.mesh.setColorAt(i, new THREE.Color(1, 1, 1));
  scene.add(DEB.mesh);
}
function debris(x, y, z, n, colour, size, spread, up) {
  for (let i = 0; i < n; i++) {
    if (DEB.list.length >= DEB.cap) DEB.list.shift();
    DEB.list.push({ x, y, z, vx: rand(-spread, spread), vy: rand(up * 0.4, up), vz: rand(-spread, spread), rx: rand(0, 6), ry: rand(0, 6), wx: rand(-12, 12), wy: rand(-12, 12), s: size * rand(0.5, 1.4), c: colour, life: rand(6, 10) });
  }
}
const glassBurst = (x, y, z, n) => debris(x, y, z, n, 0xbfd8e6, 0.07, 3.5, 3.5);
const leaves = (x, z, n) => debris(x, 4.5, z, n, 0x3f6e32, 0.12, 2.5, 1.5);
function updateDebris(dt) {
  const L = DEB.list;
  for (let i = L.length - 1; i >= 0; i--) {
    const d = L[i];
    if ((d.life -= dt) <= 0) { L.splice(i, 1); continue; }
    if (d.y > 0.02 || Math.abs(d.vy) > 0.2) {
      d.vy -= 9.81 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt; d.rx += d.wx * dt; d.ry += d.wy * dt;
      if (d.y < 0.02) { d.y = 0.02; d.vy = -d.vy * 0.3; d.vx *= 0.5; d.vz *= 0.5; d.wx *= 0.5; d.wy *= 0.5; }
    }
  }
  L.forEach((d, i) => {
    dummy.position.set(d.x, d.y, d.z); dummy.rotation.set(d.rx, d.ry, 0); dummy.scale.set(d.s, d.s * 0.3, d.s * 0.8); dummy.updateMatrix();
    DEB.mesh.setMatrixAt(i, dummy.matrix); DEB.mesh.setColorAt(i, _c.setHex(d.c));
  });
  dummy.scale.set(1, 1, 1);
  DEB.mesh.count = L.length; DEB.mesh.instanceMatrix.needsUpdate = true; if (DEB.mesh.instanceColor) DEB.mesh.instanceColor.needsUpdate = true;
}
// skid marks: rubber laid down by the rear tyres when they slide or lock
const SKID = { cap: PHONE ? 500 : 1400, n: 0, head: 0, mesh: null, prev: null };
function buildSkids() {
  SKID.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicNodeMaterial({ color: 0x050505, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }), SKID.cap);
  SKID.mesh.count = 0; SKID.mesh.frustumCulled = false; scene.add(SKID.mesh);
}
function layRubber(b, on) {
  const s = Math.sin(b.yaw), c = Math.cos(b.yaw);
  const wheels = [-1, 1].map((side) => [b.x - s * b.hl * 0.68 + c * side * b.hw * 0.8, b.z - c * b.hl * 0.68 - s * side * b.hw * 0.8]);
  if (on && SKID.prev) {
    if (Math.hypot(wheels[0][0] - SKID.prev[0][0], wheels[0][1] - SKID.prev[0][1]) < 0.3) return; // wait for a longer stretch
    for (let k = 0; k < 2; k++) {
      const [x0, z0] = SKID.prev[k], [x1, z1] = wheels[k], len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.25 || len > 3) continue;
      dummy.position.set((x0 + x1) / 2, 0.075, (z0 + z1) / 2); dummy.rotation.set(0, Math.atan2(x1 - x0, z1 - z0), 0); dummy.scale.set(0.22, 1, len + 0.05); dummy.updateMatrix();
      SKID.mesh.setMatrixAt(SKID.head, dummy.matrix); SKID.head = (SKID.head + 1) % SKID.cap; SKID.n = Math.min(SKID.cap, SKID.n + 1);
    }
    dummy.scale.set(1, 1, 1);
    SKID.mesh.count = SKID.n; SKID.mesh.instanceMatrix.needsUpdate = true;
  }
  SKID.prev = on ? wheels : null;
}
// flying trucks: decoration on loops above the town, with their thruster animation
const SKY = [];
function buildSkyTrucks(gltf) {
  for (let k = 0; k < (PHONE ? 4 : 8); k++) {
    const obj = gltf.scene.clone(true);
    obj.scale.setScalar(1.6);
    const mixer = new THREE.AnimationMixer(obj);
    for (const clip of gltf.animations) mixer.clipAction(clip).play();
    scene.add(obj);
    SKY.push({ obj, mixer, cx: rand(-1500, 1500), cz: rand(-1200, 1200), a: rand(500, 1300), b: rand(300, 800), alt: rand(90, 220), w: rand(0.03, 0.06) * (Math.random() < 0.5 ? -1 : 1), ph: rand(0, 6.3) });
  }
}
function updateSky(t, dt) {
  for (const s of SKY) {
    const u = s.ph + t * s.w, x = s.cx + s.a * Math.sin(u), z = s.cz + s.b * Math.cos(u);
    const dx = s.a * Math.cos(u) * s.w, dz = -s.b * Math.sin(u) * s.w;
    s.obj.position.set(x, s.alt + 8 * Math.sin(u * 3), z);
    s.obj.rotation.set(0, Math.atan2(dx, dz) - Math.PI / 2, 0);
    s.mixer.update(dt);
  }
}

// ---------------------------------------------------------------- the player's vehicle
// A rigid box with arcade tyres (physics.drive). Damage dents the panels, slows the engine, pulls
// the steering to one side and, past half, sets the bonnet smoking.
const VEHICLES = {
  robotaxi: { seats: 4, accel: 4.2, vmax: 16.7, turn: 1.9, grip: 24, len: 4.6, hl: 2.3, hw: 0.98, mass: 1500, shape: { cabin: 1.55, bonnet: 0.8, roof: 1.4 }, cam: [10, 4.2] },
  robovan: { seats: 10, accel: 2.9, vmax: 13.9, turn: 1.45, grip: 20, len: 6.6, hl: 3.3, hw: 1.15, mass: 2600, shape: { roof: 2.38 }, cam: [13, 5.4] },
};
const car = {
  body: new PH.Body({ hl: 2.3, hw: 0.98, mass: 1500, e: 0.2, mu: 0.5 }),
  get x() { return this.body.x; }, get z() { return this.body.z; }, get yaw() { return this.body.yaw; },
  v: 0, slide: 0, steer: 0, spec: VEHICLES.robotaxi, obj: null, models: {}, safe: [], lights: { head: [], tail: [] }, glass: [], broken: 0, pull: 1,
};
const keys = {};
let camMode = 0; // 0 chase, 1 high, 2 overhead
const head = new THREE.SpotLight(0xfff0d8, 0, 110, 0.55, 0.6, 1.2);
head.position.set(2.2, 1.0, 0);
head.target.position.set(25, 0, 0);

function setVehicle(name) {
  car.spec = VEHICLES[name];
  const b = car.body; b.hl = car.spec.hl; b.hw = car.spec.hw; b.setMass(car.spec.mass);
  if (car.obj) { car.obj.remove(head, head.target); scene.remove(car.obj); }
  car.obj = dentable(car.models[name].clone(true));
  // its own lamp materials: brake lights brighten, broken headlights go dark
  car.lights = { head: [], tail: [] }; car.glass = [];
  car.obj.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const n = o.material.name;
    if (n === "headlight" || n === "taillight") { o.material = o.material.clone(); car.lights[n === "headlight" ? "head" : "tail"].push(o.material); }
    if (n === "glass") { o.material = o.material.clone(); car.glass.push(o.material); }
  });
  car.obj.add(head, head.target);
  head.position.x = car.spec.len / 2;
  scene.add(car.obj);
  car.broken = 0; car.pull = Math.random() < 0.5 ? -1 : 1;
}

function driveStep(dt) {
  const S = car.spec, b = car.body, cond = G.condition;
  if (G.tow > 0) { PH.coast(b, dt); b.integrate(dt); PH.collideWalls(b, solid); car.v = 0; return; }
  const onRoad = maskAt(b.x, b.z) & ROAD;
  const target = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
  car.steer += (target - car.steer) * Math.min(1, dt * 6);
  const P = { accel: S.accel * (0.65 + 0.35 * cond), vmax: (onRoad ? S.vmax : 6) * (0.6 + 0.4 * cond), turn: S.turn, grip: S.grip, pull: (1 - cond) * 0.14 * car.pull };
  const r = PH.drive(b, { throttle: !!keys.up, brake: !!keys.down, steer: car.steer, handbrake: !!keys.hand }, P, dt);
  car.v = r.vf; car.slide = r.slide;
  b.integrate(dt);
  const hit = PH.collideWalls(b, solid);
  if (hit.j > 0) {
    const dv = hit.j / b.mass;
    dent(car.obj, b, hit.x, hit.z, hit.nx, hit.nz, dv * 1.3);
    if (dv > 2) { sparks(hit.x, 0.6, hit.z, 8 + dv * 2, b.vx, b.vz); crashSound(dv, hit.x, hit.z); }
    if (dv > 7) glassBurst(hit.x, 1.1, hit.z, 14);
    playerImpact(dv, hit.x, hit.z, "a wall");
  }
  if (!Number.isFinite(b.x + b.z + b.vx + b.vz + b.yaw + b.w)) recover();
  else if (!solid(b.x, b.z) && (driveStep.t = (driveStep.t || 0) + dt) > 0.5) {
    driveStep.t = 0;
    car.safe.push({ x: b.x, z: b.z, yaw: b.yaw });
    if (car.safe.length > 8) car.safe.shift();
  }
}
// R: back to where the vehicle was a few seconds ago, stopped
function recover() {
  const p = car.safe[0] || car.safe[car.safe.length - 1];
  const b = car.body;
  if (p) Object.assign(b, { x: p.x, z: p.z, yaw: p.yaw });
  Object.assign(b, { vx: 0, vz: 0, w: 0 }); car.v = 0; car.steer = 0;
  car.safe.length = 0;
}

let shake = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), _want = new THREE.Vector3(), _look = new THREE.Vector3();
function updateCamera(dt, attract, t) {
  if (attract) {  // menu: a slow flight round the town centre
    const a = t * 0.04;
    camPos.set(250 + Math.cos(a) * 900, 380, -350 + Math.sin(a) * 900);
    camera.position.copy(camPos); camera.lookAt(250, 0, -350);
    if (camera.fov !== 60) { camera.fov = 60; camera.updateProjectionMatrix(); }
    return;
  }
  const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
  let [back, upH] = camMode === 0 ? car.spec.cam : camMode === 1 ? [34, 24] : [6, 150];
  // pull in (and up) rather than sit inside a block behind the car
  for (let k = 0; k < 4 && camMode !== 2 && maskAt(car.x - fx * back, car.z - fz * back) & BLDG; k++) { back *= 0.6; upH += 2.5; }
  _want.set(car.x - fx * back, upH, car.z - fz * back);
  const k = 1 - Math.exp(-dt * (camMode === 2 ? 3 : 4.5));
  camera.position.lerp(_want, k);
  camLook.lerp(_look.set(car.x + fx * (camMode === 2 ? 1 : 6), 1.2, car.z + fz * (camMode === 2 ? 1 : 6)), Math.min(1, k * 1.5));
  if (shake > 0) { camera.position.x += rand(-1, 1) * shake; camera.position.y += rand(-1, 1) * shake; shake = Math.max(0, shake - dt * 1.5); }
  camera.lookAt(camLook);
  const fov = 58 + 11 * Math.min(1, Math.abs(car.v) / car.spec.vmax) + (G.slow > 0 ? -6 : 0);
  if (Math.abs(fov - camera.fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 2.5); camera.updateProjectionMatrix(); }
}

// ---------------------------------------------------------------- riders: observed demand
let D = {};
let HOUR = 19.5, HI = 14;            // chosen hour, and its index in the hourly arrays (05:00 = 0)
const FLOWS = new Map();              // origin stop code -> [{ d: stop index, w }] for this hour
const byCode = new Map();
function prepareDemand() {
  FLOWS.clear(); byCode.clear();
  STOPS.forEach((s) => byCode.set(s.code, s));
  for (const [o, d, w] of (D.demand.top_flows || [])[HI] || []) {
    if (!byCode.has(o) || !byCode.has(d)) continue;
    if (!FLOWS.has(o)) FLOWS.set(o, []);
    FLOWS.get(o).push({ d: byCode.get(d).idx, w });
  }
}
// The destination: an observed top flow from this stop, else a stop riders alight at this
// hour (LTA's alighting counts), nearer ones likelier, like the short hub-bound rides in the data.
function pickDest(s) {
  const f = FLOWS.get(s.code);
  if (f && Math.random() < 0.7) {
    let r = Math.random() * f.reduce((a, b) => a + b.w, 0);
    for (const c of f) { r -= c.w; if (r <= 0) return c.d; }
  }
  let total = 0;
  const w = STOPS.map((t) => {
    const dist = Math.hypot(t.x - s.x, t.z - s.z);
    const v = t === s || dist < 250 || dist > 3500 ? 0 : (t.d[HI] || 0) * Math.exp(-dist / 1200);
    total += v; return v;
  });
  let r = Math.random() * total;
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
  return (s.idx + 1) % STOPS.length;
}
// What the same ride takes by bus, roughly: the hour's mean wait plus a bus crawling along at
// 17 km/h stop to stop over a detour 1.3 times the straight line. A game estimate.
function busEstimate(s, dest) {
  const dist = Math.hypot(STOPS[dest].x - s.x, STOPS[dest].z - s.z);
  return ((D.baseline.wait_min || [])[HI] || 4) * 60 + (dist * 1.3) / 4.7 + 20;
}
function spawnRider(s, t, age = 0) {
  const dest = pickDest(s);
  s.queue.push({ dest, t0: t - age, patience: rand(300, 600), bus: busEstimate(s, dest), from: s.idx });
  queueDirty = true;
}
function seedQueues() {
  for (const s of STOPS) {
    s.queue = [];
    const expect = ((s.o[HI] || 0) * 4) / 60; // riders arriving over the last ~4 minutes
    let k = Math.floor(expect + Math.random());
    while (k-- > 0) spawnRider(s, 0, rand(0, 240));
  }
  queueDirty = true;
}

// ---------------------------------------------------------------- game state, HUD
const G = {
  running: false, paused: false, over: false, t: 0, score: 0, delivered: 0, beat: 0, onboard: [], dwell: 0, veh: "robotaxi",
  condition: 1, safety: 5, streak: 0, peds: 0, crashes: 0, lost: 0, tow: 0, slow: 0, lastDrop: null, suspended: false,
};

function toast(big, small, tone) {
  const el = $("toast"), col = tone === "bad" ? "--bad" : tone ? "--ion" : "--sodium";
  el.innerHTML = `<span style="color:var(${col})">${big}</span>${small ? `<small>${small}</small>` : ""}`;
  el.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 2400);
}
const floaters = [];
function floater(text, x, z, tone) {
  const el = document.createElement("div"); el.className = `floater${tone === "bad" ? " bad" : tone ? " teal" : ""}`; el.textContent = text;
  $("labels").appendChild(el);
  floaters.push({ el, x, z, age: 0 });
}
const tmp = new THREE.Vector3();
function project(x, y, z) {
  tmp.set(x, y, z).project(camera);
  if (tmp.z > 1 || tmp.z < -1) return null;
  return [(tmp.x * 0.5 + 0.5) * innerWidth, (-tmp.y * 0.5 + 0.5) * innerHeight];
}
function updateFloaters(dt) {
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i]; f.age += dt;
    const p = project(f.x, 6 + f.age * 6, f.z);
    if (!p || f.age > 1.6) { f.el.remove(); floaters.splice(i, 1); continue; }
    f.el.style.left = `${p[0]}px`; f.el.style.top = `${p[1]}px`; f.el.style.opacity = String(1 - f.age / 1.6);
  }
}

function renderPax() {
  const S = car.spec;
  $("pax-title").textContent = `On board ${G.onboard.length}/${S.seats}`;
  $("seats").innerHTML = Array.from({ length: S.seats }, (_, i) => `<i class="${i < G.onboard.length ? "on" : ""}"></i>`).join("");
  $("pax-empty").hidden = G.onboard.length > 0;
  $("pax-list").innerHTML = G.onboard.map((r) => {
    const s = STOPS[r.dest], dist = Math.hypot(s.x - car.x, s.z - car.z), left = r.bus - (G.t - r.t0);
    return `<li><span class="to">→ ${s.name}</span><span class="d">${dist > 950 ? (dist / 1000).toFixed(1) + " km" : Math.round(dist / 10) * 10 + " m"}</span>`
      + `<span class="bus${left < 0 ? " late" : ""}">${left >= 0 ? `beat the bus: ${mmss(left)} left` : `the bus would be there by now`}</span></li>`;
  }).join("");
}

const stars = (n) => "★★★★★".slice(0, Math.max(0, Math.ceil(n - 0.01))) + "☆☆☆☆☆".slice(0, 5 - Math.max(0, Math.ceil(n - 0.01)));
const mult = () => 1 + 0.25 * Math.min(4, G.streak);
function updateHud() {
  $("clock").textContent = clockOf(HOUR + G.t / 3600);
  $("shift-label").textContent = `shift ${mmss(SHIFT - G.t)}`;
  $("shift-label").classList.toggle("late", SHIFT - G.t < 30);
  $("score").textContent = String(G.score);
  $("delivered").textContent = String(G.delivered);
  $("beat").textContent = G.delivered ? `${G.beat} (${Math.round((100 * G.beat) / G.delivered)}%)` : "0";
  $("streak").textContent = `×${mult().toFixed(2).replace(/0$/, "")}`;
  $("safety").textContent = stars(G.safety);
  const c = Math.round(G.condition * 100), bar = $("cond-bar");
  bar.style.width = `${c}%`; bar.style.background = c > 60 ? "var(--good)" : c > 30 ? "var(--sodium)" : "var(--bad)";
  $("cond").textContent = G.tow > 0 ? "towing" : `${c}%`;
  $("kmh").textContent = String(Math.round(Math.abs(car.v) * 3.6));
}

// ---------------------------------------------------------------- beams and labels: where to go
let beams = null;
const BEAM_CAP = 260;
const AMBER = new THREE.Color(0xf2a53a), TEAL = new THREE.Color(0x7cc8ff);
function buildBeams() {
  const c = document.createElement("canvas"); c.width = 4; c.height = 128;
  const x = c.getContext("2d"), gr = x.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(1, "rgba(255,255,255,1)");
  x.fillStyle = gr; x.fillRect(0, 0, 4, 128);
  const tex = new THREE.CanvasTexture(c);
  beams = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 20, 1, true).translate(0, 0.5, 0),
    new THREE.MeshBasicMaterial({ alphaMap: tex, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }), BEAM_CAP);
  beams.frustumCulled = false;
  for (let i = 0; i < BEAM_CAP; i++) beams.setColorAt(i, AMBER);
  scene.add(beams);
}
function updateBeams() {
  const dests = new Set(G.onboard.map((r) => r.dest));
  let n = 0;
  for (const s of STOPS) {
    const isDest = dests.has(s.idx), q = s.queue.length;
    if (!isDest && !q) continue;
    if (n >= BEAM_CAP) break;
    let h = isDest ? 120 : 10 + Math.min(q, 30) * 2.4, r = isDest ? 4 : 2.2 + Math.min(q, 30) * 0.04;
    if (Math.hypot(s.x - car.x, s.z - car.z) < 45) { r = 0.9; h *= 0.6; } // don't drown the car in light
    dummy.position.set(s.x - s.nx * 2, 0, s.z - s.nz * 2); dummy.rotation.set(0, 0, 0); dummy.scale.set(r, h, r); dummy.updateMatrix();
    beams.setMatrixAt(n, dummy.matrix); beams.setColorAt(n, isDest ? TEAL : AMBER); n++;
  }
  dummy.scale.set(1, 1, 1);
  beams.count = n; beams.instanceMatrix.needsUpdate = true; if (beams.instanceColor) beams.instanceColor.needsUpdate = true;
}
const labelEls = [];
function updateLabels() {
  const dests = new Set(G.onboard.map((r) => r.dest));
  const near = STOPS.filter((s) => dests.has(s.idx) || s.queue.length)
    .map((s) => ({ s, d: Math.hypot(s.x - car.x, s.z - car.z) + (dests.has(s.idx) ? -2000 : 0) }))
    .sort((a, b) => a.d - b.d).slice(0, 6);
  while (labelEls.length < 6) { const el = document.createElement("div"); el.className = "stop-label"; $("labels").appendChild(el); labelEls.push(el); }
  labelEls.forEach((el, i) => {
    const it = near[i]; const p = it && project(it.s.x, dests.has(it.s.idx) ? 14 : 8 + Math.min(it.s.queue.length, 30) * 2.4, it.s.z);
    if (!p || !G.running) { el.hidden = true; return; }
    const dest = dests.has(it.s.idx), real = Math.hypot(it.s.x - car.x, it.s.z - car.z);
    el.hidden = false; el.className = `stop-label${dest ? " dest" : ""}`;
    el.textContent = dest ? `drop · ${it.s.name} · ${Math.round(real)} m` : `${it.s.queue.length} waiting · ${Math.round(real)} m`;
    el.style.left = `${p[0]}px`; el.style.top = `${p[1]}px`;
  });
}

// a chevron above the car pointing to the nearest drop-off, or to riders when empty
const chevron = new THREE.Mesh((() => {
  const sh = new THREE.Shape([new THREE.Vector2(0, 1.6), new THREE.Vector2(1.1, -0.6), new THREE.Vector2(0, -0.1), new THREE.Vector2(-1.1, -0.6)]);
  return new THREE.ExtrudeGeometry(sh, { depth: 0.18, bevelEnabled: false }).rotateX(Math.PI / 2); // lies flat, tip along +z
})(), new THREE.MeshBasicMaterial({ color: 0x7cc8ff, fog: false, transparent: true, opacity: 0.9 }));
scene.add(chevron);
function updateChevron() {
  let target = null, best = 1e12;
  if (G.onboard.length) {
    for (const r of G.onboard) { const s = STOPS[r.dest], d = Math.hypot(s.x - car.x, s.z - car.z); if (d < best) { best = d; target = s; } }
    chevron.material.color.copy(TEAL);
  } else {
    for (const s of STOPS) { if (!s.queue.length) continue; const d = Math.hypot(s.x - car.x, s.z - car.z) / (1 + Math.min(s.queue.length, 20) * 0.08); if (d < best) { best = d; target = s; } }
    chevron.material.color.copy(AMBER);
  }
  chevron.visible = !!target && G.running && camMode !== 2;
  if (!target) return;
  chevron.position.set(car.x, car.spec.len > 5 ? 4.6 : 3.4, car.z);
  chevron.rotation.y = Math.atan2(target.x - car.x, target.z - car.z);
}

// ---------------------------------------------------------------- the minimap
let miniBase = null;
const MINI_RES = 4;
function buildMinimapBase(town, buildings) {
  const W = Math.ceil(8600 / MINI_RES), H = Math.ceil(7600 / MINI_RES);
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#0c111b"; ctx.fillRect(0, 0, W, H);
  const fill = (rings, color) => {
    ctx.fillStyle = color; ctx.beginPath();
    for (const ring of rings) { ring.forEach(([lng, lat], i) => { const x = (X(lng) - MASK.x0) / MINI_RES, y = (Z(lat) - MASK.z0) / MINI_RES; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); }
    ctx.fill();
  };
  fill(town.green, "#16301f"); fill(town.water, "#163452"); fill(town.roads, "#4a5468"); fill(buildings.filter((b) => Array.isArray(b.p)).map((b) => b.p), "#262d3a");
  miniBase = cv;
}
function drawMinimap() {
  const cv = $("minimap"), ctx = cv.getContext("2d"), W = cv.width, R = W / 2, scale = W / 1000; // 1 km across
  ctx.save();
  ctx.clearRect(0, 0, W, W);
  ctx.beginPath(); ctx.arc(R, R, R, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = "#0c111b"; ctx.fillRect(0, 0, W, W);
  ctx.translate(R, R); ctx.rotate(car.yaw - Math.PI);
  const k = scale * MINI_RES;
  ctx.drawImage(miniBase, -(car.x - MASK.x0) * scale, -(car.z - MASK.z0) * scale, miniBase.width * k, miniBase.height * k);
  const dot = (x, z, r, color, ring) => {
    const px = (x - car.x) * scale, py = (z - car.z) * scale;
    if (Math.abs(px) > R * 1.5 || Math.abs(py) > R * 1.5) return;
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
    if (ring) { ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.stroke(); } else { ctx.fillStyle = color; ctx.fill(); }
  };
  for (const F of FLEETS) for (const p of F.seen) dot(p.x, p.z, F.kind === "bus" ? 3 : 2.2, F.kind === "bus" ? "#2f7f8c" : "#8a6430");
  for (const a of AMB.list) dot(a.x, a.z, 1.8, "#59606b");
  for (const wk of WRECKS) dot(wk.body.x, wk.body.z, 3.2, "#e2725b");
  for (const rd of ragdolls) dot(rd.p[6], rd.p[8], 2.6, "#e9e6de");
  for (const s of STOPS) if (s.queue.length) dot(s.x, s.z, 3 + Math.min(s.queue.length, 25) * 0.25, "#f2a53a");
  for (const r of G.onboard) dot(STOPS[r.dest].x, STOPS[r.dest].z, 9, "#7cc8ff", true);
  ctx.restore();
  // edge pointers for drop-offs beyond the map
  for (const r of G.onboard) {
    const s = STOPS[r.dest], dx = s.x - car.x, dz = s.z - car.z;
    if (Math.hypot(dx, dz) * scale < R - 8) continue;
    const a = Math.atan2(dz, dx) + (car.yaw - Math.PI);
    ctx.beginPath(); ctx.arc(R + Math.cos(a) * (R - 8), R + Math.sin(a) * (R - 8), 6, 0, Math.PI * 2); ctx.fillStyle = "#7cc8ff"; ctx.fill();
  }
  ctx.fillStyle = "#e9e6de"; ctx.beginPath(); ctx.moveTo(R, R - 12); ctx.lineTo(R + 8, R + 9); ctx.lineTo(R, R + 4); ctx.lineTo(R - 8, R + 9); ctx.closePath(); ctx.fill();
}

// ---------------------------------------------------------------- sound
let ac = null, muted = false, engine = null, screech = null, noiseBuf = null;
function audioInit() {
  if (ac) return;
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), f = ac.createBiquadFilter(), g = ac.createGain();
    o.type = "sawtooth"; o.frequency.value = 50; f.type = "lowpass"; f.frequency.value = 500; g.gain.value = 0;
    o.connect(f).connect(g).connect(ac.destination); o.start();
    engine = { o, g };
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource(), bp = ac.createBiquadFilter(), sg = ac.createGain();
    src.buffer = noiseBuf; src.loop = true; bp.type = "bandpass"; bp.frequency.value = 1900; bp.Q.value = 4; sg.gain.value = 0;
    src.connect(bp).connect(sg).connect(ac.destination); src.start();
    screech = sg;
  } catch (e) { ac = null; }
}
const safeSound = (fn) => { if (!ac || muted) return; try { fn(); } catch (e) { ac = null; engine = null; screech = null; } };
function chime(freqs, dur = 0.12, vol = 0.1) {
  safeSound(() => {
    let t = ac.currentTime;
    for (const fq of freqs) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "triangle"; o.frequency.value = fq;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + 0.05);
      t += dur * 0.55;
    }
  });
}
function burst(dur, type, freq, vol, q = 1) {
  const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(), t = ac.currentTime;
  s.buffer = noiseBuf; f.type = type; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(ac.destination); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
}
// louder the harder the knock and the nearer the camera
function crashSound(strength, x, z) {
  const near = 1 / (1 + Math.hypot(x - camera.position.x, z - camera.position.z) / 25);
  safeSound(() => {
    const v = Math.min(0.55, 0.05 + strength * 0.035) * near;
    burst(0.25 + Math.min(0.4, strength * 0.03), "lowpass", 900 + strength * 80, v);
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
    o.type = "square"; o.frequency.setValueAtTime(140 + Math.random() * 90, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.2);
    g.gain.setValueAtTime(v * 0.25, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.25);
    if (strength > 6) burst(0.35, "highpass", 4500, v * 0.5);
  });
}
function thud(k) {
  safeSound(() => {
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
    o.type = "sine"; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.2);
    g.gain.setValueAtTime(0.25 * (0.4 + k), t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.32);
    burst(0.15, "lowpass", 500, 0.12 * (0.4 + k));
  });
}
function horn() {
  safeSound(() => {
    const t = ac.currentTime, f = ac.createBiquadFilter(), g = ac.createGain();
    f.type = "lowpass"; f.frequency.value = 1800; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.02); g.gain.setValueAtTime(0.12, t + 0.38); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    f.connect(g).connect(ac.destination);
    for (const fq of [415, 523]) { const o = ac.createOscillator(); o.type = "square"; o.frequency.value = fq; o.connect(f); o.start(t); o.stop(t + 0.47); }
  });
}
function updateEngine() {
  if (!ac) return;
  try {
    const v = Math.abs(car.v) / car.spec.vmax, on = !muted && G.running && !G.paused;
    if (engine) {
      engine.o.frequency.setTargetAtTime(48 + v * 110 - (1 - G.condition) * 10, ac.currentTime, 0.1);
      engine.g.gain.setTargetAtTime(on ? 0.012 + v * 0.025 : 0, ac.currentTime, 0.1);
    }
    if (screech) screech.gain.setTargetAtTime(on && car.skidding ? Math.min(0.09, 0.02 + Math.abs(car.slide) * 0.01) : 0, ac.currentTime, 0.05);
  } catch (e) { engine = null; screech = null; }
}

// ---------------------------------------------------------------- incidents
// Hitting people or vehicles costs safety stars (none left: the operator suspends the shift) and
// breaks the clean-driving streak; knocks wear the vehicle down until it has to be towed.
function playerImpact(dv, x, z, what, kind) {
  if (dv < 1.5 || !G.running) return;
  shake = Math.min(1.2, shake + dv * 0.07);
  IMPACT.value = Math.min(1, IMPACT.value + dv * 0.07);
  G.condition = Math.max(0, G.condition - dv * (kind === "vehicle" ? 0.034 : 0.026) * (car.spec.mass > 2000 ? 0.8 : 1));
  if (dv > 7) G.slow = Math.max(G.slow, 0.5);
  if (dv > 3.5) G.streak = 0;
  if (dv > 6.5) {
    const [la] = car.body.toLocal(x, z);
    if (la > car.spec.hl * 0.4) car.broken |= 1; else if (la < -car.spec.hl * 0.4) car.broken |= 2;
  }
  if (dv > 8 || G.condition < 0.3) for (const m of car.glass) { m.roughness = 0.6; m.color.setHex(0x46525c); m.metalness = 0; } // the glass crazes
  if (kind !== "vehicle" && dv > 4) toast(`Hit ${what}`, `Vehicle condition ${Math.round(G.condition * 100)}%`, "bad");
  if (G.condition <= 0 && G.tow <= 0) wrecked();
}
function vehicleIncident(name, closing) {
  if (!G.running) return;
  G.crashes++;
  G.safety = Math.max(0, G.safety - (closing > 8 ? 0.5 : 0.25));
  G.score = Math.max(0, G.score - 40);
  G.streak = 0;
  toast(`Collision with ${name}`, `−40 · safety ${stars(G.safety)} · condition ${Math.round(G.condition * 100)}%`, "bad");
  if (G.safety <= 0) setTimeout(() => endShift("suspended"), 1200);
}
function pedestrianIncident(rd, sp) {
  if (!G.running) return;
  G.peds++;
  G.safety = Math.max(0, G.safety - 1);
  G.score = Math.max(0, G.score - 150);
  G.streak = 0;
  G.slow = Math.max(G.slow, 0.7);
  shake = Math.min(1.2, shake + 0.3);
  const [px, , pz] = rd.pelvis();
  floater("−150", px, pz, "bad");
  toast("Pedestrian struck", `Hit at ${Math.round(sp * 3.6)} km/h · safety ${stars(G.safety)} · they will get up, but slow down`, "bad");
  if (G.safety <= 0) setTimeout(() => endShift("suspended"), 1600);
}
function wrecked() {
  G.tow = 6;
  G.lost += G.onboard.length;
  const n = G.onboard.length;
  G.onboard = []; renderPax(); updateBeams();
  toast("Vehicle disabled", n ? `A recovery truck is coming. ${n} rider${n > 1 ? "s" : ""} on board refunded.` : "A recovery truck is coming.", "bad");
}
function towDone() {
  // the old vehicle stays behind as a smoking wreck; a fresh one waits at the hub
  const b = car.body;
  car.obj.remove(head, head.target);
  WRECKS.push({ body: new PH.Body({ x: b.x, z: b.z, yaw: b.yaw, hl: b.hl, hw: b.hw, mass: b.mass, e: 0.2, mu: 0.6 }), obj: car.obj, kind: "player", spec: car.spec, age: 0, dmg: 20 });
  car.obj = null;
  G.condition = 1; G.tow = 0;
  setVehicle(G.veh);
  spawnAtHub();
  toast("Back on the road", "A fresh vehicle from the depot, at the hub", true);
}

// ---------------------------------------------------------------- game rules
function atStop() {
  let best = null, bd = 18;
  for (const s of STOPS) { const d = Math.hypot(s.x - car.x, s.z - car.z); if (d < bd) { bd = d; best = s; } }
  return best;
}
let paxClock = 0, beamClock = 0;
function gameStep(dt) {
  // riders arrive at every stop at this hour's observed rate, and give up after a while
  for (const s of STOPS) {
    const rate = s.o[HI] || 0;
    if (rate > 0 && Math.random() < (rate * dt) / 3600) spawnRider(s, G.t);
    if (s.queue.length && s.queue[0].t0 + s.queue[0].patience < G.t) {
      s.queue = s.queue.filter((r) => r.t0 + r.patience >= G.t); queueDirty = true;
    }
  }
  if (G.tow > 0 && (G.tow -= dt) <= 0) towDone();
  // stopped at a stop: drop riders bound here first, then board, one every 0.4 s
  const s = G.tow > 0 ? null : atStop(), slow = Math.abs(car.v) < 2.2;
  const hint = $("hint");
  if (s && slow) {
    G.dwell += dt;
    const dropping = G.onboard.findIndex((r) => r.dest === s.idx);
    const canBoard = s.queue.length && G.onboard.length < car.spec.seats;
    if (G.dwell > 0.4 && (dropping >= 0 || canBoard)) {
      G.dwell = 0;
      if (dropping >= 0) deliver(G.onboard.splice(dropping, 1)[0], s);
      else { G.onboard.push(s.queue.shift()); queueDirty = true; chime([660, 880], 0.09, 0.07); }
      renderPax();
    }
    hint.hidden = false;
    hint.textContent = dropping >= 0 ? `Dropping off at ${s.name}…` : canBoard ? `Boarding at ${s.name}… (${s.queue.length} waiting)`
      : s.queue.length ? "Full: drop riders off first" : `${s.name}: nobody waiting`;
  } else {
    G.dwell = 0;
    hint.hidden = !(s && !slow);
    if (s && !slow) hint.textContent = "Stop here to board or drop riders";
  }
  // rubber on the road, smoke from a battered bonnet, brake lights
  const b = car.body;
  car.skidding = G.tow <= 0 && (Math.abs(car.slide) > 2.2 || (keys.down && car.v > 7) || (keys.hand && Math.abs(car.v) > 4));
  layRubber(b, car.skidding);
  if (G.condition < 0.5 && Math.random() < dt * (G.condition < 0.25 ? 14 : 6)) {
    const f = Math.sin(b.yaw), g = Math.cos(b.yaw);
    smoke(b.x + f * b.hl * 0.6, car.spec.shape.cabin ? 0.95 : 1.5, b.z + g * b.hl * 0.6, G.condition < 0.25);
  }
  if ((paxClock += dt) > 0.25) { paxClock = 0; renderPax(); }
  if ((beamClock += dt) > 0.3) { beamClock = 0; updateBeams(); }
  if (G.t >= 9 && G.t - dt < 9 && !PHONE && !G.tipped) { G.tipped = true; toast("Space: handbrake · H: horn · R: recover", "People step aside when you sound the horn. Everyone you hit costs a safety star.", true); }
  if (G.t >= SHIFT - 30 && G.t - dt < SHIFT - 30) toast("30 seconds left", "Drop off who you can", true);
  if (G.t >= SHIFT) endShift();
}
function deliver(r, s) {
  const took = G.t - r.t0, from = STOPS[r.from];
  const dist = Math.hypot(s.x - from.x, s.z - from.z);
  let pts = Math.round(20 + dist / 20);
  const beat = took < r.bus;
  if (beat) { pts += Math.round(pts * 0.6 + (r.bus - took) / 6); G.beat++; }
  // pooled drop-offs at the same stop earn a bonus; clean driving multiplies everything
  const pooled = G.lastDrop && G.lastDrop.stop === s.idx && G.t - G.lastDrop.t < 4 ? G.lastDrop.n + 1 : 1;
  G.lastDrop = { stop: s.idx, t: G.t, n: pooled };
  if (pooled > 1) pts += 15 * (pooled - 1);
  const m = mult();
  pts = Math.round(pts * m);
  G.score += pts; G.delivered++; G.streak++;
  floater(`+${pts}`, s.x, s.z, beat);
  const extra = [pooled > 1 ? `pooled ×${pooled}` : "", m > 1 ? `clean streak ×${m}` : ""].filter(Boolean).join(" · ");
  toast(beat ? `+${pts} · beat the bus by ${mmss(r.bus - took)}` : `+${pts}`, (beat ? `${from.name} → ${s.name} in ${mmss(took)}` : `${from.name} → ${s.name}: the bus would have taken ${mmss(r.bus)}`) + (extra ? ` · ${extra}` : ""), beat);
  chime(beat ? [523, 659, 784, 1047] : [523, 392], 0.12, 0.09);
}

function spawnAtHub() {
  // beside the busiest hub this hour, on the road, facing along the kerb
  const hub = STOPS.filter((s) => s.hub).sort((a, b) => (b.o[HI] || 0) - (a.o[HI] || 0))[0] || STOPS[0];
  Object.assign(car.body, { x: hub.x - hub.nx * 3.5, z: hub.z - hub.nz * 3.5, yaw: Math.atan2(hub.dx, hub.dz), vx: 0, vz: 0, w: 0 });
  car.v = 0; car.steer = 0; car.safe = [];
  camera.position.set(car.x - Math.sin(car.yaw) * 40, 30, car.z - Math.cos(car.yaw) * 40);
  camLook.set(car.x, 0, car.z);
  return hub;
}
// Clear the last shift's mess: wrecks, people on the ground, fallen lamps, skid marks.
function resetWorld() {
  while (WRECKS.length) removeWreck(WRECKS[0]);
  ragdolls.length = 0; returners.length = 0;
  for (const w of walkers) if (w.mode !== WALK) { const p = alongEdge(w.e, w.s, w.off); Object.assign(w, { mode: WALK, x: p.x, z: p.z, ox: 0, oz: 0, react: -1, dodge: 0 }); }
  for (const l of LAMPS) if (l.angle || !l.lit) { Object.assign(l, { angle: 0, w: 0, falling: false, down: false, lit: true }); placeLamp(l); }
  fallingLamps.clear();
  for (const F of FLEETS) { F.crashed.clear(); F.delay.clear(); }
  AMB.list.length = 0;
  smokeFx.clear(); glowFx.clear(); DEB.list.length = 0;
  SKID.n = 0; SKID.head = 0; SKID.prev = null; SKID.mesh.count = 0;
}
function startShift() {
  if (!READY || !STOPS.length) return;
  $("menu").hidden = true; $("end").hidden = true; $("hud").hidden = false;
  $("touch").hidden = !matchMedia("(pointer: coarse)").matches;
  audioInit();
  if (ac && ac.state === "suspended") ac.resume().catch(() => {});
  Object.assign(G, { running: true, paused: false, over: false, t: 0, score: 0, delivered: 0, beat: 0, onboard: [], dwell: 0,
    condition: 1, safety: 5, streak: 0, peds: 0, crashes: 0, lost: 0, tow: 0, slow: 0, lastDrop: null, suspended: false });
  HI = Math.max(0, Math.min(20, Math.floor(HOUR) - 5));
  applyLook(HOUR);
  setVehicle(G.veh);
  resetWorld();
  prepareDemand();
  seedQueues();
  const hub = spawnAtHub();
  renderPax(); updateBeams();
  toast(`${clockOf(HOUR)} · ${hub.name}`, `${Math.round(hub.o[HI] || 0)} rides an hour start here. Follow the amber beams.`);
}
function endShift(reason) {
  if (!G.running) return;
  G.running = false; G.over = true; G.suspended = reason === "suspended";
  $("hud").hidden = true; $("touch").hidden = true;
  for (const el of labelEls) el.hidden = true;
  const key = `nightshift-best-${G.veh}-${HOUR}`;
  let best = 0;
  try { best = Math.max(G.score, +(localStorage.getItem(key) || 0)); localStorage.setItem(key, String(best)); } catch (e) { best = G.score; }
  $("r-score").textContent = String(G.score);
  $("r-del").textContent = String(G.delivered);
  $("r-beat").textContent = G.delivered ? `${Math.round((100 * G.beat) / G.delivered)}%` : "—";
  $("r-best").textContent = String(best);
  $("r-inc").textContent = G.peds || G.crashes ? `${G.peds} ${G.peds === 1 ? "person" : "people"} · ${G.crashes} crash${G.crashes === 1 ? "" : "es"}` : "None";
  $("r-safety").textContent = stars(G.safety);
  $("end-eyebrow").textContent = G.suspended ? "Shift suspended" : "Shift over";
  $("end-title").textContent = G.suspended ? "The operator has taken your shuttle off the road"
    : G.delivered ? `${G.delivered} rider${G.delivered > 1 ? "s" : ""} home at ${clockOf(HOUR + G.t / 3600)}` : "No riders delivered";
  $("r-note").textContent = `${G.suspended ? "Driverless shuttles are judged on safety first: every person struck cost a star. " : ""}In the study, ${D.results?.numbers?.parity || "450"} ten-seat shuttles carry all of Yishun's ${D.results?.numbers?.rides || "164,000"} internal bus rides a weekday and keep up with the bus every hour. "Beat the bus" here uses a rough estimate of each ride by bus, for the game.`;
  $("end").hidden = false;
}
function setPaused(p) {
  if (!G.running) return;
  G.paused = p; $("paused").hidden = !p;
}

// ---------------------------------------------------------------- input
const KEYMAP = { ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down", ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right", Space: "hand" };
addEventListener("keydown", (e) => {
  if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = true; e.preventDefault(); }
  if (e.repeat) return;
  if (e.code === "KeyC") camMode = (camMode + 1) % 3;
  if (e.code === "KeyM") toggleMute();
  if (e.code === "KeyH" && G.running && !G.paused) honk();
  if (e.code === "KeyR" && G.running && !G.paused && G.tow <= 0) { recover(); toast("Recovered", "Back where you were a few seconds ago"); }
  if (e.code === "KeyP" || e.code === "Escape") setPaused(!G.paused);
  if (e.code === "Enter" && !$("menu").hidden && READY) startShift();
});
addEventListener("keyup", (e) => { if (KEYMAP[e.code]) keys[KEYMAP[e.code]] = false; });
for (const [id, k] of [["t-left", "left"], ["t-right", "right"], ["t-go", "up"], ["t-brake", "down"]]) {
  const el = $(id);
  el.addEventListener("pointerdown", (e) => { keys[k] = true; try { el.setPointerCapture(e.pointerId); } catch (err) { /* already released */ } e.preventDefault(); });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(ev, () => { keys[k] = false; });
}
$("t-horn").addEventListener("pointerdown", (e) => { e.preventDefault(); if (G.running && !G.paused) honk(); });
function toggleMute() { muted = !muted; $("mute").setAttribute("aria-pressed", String(muted)); $("mute").textContent = muted ? "Sound off" : "Sound on"; }
$("mute").onclick = toggleMute;
$("pause").onclick = () => setPaused(true);
$("resume").onclick = () => setPaused(false);
$("quit").onclick = () => { setPaused(false); endShift(); };
$("again").onclick = startShift;
addEventListener("contextmenu", (e) => { if (e.target.closest && e.target.closest("#touch")) e.preventDefault(); }); // long-press on touch buttons
$("change").onclick = () => { $("end").hidden = true; $("menu").hidden = false; G.over = false; };
$("start").onclick = startShift;
for (const group of ["opt-veh", "opt-hour"]) {
  for (const b of $(group).querySelectorAll("button")) b.onclick = () => {
    for (const x of $(group).querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    if (b.dataset.veh) G.veh = b.dataset.veh;
    if (b.dataset.hour) { HOUR = +b.dataset.hour; applyLook(HOUR); }
  };
}
document.addEventListener("visibilitychange", () => { if (document.hidden) setPaused(true); });
addEventListener("blur", () => { for (const k in keys) keys[k] = false; }); // no key stuck down after alt-tab
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- the world, one step
const movers = [], vehBoxes = [], obstacles = [];
function obstacleList() {
  obstacles.length = 0;
  const along = (b, r, self) => { const f = Math.sin(b.yaw), g = Math.cos(b.yaw); for (const k of [-0.6, 0, 0.6]) obstacles.push({ x: b.x + f * b.hl * k, z: b.z + g * b.hl * k, r, self }); };
  if (G.running) along(car.body, car.spec.hw + 0.3, car);
  for (const wk of WRECKS) along(wk.body, wk.spec.hw + 0.3, wk);
  for (const rd of ragdolls) obstacles.push({ x: rd.p[6], z: rd.p[8], r: 1.0 });
  for (const w of walkers) if ((w.mode === CROSS || w.mode === BACK || w.mode === STAND) && Math.abs(w.x - car.x) < 200 && Math.abs(w.z - car.z) < 200) obstacles.push({ x: w.x, z: w.z, r: 0.6 });
  for (const it of returners) if (it) obstacles.push({ x: it.x, z: it.z, r: 0.6 });
  for (const F of FLEETS) for (const n of F.seen) if (Math.abs(n.x - car.x) < 300 && Math.abs(n.z - car.z) < 300) obstacles.push({ x: n.x, z: n.z, r: F.spec.hw + 0.4 });
  for (const a of AMB.list) obstacles.push({ x: a.x, z: a.z, r: 1.2, self: a });
}
function tick(dt, live) {
  if (live) { G.t += dt; driveStep(dt); }
  U.time.value += dt;
  const simSec = HOUR * 3600 + G.t + (G.running || G.over ? 0 : menuClock);
  obstacleList();
  updateFleets(simSec, dt, obstacles);
  updateAmbient(dt, obstacles);
  if (live && G.tow <= 0) {
    const onCar = (dv, c) => playerImpact(dv, c.px, c.pz, "a vehicle", "vehicle");
    hitTraffic(car.body, car.obj, true, onCar);
    for (const wk of WRECKS) {
      const c = PH.collide(car.body, wk.body);
      if (!c) continue;
      const closing = (car.body.vx - wk.body.vx) * c.nx + (car.body.vz - wk.body.vz) * c.nz;
      crash(car.body, wk.body, car.obj, wk.obj, c, onCar, (dv) => { wk.dmg += dv; });
      if (closing > 4 && wk.kind !== "player") vehicleIncident(`a crashed ${wk.kind === "car" ? "car" : wk.kind === "bus" ? "bus" : "robovan"}`, closing);
    }
    hitStatic(car.body, car.obj, (dv, c, what) => playerImpact(dv, c.px, c.pz, what));
  }
  updateWrecks(dt);
  movers.length = 0; vehBoxes.length = 0;
  if (G.running) { movers.push({ body: car.body, sp: car.body.speed(), who: "player" }); vehBoxes.push(...PH.vehicleBoxes(car.body, car.spec.shape)); }
  for (const wk of WRECKS) { const sp = wk.body.speed(); if (sp > 1) movers.push({ body: wk.body, sp, who: "wreck" }); vehBoxes.push(...PH.vehicleBoxes(wk.body, wk.spec.shape)); }
  updateWalkers(dt, movers);
  queueHits(movers);
  updateQueues();
  updateReturners(dt);
  updateRagdolls(dt, vehBoxes);
  PEOPLE.pose.needsUpdate = true; PEOPLE.gait.needsUpdate = true;
  updateLamps(dt); updateTrees(dt); updateTrains(dt);
  smokeFx.update(dt); glowFx.update(dt); updateDebris(dt);
  if (live) gameStep(dt);
}

// ---------------------------------------------------------------- main loop
let READY = false, HOLD = false, last = performance.now(), clock = 0, menuClock = 0;
let loopErrors = 0;
function frame(now) {
  const real = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now; clock += real;
  if (HOLD) { requestAnimationFrame(frame); return; } // tests: frozen while a frame is captured
  try {
    if (READY && !contextLost) {
      const live = G.running && !G.paused;
      let dt = real;
      if (G.slow > 0) { G.slow -= real; dt *= 0.3; }
      if (!G.running && !G.over) menuClock += real;
      if (!G.paused) tick(dt, live);
      updateSky(clock, real);
      IMPACT.value = Math.max(0, IMPACT.value - real * 3);
      if (car.obj) { car.obj.position.set(car.x, 0, car.z); car.obj.rotation.y = car.yaw - Math.PI / 2; car.obj.visible = G.running || G.over; }
      const flick = car.broken & 1 ? (Math.random() < 0.15 ? 1 : 0) : 1;
      head.intensity = look.night > 0.3 && G.tow <= 0 ? 260 * flick : 0;
      for (const m of car.lights.head) m.emissiveIntensity = (car.broken & 1 ? 0.1 : 1) * flick;
      const braking = (keys.down && car.v > 0.5) || keys.hand;
      for (const m of car.lights.tail) m.emissiveIntensity = car.broken & 2 ? 0.05 : braking ? 4 : 1;
      U.car.value.set(car.x, 0, car.z);
      updateCamera(real, !G.running && !G.over, clock);
      if (G.running) { updateChevron(); updateLabels(); updateFloaters(real); updateHud(); drawMinimap(); } else chevron.visible = false;
      updateEngine();
      // the sun (and its shadow box) follows the camera
      const fx = G.running ? car.x : camera.position.x, fz = G.running ? car.z : camera.position.z;
      sun.target.position.set(fx, 0, fz);
      sun.position.set(fx + look.sunDir[0] * 600, look.sunDir[1] * 600, fz + look.sunDir[2] * 600);
      sky.position.copy(camera.position);
    }
    if (!contextLost) draw();
    loopErrors = Math.max(0, loopErrors - 0.02);
  } catch (e) {
    // one bad frame is skipped; only an error that keeps coming back ends the game, with a way out
    if (loopErrors < 1) console.error(e);
    if ((loopErrors += 1) > 30) { G.running = false; fail("Something went wrong while drawing the city."); return; }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot
// A plain stand-in if a vehicle model fails to download: a champagne box with light bars.
function standInCar(len) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(len, 1.4, 1.9).translate(0, 0.9, 0), new THREE.MeshStandardMaterial({ color: 0xcfae7c, roughness: 0.4 }));
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 1.6).translate(len / 2, 1.1, 0), new THREE.MeshStandardMaterial({ color: 0x222, emissive: 0xfff4dc, emissiveIntensity: 4 }));
  g.add(body, bar);
  return g;
}
// For tests: the frame as an image, read back from a render target (headless browsers cannot
// always capture a WebGPU canvas).
async function snapshot() {
  const w = renderer.domElement.width, h = renderer.domElement.height, rt = new THREE.RenderTarget(w, h);
  renderer.setRenderTarget(rt); draw(); renderer.setRenderTarget(null);
  const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h);
  rt.dispose();
  const stride = px.length === w * h * 4 ? w * 4 : Math.ceil((w * 4) / 256) * 256; // WebGPU pads rows to 256 bytes
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d"), img = x.createImageData(w, h);
  for (let y = 0; y < h; y++) img.data.set(px.subarray(y * stride, y * stride + w * 4), y * w * 4);
  if (!renderer.backend.isWebGPUBackend) { // WebGL reads bottom-up
    const flip = x.createImageData(w, h);
    for (let y = 0; y < h; y++) flip.data.set(img.data.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    x.putImageData(flip, 0, 0);
  } else x.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

async function boot() {
  try {
    progress(0.05, "Loading the map…");
    const [town0, bjson, stops, demand, baseline] = await Promise.all(["town.json", "buildings.json", "stops.json", "demand.json", "baseline.json"].map((n) => getJSON(n)));
    const [results, idx] = await Promise.all(["results.json", "anim_index.json"].map((n) => optional(getJSON(n))));
    if (idx && Array.isArray(idx.origin)) [LNG0, LAT0] = idx.origin;
    const town = { ...town0, roads: town0.roads || [], green: town0.green || [], water: town0.water || [], rail: town0.rail || [] };
    const blds = bjson.buildings || [];
    D = { town, stops, demand: demand || {}, baseline: baseline || {}, results: results || {} };
    applyLook(HOUR);
    progress(0.3, "Laying roads, parks and water…"); await breathe();
    buildMask(town, blds);
    const ao = buildAO(blds);
    const groundMat = groundMaterial(ao, "ground", PHONE);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000).rotateX(-Math.PI / 2), groundMat);
    ground.position.y = -0.05; ground.receiveShadow = true; scene.add(ground);
    flatLayer(town.green, 0.02, groundMaterial(ao, "park", PHONE), -1);
    flatLayer(town.water, 0.03, waterMaterial(), -2);
    flatLayer(town.roads, 0.06, groundMaterial(ao, "road", PHONE), -3);
    buildEdges(town); buildKerbs(ao);
    progress(0.45, `Raising ${blds.length.toLocaleString()} buildings…`); await breathe();
    buildBuildings(blds);
    progress(0.6, "Planting trees, lighting streets…"); await breathe();
    buildLamps(); buildTrees(); buildRail(town);
    buildStops(stops); clearAroundStops(); buildBeams(); buildMinimapBase(town, blds);
    buildPeople(); buildWalkers(); buildRagdollMeshes(); buildDebris(); buildSkids();
    smokeFx = new Puffs(PHONE ? 160 : 420, false); glowFx = new Puffs(PHONE ? 200 : 520, true);
    progress(0.72, "Fetching the simulated fleet, its buses and the vehicles…"); await breathe();
    const loader = new GLTFLoader();
    const [taxi, van, bus, truck, pathsRaw, anim, animBus] = await Promise.all([
      optional(loader.loadAsync("models/robotaxi.glb")), optional(loader.loadAsync("models/robovan.glb")), optional(loader.loadAsync("models/bus.glb")), optional(loader.loadAsync("models/skytruck.glb")),
      optional(getJSON("paths.json")), optional(getJSON("anim_s10_450.json")), optional(getJSON("anim_bus.json")),
    ]);
    for (const g of [taxi, van, bus]) if (g) upgradeMaterials(g.scene);
    MODELS = { robovan: van && van.scene, bus: bus && bus.scene };
    // the game still runs without any of these: stand-in cars, no traffic, no flying trucks
    car.models = { robotaxi: taxi ? taxi.scene : standInCar(4.6), robovan: van ? van.scene : standInCar(6.6) };
    if (pathsRaw && pathsRaw.paths) {
      try { decodePaths(pathsRaw); buildLaneLines(pathsRaw); buildAmbient(); } catch (e) { console.warn("no traffic:", e); PATHS = null; }
    }
    if (PATHS && van && anim && anim.legs) try { addFleet("van", anim, van.scene, PHONE ? 60 : 160); } catch (e) { console.warn("no fleet:", e); }
    if (PATHS && bus && animBus && animBus.legs) try { addFleet("bus", animBus, bus.scene, PHONE ? 16 : 40); } catch (e) { console.warn("no buses:", e); }
    if (truck) buildSkyTrucks(truck);
    applyLook(HOUR); // again, now the lamps and trains exist
    $("renderer").textContent = BACKEND;
    window.__nsSnap = snapshot; // for screenshots: headless browsers cannot always read a WebGPU canvas
    progress(1, "Ready");
    READY = true;
    $("loading").hidden = true;
    $("menu").hidden = false;
    if (AUTO) {  // test hook: step the rules without waiting on frames, and stage collisions
      startShift();
      const ahead = (d, side = 0) => { const f = Math.sin(car.yaw), g = Math.cos(car.yaw); return [car.x + f * d + g * side, car.z + g * d - f * side]; };
      window.__ns = {
        G, car, keys, STOPS, walkers, ragdolls, WRECKS, FLEETS, AMB, BACKEND, LAMPS,
        sim: (sec) => { for (let i = 0; i < sec * 30; i++) tick(1 / 30, G.running && !G.paused); return { x: car.x, z: car.z, v: car.v, onboard: G.onboard.length, delivered: G.delivered, score: G.score, condition: G.condition, safety: G.safety, ragdolls: ragdolls.length, wrecks: WRECKS.length }; },
        // stand a walker in the road ahead, or park a robovan there
        walkerAhead: (d = 14, side = 0) => { const w = walkers.find((q) => q.mode === WALK); const [x, z] = ahead(d, side); Object.assign(w, { mode: STAND, x, z, tx: x, tz: z, yaw: car.yaw + Math.PI / 2, react: 99, freeze: true }); return w.i; },
        vanAhead: (d = 16, side = 0) => { const [x, z] = ahead(d, side); spawnWreck("van", { x, z, yaw: car.yaw + Math.PI / 2, vx: 0, vz: 0 }); return WRECKS.length; },
        carAhead: (d = 16, side = 0) => { const [x, z] = ahead(d, side); spawnWreck("car", { x, z, yaw: car.yaw + Math.PI / 2, vx: 0, vz: 0 }, 0x8b1e24); return WRECKS.length; },
        snap: snapshot,
        hold: (on) => { HOLD = !!on; IMPACT.value = 0; },
        hour: (h) => { HOUR = h; HI = Math.max(0, Math.min(20, Math.floor(HOUR) - 5)); applyLook(HOUR); },
        view: (mode = 0) => { // put the camera where the chase camera settles, and refresh the HUD
          camMode = mode; car.obj.position.set(car.x, 0, car.z); car.obj.rotation.y = car.yaw - Math.PI / 2;
          for (let i = 0; i < 12; i++) updateCamera(0.5, false, clock);
          U.car.value.set(car.x, 0, car.z); sky.position.copy(camera.position);
          sun.target.position.set(car.x, 0, car.z); sun.position.set(car.x + look.sunDir[0] * 600, look.sunDir[1] * 600, car.z + look.sunDir[2] * 600);
          updateChevron(); updateLabels(); updateHud(); drawMinimap(); renderPax(); IMPACT.value = 0;
        },
        camera, look: (x, y, z, tx, ty, tz) => { camera.position.set(x, y, z); camera.lookAt(tx, ty, tz); sky.position.copy(camera.position); },
        drive: (kmh) => { const f = Math.sin(car.yaw), g = Math.cos(car.yaw); car.body.vx = f * kmh / 3.6; car.body.vz = g * kmh / 3.6; },
        frame: () => { const h = HOLD; HOLD = false; frame(performance.now()); HOLD = h; }, // one frame on demand (camera, HUD)
      };
    }
  } catch (e) {
    console.error(e);
    fail(`Could not build the city (${e.message || e}).`);
  }
}
requestAnimationFrame(frame);
boot();
