/* Night Shift shaders, written in three.js TSL: the same node graphs compile to WGSL for WebGPU
   and to GLSL for the WebGL 2 fallback.
   - Sky: gradient, sun, drifting clouds lit by the sun by day and by the town's sodium glow by
     night, and stars.
   - Buildings: storeys of windows looking into rooms (interior mapping: each window is a box
     traced in the pixel shader, so rooms shift with parallax as you drive past), curtains,
     air-conditioner ledges, HDB void decks and blank gable ends painted with the block number,
     rain streaks; offices with glass curtain walls or strip windows and lit shops below.
   - Ground: asphalt with patches and puddles, grass, paving, water with moving waves, all darkened
     near buildings by an ambient-occlusion map baked from the footprints.
   - Trees sway in the wind; people walk by moving their own legs and arms on the GPU. */
import * as THREE from "three/webgpu";
import {
  Fn, float, vec2, vec3, uniform, attribute, property, texture, select,
  positionGeometry, normalGeometry, normalLocal, positionLocal, positionWorld, cameraPosition,
  mix, step, smoothstep, floor, fract, abs, min, max, clamp, sin, cos, pow, exp, dot, normalize, length, distance, fwidth, atan,
  mx_noise_float, mx_fractal_noise_float, instancedDynamicBufferAttribute, instancedBufferAttribute, transformNormalToView,
} from "three/tsl";

// Shared state the game writes each hour or frame.
export const U = {
  night: uniform(0.8),                              // 0 noon .. 1 deep night
  time: uniform(0),                                 // seconds of play (stops when paused)
  sunDir: uniform(new THREE.Vector3(0, 1, 0)),
  sunCol: uniform(new THREE.Color(1, 1, 1)),
  top: uniform(new THREE.Color(0x3d7ccc)),
  horizon: uniform(new THREE.Color(0xbcd4ec)),
  glow: uniform(new THREE.Color(0x000000)),         // the town's light on the low sky at night
  clouds: uniform(0.45),                            // cover, 0..1
  wet: uniform(0),                                  // how wet the roads are, 0..1
  car: uniform(new THREE.Vector3()),                // the player, for fading fake lamp pools
  lampR: uniform(60),                               // radius the real lamp lights cover
  aoBox: uniform(new THREE.Vector4(-3800, -3500, 8600, 7600)), // x0, z0, width, depth of the AO map
  sunDisk: uniform(1),                              // turned down while baking reflections, so paint shows no blown-out sun
};

const hash21 = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const hash31 = Fn(([p]) => fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453)));

// ---------------------------------------------------------------- sky
export function skyMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  m.colorNode = Fn(() => {
    const d = normalize(positionGeometry).toVar();
    const h = max(d.y, 0);
    const col = mix(U.horizon, U.top, pow(h, 0.45)).toVar();
    col.addAssign(U.glow.mul(exp(h.mul(-7))).mul(U.night));
    const s = max(dot(d, normalize(U.sunDir)), 0);
    col.addAssign(U.sunCol.mul(pow(s, 1400).mul(20).mul(U.sunDisk).add(pow(s, 22).mul(0.3)).add(pow(s, 4).mul(0.06))));
    // clouds on a plane overhead, drifting
    const uv = d.xz.div(d.y.add(0.09)).mul(0.5).add(vec2(U.time.mul(0.0035), U.time.mul(0.0012)));
    const n = mx_fractal_noise_float(vec3(uv.mul(1.7), U.time.mul(0.002)), 4).mul(0.55).add(0.5);
    const edge = U.clouds.oneMinus();
    const cover = smoothstep(edge, edge.add(0.32), n).mul(smoothstep(0.0, 0.16, d.y)).toVar();
    const thick = smoothstep(edge.add(0.1), edge.add(0.55), n);
    const dayC = mix(vec3(1.0, 0.99, 0.97), U.horizon.mul(0.75), thick.mul(0.6)).add(U.sunCol.mul(pow(s, 5).mul(0.6)));
    const nightC = U.glow.mul(mix(0.8, 0.45, thick)).add(U.top.mul(0.5));
    col.assign(mix(col, mix(dayC, nightC, U.night), cover.mul(0.9)));
    // stars, round, twinkling, behind the clouds
    const g = d.mul(380), cell = floor(g), r = hash31(cell);
    const core = smoothstep(0.32, 0.05, length(fract(g).sub(0.5)));
    const tw = sin(U.time.mul(2.3).add(r.mul(91))).mul(0.3).add(0.7);
    col.addAssign(vec3(step(0.9972, r).mul(core).mul(tw).mul(U.night).mul(cover.oneMinus()).mul(smoothstep(0.04, 0.25, d.y)).mul(1.6)));
    return select(d.y.lessThan(0), U.horizon.mul(0.45), col);
  })();
  return m;
}

