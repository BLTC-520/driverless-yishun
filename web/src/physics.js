/* Night Shift physics: small, dependency-free, and testable in Node (web/test/physics.test.mjs).
   Vehicles are boxes sliding on the ground plane: position (x, z), heading yaw, velocity and spin.
   They collide by the separating-axis test and exchange impulses at the contact point, so a
   glancing blow spins a car and a square hit stops it. Walls come from the game's raster of
   buildings and water. People who are hit become Verlet ragdolls: fifteen points held by distance
   constraints and thrown by the vehicle's own shape, so a body folds over a low bonnet and is
   pushed ahead by the flat front of a van or bus.
   Coordinates follow the game: x east, z south, y up; heading yaw points along (sin yaw, cos yaw)
   and the side axis is (cos yaw, -sin yaw). */

export const GRAV = 9.81;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------- rigid boxes
export class Body {
  constructor(o = {}) {
    this.x = 0; this.z = 0; this.yaw = 0; this.vx = 0; this.vz = 0; this.w = 0;
    this.hl = 2.3; this.hw = 1.0;   // half length, half width (m)
    this.mass = 1500;
    this.e = 0.25;                   // restitution
    this.mu = 0.5;                   // friction along a contact
    this.kinematic = false;          // moved by its own rules; immovable in a collision
    Object.assign(this, o);
    this.setMass(this.mass);
  }
  setMass(m) { this.mass = m; this.inertia = (m * 4 * (this.hl * this.hl + this.hw * this.hw)) / 12; }
  get invM() { return this.kinematic ? 0 : 1 / this.mass; }
  get invI() { return this.kinematic ? 0 : 1 / this.inertia; }
  speed() { return Math.hypot(this.vx, this.vz); }
  // velocity of the point at offset (rx, rz) from the centre
  pointVel(rx, rz) { return [this.vx + this.w * rz, this.vz - this.w * rx]; }
  applyImpulse(px, pz, rx, rz) {
    if (this.kinematic) return;
    this.vx += px / this.mass; this.vz += pz / this.mass;
    this.w += (rz * px - rx * pz) / this.inertia;
  }
  integrate(dt) { this.x += this.vx * dt; this.z += this.vz * dt; this.yaw += this.w * dt; }
  // world corners, front-left first, going round
  corners() {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), sx = Math.cos(this.yaw), sz = -Math.sin(this.yaw);
    const out = [];
    for (const [a, c] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) out.push([this.x + fx * this.hl * a + sx * this.hw * c, this.z + fz * this.hl * a + sz * this.hw * c]);
    return out;
  }
  // body-frame coordinates (along, side) of a world point
  toLocal(x, z) {
    const dx = x - this.x, dz = z - this.z, s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    return [dx * s + dz * c, dx * c - dz * s];
  }
}

// Separating-axis test between two boxes. Returns the contact normal (pointing from a to b), the
// overlap and a contact point, or null when they do not touch.
export function collide(a, b) {
  const sa = Math.sin(a.yaw), ca = Math.cos(a.yaw), sb = Math.sin(b.yaw), cb = Math.cos(b.yaw);
  const axes = [[sa, ca], [ca, -sa], [sb, cb], [cb, -sb]];
  const dx = b.x - a.x, dz = b.z - a.z;
  let best = Infinity, nx = 0, nz = 0, fromA = true;
  for (let k = 0; k < 4; k++) {
    const [ax, az] = axes[k];
    const ra = a.hl * Math.abs(sa * ax + ca * az) + a.hw * Math.abs(ca * ax - sa * az);
    const rb = b.hl * Math.abs(sb * ax + cb * az) + b.hw * Math.abs(cb * ax - sb * az);
    const d = dx * ax + dz * az, o = ra + rb - Math.abs(d);
    if (o <= 0) return null;
    if (o < best * (k < 2 ? 1 : 0.98)) { best = o; nx = d < 0 ? -ax : ax; nz = d < 0 ? -az : az; fromA = k < 2; }
  }
  // the incident box's corner(s) reaching deepest across the reference face
  const inc = fromA ? b.corners() : a.corners(), sign = fromA ? 1 : -1;
  let ext = Infinity;
  for (const [x, z] of inc) ext = Math.min(ext, sign * (x * nx + z * nz));
  let px = 0, pz = 0, n = 0;
  for (const [x, z] of inc) if (sign * (x * nx + z * nz) < ext + 0.08) { px += x; pz += z; n++; }
  return { nx, nz, depth: best, px: px / n, pz: pz / n };
}

