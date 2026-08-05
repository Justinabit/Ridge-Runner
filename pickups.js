import * as THREE from 'three';
import { sampleRoad } from './roadgen.js';
import { hash1 } from './noise.js';

/* Pickups: fuel plus three power-ups.
 *
 * Placement is a pure function of the road, so every player sees the same
 * layout, nothing needs generating up front, and the sequence continues
 * forever. Only a window around the car exists as meshes at any time. */

export const PICKUP = {
  FUEL: 'FUEL',
  BOOST: 'BOOST',
  SHIELD: 'SHIELD',
  DOUBLE: 'DOUBLE',
};

const SPACING = 190;          // metres between pickups of any kind
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

function positionFor(i) {
  const z = i * SPACING;
  const s = sampleRoad(z);
  const lateral = (hash1(i * 7.31) - 0.5) * 4.6;
  return new THREE.Vector3(s.x + lateral, s.y + 1.05, z);
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
   * @param {{x:number,y:number,z:number}} carPos
   * @param {number} magnetRadius unused hook, kept at 0
   * @returns {{taken: string[]}} pickup types collected this frame
   */
  function update(carPos, dt, t) {
    const first = Math.ceil((carPos.z - WINDOW_BEHIND) / SPACING);
    const last = Math.ceil((carPos.z + WINDOW_AHEAD) / SPACING);
    for (let i = first; i <= last; i++) spawn(i);

    const taken = [];
    for (const [i, mesh] of Array.from(active)) {
      if (mesh.position.z < carPos.z - WINDOW_BEHIND || mesh.position.z > carPos.z + WINDOW_AHEAD) {
        despawn(i);
        continue;
      }
      mesh.rotation.y += dt * 1.7;
      mesh.position.y = positionFor(i).y + Math.sin(t * 0.003 + i) * 0.14;

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