// Lit windows on a band round the horizon: only for the environment map, so cars and glass
// reflect a town at night rather than a black sky.
export function horizonCityMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false });
  m.colorNode = Fn(() => {
    const d = normalize(positionGeometry);
    const a = atan(d.x, d.z).mul(60), y = positionGeometry.y;
    const cell = floor(vec2(a.mul(2), y.mul(3)));
    const lit = step(hash21(cell), U.night.mul(0.35));
    const blockH = hash21(vec2(floor(a.mul(0.25)), 7)).mul(4).add(1);
    const under = step(y, blockH);
    return mix(vec3(0.02, 0.025, 0.035), vec3(1.0, 0.75, 0.45).mul(lit).mul(2.2), lit).mul(under);
  })();
  return m;
}

// ---------------------------------------------------------------- buildings
// Attributes: aWall (run along the facade, height), aInfo (seed, is HDB, building height),
// aTan (the facade's direction in xz), aSeg (this wall's start, length, gable 0/1, text flip 0/1),
// aBlk (glyph indices of the HDB block number, -1 for none). The mesh sits at the origin, so
// geometry normals are world normals.
// lite: phones, where per-pixel Perlin noise for grime is swapped for a cheap hash.
export function buildingMaterial(glyphTex, nGlyph, lite = false) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
  const aWall = attribute("aWall", "vec2"), aInfo = attribute("aInfo", "vec3"), aTan = attribute("aTan", "vec2");
  const aSeg = attribute("aSeg", "vec4"), aBlk = attribute("aBlk", "vec4");
  const glow = property("vec3", "nsGlow"), rough = property("float", "nsRough"), glassP = property("float", "nsGlass");
  m.colorNode = Fn(() => {
    const seed = aInfo.x, isHdb = step(0.5, aInfo.y), H = aInfo.z;
    const pastel = vec3(hash21(vec2(seed, 1)), hash21(vec2(seed, 2)), hash21(vec2(seed, 3))).mul(0.5).add(0.5);
    const kind = hash21(vec2(seed, 9)); // offices: < .3 glass tower, < .65 strip windows, else punched
    const concrete = vec3(0.5, 0.51, 0.53).mul(seed.mul(0.3).add(0.8));
    const base = mix(concrete, mix(vec3(0.9, 0.88, 0.83), pastel, 0.22), isHdb).toVar();
    const isWall = step(normalGeometry.y, 0.5);
    // straight-line code: derivatives and texture reads must not sit inside branches
    const storey = mix(3.6, 2.8, isHdb), colw = mix(3.2, 2.6, isHdb);
    const g = vec2(aWall.x.div(colw), aWall.y.div(storey));
    const cell = floor(g), f = fract(g);
    const fw = fwidth(g);
    const sharp = clamp(float(1.35).sub(max(fw.x, fw.y).mul(3.4)), 0, 1);
    const ground = step(aWall.y, storey);
    const top = step(H.sub(1.1), aWall.y);
    const gable = aSeg.z.mul(isHdb);
    const tall = step(4.5, H);
    const glassy = step(kind, 0.3).mul(isHdb.oneMinus()), strip = step(0.3, kind).mul(step(kind, 0.65)).mul(isHdb.oneMinus());
    // window opening within its cell
    const wx0 = mix(mix(0.2, 0.04, glassy), 0.0, strip), wx1 = mix(mix(0.8, 0.96, glassy), 1.0, strip);
    const wy0 = mix(mix(0.3, 0.1, glassy), 0.32, strip), wy1 = mix(0.84, 0.95, glassy);
    const win = step(wx0, f.x).mul(step(f.x, wx1)).mul(step(wy0, f.y)).mul(step(f.y, wy1))
      .mul(ground.oneMinus()).mul(top.oneMinus()).mul(gable.oneMinus()).mul(tall).toVar();
    const frame = step(wx0.sub(0.05), f.x).mul(step(f.x, wx1.add(0.05))).mul(step(wy0.sub(0.05), f.y)).mul(step(f.y, wy1.add(0.04)))
      .mul(ground.oneMinus()).mul(top.oneMinus()).mul(gable.oneMinus()).mul(tall).sub(win).max(0);
    // --- the room behind the window, traced as a box in the window's own frame
    const V = normalize(positionWorld.sub(cameraPosition));
    const T = vec3(aTan.x, 0, aTan.y), N = normalGeometry;
    const D = colw.mul(1.5);
    const rd = vec3(dot(V, T).div(colw.mul(wx1.sub(wx0))), V.y.div(storey.mul(wy1.sub(wy0))), dot(V, N).negate().div(D)).toVar();
    const lx = f.x.sub(wx0).div(wx1.sub(wx0)), ly = f.y.sub(wy0).div(wy1.sub(wy0));
    const sx = select(rd.x.greaterThanEqual(0), float(1e-4), float(-1e-4)), sy = select(rd.y.greaterThanEqual(0), float(1e-4), float(-1e-4));
    const tx = step(0, rd.x).sub(lx).div(rd.x.add(sx)), ty = step(0, rd.y).sub(ly).div(rd.y.add(sy));
    const tz = float(1).div(max(rd.z, 0.02));
    const t = min(min(tx, ty), tz);
    const hit = vec3(lx, ly, 0).add(rd.mul(t));
    const back = step(tz, min(tx, ty)), side = step(tx, min(ty, tz)).mul(back.oneMinus());
    const flat = back.oneMinus().mul(side.oneMinus()), floorS = flat.mul(step(rd.y, 0)), ceil = flat.mul(step(0, rd.y));
    const rh = hash21(cell.add(seed.mul(53.1)));
    const paint = mix(vec3(0.78, 0.72, 0.62), vec3(0.62, 0.7, 0.74), hash21(cell.add(7.3))).mul(mix(0.75, 1.1, hash21(cell.add(2.9))));
    const furniture = step(hit.y, 0.32).mul(step(0.18, hit.x)).mul(step(hit.x, 0.75)).mul(back);
    const room = paint.mul(back.add(side.mul(0.72))).add(vec3(0.33, 0.25, 0.18).mul(floorS)).add(vec3(0.92, 0.9, 0.86).mul(ceil))
      .mul(furniture.mul(-0.6).add(1));
    const lamp = float(1).div(pow(distance(hit, vec3(0.5, 1.0, 0.55)).mul(1.6).add(0.6), 2));
    const litShare = mix(0.03, 0.42, U.night);
    const lit = step(rh, litShare);
    const warm = select(hash21(cell.mul(1.7).add(seed)).greaterThan(0.8), vec3(0.78, 0.88, 1.0), vec3(1.0, 0.74, 0.44));
    const tv = step(0.93, hash21(cell.add(31.7))).mul(sin(U.time.mul(9).add(rh.mul(40))).mul(0.25).add(0.75));
    const roomLight = room.mul(mix(warm, vec3(0.55, 0.65, 1.0), tv)).mul(lamp.mul(1.5).add(0.25)).mul(lit);
    // curtains drawn across part of some windows
    const cw = select(hash21(cell.add(11.1)).greaterThan(0.45), hash21(cell.add(4.4)).mul(0.32).add(0.08), float(0));
    const curtain = step(lx, cw).add(step(cw.oneMinus(), lx)).min(1).mul(step(0.01, cw));
    const cloth = mix(vec3(0.85, 0.8, 0.7), pastel, hash21(cell.add(5.5)));
    const inside = mix(room.mul(mix(0.22, 0.05, U.night)), cloth.mul(0.55), curtain);
    const insideGlow = mix(roomLight, cloth.mul(warm).mul(0.45).mul(lit), curtain);
    // --- the wall around the windows
    const wallC = base.toVar();
    const band = isHdb.mul(step(0.86, f.y)).mul(ground.oneMinus());                     // corridor parapet stripe
    const accent = isHdb.mul(step(0.92, fract(aWall.x.div(colw.mul(6)).add(seed))));   // service-duct stripe
    wallC.assign(mix(wallC, pastel.mul(0.78), band.add(accent).min(1).mul(0.55)));
    const ac = isHdb.mul(step(0.55, hash21(cell.add(13.0)))).mul(step(0.06, f.y)).mul(step(f.y, 0.22)).mul(step(0.24, f.x)).mul(step(f.x, 0.58))
      .mul(ground.oneMinus()).mul(gable.oneMinus()).mul(top.oneMinus());
    wallC.assign(mix(wallC, vec3(0.32, 0.33, 0.34), ac));
    wallC.assign(mix(wallC, vec3(0.7, 0.72, 0.74), frame));
    // shops under offices, signboards above them
    const shop = isHdb.oneMinus().mul(ground).mul(step(0.12, f.x)).mul(step(f.x, 0.88)).mul(step(0.05, f.y)).mul(step(f.y, 0.7)).mul(tall);
    const sign = isHdb.oneMinus().mul(ground).mul(step(0.76, f.y)).mul(step(f.y, 0.93)).mul(tall).mul(step(0.55, hash21(vec2(floor(aWall.x.div(colw.mul(3))), seed))));
    const shopLit = step(0.35, hash21(cell.add(9.0))).mul(hash21(cell.add(19.0)).mul(0.6).add(0.4));
    const signC = vec3(hash21(cell.add(21.0)), hash21(cell.add(22.0)), hash21(cell.add(23.0))).mul(0.8).add(0.2);
    // HDB void deck: open ground floor between pillars, tube lights under the slab
    const pillar = step(0.8, fract(aWall.x.div(6.0)));
    const voidDeck = isHdb.mul(ground).mul(pillar.oneMinus());
    const tube = voidDeck.mul(step(0.86, f.y)).mul(step(0.55, fract(aWall.x.div(5.0))));
    // rain streaks and grime, darker near the ground
    const streak = lite ? hash21(vec2(floor(aWall.x.mul(0.7)), seed)) : mx_noise_float(vec3(aWall.x.mul(0.45), aWall.y.mul(0.025), seed.mul(17.0))).mul(0.5).add(0.5);
    const grime = smoothstep(0.5, 1.0, streak).mul(0.2).add(smoothstep(storey.mul(1.5), 0.0, aWall.y).mul(0.14));
    wallC.mulAssign(grime.oneMinus());
    wallC.mulAssign(mix(0.55, 1.0, smoothstep(0.0, 2.2, aWall.y)));
    // the block number on HDB gable ends
    const nCh = step(0, aBlk.x).add(step(0, aBlk.y)).add(step(0, aBlk.z)).add(step(0, aBlk.w));
    const gh = storey.mul(1.6), gw = gh.mul(0.62);
    const segU = aWall.x.sub(aSeg.x), lu = mix(segU, aSeg.y.sub(segU), aSeg.w);
    const u = lu.sub(aSeg.y.mul(0.5).sub(nCh.mul(gw).mul(0.5)));
    const v = aWall.y.sub(H.sub(storey.mul(2.4))).div(gh);
    const k = floor(u.div(gw));
    const ch = select(k.lessThan(0.5), aBlk.x, select(k.lessThan(1.5), aBlk.y, select(k.lessThan(2.5), aBlk.z, aBlk.w)));
    const inText = gable.mul(step(0, u)).mul(step(u, nCh.mul(gw))).mul(step(0, v)).mul(step(v, 1)).mul(step(nCh.mul(gw), aSeg.y.mul(0.85))).mul(step(0, ch));
    const glyph = texture(glyphTex, vec2(ch.add(fract(u.div(gw))).div(nGlyph), v)).r.mul(inText);
    wallC.assign(mix(wallC, pastel.mul(0.35), glyph));
    // --- put it together; windows smaller than a pixel average out instead of shimmering
    const facade = ground.oneMinus().mul(top.oneMinus());
    const detail = mix(wallC, inside, win).toVar();
    detail.assign(mix(detail, vec3(0.08, 0.09, 0.1), shop.mul(0.8)));
    detail.assign(mix(detail, vec3(0.06), voidDeck.mul(0.85)));
    const far = mix(wallC.mul(0.7), vec3(0.12, 0.14, 0.17), glassy.mul(0.7));
    const col = mix(far, detail, sharp).toVar();
    const g1 = insideGlow.mul(win).add(vec3(1.0, 0.72, 0.42).mul(shop).mul(shopLit).mul(U.night).mul(0.28))
      .add(signC.mul(sign).mul(U.night).mul(0.9)).add(vec3(0.75, 0.9, 1.0).mul(tube).mul(U.night).mul(0.9));
    const g0 = vec3(1.0, 0.8, 0.55).mul(litShare).mul(0.32).mul(facade).mul(tall);
    const roofN = lite ? float(0) : mx_noise_float(positionWorld.xz.mul(0.3)).mul(0.08);
    const roofC = base.mul(0.62).add(roofN);
    const beacon = vec3(0.9, 0.2, 0.15).mul(step(0.996, hash21(floor(positionWorld.xz.div(3))))).mul(U.night).mul(step(40, H)).mul(3);
    glow.assign(mix(beacon, mix(g0, g1, sharp), isWall));
    glassP.assign(win.mul(sharp).mul(isWall));
    rough.assign(mix(0.9, mix(0.9, 0.06, glassP).sub(grime.mul(0.1)), isWall));
    col.assign(mix(roofC, col, isWall));
    return col;
  })();
  m.roughnessNode = rough;
  m.metalnessNode = glassP.mul(0.15);
  m.emissiveNode = glow;
  return m;
}