// Exchange the impulse for a contact between two bodies; returns its size (N·s).
export function resolve(a, b, c) {
  const ia = a.invM, ib = b.invM;
  if (ia + ib === 0) return 0;
  const { nx, nz, px, pz } = c;
  const corr = (Math.max(0, c.depth - 0.01) * 0.9) / (ia + ib);
  a.x -= nx * corr * ia; a.z -= nz * corr * ia;
  b.x += nx * corr * ib; b.z += nz * corr * ib;
  const rax = px - a.x, raz = pz - a.z, rbx = px - b.x, rbz = pz - b.z;
  const [vax, vaz] = a.pointVel(rax, raz), [vbx, vbz] = b.pointVel(rbx, rbz);
  const rvx = vbx - vax, rvz = vbz - vaz, vn = rvx * nx + rvz * nz;
  if (vn >= 0) return 0;
  const can = raz * nx - rax * nz, cbn = rbz * nx - rbx * nz;
  const kn = ia + ib + can * can * a.invI + cbn * cbn * b.invI;
  const j = (-(1 + (a.e + b.e) / 2) * vn) / kn;
  const tx = -nz, tz = nx, vt = rvx * tx + rvz * tz;
  const cat = raz * tx - rax * tz, cbt = rbz * tx - rbx * tz;
  const kt = ia + ib + cat * cat * a.invI + cbt * cbt * b.invI;
  const mu = Math.sqrt(a.mu * b.mu), jt = clamp(-vt / kt, -mu * j, mu * j);
  const Px = j * nx + jt * tx, Pz = j * nz + jt * tz;
  a.applyImpulse(-Px, -Pz, rax, raz);
  b.applyImpulse(Px, Pz, rbx, rbz);
  return j;
}

// A contact with something that does not move (a wall, a tree): n points out of it, toward the body.
export function resolveStatic(b, px, pz, nx, nz, depth, e = 0.15, mu = 0.35) {
  b.x += nx * depth; b.z += nz * depth;
  const rx = px - b.x, rz = pz - b.z;
  const [vx, vz] = b.pointVel(rx, rz);
  const vn = vx * nx + vz * nz;
  if (vn >= 0) return 0;
  const cn = rz * nx - rx * nz, kn = b.invM + cn * cn * b.invI;
  const j = (-(1 + e) * vn) / kn;
  const tx = -nz, tz = nx, vt = vx * tx + vz * tz, ct = rz * tx - rx * tz;
  const jt = clamp(-vt / (b.invM + ct * ct * b.invI), -mu * j, mu * j);
  b.applyImpulse(j * nx + jt * tx, j * nz + jt * tz, rx, rz);
  return j;
}

// The direction out of a wall at (x, z), from which of eight neighbours 3 m away are free.
export function wallNormal(solid, x, z, cx, cz) {
  let nx = 0, nz = 0;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4, dx = Math.cos(a), dz = Math.sin(a);
    if (!solid(x + dx * 3, z + dz * 3)) { nx += dx; nz += dz; }
  }
  let l = Math.hypot(nx, nz);
  if (l < 1e-3) { nx = cx - x; nz = cz - z; l = Math.hypot(nx, nz) || 1; } // deep inside: back toward the body
  return [nx / l, nz / l];
}

