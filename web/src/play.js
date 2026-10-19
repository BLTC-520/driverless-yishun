/* Night Shift: a driving game built on the study's data.
   The city is the study's own: every building footprint and height (HDB + OpenStreetMap),
   road areas, parks, water, the MRT line and the 180 bus stops, read from ./data/*.json.
   Riders appear at each stop at the hourly rate in LTA's fare-card OD and travel to the
   stops riders really go to. The other shuttles are the simulator's 450-vehicle fleet at
   the same minute. Walkers, trains and flying trucks are decoration. */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

window.__nsAlive = true; // the 3D engine loaded: the page's watchdog stands down
const $ = (id) => document.getElementById(id);
const fail = (msg) => (window.nsFail ? window.nsFail(msg) : ($("load-text").textContent = msg));
const PHONE = matchMedia("(pointer: coarse)").matches || innerWidth < 640;
const AUTO = location.hash === "#auto"; // start straight away (screenshots, tests)
const SHIFT = 300;                       // seconds of play
const pad = (n) => String(n).padStart(2, "0");
const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${pad(Math.floor(Math.max(0, s) % 60))}`;
const clockOf = (h) => { const m = Math.floor(h * 60) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
const rand = (a, b) => a + Math.random() * (b - a);

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

// ---------------------------------------------------------------- renderer, scene, looks
let renderer;
try {
  if (!document.createElement("canvas").getContext("webgl2")) throw new Error("WebGL 2 unavailable");
  renderer = new THREE.WebGLRenderer({ canvas: $("c"), antialias: !PHONE, powerPreference: "high-performance" });
} catch (e) {
  fail("This browser or device can't draw the 3D city (WebGL 2 is switched off or not supported).");
  throw e; // nothing below can run without a renderer
}
let contextLost = false;
renderer.domElement.addEventListener("webglcontextlost", (e) => {
  e.preventDefault(); contextLost = true; G.paused = true;
  fail("The graphics driver reset the 3D view.");
});
renderer.domElement.addEventListener("webglcontextrestored", () => location.reload());
renderer.setPixelRatio(Math.min(devicePixelRatio, PHONE ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = !PHONE;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 9000);
try { scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture; } catch (e) { console.warn(e); }

const hemi = new THREE.HemisphereLight(0x9fb4d6, 0x20242b, 0.5);
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.castShadow = !PHONE;
Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 10, far: 1600 });
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.5;
scene.add(hemi, sun, sun.target);

let composer = null, bloom = null;
if (!PHONE) {
  try {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.45, 0.92);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  } catch (e) { console.warn("no bloom:", e); composer = bloom = null; } // plain rendering still works
}

// Four hours to play, each with its own light. `night` drives lit windows, lamps and headlights.
const LOOKS = {
  7.5: { night: 0.1, top: 0x5d93cf, horizon: 0xf0c7a2, sun: 0xffd8a8, sunI: 2.4, sunDir: [0.9, 0.32, 0.25], hemi: 0.9, fog: 0xd2c2b4, fogFar: 5200, exposure: 0.9, bloom: 0.2, env: 0.6 },
  13: { night: 0, top: 0x3d7ccc, horizon: 0xbcd4ec, sun: 0xffffff, sunI: 2.8, sunDir: [0.25, 1, 0.35], hemi: 1.0, fog: 0xb8cde0, fogFar: 6000, exposure: 0.95, bloom: 0.12, env: 0.8 },
  19.5: { night: 0.8, top: 0x111a36, horizon: 0x7d4f63, sun: 0xff9e6a, sunI: 0.45, sunDir: [-1, 0.1, 0.15], hemi: 0.3, fog: 0x2a2436, fogFar: 4300, exposure: 1.0, bloom: 0.5, env: 0.22 },
  23: { night: 1, top: 0x04070d, horizon: 0x172033, sun: 0x9db4ff, sunI: 0.22, sunDir: [0.4, 0.8, -0.3], hemi: 0.18, fog: 0x0d131e, fogFar: 3800, exposure: 1.05, bloom: 0.6, env: 0.1 },
};
const U = { uNight: { value: 0.8 } }; // shared by the building and lamp shaders

const sky = new THREE.Mesh(new THREE.SphereGeometry(6000, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Color() } },
  vertexShader: "varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: `uniform vec3 uTop, uHorizon, uSunDir, uSunCol; varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir); float h = max(d.y, 0.0);
      vec3 c = mix(uHorizon, uTop, pow(h, 0.5));
      float s = max(dot(d, normalize(uSunDir)), 0.0);
      c += uSunCol * (pow(s, 300.0) * 3.0 + pow(s, 8.0) * 0.3);
      if (d.y < 0.0) c = uHorizon * 0.7;
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
}));
sky.renderOrder = -1;
scene.add(sky);

const stars = (() => {
  const n = 1800, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 * Math.PI, v = Math.acos(rand(0.05, 1));
    p.set([Math.sin(v) * Math.cos(u) * 5500, Math.cos(v) * 5500, Math.sin(v) * Math.sin(u) * 5500], i * 3);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, color: 0xdfe8ff, transparent: true, fog: false, depthWrite: false }));
})();
scene.add(stars);

let look = LOOKS[19.5];
function applyLook(hour) {
  look = LOOKS[hour];
  U.uNight.value = look.night;
  sky.material.uniforms.uTop.value.set(look.top);
  sky.material.uniforms.uHorizon.value.set(look.horizon);
  sky.material.uniforms.uSunDir.value.set(...look.sunDir).normalize();
  sky.material.uniforms.uSunCol.value.set(look.sun).multiplyScalar(look.night > 0.9 ? 0.3 : 1);
  stars.material.opacity = Math.max(0, look.night - 0.3);
  sun.color.set(look.sun); sun.intensity = look.sunI;
  hemi.intensity = look.hemi;
  scene.fog = new THREE.Fog(look.fog, 350, look.fogFar);
  renderer.toneMappingExposure = look.exposure;
  scene.environmentIntensity = look.env;
  if (bloom) bloom.strength = look.bloom;
  for (const m of nightMats) m.update(look.night);
}
const nightMats = []; // materials whose glow follows the hour: { update(night) }

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

