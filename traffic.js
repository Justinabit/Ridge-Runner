import * as THREE from 'three';
import { sampleRoadFrame } from './roadgen.js';
import { hash1 } from './noise.js';

/* Traffic.
 *
 * The obstacle used to be a static rock, barrel or oil slick sitting on the
 * road, sampled once at a fixed arc length and never moving. The goal now is
 * "go as far as you can while avoiding traffic", so the obstacle itself has
 * to move: each vehicle has its own arc-length position that advances every
 * frame, in one of two directions —
 *
 *   - SAME-DIRECTION traffic drives the same way the player does, slower
 *     than a typical cruising speed, so the player gains on it and has to
 *     find a way past. It keeps mostly to the +right half of the road.
 *   - ONCOMING traffic drives the other way, so it closes on the player far
 *     faster than its own speed alone suggests. It keeps mostly to the
 *     -right half, i.e. the other lane.
 *
 * Placement still starts from a deterministic slot sequence indexed by arc
 * length, exactly like the old hazards did — kind, direction, speed and lane
 * are all pure functions of the slot index, so two players see the same
 * traffic in the same places. What's new is that once a slot is spawned its
 * vehicle is simulated forward in time rather than staying parked at its
 * spawn point, which is why active vehicles are tracked in a Map keyed by
 * slot index rather than rebuilt from the index alone every frame. */

export const TRAFFIC = { CAR: 'CAR', TRUCK: 'TRUCK', BIKE: 'BIKE' };

const BASE_SPACING = 210;      // metres of (initial) road between slots at the start
const MIN_SPACING = 78;        // tightest spacing once fully ramped
const RAMP_DISTANCE = 3500;
const FIRST_TRAFFIC_S = 260;   // grace period before any traffic appears

/* A slot's spawn point only has to come within this range ahead of the car to
 * spawn a vehicle; once spawned, the vehicle's own arc length is what decides
 * when it despawns (LIVE_WINDOW_*), because by then it has moved. */
const SPAWN_WINDOW_AHEAD = 560;
const LIVE_WINDOW_AHEAD = 950;
const LIVE_WINDOW_BEHIND = 150;

/* Fraction of slots that drive toward the player rather than with it. Kept
 * a little under half: oncoming traffic is the scarier of the two because
 * closing speed stacks, so it should be the spicier minority, not the norm. */
const ONCOMING_CHANCE = 0.38;

const HIT_RADIUS = { CAR: 2.0, TRUCK: 2.7, BIKE: 1.35 };
const LIFT = { CAR: 0.5, TRUCK: 0.78, BIKE: 0.35 };

export const CAR_DAMAGE = 24;
export const TRUCK_DAMAGE = 38;
export const BIKE_DAMAGE = 15;
const DAMAGE = { CAR: CAR_DAMAGE, TRUCK: TRUCK_DAMAGE, BIKE: BIKE_DAMAGE };

/* Speed ranges (m/s), separate for driving with the player's flow versus
 * against it. Same-direction traffic is deliberately slower than a typical
 * cruise so the player is always gaining on somebody; oncoming traffic is a
 * touch faster because the player only sees it, never chases it. */
const SPEED_RANGE = {
  CAR: { with: [9, 15], against: [10, 16] },
  TRUCK: { with: [7, 11], against: [8, 13] },
  BIKE: { with: [14, 21], against: [15, 22] },
};

/* ---------------------------------------------------------------------------
 * Geometry & materials — built once and shared. Colour variety comes from a
 * small palette of pre-built materials rather than per-vehicle materials, so
 * spawning traffic never allocates a shader.
 * ------------------------------------------------------------------------ */
function lambert(hex) { return new THREE.MeshLambertMaterial({ color: hex, flatShading: true }); }

const CAR_PALETTE = [0xd8452f, 0x3d6ad8, 0x39b37a, 0xe0c23d, 0xe8e4d4, 0x2a2233, 0xff8a3d].map(lambert);
const TRUCK_PALETTE = [0xc8c2b0, 0x3d5a80, 0x8a4b2f, 0x556b2f].map(lambert);
const BIKE_PALETTE = [0x1c1720, 0xd8452f, 0x3d6ad8].map(lambert);

const cabinMat = lambert(0x1c1720);
const wheelMat = lambert(0x14101c);
/* Unlit, like the road markings and lamp heads — headlights and tail-lights
 * need to read at a glance regardless of scene lighting, which is exactly
 * what tells the player which way a vehicle is travelling before they're
 * close enough to see its shape clearly. */
const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfff2c9 });
const taillightMat = new THREE.MeshBasicMaterial({ color: 0xff3020 });

const carBodyGeo = new THREE.BoxGeometry(1.55, 0.5, 3.3);
const carCabinGeo = new THREE.BoxGeometry(1.2, 0.42, 1.5);
const truckBodyGeo = new THREE.BoxGeometry(2.05, 0.95, 5.0);
const truckCabGeo = new THREE.BoxGeometry(1.9, 0.7, 1.3);
const bikeBodyGeo = new THREE.BoxGeometry(0.42, 0.42, 1.55);
const bikeRiderGeo = new THREE.BoxGeometry(0.36, 0.55, 0.5);
const lightGeo = new THREE.BoxGeometry(0.16, 0.12, 0.08);

const carWheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.24, 8);
carWheelGeo.rotateZ(Math.PI / 2);
const truckWheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 8);
truckWheelGeo.rotateZ(Math.PI / 2);
const bikeWheelGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.12, 8);
bikeWheelGeo.rotateZ(Math.PI / 2);

/* Local +Z is always "the direction this vehicle is travelling", matching how
 * the orientation is built in placeMesh() below — so headlights sit at +Z and
 * tail-lights at -Z here regardless of which way the slot ends up facing. */
function addWheels(group, geo, positions) {
  for (const [x, y, z] of positions) {
    const w = new THREE.Mesh(geo, wheelMat);
    w.position.set(x, y, z);
    group.add(w);
  }
}

function makeCarMesh(mat) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(carBodyGeo, mat);
  body.position.y = 0.34;
  body.castShadow = true;
  const cabin = new THREE.Mesh(carCabinGeo, cabinMat);
  cabin.position.set(0, 0.34 + 0.25 + 0.21, -0.15);
  cabin.castShadow = true;
  g.add(body, cabin);
  addWheels(g, carWheelGeo, [
    [-0.8, 0.12, 1.05], [0.8, 0.12, 1.05], [-0.8, 0.12, -1.05], [0.8, 0.12, -1.05],
  ]);
  const hlL = new THREE.Mesh(lightGeo, headlightMat); hlL.position.set(-0.55, 0.36, 1.62);
  const hlR = new THREE.Mesh(lightGeo, headlightMat); hlR.position.set(0.55, 0.36, 1.62);
  const tlL = new THREE.Mesh(lightGeo, taillightMat); tlL.position.set(-0.55, 0.36, -1.62);
  const tlR = new THREE.Mesh(lightGeo, taillightMat); tlR.position.set(0.55, 0.36, -1.62);
  g.add(hlL, hlR, tlL, tlR);
  return g;
}

function makeTruckMesh(mat) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(truckBodyGeo, mat);
  body.position.set(0, 0.62, -0.5);
  body.castShadow = true;
  const cab = new THREE.Mesh(truckCabGeo, cabinMat);
  cab.position.set(0, 0.72, 2.1);
  cab.castShadow = true;
  g.add(body, cab);
  addWheels(g, truckWheelGeo, [
    [-1.0, 0.16, 1.6], [1.0, 0.16, 1.6],
    [-1.0, 0.16, -0.6], [1.0, 0.16, -0.6],
    [-1.0, 0.16, -1.9], [1.0, 0.16, -1.9],
  ]);
  const hlL = new THREE.Mesh(lightGeo, headlightMat); hlL.position.set(-0.7, 0.55, 2.72);
  const hlR = new THREE.Mesh(lightGeo, headlightMat); hlR.position.set(0.7, 0.55, 2.72);
  const tlL = new THREE.Mesh(lightGeo, taillightMat); tlL.position.set(-0.85, 0.5, -3.0);
  const tlR = new THREE.Mesh(lightGeo, taillightMat); tlR.position.set(0.85, 0.5, -3.0);
  g.add(hlL, hlR, tlL, tlR);
  return g;
}

function makeBikeMesh(mat) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(bikeBodyGeo, mat);
  body.position.y = 0.32;
  body.castShadow = true;
  const rider = new THREE.Mesh(bikeRiderGeo, cabinMat);
  rider.position.set(0, 0.62, -0.05);
  rider.castShadow = true;
  g.add(body, rider);
  addWheels(g, bikeWheelGeo, [[0, 0.16, 0.68], [0, 0.16, -0.68]]);
  const hl = new THREE.Mesh(lightGeo, headlightMat); hl.position.set(0, 0.35, 0.82);
  const tl = new THREE.Mesh(lightGeo, taillightMat); tl.position.set(0, 0.35, -0.82);
  g.add(hl, tl);
  return g;
}

function pick(palette, i, salt) {
  return palette[Math.floor(hash1(i * 7.7 + salt) * palette.length) % palette.length];
}

function makeMesh(kind, i) {
  if (kind === TRAFFIC.TRUCK) return makeTruckMesh(pick(TRUCK_PALETTE, i, 3.1));
  if (kind === TRAFFIC.BIKE) return makeBikeMesh(pick(BIKE_PALETTE, i, 6.4));
  return makeCarMesh(pick(CAR_PALETTE, i, 1.7));
}

/* ---------------------------------------------------------------------------
 * Slot sequence — deterministic, exactly like the old hazard slots.
 * ------------------------------------------------------------------------ */
function spacingAt(s) {
  const t = Math.min(1, Math.max(0, s) / RAMP_DISTANCE);
  return BASE_SPACING - (BASE_SPACING - MIN_SPACING) * t;
}

const _sCache = [FIRST_TRAFFIC_S];
function trafficS(i) {
  while (_sCache.length <= i) {
    const prev = _sCache[_sCache.length - 1];
    _sCache.push(prev + spacingAt(prev));
  }
  return _sCache[i];
}