// Keep a body out of walls: its corners and mid-sides are tested against `solid(x, z)`.
// Returns the largest impulse and where it landed, for damage and sparks.
const PROBES = [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0.5, 1], [0.5, -1], [-0.5, 1], [-0.5, -1]];
export function collideWalls(b, solid) {
  const hit = { j: 0, x: 0, z: 0, nx: 0, nz: 0 };
  if (solid(b.x, b.z)) return hit; // already inside (a spawn or a squeeze): let it drive out
  for (const [a, c] of PROBES) {
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), sx = Math.cos(b.yaw), sz = -Math.sin(b.yaw);
    const px = b.x + fx * b.hl * a + sx * b.hw * c, pz = b.z + fz * b.hl * a + sz * b.hw * c;
    if (!solid(px, pz)) continue;
    const [nx, nz] = wallNormal(solid, px, pz, b.x, b.z);
    let d = 0.05;
    while (d < 2.5 && solid(px + nx * d, pz + nz * d)) d += 0.2;
    const j = resolveStatic(b, px, pz, nx, nz, Math.min(d, 0.6));
    if (j > hit.j) Object.assign(hit, { j, x: px, z: pz, nx, nz });
  }
  return hit;
}

// A round post or trunk of radius r at (cx, cz) against a body: the contact, or null.
export function circleContact(b, cx, cz, r) {
  const [la, ls] = b.toLocal(cx, cz);
  const qa = clamp(la, -b.hl, b.hl), qs = clamp(ls, -b.hw, b.hw);
  const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), sx = Math.cos(b.yaw), sz = -Math.sin(b.yaw);
  const qx = b.x + fx * qa + sx * qs, qz = b.z + fz * qa + sz * qs;
  let nx = qx - cx, nz = qz - cz, d = Math.hypot(nx, nz);
  if (d >= r) return null;
  if (d < 1e-4) { // centre inside the box: out through the nearest face
    const ea = b.hl - Math.abs(la), es = b.hw - Math.abs(ls);
    if (ea < es) { nx = -fx * Math.sign(la || 1); nz = -fz * Math.sign(la || 1); d = -ea; } else { nx = -sx * Math.sign(ls || 1); nz = -sz * Math.sign(ls || 1); d = -es; }
    return { nx, nz, depth: r - d, px: cx, pz: cz };
  }
  return { nx: nx / d, nz: nz / d, depth: r - d, px: qx, pz: qz };
}

// ---------------------------------------------------------------- driving
// Arcade tyres: throttle and brakes act along the heading, the tyres scrub off sideways sliding up
// to a grip limit, and the yaw rate eases toward what the steering asks for. A collision's spin and
// sideways shove therefore fade as the tyres bite again; the handbrake lets the tail slide.
// inp: { throttle, brake, steer (-1 right .. 1 left), handbrake }; P: { accel, vmax, turn, grip, pull }
export function drive(b, inp, P, dt) {
  const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), sx = Math.cos(b.yaw), sz = -Math.sin(b.yaw);
  let vf = b.vx * fx + b.vz * fz, vs = b.vx * sx + b.vz * sz;
  if (inp.throttle) vf += P.accel * dt * (vf < 0 ? 2.2 : 1);
  if (inp.brake) vf -= (vf > 0.3 ? 9 : P.accel * 0.6) * dt;
  if (!inp.throttle && !inp.brake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 1.6 * dt);
  if (inp.handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 4 * dt);
  if (vf > P.vmax) vf = Math.max(P.vmax, vf - 6 * dt);
  vf = Math.max(-4, vf);
  const lat = P.grip * (inp.handbrake ? 0.28 : 1) * dt;
  const slide = vs;
  vs -= clamp(vs, -lat, lat);
  const sp = Math.abs(vf), turnGrip = Math.min(1, sp / 5) * (1 - 0.35 * Math.min(1, sp / P.vmax));
  const want = clamp((inp.steer || 0) + (P.pull || 0), -1, 1) * P.turn * turnGrip * Math.sign(vf) * (inp.handbrake ? 1.6 : 1);
  const yawAcc = (inp.handbrake ? 3 : 9) / (1 + Math.abs(vs) / 3);
  b.w += clamp(want - b.w, -yawAcc * dt, yawAcc * dt);
  b.vx = fx * vf + sx * vs; b.vz = fz * vf + sz * vs;
  return { vf, slide };
}

