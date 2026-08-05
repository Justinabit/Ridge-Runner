import * as THREE from 'three';
import { sampleRoad } from './roadgen.js';
import { hash1 } from './noise.js';

/* Fuel cans.
 *
 * The original game drained a full tank in about 45 seconds and offered no way
 * to top it up, so every run ended the same way: the throttle quietly cut to
 * 15% and the car rolled to a stop. Fuel was a countdown, not a mechanic.
 *
 * Cans are placed deterministically from the road function, so every player
 * sees them in the same place and no state needs to be generated up front.
 * Only a window of cans around the car exists as meshes at any time. */

const SPACING = 380;          // meters between cans
const FUEL_PER_CAN = 22;      // percentage points restored
const SCORE_PER_CAN = 100;
const PICKUP_RADIUS = 4.0;    // generous, since you are travelling ~34 m/s
const WINDOW_AHEAD = 900;
const WINDOW_BEHIND = 120;

const canMat = new THREE.MeshLambertMaterial({ color: 0xf5c542, flatShading: true });
const capMat = new THREE.MeshLambertMaterial({ color: 0x2a2233, flatShading: true });
const canGeo = new THREE.BoxGeometry(0.7, 0.95, 0.45);
const capGeo = new THREE.BoxGeometry(0.22, 0.2, 0.22);
const glowGeo = new THREE.SphereGeometry(0.9, 8, 6);
const glowMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.18 });

function makeCan() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(canGeo, canMat);
  body.castShadow = true;
  const cap = new THREE.Mesh(capGeo, capMat);
  cap.position.set(0, 0.57, 0);
  const glow = new THREE.Mesh(glowGeo, glowMat);
  g.add(body, cap, glow);
  return g;
}

/** Index of the first can at or after z. */
function canIndexAfter(z) {
  return Math.ceil(z / SPACING);
}

/** Deterministic world position of can `i`. */
function canPosition(i) {
  const z = i * SPACING;
  const s = sampleRoad(z);
  // nudge it off centre a little, but keep it well inside the 9 m road
  const lateral = (hash1(i * 7.31) - 0.5) * 4.2;
  return new THREE.Vector3(s.x + lateral, s.y + 1.0, z);
}

export function createPickupManager(scene) {
  const active = new Map();      // index -> THREE.Group
  const collected = new Set();   // indices taken during this run
  const group = new THREE.Group();
  scene.add(group);

  function spawn(i) {
    if (i < 1 || active.has(i) || collected.has(i)) return;
    const mesh = makeCan();
    mesh.position.copy(canPosition(i));
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
   * @returns {{fuel:number, score:number, collected:number}} rewards earned this frame
   */
  function update(carPos, dt) {
    const first = canIndexAfter(carPos.z - WINDOW_BEHIND);
    const last = canIndexAfter(carPos.z + WINDOW_AHEAD);
    for (let i = first; i <= last; i++) spawn(i);

    let fuel = 0, score = 0, taken = 0;

    for (const [i, mesh] of Array.from(active)) {
      if (mesh.position.z < carPos.z - WINDOW_BEHIND || mesh.position.z > carPos.z + WINDOW_AHEAD) {
        despawn(i);
        continue;
      }
      mesh.rotation.y += dt * 1.6;
      mesh.position.y = canPosition(i).y + Math.sin(performance.now() * 0.003 + i) * 0.12;

      const dx = mesh.position.x - carPos.x;
      const dy = mesh.position.y - carPos.y;
      const dz = mesh.position.z - carPos.z;
      if (dx * dx + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS && Math.abs(dy) < 3.5) {
        collected.add(i);
        despawn(i);
        fuel += FUEL_PER_CAN;
        score += SCORE_PER_CAN;
        taken++;
      }
    }
    return { fuel, score, collected: taken };
  }

  function reset() {
    for (const i of Array.from(active.keys())) despawn(i);
    collected.clear();
  }

  return { update, reset };
}
