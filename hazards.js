import * as THREE from 'three';
import { sampleRoadFrame } from './roadgen.js';
import { hash1 } from './noise.js';

/* Road hazards.
 *
 * Hits are detected by proximity in JS rather than by giving each hazard a
 * physics body. That is deliberate: dropping dozens of small dynamic bodies
 * onto a streamed trimesh is a reliable way to destabilise the solver, and it
 * makes the damage response much harder to tune. Proximity plus a manual
 * impulse gives an identical feel with none of that risk.
 *
 * Difficulty ramps with distance, so the opening kilometre stays gentle. */

export const HAZARD = { ROCK: 'ROCK', BARREL: 'BARREL', OIL: 'OIL' };

const BASE_SPACING = 150;      // metres between hazard slots near the start
const MIN_SPACING = 62;        // tightest spacing once fully ramped
const RAMP_DISTANCE = 3500;
const HIT_RADIUS = 1.9;
const OIL_RADIUS = 3.6;
const FIRST_HAZARD_Z = 450;    // grace period before anything can hurt you

export const ROCK_DAMAGE = 20;
export const BARREL_DAMAGE = 12;
export const OIL_GRIP_PENALTY = 0.35;   // fraction of normal grip while sliding
export const OIL_SECONDS = 1.4;

const rockGeo = new THREE.DodecahedronGeometry(0.85, 0);
const barrelGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.15, 8);
const oilGeo = new THREE.CircleGeometry(2.4, 12);

const rockMat = new THREE.MeshLambertMaterial({ color: 0x7a7480, flatShading: true });
const barrelMat = new THREE.MeshLambertMaterial({ color: 0xd8452f, flatShading: true });
const barrelBandMat = new THREE.MeshLambertMaterial({ color: 0x2a2233, flatShading: true });
const bandGeo = new THREE.CylinderGeometry(0.53, 0.53, 0.16, 8);
const oilMat = new THREE.MeshBasicMaterial({
  color: 0x14101c, transparent: true, opacity: 0.82, depthWrite: false,
});

/** Hazard slots get closer together the further you go. */
function spacingAt(z) {
  const t = Math.min(1, Math.max(0, z) / RAMP_DISTANCE);
  return BASE_SPACING - (BASE_SPACING - MIN_SPACING) * t;
}

/** Walks the slot sequence to find the z of hazard `i`. Cheap and deterministic. */
const _zCache = [FIRST_HAZARD_Z];
function hazardZ(i) {
  while (_zCache.length <= i) {
    const prev = _zCache[_zCache.length - 1];
    _zCache.push(prev + spacingAt(prev));
  }
  return _zCache[i];
}

function typeFor(i) {
  const h = hash1(i * 5.13 + 2.9);
  if (h < 0.42) return HAZARD.ROCK;
  if (h < 0.74) return HAZARD.BARREL;
  return HAZARD.OIL;
}

function makeMesh(type) {
  if (type === HAZARD.OIL) {
    const m = new THREE.Mesh(oilGeo, oilMat);
    m.rotation.x = -Math.PI / 2;
    return m;
  }
  if (type === HAZARD.ROCK) {
    const m = new THREE.Mesh(rockGeo, rockMat);
    m.castShadow = true;
    return m;
  }
  const g = new THREE.Group();
  const body = new THREE.Mesh(barrelGeo, barrelMat);
  body.castShadow = true;
  const band = new THREE.Mesh(bandGeo, barrelBandMat);
  band.position.y = 0.22;
  g.add(body, band);
  return g;
}

export function createHazardManager(scene) {
  const active = new Map();
  const hit = new Set();
  const group = new THREE.Group();
  scene.add(group);

  function placement(i) {
    const z = hazardZ(i);
    const frame = sampleRoadFrame(z);
    const type = typeFor(i);
    // sit it somewhere across the lane, but never hard against a barrier where
    // it would be unavoidable
    const across = (hash1(i * 9.41) - 0.5) * 5.4;
    const pos = frame.center.clone().addScaledVector(frame.right, across);
    pos.y += type === HAZARD.OIL ? 0.06 : (type === HAZARD.ROCK ? 0.5 : 0.6);
    return { z, type, pos };
  }

  function spawn(i) {
    if (i < 0 || active.has(i) || hit.has(i)) return;
    const { type, pos } = placement(i);
    const mesh = makeMesh(type);
    mesh.position.copy(pos);
    mesh.userData.type = type;
    group.add(mesh);
    active.set(i, mesh);
  }

  function despawn(i) {
    const mesh = active.get(i);
    if (!mesh) return;
    group.remove(mesh);
    active.delete(i);
  }

  /**
   * @returns {{impacts: string[], onOil: boolean}}
   */
  function update(carPos) {
    // find the slot range covering the window around the car
    let first = 0;
    while (hazardZ(first) < carPos.z - 80) first++;
    let last = first;
    while (hazardZ(last) < carPos.z + 700) last++;
    for (let i = first; i <= last; i++) spawn(i);

    const impacts = [];
    let onOil = false;

    for (const [i, mesh] of Array.from(active)) {
      if (mesh.position.z < carPos.z - 80 || mesh.position.z > carPos.z + 700) {
        despawn(i);
        continue;
      }
      const dx = mesh.position.x - carPos.x;
      const dy = mesh.position.y - carPos.y;
      const dz = mesh.position.z - carPos.z;
      const d2 = dx * dx + dz * dz;
      const type = mesh.userData.type;

      if (type === HAZARD.OIL) {
        if (d2 < OIL_RADIUS * OIL_RADIUS && Math.abs(dy) < 2.5) onOil = true;
      } else if (d2 < HIT_RADIUS * HIT_RADIUS && Math.abs(dy) < 2.2) {
        impacts.push(type);
        hit.add(i);
        despawn(i);
      }
    }
    return { impacts, onOil };
  }

  function reset() {
    for (const i of Array.from(active.keys())) despawn(i);
    hit.clear();
  }

  /**
   * Hazards in [fromZ, toZ) that are still live. Useful for anything that needs
   * to see the road ahead: a minimap, a difficulty probe, or an AI driver.
   * @returns {Array<{z:number, type:string, pos:THREE.Vector3}>}
   */
  function upcoming(fromZ, toZ) {
    const out = [];
    let i = 0;
    while (hazardZ(i) < fromZ) i++;
    while (hazardZ(i) < toZ) {
      if (!hit.has(i)) out.push(placement(i));
      i++;
    }
    return out;
  }

  return { update, reset, upcoming };
}
