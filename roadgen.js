import * as THREE from 'three';
import { octaveNoise, smoothNoise } from './noise.js';

/* =============================================================================
 * THE ROAD
 *
 * REWRITE: the road used to be defined as two functions of world z —
 * `x = lateralAt(z)` and `y = heightAt(z)`. That is a *graph over z*, and a
 * graph over z can never turn. The steepest it can ever get is a diagonal, the
 * tangent's z-component is always positive, and a hairpin is not merely hard to
 * express, it is unrepresentable: a real turn needs two different x values at
 * the same z, which a function of z cannot produce by definition. Every
 * "corner" the old generator made was really just a lane change.
 *
 * The road is now integrated along its own arc length `s` instead:
 *
 *     dheading/ds = curvature(s)
 *     dpitch  /ds = 0            (pitch is sampled directly)
 *     dx/ds = sin(heading) * cos(pitch)
 *     dz/ds = cos(heading) * cos(pitch)
 *     dy/ds =                sin(pitch)
 *
 * Curvature is what makes turns, and pitch is what makes hills — both are now
 * first-class quantities rather than side effects of a height field. Because
 * heading is an integral, a long stretch of mild curvature accumulates into a
 * genuine change of direction, which is exactly what a mountain road is.
 *
 * The trade is that `s` and `z` are no longer interchangeable, so `s` (distance
 * driven along the road) replaces `z` as the coordinate everything else indexes
 * by: chunk streaming, pickups, hazards, scenery, scoring. `projectToRoad()`
 * recovers `s` from a world position for anything that only has one.
 *
 * Integration is done once into a table at a fixed step and cached, so all of
 * this stays a pure, deterministic function of `s` — the property the streaming
 * relies on to make neighbouring chunks share an exact edge.
 * ========================================================================== */

/** Base width of the tarmac. Was 9 m, which is barely two lanes and left no
 *  room to pick a line through a corner. 14 m is a comfortable three. */
export const ROAD_WIDTH = 14;

/** Corners are widened a little so a hairpin doesn't feel like a funnel. */
const MAX_CORNER_WIDENING = 3.5;

const SEED = 91;
const DIFFICULTY_RAMP_DISTANCE = 3000;

/* ---------------------------------------------------------------------------
 * Integration parameters
 * ------------------------------------------------------------------------ */
const SAMPLE_STEP = 2;            // metres between integrated samples
const MAX_SAMPLES = 60000;        // ~120 km of road before the table is capped

/* Curvature budget, in 1/m. Radius = 1/curvature, so:
 *   0.0040 -> R 250 m  (fast sweeper)
 *   0.0100 -> R 100 m  (third-gear corner)
 *   0.0220 -> R  45 m  (hairpin)
 * These are real mountain-road numbers and are what set how hard the game is
 * to drive at speed. */
const CURV_SWEEP = 0.0090;        // slow, long-wavelength direction changes
const CURV_ESSES = 0.0046;        // faster alternation stacked on top
const CURV_HAIRPIN = 0.0135;      // extra curvature inside a corner "event"
const HAIRPIN_THRESHOLD = 0.78;   // envelope level above which a corner fires

/* Heading is pulled back toward "down the valley" by a cubic term. Cubic rather
 * than a clamp: it is nearly zero for gentle headings so it doesn't flatten
 * ordinary corners, but it grows fast enough to guarantee the road never spirals
 * or doubles back on itself. */
const HEADING_PULL = 0.0062;
const HEADING_LIMIT = 1.35;       // rad, ~77 deg off-axis at the very most

/* Pitch, in radians. 0.20 rad is an 11 deg / 20% grade — steep, but the car has
 * the power for it and the wheel raycasts stay stable. */
const PITCH_ROLLING = 0.085;      // constant undulation
const PITCH_CLIMB = 0.115;        // long climb/descent events on top
const PITCH_LIMIT = 0.20;
/* Without this the elevation is a random walk and wanders kilometres away from
 * zero over a long run. A weak spring toward y = 0 keeps the road in a valley
 * without visibly flattening any individual hill. */
const ELEVATION_SPRING = 0.00055;

/* Banking. A corner is banked *into* its turn, which is what makes a fast
 * corner hold instead of pushing the car off the outside edge. */
const BANK_PER_CURVATURE = 16;
const MAX_BANK = 0.20;            // rad, ~11.5 deg

function difficultyAt(s) {
  const restEnvelope = 0.45 + 0.55 * Math.max(0, Math.sin(s * 0.0022 + SEED));
  const ramp = Math.min(1, Math.max(0, s) / DIFFICULTY_RAMP_DISTANCE);
  return (0.4 + 0.6 * ramp) * restEnvelope;
}

/**
 * Curvature the road "wants" at `s`, before the heading-limiting term. Three
 * layers: long sweepers, quicker esses on top, and sparse hairpin events.
 */