function flatLayer(rings, y, color, opts = {}) {
  const m = new THREE.Mesh(flatGeometry(rings, y), new THREE.MeshStandardMaterial({
    color, roughness: opts.rough ?? 0.95, metalness: opts.metal ?? 0, polygonOffset: true, polygonOffsetFactor: opts.offset ?? -1, polygonOffsetUnits: opts.offset ?? -1,
  }));
  m.receiveShadow = true;
  scene.add(m);
  return m;
}

// ---------------------------------------------------------------- buildings
// One merged mesh. Walls carry their running length along the facade (aWall.x) and height
// (aWall.y); a shader paints storeys of windows from those, lit at random at night, with the
// HDB void deck at ground level.
function buildBuildings(list) {
  const pos = [], nor = [], wall = [], info = [], idx = [];
  let seed = 1;
  for (const b of list) {
    const pts = Array.isArray(b.p) ? ringXZ(b.p) : [];
    if (pts.length < 3 || !Number.isFinite(b.h)) continue;
    const h = Math.max(3, b.h), hdb = b.k === "hdb" ? 1 : 0, s = (seed = (seed * 16807) % 2147483647) / 2147483647;
    const ccw = signedArea(pts) > 0;
    let run = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const dx = q.x - p.x, dz = q.y - p.y, len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const nx = (ccw ? dz : -dz) / len, nz = (ccw ? -dx : dx) / len;
      const base = pos.length / 3;
      // HDB and OpenStreetMap sometimes trace the same wall: a few cm per building keeps them from z-fighting
      const o = s * 0.08, ox = nx * o, oz = nz * o;
      pos.push(p.x + ox, 0, p.y + oz, q.x + ox, 0, q.y + oz, q.x + ox, h, q.y + oz, p.x + ox, h, p.y + oz);
      for (let k = 0; k < 4; k++) { nor.push(nx, 0, nz); info.push(s, hdb, h); }
      wall.push(run, 0, run + len, 0, run + len, h, run, h);
      if (ccw) idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      run += len;
    }
    let roof = [];
    try { roof = THREE.ShapeUtils.triangulateShape(pts, []); } catch (e) { /* a self-crossing footprint: walls only */ }
    const base = pos.length / 3;
    for (const p of pts) { pos.push(p.x, h + s * 0.06, p.y); nor.push(0, 1, 0); wall.push(0, h); info.push(s, hdb, h); }
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
  g.setIndex(idx);
  g.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 aWall; attribute vec3 aInfo; varying vec2 vWall; varying vec3 vInfo; varying float vUp;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWall = aWall; vInfo = aInfo; vUp = normal.y;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float uNight; varying vec2 vWall; varying vec3 vInfo; varying float vUp;
        float hsh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec3 glow = vec3(0.0); float glass = 0.0;
        float hdb = vInfo.y, seed = vInfo.x;
        // HDB blocks: off-white with a pastel accent per block; others: concrete greys
        vec3 pastel = vec3(0.55 + 0.45 * hsh(vec2(seed, 1.0)), 0.55 + 0.45 * hsh(vec2(seed, 2.0)), 0.55 + 0.45 * hsh(vec2(seed, 3.0)));
        vec3 baseC = hdb > 0.5 ? mix(vec3(0.88, 0.86, 0.8), pastel, 0.28) : vec3(0.42 + 0.2 * seed, 0.44 + 0.2 * seed, 0.48 + 0.18 * seed);
        if (vUp < 0.5) {
          float storey = hdb > 0.5 ? 2.8 : 3.6, colw = hdb > 0.5 ? 2.5 : 3.4;
          vec2 g = vec2(vWall.x / colw, vWall.y / storey);
          vec2 cell = floor(g), f = fract(g);
          vec2 fw = fwidth(g);
          float sharp = clamp(1.5 - max(fw.x, fw.y) * 3.0, 0.0, 1.0);  // windows smaller than a pixel: average them out
          float ground = 1.0 - step(storey, vWall.y);
          float top = step(vInfo.z - 1.0, vWall.y);
          float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.28, f.y) * step(f.y, 0.8) * (1.0 - ground) * (1.0 - top);
          float band = hdb > 0.5 ? step(0.86, f.y) * (1.0 - ground) : 0.0;  // corridor parapet stripe
          baseC = mix(baseC, pastel * 0.8, band * 0.5);
          float r = hsh(cell + seed * 37.0);
          float litShare = mix(0.02, 0.36, uNight);
          float lit = step(r, litShare) * win;
          vec3 warm = hsh(cell * 1.7 + seed) > 0.78 ? vec3(0.8, 0.9, 1.0) : vec3(1.0, 0.76, 0.46);
          float facade = (1.0 - ground) * (1.0 - top);
          glow += mix(vec3(1.0, 0.8, 0.55) * litShare * 0.3 * facade, warm * lit * (0.35 + 0.55 * hsh(cell + 3.1)), sharp);
          glass = win * sharp;
          baseC = mix(baseC * mix(1.0, 0.62, facade), mix(baseC, vec3(0.07, 0.09, 0.12), win * 0.85), sharp);
          if (hdb > 0.5) {  // void deck: open, shaded ground floor lit by tube lights at night
            baseC *= mix(1.0, 0.3, ground);
            glow += vec3(0.75, 0.9, 1.0) * ground * uNight * 0.3 * step(0.55, fract(vWall.x / 5.0)) * step(0.6, vWall.y / storey);
          } else {
            float shop = ground * step(0.15, f.x) * step(f.x, 0.85) * step(0.15, f.y) * step(f.y, 0.75);
            glow += vec3(1.0, 0.85, 0.6) * shop * uNight * step(0.5, hsh(cell + 9.0)) * 0.7;
          }
        } else {
          baseC *= 0.72;  // roofs
        }
        diffuseColor.rgb *= baseC;`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, glass);")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.7, glass);")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += glow;");
  };
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
}

// ---------------------------------------------------------------- the drivable mask
// Roads, buildings, water and parks rasterised once (2.5 m cells): the car drives on roads,
// slows on grass, and stops at walls and water.
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

// ---------------------------------------------------------------- road edges: kerbs, lamps, trees, pavements
// Road areas are outer rings, so each ring is a kerb; "outward" points off the road.
let EDGES = [];
function buildEdges(town) {
  EDGES = [];
  for (const ring of town.roads) {
    const pts = ringXZ(ring);
    if (pts.length < 3) continue;
    const ccw = signedArea(pts) > 0, n = pts.length;
    const xs = new Float32Array(n + 1), zs = new Float32Array(n + 1), cum = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) { const p = pts[i % n]; xs[i] = p.x; zs[i] = p.y; if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]); }
    if (cum[n] > 1) EDGES.push({ xs, zs, cum, len: cum[n], ccw });
  }
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

function buildKerbs() {
  const pos = [];
  for (const e of EDGES) for (let i = 1; i < e.xs.length; i++) pos.push(e.xs[i - 1], 0.12, e.zs[i - 1], e.xs[i], 0.12, e.zs[i]);
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x8a8f99, transparent: true, opacity: 0.55 })));
}

const dummy = new THREE.Object3D();
function radialTexture(inner = "rgba(255,255,255,1)") {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const x = c.getContext("2d"), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner); gr.addColorStop(0.4, "rgba(255,255,255,0.35)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function buildLamps() {
  if (!EDGES.length) return;
  const total = EDGES.reduce((a, e) => a + e.len, 0);
  const spacing = Math.max(34, total / (PHONE ? 1500 : 3200));
  const spots = [];
  for (const e of EDGES) for (let s = 0; s < e.len; s += spacing) spots.push(alongEdge(e, s, 1.0));
  const poleG = mergeGeometries([new THREE.BoxGeometry(0.22, 9, 0.22).translate(0, 4.5, 0), new THREE.BoxGeometry(0.12, 0.12, 1.8).translate(0, 8.9, 0.9)]);
  const poles = new THREE.InstancedMesh(poleG, new THREE.MeshStandardMaterial({ color: 0x59606b, roughness: 0.6, metalness: 0.5 }), spots.length);
  const headMat = new THREE.MeshStandardMaterial({ color: 0x332a1c, emissive: 0xffb554, emissiveIntensity: 3 });
  const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.18, 0.9), headMat, spots.length);
  const poolMat = new THREE.MeshBasicMaterial({ map: radialTexture(), color: 0xffa64a, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2), poolMat, spots.length);
  spots.forEach((p, i) => {
    const yaw = Math.atan2(-p.nx, -p.nz); // arm reaches over the road
    dummy.position.set(p.x, 0, p.z); dummy.rotation.set(0, yaw, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
    poles.setMatrixAt(i, dummy.matrix);
    dummy.position.set(p.x - p.nx * 1.7, 8.8, p.z - p.nz * 1.7); dummy.updateMatrix(); heads.setMatrixAt(i, dummy.matrix);
    dummy.position.set(p.x - p.nx * 3, 0.16, p.z - p.nz * 3); dummy.updateMatrix(); pools.setMatrixAt(i, dummy.matrix);
  });
  poles.castShadow = true;
  scene.add(poles, heads, pools);
  nightMats.push({ update: (n) => { headMat.emissiveIntensity = n > 0.3 ? 4 : 0; pools.visible = n > 0.3; poolMat.opacity = 0.55 * n; } });
}

function buildTrees(town) {
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
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.32, 3.4, 5).translate(0, 1.7, 0), new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 1 }), spots.length);
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.8, 0).scale(1.3, 0.8, 1.3).translate(0, 4.6, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), spots.length);
  const greens = [0x2f5e34, 0x3b6e3a, 0x26502f, 0x4a7a3c, 0x315a2a].map((c) => new THREE.Color(c));
  spots.forEach(([x, z], i) => {
    const s = rand(0.7, 1.45);
    dummy.position.set(x, 0, z); dummy.rotation.set(0, rand(0, 6.3), 0); dummy.scale.set(s, s * rand(0.85, 1.2), s); dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix); crowns.setMatrixAt(i, dummy.matrix);
    crowns.setColorAt(i, greens[i % greens.length]);
  });
  dummy.scale.set(1, 1, 1);
  crowns.castShadow = true;
  scene.add(trunks, crowns);
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
  const via = new THREE.Mesh(mergeGeometries(parts.map((g) => g.toNonIndexed())), new THREE.MeshStandardMaterial({ color: 0x8d8f94, roughness: 0.9 }));
  via.castShadow = via.receiveShadow = true;
  scene.add(via);
  // two six-car trains shuttle along the longest stretches
  const withLen = lines.map((l) => { const cum = [0]; for (let i = 1; i < l.length; i++) cum.push(cum[i - 1] + l[i - 1].distanceTo(l[i])); return { l, cum, len: cum[cum.length - 1] }; })
    .sort((a, b) => b.len - a.len).slice(0, 2);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe8eaee, roughness: 0.35, metalness: 0.4 });
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
  const glass = new THREE.InstancedMesh(new THREE.BoxGeometry(3.8, 1.9, 0.05).translate(0, 1.5, -1.0), new THREE.MeshStandardMaterial({ color: 0x9fc4d8, transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0.5 }), STOPS.length);
  const signMat = new THREE.MeshStandardMaterial({ color: 0x223, emissive: 0xffffff, emissiveIntensity: 0.6 });
  const sign = new THREE.InstancedMesh(mergeGeometries([new THREE.BoxGeometry(0.08, 3.2, 0.08).translate(0, 1.6, 0), new THREE.BoxGeometry(0.06, 0.6, 0.9).translate(0, 3.0, 0)]), signMat, STOPS.length);
  STOPS.forEach((s, i) => {
    const yaw = Math.atan2(-s.nx, -s.nz); // open side faces the road
    dummy.position.set(s.x + s.nx * 3.2, 0, s.z + s.nz * 3.2); dummy.rotation.set(0, yaw, 0); dummy.updateMatrix();
    frame.setMatrixAt(i, dummy.matrix); glass.setMatrixAt(i, dummy.matrix);
    dummy.position.set(s.x + s.nx * 1.4 + s.dx * 3, 0, s.z + s.nz * 1.4 + s.dz * 3); dummy.updateMatrix(); sign.setMatrixAt(i, dummy.matrix);
  });
  frame.castShadow = true;
  scene.add(frame, glass, sign);
  nightMats.push({ update: (n) => { signMat.emissiveIntensity = 0.3 + 1.7 * n; } });
}

// ---------------------------------------------------------------- people (decoration, plus the real queues)
// Walkers stroll the pavements; riders waiting at a stop stand in a cluster beside it.
const SHIRTS = [0xe9e6de, 0x2b3a55, 0xc0392b, 0x2e86c1, 0xf2a53a, 0x7cc58f, 0x8e44ad, 0x34495e, 0xd35400, 0xecf0f1, 0x16a085, 0xf5b7b1];
const SKINS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
const torsoG = new THREE.BoxGeometry(0.44, 0.62, 0.26).translate(0, 1.16, 0);
const headG = new THREE.SphereGeometry(0.13, 8, 6).translate(0, 1.62, 0);
const legG = new THREE.BoxGeometry(0.15, 0.82, 0.17).translate(0, -0.41, 0);
const legsG = mergeGeometries([new THREE.BoxGeometry(0.15, 0.84, 0.17).translate(-0.1, 0.42, 0), new THREE.BoxGeometry(0.15, 0.84, 0.17).translate(0.1, 0.42, 0)]);
const personMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
const legMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.9 });
function crowdMeshes(n, walking) {
  const m = {
    torso: new THREE.InstancedMesh(torsoG, personMat, n), head: new THREE.InstancedMesh(headG, personMat, n),
    legA: new THREE.InstancedMesh(walking ? legG : legsG, legMat, n), legB: walking ? new THREE.InstancedMesh(legG, legMat, n) : null,
  };
  for (let i = 0; i < n; i++) {
    m.torso.setColorAt(i, new THREE.Color(SHIRTS[(i * 7) % SHIRTS.length]));
    m.head.setColorAt(i, new THREE.Color(SKINS[(i * 3) % SKINS.length]));
  }
  for (const k in m) if (m[k]) { m[k].frustumCulled = false; m[k].castShadow = !PHONE; scene.add(m[k]); }
  return m;
}

let walkers = [], walkMesh = null;
function buildWalkers() {
  if (!EDGES.length) return;
  const n = PHONE ? 500 : 1600;
  // more people on pavements near the HDB town centre
  const weights = EDGES.map((e) => { const cx = e.xs[0], cz = e.zs[0]; return e.len * (0.4 + 3 * Math.exp(-Math.hypot(cx - 200, cz + 300) / 1400)); });
  const total = weights.reduce((a, b) => a + b, 0);
  walkers = [];
  for (let i = 0; i < n; i++) {
    let r = Math.random() * total, k = 0;
    while (r > weights[k] && k < weights.length - 1) r -= weights[k++];
    const e = EDGES[k];
    walkers.push({ e, s: Math.random() * e.len, dir: Math.random() < 0.5 ? 1 : -1, v: rand(1.1, 1.6), off: rand(1.8, 3.2), ph: rand(0, 6.3) });
  }
  walkMesh = crowdMeshes(n, true);
}
function updateWalkers(dt) {
  const m = walkMesh; if (!m) return;
  walkers.forEach((w, i) => {
    w.s += w.dir * w.v * dt; w.ph += w.v * dt * 5.2;
    const p = alongEdge(w.e, w.s, w.off), yaw = Math.atan2(p.dx * w.dir, p.dz * w.dir);
    const bob = Math.abs(Math.sin(w.ph)) * 0.05, swing = Math.sin(w.ph) * 0.55;
    dummy.position.set(p.x, bob, p.z); dummy.rotation.set(0, yaw, 0); dummy.updateMatrix();
    m.torso.setMatrixAt(i, dummy.matrix); m.head.setMatrixAt(i, dummy.matrix);
    const sx = Math.cos(yaw) * 0.1, sz = -Math.sin(yaw) * 0.1;
    dummy.rotation.order = "YXZ";
    dummy.position.set(p.x + sx, 0.84 + bob, p.z + sz); dummy.rotation.set(swing, yaw, 0); dummy.updateMatrix(); m.legA.setMatrixAt(i, dummy.matrix);
    dummy.position.set(p.x - sx, 0.84 + bob, p.z - sz); dummy.rotation.set(-swing, yaw, 0); dummy.updateMatrix(); m.legB.setMatrixAt(i, dummy.matrix);
    dummy.rotation.order = "XYZ";
  });
  for (const k in m) if (m[k]) m[k].instanceMatrix.needsUpdate = true;
}

const QUEUE_SHOWN = 14; // people drawn per stop; the label gives the full count
let queueMesh = null, queueDirty = true;
function updateQueues() {
  if (!queueDirty) return;
  queueDirty = false;
  if (!queueMesh) queueMesh = crowdMeshes(STOPS.length * QUEUE_SHOWN, false);
  let n = 0;
  for (const s of STOPS) {
    const k = Math.min(QUEUE_SHOWN, s.queue.length);
    for (let j = 0; j < k; j++) {
      const row = Math.floor(j / 5), col = (j % 5) - 2;
      const off = 3.6 + row * 0.9 + ((j * 37) % 7) / 20, along = col * 0.8 + ((j * 13) % 5) / 10;
      dummy.position.set(s.x + s.nx * off + s.dx * along, 0, s.z + s.nz * off + s.dz * along);
      dummy.rotation.set(0, Math.atan2(-s.nx, -s.nz) + ((j * 29) % 9 - 4) / 10, 0); dummy.updateMatrix();
      for (const key of ["torso", "head", "legA"]) queueMesh[key].setMatrixAt(n, dummy.matrix);
      n++;
    }
  }
  for (const key of ["torso", "head", "legA"]) { queueMesh[key].count = n; queueMesh[key].instanceMatrix.needsUpdate = true; }
}

// ---------------------------------------------------------------- simulated fleet (the study's output)
const FLEET = { legs: null, paths: null, inst: [], cap: PHONE ? 60 : 160 };
function decodeFleet(pathsRaw, anim) {
  const [lng0, lat0] = pathsRaw.origin;
  FLEET.paths = pathsRaw.paths.map((flat) => {
    const n = flat.length / 3, xs = new Float32Array(n), zs = new Float32Array(n), fr = new Float32Array(n);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) { x += flat[3 * i]; y += flat[3 * i + 1]; xs[i] = X(lng0 + x / 1e5); zs[i] = Z(lat0 + y / 1e5); fr[i] = flat[3 * i + 2] / 1000; }
    return { xs, zs, fr };
  });
  const t = anim.legs, n = t.pid.length, t0 = new Float64Array(n);
  let acc = 0, maxDur = 1800;
  for (let i = 0; i < n; i++) { acc += t.t0[i]; t0[i] = acc; if (t.dur[i] > maxDur) maxDur = t.dur[i]; }
  FLEET.legs = { n, pid: t.pid, t0, dur: t.dur, cut: t.cut, occ: t.occ, maxDur };
}
function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
function poseOn(path, f) {
  const { xs, zs, fr } = path; let lo = 0, hi = fr.length - 1;
  f = Math.max(0, Math.min(1, f));
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (fr[m] <= f) lo = m; else hi = m; }
  const u = Math.max(0, Math.min(1, (f - fr[lo]) / (fr[hi] - fr[lo] || 1)));
  return { x: xs[lo] + u * (xs[hi] - xs[lo]), z: zs[lo] + u * (zs[hi] - zs[lo]), yaw: Math.atan2(xs[hi] - xs[lo], zs[hi] - zs[lo]) };
}
function instancedModel(gltf, cap) {
  const meshes = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const im = new THREE.InstancedMesh(o.geometry.clone().applyMatrix4(o.matrixWorld), o.material, cap);
    im.count = 0; im.frustumCulled = false; im.castShadow = !PHONE;
    scene.add(im); meshes.push(im);
  });
  return meshes;
}
const FLEET_SEEN = []; // simulated shuttles near the player this frame, for the minimap
function updateFleet(simSec) {
  const L = FLEET.legs; if (!L || !FLEET.inst.length) return;
  const i0 = lowerBound(L.t0, simSec - L.maxDur), i1 = lowerBound(L.t0, simSec);
  let n = 0;
  FLEET_SEEN.length = 0;
  for (let i = i0; i < i1 && n < FLEET.cap; i++) {
    const end = L.t0[i] + (L.cut[i] > 0 ? L.cut[i] : L.dur[i]);
    if (end <= simSec) continue;
    const path = FLEET.paths[L.pid[i]];
    if (!path || path.xs.length < 2) continue;
    const p = poseOn(path, (simSec - L.t0[i]) / (L.dur[i] || 1));
    if (Math.abs(p.x - car.x) > 900 || Math.abs(p.z - car.z) > 900) continue;
    FLEET_SEEN.push(p);
    dummy.position.set(p.x, 0, p.z); dummy.rotation.set(0, p.yaw - Math.PI / 2, 0); dummy.updateMatrix();
    for (const im of FLEET.inst) im.setMatrixAt(n, dummy.matrix);
    n++;
  }
  for (const im of FLEET.inst) { im.count = n; im.instanceMatrix.needsUpdate = true; }
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
const VEHICLES = {
  robotaxi: { seats: 4, accel: 4.2, vmax: 16.7, turn: 1.9, len: 4.6, cam: [10, 4.2] },
  robovan: { seats: 10, accel: 2.9, vmax: 13.9, turn: 1.45, len: 6.6, cam: [13, 5.4] },
};
const car = { x: 0, z: 0, yaw: 0, v: 0, steer: 0, spec: VEHICLES.robotaxi, obj: null, models: {}, safe: { x: 0, z: 0, yaw: 0 } };
const keys = {};
let camMode = 0; // 0 chase, 1 high, 2 overhead
const head = new THREE.SpotLight(0xfff0d8, 0, 110, 0.55, 0.6, 1.2);
head.position.set(2.2, 1.0, 0);
head.target.position.set(25, 0, 0);

function setVehicle(name) {
  car.spec = VEHICLES[name];
  if (car.obj) scene.remove(car.obj);
  car.obj = car.models[name].clone(true);
  car.obj.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  car.obj.add(head, head.target);
  head.position.x = car.spec.len / 2;
  scene.add(car.obj);
}

function driveStep(dt) {
  const S = car.spec;
  const up = keys.up, down = keys.down, left = keys.left, right = keys.right;
  const flags = maskAt(car.x, car.z), onRoad = flags & ROAD;
  const vmax = onRoad ? S.vmax : 6;
  if (up) car.v += S.accel * dt * (car.v < 0 ? 2.2 : 1);
  if (down) car.v -= (car.v > 0.3 ? 9 : S.accel * 0.6) * dt;
  if (!up && !down) car.v -= Math.sign(car.v) * Math.min(Math.abs(car.v), 1.6 * dt);
  car.v = Math.max(-4, Math.min(vmax, car.v - (car.v > vmax ? 6 * dt : 0)));
  const target = (left ? 1 : 0) - (right ? 1 : 0);
  car.steer += (target - car.steer) * Math.min(1, dt * 6);
  const grip = Math.min(1, Math.abs(car.v) / 5) * (1 - 0.35 * Math.min(1, Math.abs(car.v) / S.vmax));
  car.yaw += car.steer * S.turn * grip * Math.sign(car.v) * dt;
  const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
  const nx = car.x + fx * car.v * dt, nz = car.z + fz * car.v * dt;
  const probe = (S.len / 2) * Math.sign(car.v || 1);
  const stuck = maskAt(car.x, car.z) & (BLDG | WATER); // already inside a wall: always let it drive out
  if (!stuck && maskAt(nx + fx * probe, nz + fz * probe) & (BLDG | WATER)) {
    if (Math.abs(car.v) > 4) { bump(); shake = 0.4; }
    car.v = -car.v * 0.25;
  } else { car.x = nx; car.z = nz; }
  if (!Number.isFinite(car.x + car.z + car.v + car.yaw + car.steer)) Object.assign(car, car.safe, { v: 0, steer: 0 });
  else if (!(maskAt(car.x, car.z) & (BLDG | WATER))) car.safe = { x: car.x, z: car.z, yaw: car.yaw };
}

let shake = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
function updateCamera(dt, attract, t) {
  if (attract) {  // menu: a slow flight round the town centre
    const a = t * 0.04;
    camPos.set(250 + Math.cos(a) * 900, 380, -350 + Math.sin(a) * 900);
    camera.position.copy(camPos); camera.lookAt(250, 0, -350);
    return;
  }
  const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
  let [back, upH] = camMode === 0 ? car.spec.cam : camMode === 1 ? [34, 24] : [6, 150];
  // pull in (and up) rather than sit inside a block behind the car
  for (let k = 0; k < 4 && camMode !== 2 && maskAt(car.x - fx * back, car.z - fz * back) & BLDG; k++) { back *= 0.6; upH += 2.5; }
  const want = new THREE.Vector3(car.x - fx * back, upH, car.z - fz * back);
  const k = 1 - Math.exp(-dt * (camMode === 2 ? 3 : 4.5));
  camera.position.lerp(want, k);
  camLook.lerp(new THREE.Vector3(car.x + fx * (camMode === 2 ? 1 : 6), 1.2, car.z + fz * (camMode === 2 ? 1 : 6)), Math.min(1, k * 1.5));
  if (shake > 0) { camera.position.x += rand(-1, 1) * shake; camera.position.y += rand(-1, 1) * shake; shake = Math.max(0, shake - dt); }
  camera.lookAt(camLook);
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
}

// ---------------------------------------------------------------- game state, HUD
const G = { running: false, paused: false, over: false, t: 0, score: 0, delivered: 0, beat: 0, onboard: [], dwell: 0, nearStop: null, veh: "robotaxi" };

function toast(big, small, teal) {
  const el = $("toast");
  el.innerHTML = `<span style="color:var(${teal ? "--ion" : "--sodium"})">${big}</span>${small ? `<small>${small}</small>` : ""}`;
  el.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 2200);
}
const floaters = [];
function floater(text, x, z, teal) {
  const el = document.createElement("div"); el.className = `floater${teal ? " teal" : ""}`; el.textContent = text;
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

function updateHud() {
  $("clock").textContent = clockOf(HOUR + G.t / 3600);
  $("shift-label").textContent = `shift ${mmss(SHIFT - G.t)}`;
  $("score").textContent = String(G.score);
  $("delivered").textContent = String(G.delivered);
  $("beat").textContent = G.delivered ? `${G.beat} (${Math.round((100 * G.beat) / G.delivered)}%)` : "0";
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
  fill(town.green, "#16301f"); fill(town.water, "#163452"); fill(town.roads, "#4a5468"); fill(buildings.map((b) => b.p), "#262d3a");
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
  for (const p of FLEET_SEEN) dot(p.x, p.z, 2.2, "#8a6430");
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
let ac = null, muted = false, engine = null;
function audioInit() {
  if (ac) return;
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), f = ac.createBiquadFilter(), g = ac.createGain();
    o.type = "sawtooth"; o.frequency.value = 50; f.type = "lowpass"; f.frequency.value = 500; g.gain.value = 0;
    o.connect(f).connect(g).connect(ac.destination); o.start();
    engine = { o, g };
  } catch (e) { ac = null; }
}
function chime(freqs, dur = 0.12, vol = 0.1) {
  if (!ac || muted) return;
  try { playChime(freqs, dur, vol); } catch (e) { ac = null; engine = null; }
}
function playChime(freqs, dur, vol) {
  let t = ac.currentTime;
  for (const fq of freqs) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = "triangle"; o.frequency.value = fq;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + 0.05);
    t += dur * 0.55;
  }
}
const bump = () => chime([140, 90], 0.15, 0.12);
function updateEngine() {
  if (!engine || !ac) return;
  try { engineTone(); } catch (e) { engine = null; }
}
function engineTone() {
  const v = Math.abs(car.v) / car.spec.vmax;
  engine.o.frequency.setTargetAtTime(48 + v * 110, ac.currentTime, 0.1);
  engine.g.gain.setTargetAtTime(muted || !G.running || G.paused ? 0 : 0.012 + v * 0.025, ac.currentTime, 0.1);
}

// ---------------------------------------------------------------- game rules
function atStop() {
  let best = null, bd = 18;
  for (const s of STOPS) { const d = Math.hypot(s.x - car.x, s.z - car.z); if (d < bd) { bd = d; best = s; } }
  return best;
}
let paxClock = 0, beamClock = 0;
function gameStep(dt) {
  G.t += dt;
  driveStep(dt);
  // riders arrive at every stop at this hour's observed rate, and give up after a while
  for (const s of STOPS) {
    const rate = s.o[HI] || 0;
    if (rate > 0 && Math.random() < (rate * dt) / 3600) spawnRider(s, G.t);
    if (s.queue.length && s.queue[0].t0 + s.queue[0].patience < G.t) {
      s.queue = s.queue.filter((r) => r.t0 + r.patience >= G.t); queueDirty = true;
    }
  }
  // stopped at a stop: drop riders bound here first, then board, one every 0.4 s
  const s = atStop(), slow = Math.abs(car.v) < 2.2;
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
  if ((paxClock += dt) > 0.25) { paxClock = 0; renderPax(); }
  if ((beamClock += dt) > 0.3) { beamClock = 0; updateBeams(); }
  if (G.t >= SHIFT) endShift();
}
function deliver(r, s) {
  const took = G.t - r.t0, from = STOPS[r.from];
  const dist = Math.hypot(s.x - from.x, s.z - from.z);
  let pts = Math.round(20 + dist / 20);
  const beat = took < r.bus;
  if (beat) { pts += Math.round(pts * 0.6 + (r.bus - took) / 6); G.beat++; }
  G.score += pts; G.delivered++;
  floater(`+${pts}`, s.x, s.z, beat);
  toast(beat ? `+${pts} · beat the bus by ${mmss(r.bus - took)}` : `+${pts}`, beat ? `${from.name} → ${s.name} in ${mmss(took)}` : `${from.name} → ${s.name}: the bus would have taken ${mmss(r.bus)}`, beat);
  chime(beat ? [523, 659, 784, 1047] : [523, 392], 0.12, 0.09);
}

function startShift() {
  if (!READY || !STOPS.length) return;
  $("menu").hidden = true; $("end").hidden = true; $("hud").hidden = false;
  $("touch").hidden = !matchMedia("(pointer: coarse)").matches;
  audioInit();
  if (ac && ac.state === "suspended") ac.resume().catch(() => {});
  Object.assign(G, { running: true, paused: false, over: false, t: 0, score: 0, delivered: 0, beat: 0, onboard: [], dwell: 0 });
  HI = Math.max(0, Math.min(20, Math.floor(HOUR) - 5));
  applyLook(HOUR);
  setVehicle(G.veh);
  prepareDemand();
  seedQueues();
  // start beside the busiest hub this hour, on the road, facing along the kerb
  const hub = STOPS.filter((s) => s.hub).sort((a, b) => (b.o[HI] || 0) - (a.o[HI] || 0))[0] || STOPS[0];
  car.x = hub.x - hub.nx * 3.5; car.z = hub.z - hub.nz * 3.5; car.yaw = Math.atan2(hub.dx, hub.dz); car.v = 0; car.steer = 0;
  car.safe = { x: car.x, z: car.z, yaw: car.yaw };
  camera.position.set(car.x - Math.sin(car.yaw) * 40, 30, car.z - Math.cos(car.yaw) * 40);
  camLook.set(car.x, 0, car.z);
  renderPax(); updateBeams(); queueDirty = true;
  toast(`${clockOf(HOUR)} · ${hub.name}`, `${Math.round(hub.o[HI] || 0)} rides an hour start here. Follow the amber beams.`);
}
function endShift() {
  G.running = false; G.over = true;
  $("hud").hidden = true; $("touch").hidden = true;
  for (const el of labelEls) el.hidden = true;
  const key = `nightshift-best-${G.veh}-${HOUR}`;
  let best = 0;
  try { best = Math.max(G.score, +(localStorage.getItem(key) || 0)); localStorage.setItem(key, String(best)); } catch (e) { best = G.score; }
  $("r-score").textContent = String(G.score);
  $("r-del").textContent = String(G.delivered);
  $("r-beat").textContent = G.delivered ? `${Math.round((100 * G.beat) / G.delivered)}%` : "—";
  $("r-best").textContent = String(best);
  $("end-title").textContent = G.delivered ? `${G.delivered} rider${G.delivered > 1 ? "s" : ""} home at ${clockOf(HOUR + G.t / 3600)}` : "No riders delivered";
  $("r-note").textContent = `In the study, ${D.results?.numbers?.parity || "450"} ten-seat shuttles carry all of Yishun's ${D.results?.numbers?.rides || "164,000"} internal bus rides a weekday and keep up with the bus every hour. "Beat the bus" here uses a rough estimate of each ride by bus, for the game.`;
  $("end").hidden = false;
}
function setPaused(p) {
  if (!G.running) return;
  G.paused = p; $("paused").hidden = !p;
}

