// Night Shift physics checks. Run: node --test web/test/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  Body, collide, resolve, collideWalls, circleContact, drive, coast,
  Ragdoll, standingPose, vehicleBoxes, REST, NJ, PELVIS, HEAD, NECK, LFT, RFT,
} from "../src/physics.js";

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const momentum = (...bs) => bs.reduce(([x, z], b) => [x + b.mass * b.vx, z + b.mass * b.vz], [0, 0]);
const energy = (...bs) => bs.reduce((e, b) => e + 0.5 * b.mass * (b.vx ** 2 + b.vz ** 2) + 0.5 * b.inertia * b.w ** 2, 0);
const yawEast = Math.PI / 2; // heading +x

test("boxes apart do not collide; overlapping ones give the normal from a to b", () => {
  const a = new Body({ x: 0, yaw: yawEast }), b = new Body({ x: 5, yaw: yawEast });
  assert.equal(collide(a, b), null);
  b.x = 4.4;
  const c = collide(a, b);
  assert.ok(c);
  close(c.nx, 1, 1e-6, "normal x"); close(c.nz, 0, 1e-6, "normal z");
  close(c.depth, 0.2, 1e-6, "overlap");
  close(c.px, 2.1, 0.11, "contact on b's rear face");
});

test("a collision conserves momentum and loses energy", () => {
  const a = new Body({ x: 0, yaw: yawEast, vx: 12 }), b = new Body({ x: 4.5, z: 0.6, yaw: yawEast + 0.3, mass: 2800, hl: 3.3, hw: 1.15 });
  const p0 = momentum(a, b), e0 = energy(a, b);
  const c = collide(a, b);
  assert.ok(c);
  const j = resolve(a, b, c);
  assert.ok(j > 0, "an impulse was exchanged");
  const p1 = momentum(a, b);
  close(p1[0], p0[0], 1e-6 * Math.abs(p0[0]) + 1e-6, "momentum x");
  close(p1[1], p0[1], 1e-6, "momentum z");
  assert.ok(energy(a, b) < e0, "energy dissipated");
  assert.ok(b.vx > 0, "the van is shoved forward");
  assert.ok(Math.abs(b.w) > 0.01, "an off-centre hit spins it");
});

test("an immovable box stops a car and is not moved", () => {
  const car = new Body({ x: 0, yaw: yawEast, vx: 10 }), wall = new Body({ x: 4.5, yaw: yawEast, kinematic: true });
  resolve(car, wall, collide(car, wall));
  assert.ok(car.vx < 0.5, "car stopped or bounced");
  assert.equal(wall.x, 4.5);
});

test("walls from a raster: the car stops at the wall and slides along it", () => {
  const solid = (x) => x > 10; // a wall along x = 10
  const car = new Body({ x: 0, z: 0, yaw: yawEast - 0.5, vx: 14 * Math.sin(yawEast - 0.5), vz: 14 * Math.cos(yawEast - 0.5) });
  let hit = 0;
  for (let i = 0; i < 240; i++) {
    car.integrate(1 / 60);
    hit = Math.max(hit, collideWalls(car, solid).j);
    for (const [x] of car.corners()) assert.ok(x < 10.7, `corner through the wall at step ${i}: ${x}`);
  }
  assert.ok(hit > 1000, "a hard hit was reported");
  assert.ok(car.vx < 2, "no longer driving into the wall");
  assert.ok(Math.abs(car.vz) > 2, "kept sliding along it");
  assert.ok(Number.isFinite(car.x + car.z + car.yaw + car.w));
});

test("a post in front of the car is a contact; one beside it is not", () => {
  const car = new Body({ yaw: yawEast });
  assert.ok(circleContact(car, 2.4, 0, 0.3));
  assert.equal(circleContact(car, 2.4, 3, 0.3), null);
  const c = circleContact(car, 2.4, 0, 0.3);
  assert.ok(c.nx < -0.9, "pushes the car back");
});

test("driving: reaches top speed, turns, and recovers from a spin", () => {
  const P = { accel: 4.2, vmax: 16.7, turn: 1.9, grip: 24 };
  const car = new Body({ yaw: 0 });
  for (let i = 0; i < 60 * 8; i++) { drive(car, { throttle: 1 }, P, 1 / 60); car.integrate(1 / 60); }
  close(car.speed(), 16.7, 0.05, "top speed");
  const yaw0 = car.yaw;
  for (let i = 0; i < 60; i++) { drive(car, { throttle: 1, steer: 1 }, P, 1 / 60); car.integrate(1 / 60); }
  assert.ok(car.yaw - yaw0 > 0.6, "turned left");
  car.w = 4; car.vx += 5; // a shove from a crash
  for (let i = 0; i < 90; i++) { drive(car, {}, P, 1 / 60); car.integrate(1 / 60); }
  assert.ok(Math.abs(car.w) < 0.2, "spin died away");
  const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
  assert.ok(Math.abs(car.vx * fz - car.vz * fx) < 0.3, "sideways slide scrubbed off");
});