// A vehicle nobody is driving (a wreck): it rolls on along its heading, scrubs off sideways
// sliding fast, and its spin dies away.
export function coast(b, dt, roll = 2.5, scrub = 8, spin = 4) {
  const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), sx = Math.cos(b.yaw), sz = -Math.sin(b.yaw);
  let vf = b.vx * fx + b.vz * fz, vs = b.vx * sx + b.vz * sz;
  vf -= clamp(vf, -roll * dt, roll * dt);
  vs -= clamp(vs, -scrub * dt, scrub * dt);
  b.vx = fx * vf + sx * vs; b.vz = fz * vf + sz * vs;
  b.w -= clamp(b.w, -spin * dt, spin * dt);
}

// ---------------------------------------------------------------- ragdolls
export const HEAD = 0, NECK = 1, PELVIS = 2, LSH = 3, RSH = 4, LEL = 5, REL = 6, LHA = 7, RHA = 8,
  LHIP = 9, RHIP = 10, LKN = 11, RKN = 12, LFT = 13, RFT = 14, NJ = 15;
// Standing pose in the person's frame: x to the side, y up, z forward. The game's walkers are drawn
// with the same proportions, so a walker becomes a ragdoll without a jump.
export const REST = [
  [0, 1.62, 0], [0, 1.44, 0], [0, 0.93, 0],
  [0.21, 1.42, 0], [-0.21, 1.42, 0], [0.25, 1.13, 0], [-0.25, 1.13, 0], [0.26, 0.84, 0.03], [-0.26, 0.84, 0.03],
  [0.1, 0.9, 0], [-0.1, 0.9, 0], [0.1, 0.48, 0.02], [-0.1, 0.48, 0.02], [0.1, 0.07, 0.03], [-0.1, 0.07, 0.03],
];
export const HIP_Y = 0.9, SHOULDER_Y = 1.42; // the walk cycle swings legs and arms about these heights
const RADIUS = [0.13, 0.08, 0.1, 0.07, 0.07, 0.05, 0.05, 0.05, 0.05, 0.07, 0.07, 0.06, 0.06, 0.06, 0.06];
const torso = [NECK, PELVIS, LSH, RSH, LHIP, RHIP];
const LINKS = [];
for (let i = 0; i < torso.length; i++) for (let k = i + 1; k < torso.length; k++) LINKS.push([torso[i], torso[k], 1]);
LINKS.push([HEAD, NECK, 1], [HEAD, LSH, 0.8], [HEAD, RSH, 0.8],
  [LSH, LEL, 1], [LEL, LHA, 1], [RSH, REL, 1], [REL, RHA, 1],
  [LHIP, LKN, 1], [LKN, LFT, 1], [RHIP, RKN, 1], [RKN, RFT, 1]);
// minimum distances: elbows and knees cannot fold flat, the head stays off the hips, feet stay apart
const MINS = [[LSH, LHA, 0.3], [RSH, RHA, 0.3], [LHIP, LFT, 0.55], [RHIP, RFT, 0.55], [HEAD, PELVIS, 0.62],
  [LKN, RKN, 0.12], [LFT, RFT, 0.12], [LHA, RHA, 0.1], [HEAD, LHA, 0.15], [HEAD, RHA, 0.15]];
const restLen = (a, b) => Math.hypot(REST[a][0] - REST[b][0], REST[a][1] - REST[b][1], REST[a][2] - REST[b][2]);
for (const l of LINKS) l.push(restLen(l[0], l[1]));
export const PERSON_KG = 70;
const VMAX = 22; // m/s
const PART_KG = PERSON_KG / NJ;

// The walking pose: legs and arms swung about the hips and shoulders, then turned to face yaw.
export function standingPose(x, z, yaw, swing = 0, out = new Float32Array(NJ * 3)) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (let i = 0; i < NJ; i++) {
    let [px, py, pz] = REST[i];
    const leg = i === LKN || i === LFT ? 1 : i === RKN || i === RFT ? -1 : 0;
    const arm = i === LEL || i === LHA ? -0.8 : i === REL || i === RHA ? 0.8 : 0;
    const a = (leg || arm) * swing, pivot = leg ? HIP_Y : SHOULDER_Y;
    if (a) { const dy = py - pivot; [py, pz] = [pivot + dy * Math.cos(a) - pz * Math.sin(a), dy * Math.sin(a) + pz * Math.cos(a)]; }
    out[i * 3] = x + px * c + pz * s; out[i * 3 + 1] = py; out[i * 3 + 2] = z - px * s + pz * c;
  }
  return out;
}