// ---------------------------------------------------------------- ground layers
const aoAt = Fn(([aoTex]) => {
  const uv = positionWorld.xz.sub(U.aoBox.xy).div(U.aoBox.zw);
  return texture(aoTex, uv).r;
});

export function groundMaterial(aoTex, kind, lite = false) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0, polygonOffset: true });
  const rough = property("float", "gRough");
  m.colorNode = Fn(() => {
    const p = positionWorld.xz;
    const ao = aoAt(aoTex);
    const col = vec3(0).toVar();
    rough.assign(0.95);
    if (kind === "road") {
      const big = mx_noise_float(p.mul(0.035)).mul(0.5).add(0.5);
      const patch = lite ? float(0) : step(0.72, mx_noise_float(floor(p.div(7)).mul(0.37)).mul(0.5).add(0.5));
      const grain = lite ? hash21(floor(p.mul(3))) : mx_noise_float(p.mul(2.7)).mul(0.5).add(0.5);
      col.assign(vec3(0.085, 0.088, 0.095).mul(big.mul(0.35).add(0.8)).mul(patch.mul(-0.22).add(1)).mul(grain.mul(0.25).add(0.88)));
      const puddle = smoothstep(0.52, 0.66, (lite ? big : mx_noise_float(p.mul(0.07).add(3.1)).mul(0.5).add(0.5))).mul(U.wet);
      col.mulAssign(puddle.mul(-0.45).add(1));
      rough.assign(mix(mix(0.92, 0.7, grain), 0.07, puddle).sub(U.wet.mul(0.25)).max(0.05));
    } else if (kind === "park") {
      const n = lite ? mx_noise_float(p.mul(0.045)).mul(0.5).add(0.5) : mx_fractal_noise_float(vec3(p.mul(0.045), 0), 3).mul(0.5).add(0.5);
      const fine = lite ? hash21(floor(p.mul(2))) : mx_noise_float(p.mul(1.3)).mul(0.5).add(0.5);
      col.assign(mix(vec3(0.13, 0.24, 0.1), vec3(0.24, 0.33, 0.13), n).mul(fine.mul(0.3).add(0.85)));
    } else if (kind === "pave") {
      const tile = step(0.93, fract(p.x.div(1.2))).add(step(0.93, fract(p.y.div(1.2)))).min(1);
      const n = mx_noise_float(p.mul(0.6)).mul(0.5).add(0.5);
      col.assign(vec3(0.46, 0.45, 0.43).mul(n.mul(0.2).add(0.85)).mul(tile.mul(-0.25).add(1)));
      rough.assign(0.85);
    } else {
      const n = mx_fractal_noise_float(vec3(p.mul(0.02), 1), 3).mul(0.5).add(0.5);
      col.assign(mix(vec3(0.16, 0.22, 0.12), vec3(0.27, 0.27, 0.17), n));
    }
    return col.mul(ao.mul(-0.6).add(1));
  })();
  m.roughnessNode = rough;
  return m;
}