function targetCurvature(s) {
  const difficulty = difficultyAt(s);
  const sweep = octaveNoise((s + SEED * 13) * 0.0011, 2, 0.5);
  const esses = octaveNoise((s + SEED * 29) * 0.0042, 2, 0.5);
  let k = (sweep * CURV_SWEEP + esses * CURV_ESSES) * difficulty;

  // Corner events: a fast envelope thresholded so it is quiet most of the time
  // and then, over ~60 m, adds enough curvature to close a corner right up.
  const env = smoothNoise((s + SEED * 61) * 0.004);
  if (env > HAIRPIN_THRESHOLD) {
    const t = (env - HAIRPIN_THRESHOLD) / (1 - HAIRPIN_THRESHOLD);
    // ease in and out so the corner has an entry and an exit rather than a kink
    const shaped = t * t * (3 - 2 * t);
    const dir = sweep >= 0 ? 1 : -1;   // turn the way the road was already going
    k += dir * shaped * CURV_HAIRPIN * difficulty;
  }
  return k;
}

/** Pitch (climb angle) the road wants at `s`, before the elevation spring. */
function targetPitch(s) {
  const difficulty = difficultyAt(s);
  const rolling = octaveNoise((s + SEED * 97) * 0.0026, 3, 0.55) * PITCH_ROLLING;
  const climb = octaveNoise((s + SEED * 41) * 0.00085, 2, 0.5) * PITCH_CLIMB;
  return (rolling + climb) * (0.55 + 0.45 * difficulty);
}

/* ---------------------------------------------------------------------------
 * The integrated sample table
 *
 * samples[i] describes the road at s = i * SAMPLE_STEP. The table is grown on
 * demand and never rewritten, so sampling is deterministic no matter what order
 * callers ask in — two chunks meeting at a shared s read the identical row.
 * ------------------------------------------------------------------------ */
const samples = [{
  s: 0, x: 0, y: 0, z: 0, heading: 0, pitch: targetPitch(0), curvature: targetCurvature(0),
}];

function ensureSamples(sMax) {
  const needed = Math.min(MAX_SAMPLES, Math.ceil(sMax / SAMPLE_STEP) + 2);
  for (let i = samples.length; i <= needed; i++) {
    const prev = samples[i - 1];
    const s = prev.s;

    // heading integration, with the cubic centring term
    const curvature = targetCurvature(s) - HEADING_PULL * prev.heading ** 3;
    // Midpoint rule: using the heading at the *middle* of the step rather than
    // its start. At 2 m steps plain Euler drifts noticeably over a kilometre of
    // constant curvature, and the drift is a systematic bias (every corner ends
    // slightly wide), not noise.
    const headingMid = prev.heading + curvature * SAMPLE_STEP * 0.5;
    let heading = prev.heading + curvature * SAMPLE_STEP;
    heading = THREE.MathUtils.clamp(heading, -HEADING_LIMIT, HEADING_LIMIT);

    const pitch = THREE.MathUtils.clamp(
      targetPitch(s) - ELEVATION_SPRING * prev.y, -PITCH_LIMIT, PITCH_LIMIT,
    );
    const pitchMid = (prev.pitch + pitch) * 0.5;

    // A step of SAMPLE_STEP *along the road* advances cos(pitch) horizontally
    // and sin(pitch) vertically. Ignoring the cosine would silently stretch the
    // road's ground-plane length on every hill.
    const horizontal = Math.cos(pitchMid) * SAMPLE_STEP;
    samples.push({
      s: s + SAMPLE_STEP,
      x: prev.x + Math.sin(headingMid) * horizontal,
      z: prev.z + Math.cos(headingMid) * horizontal,
      y: prev.y + Math.sin(pitchMid) * SAMPLE_STEP,
      heading,
      pitch,
      curvature,
    });
  }
}

// Pre-integrate a comfortable buffer so the first frame never stalls.
ensureSamples(2000);

/** Interpolated raw state at arc length `s`. Handles s < 0 by extrapolating the
 *  start of the road backwards in a straight line, so spawn logic can look
 *  behind the origin without special-casing. */
function stateAt(s) {
  if (s <= 0) {
    const a = samples[0];
    return {
      x: a.x + Math.sin(a.heading) * s, y: a.y + Math.sin(a.pitch) * s,
      z: a.z + Math.cos(a.heading) * s,
      heading: a.heading, pitch: a.pitch, curvature: 0,
    };
  }
  ensureSamples(s + SAMPLE_STEP);
  const fi = s / SAMPLE_STEP;
  const i = Math.min(samples.length - 2, Math.floor(fi));
  const t = Math.min(1, fi - i);
  const a = samples[i];
  const b = samples[i + 1];
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    heading: a.heading + (b.heading - a.heading) * t,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    curvature: a.curvature + (b.curvature - a.curvature) * t,
  };
}

/** Signed curvature (1/m) at `s`. Positive turns toward the frame's `right`. */
export function curvatureAt(s) {
  return stateAt(s).curvature;
}

/** Climb angle in radians at `s`. Positive is uphill. */
export function pitchAt(s) {
  return stateAt(s).pitch;
}