// ---------------------------------------------------------------- input
const KEYMAP = { ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down", ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right" };
addEventListener("keydown", (e) => {
  if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = true; e.preventDefault(); }
  if (e.code === "KeyC") camMode = (camMode + 1) % 3;
  if (e.code === "KeyM") toggleMute();
  if (e.code === "KeyP" || e.code === "Escape") setPaused(!G.paused);
  if (e.code === "Enter" && !$("menu").hidden && READY) startShift();
});
addEventListener("keyup", (e) => { if (KEYMAP[e.code]) keys[KEYMAP[e.code]] = false; });
for (const [id, k] of [["t-left", "left"], ["t-right", "right"], ["t-go", "up"], ["t-brake", "down"]]) {
  const el = $(id);
  el.addEventListener("pointerdown", (e) => { keys[k] = true; try { el.setPointerCapture(e.pointerId); } catch (err) { /* already released */ } e.preventDefault(); });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(ev, () => { keys[k] = false; });
}
function toggleMute() { muted = !muted; $("mute").setAttribute("aria-pressed", String(muted)); $("mute").textContent = muted ? "Sound off" : "Sound on"; }
$("mute").onclick = toggleMute;
$("pause").onclick = () => setPaused(true);
$("resume").onclick = () => setPaused(false);
$("quit").onclick = () => { setPaused(false); endShift(); };
$("again").onclick = startShift;
addEventListener("contextmenu", (e) => { if (e.target.closest && e.target.closest("#touch")) e.preventDefault(); }); // long-press on touch buttons
$("change").onclick = () => { $("end").hidden = true; $("menu").hidden = false; };
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
  renderer.setSize(innerWidth, innerHeight); if (composer) composer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- main loop