export class Ragdoll {
  constructor(pose) {
    this.p = Float32Array.from(pose);   // positions
    this.q = Float32Array.from(pose);   // positions a step ago (Verlet)
    this.still = 0;                      // seconds spent nearly motionless
    this.age = 0;
    this.peak = 0;                       // fastest the body has moved (m/s), for how hard it was hit
  }
  // Give every point a velocity (m/s), e.g. from a shove.
  kick(vx, vy, vz, dt) { for (let i = 0; i < NJ; i++) { this.q[i * 3] -= vx * dt; this.q[i * 3 + 1] -= vy * dt; this.q[i * 3 + 2] -= vz * dt; } }
  pelvis() { return [this.p[PELVIS * 3], this.p[PELVIS * 3 + 1], this.p[PELVIS * 3 + 2]]; }
  // One step. env: { boxes: vehicle shapes (see collideBoxes), solid(x, z) for walls }.
  // Returns the momentum the vehicles gave the body, so the game can take it off them.
  step(dt, env = {}) {
    const p = this.p, q = this.q, g = GRAV * dt * dt;
    let vmax = 0;
    for (let i = 0; i < NJ * 3; i += 3) {
      const vx = (p[i] - q[i]) * 0.998, vy = (p[i + 1] - q[i + 1]) * 0.998, vz = (p[i + 2] - q[i + 2]) * 0.998;
      q[i] = p[i]; q[i + 1] = p[i + 1]; q[i + 2] = p[i + 2];
      p[i] += vx; p[i + 1] += vy - g; p[i + 2] += vz;
    }
    const push = [0, 0];
    for (let it = 0; it < 8; it++) {
      for (const [a, b, k, L] of LINKS) this.link(a, b, L, k, false);
      for (const [a, b, L] of MINS) this.link(a, b, L, 1, true);
      if (env.boxes) this.collideBoxes(env.boxes, dt, push);
      this.ground();
    }
    if (env.solid) for (let i = 0; i < NJ * 3; i += 3) if (p[i + 1] < 8 && env.solid(p[i], p[i + 2])) { p[i] = q[i]; p[i + 2] = q[i + 2]; }
    for (let i = 0; i < NJ * 3; i += 3) {
      if (!Number.isFinite(p[i] + p[i + 1] + p[i + 2])) { p[i] = q[i]; p[i + 1] = Math.max(0.1, q[i + 1]); p[i + 2] = q[i + 2]; }
      let v = Math.hypot(p[i] - q[i], p[i + 1] - q[i + 1], p[i + 2] - q[i + 2]) / dt;
      if (v > VMAX) { // a joint whipped out by the constraints: no faster than a body can be thrown
        const k = VMAX / v;
        q[i] = p[i] - (p[i] - q[i]) * k; q[i + 1] = p[i + 1] - (p[i + 1] - q[i + 1]) * k; q[i + 2] = p[i + 2] - (p[i + 2] - q[i + 2]) * k; v = VMAX;
      }
      vmax = Math.max(vmax, v);
    }
    this.peak = Math.max(this.peak, vmax);
    this.still = vmax < 0.35 ? this.still + dt : 0;
    this.age += dt;
    return push;
  }
  link(a, b, L, k, minOnly) {
    const p = this.p, ia = a * 3, ib = b * 3;
    const dx = p[ib] - p[ia], dy = p[ib + 1] - p[ia + 1], dz = p[ib + 2] - p[ia + 2];
    const d = Math.hypot(dx, dy, dz) || 1e-6;
    if (minOnly && d >= L) return;
    const f = ((d - L) / d) * 0.5 * k;
    p[ia] += dx * f; p[ia + 1] += dy * f; p[ia + 2] += dz * f;
    p[ib] -= dx * f; p[ib + 1] -= dy * f; p[ib + 2] -= dz * f;
  }
  ground() {
    const p = this.p, q = this.q;
    for (let i = 0; i < NJ; i++) {
      const j = i * 3, r = RADIUS[i];
      if (p[j + 1] >= r) continue;
      const vy = p[j + 1] - q[j + 1];
      p[j + 1] = r; q[j + 1] = r + vy * 0.3;                         // a little bounce
      q[j] = p[j] - (p[j] - q[j]) * 0.86; q[j + 2] = p[j + 2] - (p[j + 2] - q[j + 2]) * 0.86; // and scraping along
    }
  }
  // Vehicle shapes as boxes { x, z, yaw, hl, hw, y0, y1, vx, vz, w, cx, cz } (cx, cz: the centre the
  // vehicle spins about): a point inside is pushed out through the nearest face and takes on the
  // vehicle's speed there.
  collideBoxes(boxes, dt, push) {
    const p = this.p, q = this.q;
    for (const B of boxes) {
      const s = Math.sin(B.yaw), c = Math.cos(B.yaw);
      for (let i = 0; i < NJ; i++) {
        const j = i * 3, r = RADIUS[i];
        const dx = p[j] - B.x, dz = p[j + 2] - B.z, y = p[j + 1];
        const la = dx * s + dz * c, ls = dx * c - dz * s;
        if (Math.abs(la) > B.hl + r || Math.abs(ls) > B.hw + r || y > B.y1 + r || y < B.y0 - r) continue;
        const pen = [B.hl + r - la, B.hl + r + la, B.hw + r - ls, B.hw + r + ls, B.y1 + r - y];
        let m = 0; for (let k = 1; k < 5; k++) if (pen[k] < pen[m]) m = k;
        let nx = 0, ny = 0, nz = 0;
        if (m === 0) { nx = s; nz = c; } else if (m === 1) { nx = -s; nz = -c; } else if (m === 2) { nx = c; nz = -s; } else if (m === 3) { nx = -c; nz = s; } else ny = 1;
        const ox = (p[j] - q[j]) / dt, oz = (p[j + 2] - q[j + 2]) / dt;
        p[j] += nx * pen[m]; p[j + 1] += ny * pen[m]; p[j + 2] += nz * pen[m];
        // the vehicle's surface velocity at this point
        const ux = B.vx + B.w * (p[j + 2] - B.cz), uz = B.vz - B.w * (p[j] - B.cx);
        let vx = (p[j] - q[j]) / dt, vy = (p[j + 1] - q[j + 1]) / dt, vz = (p[j + 2] - q[j + 2]) / dt;
        const un = ux * nx + uz * nz, vn = vx * nx + vy * ny + vz * nz;
        if (vn < un) { const dv = (un - vn) * 1.25; vx += nx * dv; vy += ny * dv; vz += nz * dv; }
        const fr = ny ? 0.25 : 0.12; // a bonnet carries a body along; a bumper mostly shoves
        vx += (ux - vx) * fr; vz += (uz - vz) * fr;
        q[j] = p[j] - vx * dt; q[j + 1] = p[j + 1] - vy * dt; q[j + 2] = p[j + 2] - vz * dt;
        push[0] += (vx - ox) * PART_KG; push[1] += (vz - oz) * PART_KG;
      }
    }
  }
}

// The shapes a vehicle presents to a body, from its rigid box: a car is a low bonnet with a cabin
// set back, so a body folds onto it; a van or bus is one tall box with a flat front.
export function vehicleBoxes(b, shape) {
  const base = { x: b.x, z: b.z, yaw: b.yaw, hw: b.hw, vx: b.vx, vz: b.vz, w: b.w, cx: b.x, cz: b.z };
  if (!shape.cabin) return [{ ...base, hl: b.hl, y0: 0.15, y1: shape.roof }];
  const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), back = shape.cabin; // cabin starts this far behind the nose
  const chl = (2 * b.hl - back) / 2, off = -b.hl + chl;              // cabin centre, along the heading
  return [
    { ...base, hl: b.hl, y0: 0.15, y1: shape.bonnet },
    { ...base, x: b.x + fx * off, z: b.z + fz * off, hl: chl, hw: b.hw * 0.92, y0: shape.bonnet, y1: shape.roof },
  ];
}
