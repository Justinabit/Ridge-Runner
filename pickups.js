import * as THREE from 'three';
import { sampleRoadFrame } from './roadgen.js';
import { hash1 } from './noise.js';

/* Pickups: fuel plus three power-ups.
 *
 * Placement is a pure function of the road, so every player sees the same
 * layout, nothing needs generating up front, and the sequence continues
 * forever. Only a window around the car exists as meshes at any time.
 *
 * Indexed by ARC LENGTH along the road rather than by world z. Under the old
 * z-indexing a pickup in a hairpin could be metres off the tarmac, or two
 * different stretches of road could claim the same slot — and the spawn window
 * ("z between here and here") stops meaning "the road ahead" the moment the
 * road can turn back on itself. */

export const PICKUP = {
  FUEL: 'FUEL',
  BOOST: 'BOOST',
  SHIELD: 'SHIELD',
  DOUBLE: 'DOUBLE',
};

const SPACING = 190;          // metres of road between pickups of any kind
const PICKUP_RADIUS = 4.2;
const WINDOW_AHEAD = 900;
const WINDOW_BEHIND = 120;

export const FUEL_PER_CAN = 22;
export const BOOST_SECONDS = 5;
export const SHIELD_SECONDS = 8;
export const DOUBLE_SECONDS = 10;

const MATS = {
  [PICKUP.FUEL]: new THREE.MeshLambertMaterial({ color: 0xf5c542, flatShading: true }),
  [PICKUP.BOOST]: new THREE.MeshLambertMaterial({ color: 0xff5a3d, flatShading: true }),
  [PICKUP.SHIELD]: new THREE.MeshLambertMaterial({ color: 0x4fc3ff, flatShading: true }),
  [PICKUP.DOUBLE]: new THREE.MeshLambertMaterial({ color: 0xb45cff, flatShading: true }),
};
const GLOW = {
  [PICKUP.FUEL]: 0xffe08a,
  [PICKUP.BOOST]: 0xff9b7a,
  [PICKUP.SHIELD]: 0x9fe4ff,
  [PICKUP.DOUBLE]: 0xd9a4ff,
};

const canGeo = new THREE.BoxGeometry(0.7, 0.95, 0.45);
const capGeo = new THREE.BoxGeometry(0.22, 0.2, 0.22);
const boostGeo = new THREE.ConeGeometry(0.5, 1.1, 5);
const shieldGeo = new THREE.OctahedronGeometry(0.62, 0);
const doubleGeo = new THREE.TorusGeometry(0.45, 0.17, 6, 10);
const capMat = new THREE.MeshLambertMaterial({ color: 0x2a2233, flatShading: true });
const glowGeo = new THREE.SphereGeometry(0.95, 8, 6);

function makeMesh(type) {
  const g = new THREE.Group();
  let body;
  if (type === PICKUP.FUEL) {
    body = new THREE.Mesh(canGeo, MATS[type]);
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.set(0, 0.57, 0);
    g.add(cap);
  } else if (type === PICKUP.BOOST) {
    body = new THREE.Mesh(boostGeo, MATS[type]);
  } else if (type === PICKUP.SHIELD) {
    body = new THREE.Mesh(shieldGeo, MATS[type]);
  } else {
    body = new THREE.Mesh(doubleGeo, MATS[type]);
  }
  body.castShadow = true;
  const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({
    color: GLOW[type], transparent: true, opacity: 0.2, depthWrite: false,
  }));
  g.add(body, glow);
  g.userData.type = type;
  return g;
}

/* Fuel dominates the sequence because it is the survival resource; power-ups
 * are the reward for going further. */
function typeForIndex(i) {
  const h = hash1(i * 3.77 + 11.3);
  if (i % 3 === 0) return PICKUP.FUEL;      // guaranteed fuel cadence
  if (h < 0.42) return PICKUP.FUEL;
  if (h < 0.66) return PICKUP.BOOST;
  if (h < 0.86) return PICKUP.SHIELD;
  return PICKUP.DOUBLE;
}

/* Placed using the road's own frame, so "a bit left of centre" stays a bit left
 * of centre through a corner instead of drifting off the tarmac. The lateral
 * offset is scaled by the local half-width so it lands inside the road even
 * where the road is at its narrowest. */
function positionFor(i) {
  const s = i * SPACING;
  const frame = sampleRoadFrame(s);
  const across = (hash1(i * 7.31) - 0.5) * 1.1 * frame.halfWidth;
  return frame.center.clone()
    .addScaledVector(frame.right, across)
    .addScaledVector(frame.roadUp, 1.05);
}

export function createPickupManager(scene) {
  const active = new Map();
  const collected = new Set();
  const group = new THREE.Group();
  scene.add(group);

  function spawn(i) {
    if (i < 1 || active.has(i) || collected.has(i)) return;
    const mesh = makeMesh(typeForIndex(i));
    mesh.position.copy(positionFor(i));
    // cached so the bob animation doesn't re-project the road every frame
    mesh.userData.baseY = mesh.position.y;
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
   * @param {{x:number,y:number,z:number}} carPos world position of the car
   * @param {number} carS the car's arc length along the road
   * @returns {{taken: string[]}} pickup types collected this frame
   */
  function update(carPos, carS, dt, t) {
    const first = Math.max(1, Math.ceil((carS - WINDOW_BEHIND) / SPACING));
    const last = Math.ceil((carS + WINDOW_AHEAD) / SPACING);
    for (let i = first; i <= last; i++) spawn(i);

    const taken = [];
    for (const [i, mesh] of Array.from(active)) {
      const s = i * SPACING;
      if (s < carS - WINDOW_BEHIND || s > carS + WINDOW_AHEAD) {
        despawn(i);
        continue;
      }
      mesh.rotation.y += dt * 1.7;
      mesh.position.y = mesh.userData.baseY + Math.sin(t * 0.003 + i) * 0.14;

      // full 3D proximity: on a steep grade a pickup can be well above or below
      // the car while its horizontal distance is almost nothing
      const dx = mesh.position.x - carPos.x;
      const dy = mesh.position.y - carPos.y;
      const dz = mesh.position.z - carPos.z;
      if (dx * dx + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS && Math.abs(dy) < 3.5) {
        taken.push(mesh.userData.type);
        collected.add(i);
        despawn(i);
      }
    }
    return { taken };
  }

  function reset() {
    for (const i of Array.from(active.keys())) despawn(i);
    collected.clear();
  }

  return { update, reset };
}