let READY = false, last = performance.now(), clock = 0;
let loopErrors = 0;
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now; clock += dt;
  try {
    if (READY && !contextLost) {
      const live = G.running && !G.paused;
      if (live) gameStep(dt);
      updateWalkers(live || !G.running ? dt : 0);
      updateTrains(dt); updateSky(clock, dt);
      updateQueues();
      updateFleet(HOUR * 3600 + G.t);
      if (car.obj) { car.obj.position.set(car.x, 0, car.z); car.obj.rotation.y = car.yaw - Math.PI / 2; car.obj.visible = G.running || G.over; }
      head.intensity = look.night > 0.3 ? 260 : 0;
      updateCamera(dt, !G.running && !G.over, clock);
      if (G.running) { updateChevron(); updateLabels(); updateFloaters(dt); updateHud(); drawMinimap(); } else chevron.visible = false;
      updateEngine();
      // the sun (and its shadow box) follows the camera
      const fx = G.running ? car.x : camera.position.x, fz = G.running ? car.z : camera.position.z;
      sun.target.position.set(fx, 0, fz);
      sun.position.set(fx + look.sunDir[0] * 600, look.sunDir[1] * 600, fz + look.sunDir[2] * 600);
      sky.position.copy(camera.position); stars.position.copy(camera.position);
    }
    if (!contextLost) { if (composer) composer.render(); else renderer.render(scene, camera); }
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
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3e5238, roughness: 1 }));
    ground.position.y = -0.05; ground.receiveShadow = true; scene.add(ground);
    flatLayer(town.green, 0.02, 0x33532f, { offset: -1 });
    flatLayer(town.water, 0.03, 0x173350, { rough: 0.08, metal: 0.4, offset: -2 });
    flatLayer(town.roads, 0.06, 0x24272d, { rough: 0.8, offset: -3 });
    buildMask(town, blds);
    buildEdges(town); buildKerbs();
    progress(0.45, `Raising ${blds.length.toLocaleString()} buildings…`); await breathe();
    buildBuildings(blds);
    progress(0.6, "Planting trees, lighting streets…"); await breathe();
    buildLamps(); buildTrees(town); buildRail(town);
    buildStops(stops); clearAroundStops(); buildBeams(); buildMinimapBase(town, blds);
    buildWalkers();
    progress(0.72, "Fetching the simulated fleet and the vehicles…"); await breathe();
    const loader = new GLTFLoader();
    const [taxi, van, truck, pathsRaw, anim] = await Promise.all([
      optional(loader.loadAsync("models/robotaxi.glb")), optional(loader.loadAsync("models/robovan.glb")), optional(loader.loadAsync("models/skytruck.glb")),
      optional(getJSON("paths.json")), optional(getJSON("anim_s10_450.json")),
    ]);
    // the game still runs without any of these: stand-in cars, no traffic, no flying trucks
    car.models = { robotaxi: taxi ? taxi.scene : standInCar(4.6), robovan: van ? van.scene : standInCar(6.6) };
    if (van && pathsRaw && anim && anim.legs) {
      try { decodeFleet(pathsRaw, anim); FLEET.inst = instancedModel(van, FLEET.cap); } catch (e) { console.warn("no fleet:", e); FLEET.legs = null; }
    }
    if (truck) buildSkyTrucks(truck);
    applyLook(HOUR); // again, now the lamps and trains exist
    progress(1, "Ready");
    READY = true;
    $("loading").hidden = true;
    $("menu").hidden = false;
    if (AUTO) {  // test hook: step the rules without waiting on frames
      startShift();
      window.__ns = { G, car, keys, STOPS, sim: (sec) => { for (let i = 0; i < sec * 30; i++) gameStep(1 / 30); return { x: car.x, z: car.z, v: car.v, onboard: G.onboard.length, delivered: G.delivered, score: G.score }; } };
    }
  } catch (e) {
    console.error(e);
    fail(`Could not build the city (${e.message || e}).`);
  }
}
requestAnimationFrame(frame);
boot();
