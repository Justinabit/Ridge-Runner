import * as THREE from 'three';
import { octaveNoise } from './noise.js';

export const ROAD_WIDTH = 9;

const SEED = 91;
// Difficulty ramps up over this distance, then holds steady. The old
// fixed-length track used distFactor = z / trackLength to do this, but an
// infinitely-streamed road has no total length to divide by — "ramp then
// plateau" is the equivalent for a road that never ends.
const DIFFICULTY_RAMP_DISTANCE = 3000;
const TANGENT_SAMPLE_DELTA = 0.5;

function difficultyAt(z) {
  const restEnvelope = 0.35 + 0.65 * Math.max(0, Math.sin(z * 0.0022 + SEED));
  const ramp = Math.min(1, Math.max(0, z) / DIFFICULTY_RAMP_DISTANCE);
  return (0.35 + 0.65 * ramp) * restEnvelope;
}

function heightAt(z) {
  const difficulty = difficultyAt(z);
  const hillY = octaveNoise((z + SEED * 97) * 0.0025, 3, 0.55) * 14 * difficulty;
  const bumpY = octaveNoise((z + SEED * 53) * 0.012, 2, 0.5) * 3.5 * difficulty;
  return hillY + bumpY;
}

function lateralAt(z) {
  const ramp = Math.min(1, Math.max(0, z) / DIFFICULTY_RAMP_DISTANCE);
  return octaveNoise((z + SEED * 31) * 0.0016, 3, 0.5) * 26 * (0.4 + 0.6 * ramp);
}

/**
 * Position on the road centerline at a given distance z. This is the whole
 * API surface main.js needs for spawn/reset points — deliberately just
 * {x, y, z}, no curve or track object required.
 */
export function sampleRoad(z) {
  return { x: lateralAt(z), y: heightAt(z), z };
}

/**
 * Full local coordinate frame of the road at distance z: center point,
 * forward tangent, banked right vector, and road-up normal. Terrain chunk
 * building (and anything else that needs to offset sideways from the road —
 * shoulders, guard rails, scenery) derives from this frame without roadgen
 * needing to know about any of those consumers.
 */
export function sampleRoadFrame(z) {
  const x = lateralAt(z);
  const y = heightAt(z);

  const zBack = z - TANGENT_SAMPLE_DELTA;
  const zFwd = z + TANGENT_SAMPLE_DELTA;
  const tangent = new THREE.Vector3(
    lateralAt(zFwd) - lateralAt(zBack),
    heightAt(zFwd) - heightAt(zBack),
    zFwd - zBack
  ).normalize();

  // banking derived from lateral curvature change (roll into turns) — same
  // formula the old spline-based track used per control point
  const dx = lateralAt(zFwd) - lateralAt(zBack);
  const bank = THREE.MathUtils.clamp(dx * 0.045, -0.45, 0.45);

  // FIX (handedness): this used to be `tangent x up`, which for a road running
  // along +Z yields -X — a LEFT-handed frame. Every road quad was therefore
  // wound backwards, giving each triangle a downward-facing normal. Two things
  // broke as a result, and both looked like separate bugs:
  //   1. cannon-es's RaycastVehicle casts its wheel rays with skipBackfaces:true,
  //      so every wheel ray hit the road's *back* face and was discarded. The car
  //      never registered ground contact and free-fell through the world forever.
  //   2. three.js culls back faces by default, so the road surface was invisible
  //      when viewed from above.
  // `up x tangent` gives a proper right-handed frame (+X for a +Z road), which
  // fixes the winding — and therefore both symptoms — at the source.
  const up = new THREE.Vector3(0, 1, 0);
  let right = new THREE.Vector3().crossVectors(up, tangent).normalize();
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  const quat = new THREE.Quaternion().setFromAxisAngle(tangent, bank);
  right.applyQuaternion(quat);
  // roadUp must be flipped to match the corrected `right`, or it would now
  // point into the ground.
  const roadUp = new THREE.Vector3().crossVectors(tangent, right).normalize();

  return { center: new THREE.Vector3(x, y, z), tangent, right, roadUp, bank };
}