function kindFor(i) {
  const h = hash1(i * 5.13 + 2.9);
  if (h < 0.55) return TRAFFIC.CAR;
  if (h < 0.8) return TRAFFIC.TRUCK;
  return TRAFFIC.BIKE;
}

/** +1 drives with the player, -1 drives toward the player. */
function dirFor(i) {
  return hash1(i * 8.61 + 4.4) < ONCOMING_CHANCE ? -1 : 1;
}

function paramsFor(i) {
  const kind = kindFor(i);
  const dirSign = dirFor(i);
  const range = SPEED_RANGE[kind][dirSign > 0 ? 'with' : 'against'];
  const speed = range[0] + hash1(i * 11.3 + 1.1) * (range[1] - range[0]);
  return { kind, dirSign, speed };
}

/**
 * Lateral offset for slot `i`, scaled to the local half-width. Same-direction
 * traffic keeps mostly to +right, oncoming mostly to -right, each with a
 * little overlap toward the centre so a player who just hugs one edge still
 * has to react to something eventually.
 */
function placementAcross(i, dirSign, halfWidth) {
  const h = hash1(i * 9.41);
  return dirSign > 0 ? (-0.08 + h * 0.92) * halfWidth : (0.08 - h * 0.92) * halfWidth;
}

const _m4 = new THREE.Matrix4();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

export function createTrafficManager(scene) {
  const active = new Map(); // slot index -> live vehicle state
  const group = new THREE.Group();
  scene.add(group);

  function placeMesh(v) {
    const frame = sampleRoadFrame(v.s);
    const pos = frame.center.clone()
      .addScaledVector(frame.right, v.across)
      .addScaledVector(frame.roadUp, v.lift);
    v.mesh.position.copy(pos);

    /* Local +Z always maps to "the way this vehicle is actually driving", so
     * the mesh's headlights/tail-lights automatically point the right way
     * whichever direction the slot turned out to be. */
    _fwd.copy(frame.tangent);
    if (v.dirSign < 0) _fwd.negate();
    _up.copy(frame.roadUp);
    _right.crossVectors(_up, _fwd).normalize();
    _m4.makeBasis(_right, _up, _fwd);
    v.mesh.quaternion.setFromRotationMatrix(_m4);
  }

  function spawn(i) {
    if (i < 0 || active.has(i)) return;
    const s0 = trafficS(i);
    const frame = sampleRoadFrame(s0);
    const { kind, dirSign, speed } = paramsFor(i);
    const across = placementAcross(i, dirSign, frame.halfWidth);
    const mesh = makeMesh(kind, i);
    group.add(mesh);
    const v = { mesh, kind, dirSign, speed, s: s0, across, lift: LIFT[kind], hit: false };
    active.set(i, v);
    placeMesh(v);
  }

  function despawn(i) {
    const v = active.get(i);
    if (!v) return;
    group.remove(v.mesh);
    active.delete(i);
  }

  /**
   * @param {{x:number,y:number,z:number}} carPos world position
   * @param {number} carS the car's arc length along the road
   * @param {number} dt
   * @returns {{impacts: Array<{kind:string, damage:number}>}}
   */
  function update(carPos, carS, dt) {
    // spawn any slot whose ORIGINAL spawn point has entered the ahead window
    let first = 0;
    while (trafficS(first) < carS - LIVE_WINDOW_BEHIND) first++;
    let last = first;
    while (trafficS(last) < carS + SPAWN_WINDOW_AHEAD) last++;
    for (let i = first; i <= last; i++) spawn(i);

    const impacts = [];
    for (const [i, v] of Array.from(active)) {
      // advance the vehicle's own arc length — this is what makes it "traffic"
      // rather than a hazard: its position is live, not the slot's fixed s
      v.s += v.dirSign * v.speed * dt;
      if (v.s < carS - LIVE_WINDOW_BEHIND || v.s > carS + LIVE_WINDOW_AHEAD) {
        despawn(i);
        continue;
      }
      placeMesh(v);

      if (v.hit) continue;
      const dx = v.mesh.position.x - carPos.x;
      const dy = v.mesh.position.y - carPos.y;
      const dz = v.mesh.position.z - carPos.z;
      const r = HIT_RADIUS[v.kind];
      if (dx * dx + dz * dz < r * r && Math.abs(dy) < 2.3) {
        impacts.push({ kind: v.kind, damage: DAMAGE[v.kind] });
        v.hit = true;
        despawn(i);
      }
    }
    return { impacts };
  }

  function reset() {
    for (const i of Array.from(active.keys())) despawn(i);
  }

  /**
   * Live traffic in the arc-length range [fromS, toS) — snapshot of vehicles'
   * CURRENT positions, since unlike the old hazards these actually move.
   * @returns {Array<{s:number, kind:string, dirSign:number}>}
   */
  function upcoming(fromS, toS) {
    const out = [];
    for (const v of active.values()) {
      if (v.s >= fromS && v.s <= toS) out.push({ s: v.s, kind: v.kind, dirSign: v.dirSign });
    }
    return out;
  }

  return { update, reset, upcoming };
}