/** Half-width of the tarmac at `s`; corners are widened slightly. */
export function roadHalfWidthAt(s) {
  const k = Math.abs(stateAt(s).curvature);
  const widen = Math.min(MAX_CORNER_WIDENING, k * 190);
  return (ROAD_WIDTH + widen) / 2;
}

/**
 * Centreline point at arc length `s`.
 * Kept deliberately minimal — {x, y, z} — for spawn/reset callers.
 */
export function sampleRoad(s) {
  const st = stateAt(s);
  return { x: st.x, y: st.y, z: st.z };
}

/**
 * Full local coordinate frame of the road at arc length `s`: centre point,
 * forward tangent, banked right vector, road-up normal, plus the curvature and
 * pitch that produced them (the AI-free "road ahead" info the camera, scenery
 * and gameplay code want).
 */
export function sampleRoadFrame(s) {
  const st = stateAt(s);

  const cp = Math.cos(st.pitch);
  const tangent = new THREE.Vector3(
    Math.sin(st.heading) * cp,
    Math.sin(st.pitch),
    Math.cos(st.heading) * cp,
  ).normalize();

  /* HANDEDNESS (unchanged, and load-bearing): `up x tangent` gives +X for a road
   * running along +Z — a right-handed frame. The reverse order yields a
   * left-handed one, which winds every road triangle backwards. That makes the
   * surface invisible to three.js (back-face culling) *and* invisible to
   * cannon-es's wheel raycasts (which skip back faces), so the car falls
   * straight through the world. */
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, tangent);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  right.normalize();

  /* Bank INTO the corner. A turn toward +right needs the surface normal to lean
   * toward +right too, and rotating `right` about `tangent` by a positive angle
   * leans the normal the other way — hence the minus sign. Getting this backwards
   * is not a cosmetic bug: an outward-banked corner actively throws the car off
   * the road, which is what the previous formula did. */
  const bank = THREE.MathUtils.clamp(
    -st.curvature * BANK_PER_CURVATURE, -MAX_BANK, MAX_BANK,
  );
  right.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(tangent, bank));

  const roadUp = new THREE.Vector3().crossVectors(tangent, right).normalize();

  return {
    s,
    center: new THREE.Vector3(st.x, st.y, st.z),
    tangent, right, roadUp, bank,
    curvature: st.curvature,
    pitch: st.pitch,
    halfWidth: roadHalfWidthAt(s),
  };
}

/* ---------------------------------------------------------------------------
 * Inverse mapping: world position -> arc length
 *
 * Needed now that `s` and `z` have parted ways. Everything that used to read
 * `car.position.z` as "how far along the road am I" has to ask this instead,
 * because on a road that genuinely turns those are different numbers — and on a
 * hard left-hander, z can even briefly stop increasing while s keeps climbing.
 * ------------------------------------------------------------------------ */
const _p = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _rel = new THREE.Vector3();

/**
 * Projects a world position onto the centreline.
 * @param {{x:number,y:number,z:number}} pos
 * @param {number} hintS last known arc length — the search is local to this,
 *        which keeps the cost constant and prevents a hairpin from snapping the
 *        result to the other side of the corner.
 * @param {number} radius metres of road to search either side of the hint
 * @returns {{s:number, lateral:number, height:number, frame:object}}
 *          `lateral` is signed distance along the frame's `right` (so 0 is dead
 *          centre and |lateral| > halfWidth means off the tarmac).
 */
export function projectToRoad(pos, hintS = 0, radius = 60) {
  const from = Math.max(0, hintS - radius);
  const to = hintS + radius;
  ensureSamples(to + SAMPLE_STEP);

  const iFrom = Math.max(0, Math.floor(from / SAMPLE_STEP));
  const iTo = Math.min(samples.length - 2, Math.ceil(to / SAMPLE_STEP));

  let bestS = hintS;
  let bestD2 = Infinity;
  _p.set(pos.x, pos.y, pos.z);

  for (let i = iFrom; i <= iTo; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    _seg.set(b.x - a.x, b.y - a.y, b.z - a.z);
    _rel.set(_p.x - a.x, _p.y - a.y, _p.z - a.z);
    const segLen2 = _seg.lengthSq();
    const t = segLen2 > 1e-9
      ? THREE.MathUtils.clamp(_rel.dot(_seg) / segLen2, 0, 1)
      : 0;
    const cx = a.x + _seg.x * t;
    const cy = a.y + _seg.y * t;
    const cz = a.z + _seg.z * t;
    const d2 = (_p.x - cx) ** 2 + (_p.y - cy) ** 2 + (_p.z - cz) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestS = a.s + t * SAMPLE_STEP;
    }
  }

  const frame = sampleRoadFrame(bestS);
  _rel.set(pos.x - frame.center.x, pos.y - frame.center.y, pos.z - frame.center.z);
  return {
    s: bestS,
    lateral: _rel.dot(frame.right),
    height: _rel.dot(frame.roadUp),
    frame,
  };
}

/** Pre-integrates the table out to `s`. Purely an optimisation for boot. */
export function warmRoad(s) { ensureSamples(s); }