export function waterMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x0d2a38, roughness: 0.03, metalness: 0, polygonOffset: true });
  const height = Fn(([q]) => mx_noise_float(vec3(q.mul(0.09), U.time.mul(0.22))).mul(0.7)
    .add(mx_noise_float(vec3(q.mul(0.37).add(vec2(U.time.mul(0.35), 0)), U.time.mul(0.5))).mul(0.25)));
  m.normalNode = Fn(() => {
    const p = positionWorld.xz, e = 0.5;
    const hx = height(p.add(vec2(e, 0))).sub(height(p.sub(vec2(e, 0))));
    const hz = height(p.add(vec2(0, e))).sub(height(p.sub(vec2(0, e))));
    return transformNormalToView(normalize(vec3(hx.mul(-0.9), 1, hz.mul(-0.9))));
  })();
  return m;
}

// Fake light pools under street lamps, fading out near the player where real lights take over.
export function poolMaterial(map) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffa64a });
  m.colorNode = vec3(1.0, 0.65, 0.29);
  m.opacityNode = texture(map).a.mul(U.night).mul(0.55).mul(smoothstep(U.lampR.mul(0.55), U.lampR, distance(positionWorld.xz, U.car.xz)));
  return m;
}

// ---------------------------------------------------------------- trees
export function crownMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, flatShading: true });
  m.positionNode = Fn(() => {
    const p = positionLocal; // after instancing: world space (the mesh sits at the origin)
    const k = smoothstep(2.5, 7.0, p.y);
    const w = sin(U.time.mul(1.3).add(p.x.mul(0.06)).add(p.z.mul(0.045))).mul(0.16).add(sin(U.time.mul(3.7).add(p.x.mul(0.4))).mul(0.04));
    return p.add(vec3(w.mul(k), 0, w.mul(k).mul(0.6)));
  })();
  m.colorNode = mx_noise_float(positionWorld.mul(0.35)).mul(0.18).add(0.92);
  return m;
}