test("a wreck coasts to a stop", () => {
  const w = new Body({ vx: 8, vz: 3, w: 2 });
  for (let i = 0; i < 600; i++) { coast(w, 1 / 60); w.integrate(1 / 60); }
  assert.ok(w.speed() < 1e-6 && Math.abs(w.w) < 1e-6);
});

const ground = (rd) => { let m = Infinity; for (let i = 1; i < rd.p.length; i += 3) m = Math.min(m, rd.p[i]); return m; };
const dist = (rd, a, b) => Math.hypot(rd.p[a * 3] - rd.p[b * 3], rd.p[a * 3 + 1] - rd.p[b * 3 + 1], rd.p[a * 3 + 2] - rd.p[b * 3 + 2]);

test("the standing pose matches the rest proportions", () => {
  const p = standingPose(10, 20, 0.7);
  assert.equal(p.length, NJ * 3);
  close(p[PELVIS * 3 + 1], REST[PELVIS][1], 1e-6, "pelvis height");
  close(Math.hypot(p[PELVIS * 3] - 10, p[PELVIS * 3 + 2] - 20), 0, 1e-6, "pelvis over the spot");
});

test("a nudged body topples, keeps its shape and comes to rest on the ground", () => {
  const rd = new Ragdoll(standingPose(0, 0, 0));
  rd.kick(0, 0, 1.2, 1 / 120);
  for (let i = 0; i < 120 * 4; i++) rd.step(1 / 120);
  assert.ok(rd.p[HEAD * 3 + 1] < 0.6, "fell over");
  assert.ok(ground(rd) > 0.03, "nothing sank into the ground");
  assert.ok(rd.still > 0.5, "at rest");
  close(dist(rd, HEAD, NECK), 0.18, 0.04, "neck length kept");
  close(dist(rd, NECK, PELVIS), 0.51, 0.05, "spine length kept");
});

function hit(shape, speed) {
  const car = new Body({ x: -2.7 - shape.hl, yaw: yawEast, vx: speed, hl: shape.hl, hw: shape.hw });
  const rd = new Ragdoll(standingPose(0, 0, 0)); // facing +z: struck from the side
  let maxY = 0, maxHead = 0, push = 0, peakPush = 0, t = 0;
  for (let i = 0; i < 120 * 3; i++, t += 1 / 120) {
    car.x += car.vx / 120;
    if (t > 0.5) car.vx = Math.max(0, car.vx - 7 / 120); // brakes after the hit
    push += rd.step(1 / 120, { boxes: vehicleBoxes(car, shape) })[0];
    peakPush = Math.max(peakPush, push);
    maxY = Math.max(maxY, rd.p[PELVIS * 3 + 1]);
    maxHead = Math.max(maxHead, rd.p[HEAD * 3 + 1]);
  }
  return { rd, car, maxY, maxHead, peakPush };
}

test("a car at 40 km/h folds a body onto its bonnet and carries it ahead", () => {
  const shape = { hl: 2.3, hw: 0.95, cabin: 1.4, bonnet: 0.85, roof: 1.4 };
  const { rd, car, peakPush } = hit(shape, 11);
  assert.ok(peakPush > 300, `the car gave the body momentum (${peakPush.toFixed(0)} kg·m/s)`);
  assert.ok(peakPush < 70 * 18, "no more than the body could take");
  assert.ok(rd.p[PELVIS * 3] > car.x + 1, "carried ahead of the car's centre");
  assert.ok(rd.p[HEAD * 3 + 1] < 1.25, "no longer standing");
  assert.ok(ground(rd) > 0.02);
  for (let i = 0; i < rd.p.length; i++) assert.ok(Number.isFinite(rd.p[i]));
  // nothing is left inside the bonnet
  for (let i = 0; i < NJ; i++) {
    const [la, ls] = car.toLocal(rd.p[i * 3], rd.p[i * 3 + 2]);
    assert.ok(!(Math.abs(la) < car.hl - 0.15 && Math.abs(ls) < car.hw - 0.15 && rd.p[i * 3 + 1] < shape.bonnet - 0.15), `joint ${i} inside the car`);
  }
});

test("at 60 km/h the body goes up onto the bonnet", () => {
  const { maxHead, rd } = hit({ hl: 2.3, hw: 0.95, cabin: 1.4, bonnet: 0.85, roof: 1.4 }, 16.7);
  assert.ok(maxHead > 0.9 || rd.p[HEAD * 3 + 1] > 0.9, "head reached bonnet height");
});

test("a van's flat front pushes a body ahead instead of under or over", () => {
  const { rd, car, maxY } = hit({ hl: 3.3, hw: 1.15, roof: 2.35 }, 9);
  void LFT; void RFT;
  assert.ok(maxY < 2.0, `not thrown onto the roof (${maxY.toFixed(2)} m)`);
  assert.ok(rd.p[PELVIS * 3] > car.x + 3.3 - 0.5, "ended in front of the van, not inside it");
});