// ---------------------------------------------------------------- people
// One mesh for every walker and waiting rider. Per person: pose (x, y, z, yaw), gait (phase,
// stride 0 standing .. 1 walking, shown 0/1, lean), and colours. Vertices carry a limb id:
// 0 torso, 1 head, 2/3 legs, 4/5 arms, 6 hair. Legs swing about the hips and arms about the
// shoulders, at the same heights the ragdolls use.
export function peopleMaterial(attrs, HIP_Y, SHOULDER_Y) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  const P = instancedDynamicBufferAttribute(attrs.pose, "vec4"), A = instancedDynamicBufferAttribute(attrs.gait, "vec4");
  const shirt = instancedBufferAttribute(attrs.shirt, "vec3"), skin = instancedBufferAttribute(attrs.skin, "vec3");
  const pants = instancedBufferAttribute(attrs.pants, "vec3");
  const limb = attribute("aLimb", "float");
  m.positionNode = Fn(() => {
    const p = positionGeometry;
    const sw = sin(A.x).mul(0.5).mul(A.y);
    const legSide = select(limb.equal(2), float(1), select(limb.equal(3), float(-1), float(0)));
    const armSide = select(limb.equal(4), float(-0.8), select(limb.equal(5), float(0.8), float(0)));
    const a = sw.mul(legSide.add(armSide)).add(A.w.mul(step(0.5, abs(legSide).add(abs(armSide))).oneMinus()).mul(0.2));
    const pivot = select(abs(armSide).greaterThan(0.1), float(SHOULDER_Y), float(HIP_Y));
    const dy = p.y.sub(pivot);
    const ry = dy.mul(cos(a)).sub(p.z.mul(sin(a))).add(pivot);
    const rz = dy.mul(sin(a)).add(p.z.mul(cos(a)));
    const bob = abs(sin(A.x)).mul(0.045).mul(A.y);
    const c = cos(P.w), s = sin(P.w);
    const n = normalGeometry;
    normalLocal.assign(vec3(n.x.mul(c).add(n.z.mul(s)), n.y, n.z.mul(c).sub(n.x.mul(s))));
    const world = vec3(p.x.mul(c).add(rz.mul(s)), ry.add(bob), rz.mul(c).sub(p.x.mul(s))).add(P.xyz);
    return select(A.z.greaterThan(0.5), world, vec3(P.x, -50, P.z));
  })();
  m.colorNode = Fn(() => {
    const y = positionGeometry.y;
    const legC = select(y.lessThan(0.1), vec3(0.08, 0.08, 0.09), pants);
    const armC = select(y.greaterThan(1.22), shirt, skin);
    return select(limb.equal(0), shirt, select(limb.equal(1), skin, select(limb.lessThan(3.5), legC,
      select(limb.lessThan(5.5), armC, vec3(0.05, 0.04, 0.035)))));
  })();
  return m;
}

// Soft round puffs for smoke, sparks and flames: per-instance opacity from an attribute.
export function puffMaterial(alphaAttr, map, additive) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: !additive });
  m.opacityNode = texture(map).a.mul(instancedDynamicBufferAttribute(alphaAttr, "float"));
  return m;
}

// Dashed lane markings: per-vertex distance along the line; the gaps are cut out.
export function dashMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0xd8d6cc, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  m.opacityNode = step(fract(attribute("aDash", "float").div(7)), 0.45);
  m.alphaTest = 0.5;
  return m;
}
