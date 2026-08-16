import * as THREE from 'three';
import { hash1, octaveNoise } from './noise.js';
import { sceneryKindAt } from './zones.js';

/* Roadside dressing, built per chunk from the same road frames the road mesh
 * uses, so every prop sits on ground by construction and the dressing continues
 * forever. Everything is instanced into a handful of draw calls per chunk.
 *
 * Two things changed with the curved road:
 *  - the tarmac's half-width now varies along the chunk (corners are widened),
 *    so props take a per-segment `halfWidths` array instead of one constant.
 *    Passing a single number put props through the tarmac on every corner.
 *  - corners get chevron boards on the outside of the bend, which is the single
 *    most useful piece of information the player can have at speed: it tells
 *    them which way the road goes before they can see the road itself. */

export const VERGE_WIDTH = 9;      // metres of grass either side of the tarmac
const VERGE_DROP = 0.18;

const LAMP_SPACING = 4;            // one lamp per N road segments, alternating sides
const TREES_PER_CHUNK = 20;
const HILL_TREES_PER_CHUNK = 26;   // trees out on the skirt, beyond the verge
const ROCKS_PER_CHUNK = 12;
const TUFTS_PER_CHUNK = 30;

/* Chevrons appear where curvature exceeds this (radius < ~110 m). */
const CHEVRON_CURVATURE = 0.009;

/* ---------- shared geometry, built once ---------- */
const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1.4, 5);
const pineGeo = new THREE.ConeGeometry(1.15, 3.4, 6);
const leafGeo = new THREE.IcosahedronGeometry(1.35, 0);
const palmTrunkGeo = new THREE.CylinderGeometry(0.13, 0.24, 3.4, 6);
const frondGeo = new THREE.ConeGeometry(0.38, 1.9, 4);
const rockGeo = new THREE.DodecahedronGeometry(0.75, 0);
const tuftGeo = new THREE.ConeGeometry(0.22, 0.7, 4);
const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 5.2, 6);
/* NOTE: addInstanced applies a Y rotation of `yaw`, which maps local +Z onto the
 * road's `right` vector. So anything meant to point ACROSS the road must be long
 * in Z, not X. */
const armGeo = new THREE.BoxGeometry(0.14, 0.14, 1.6);
const headGeo = new THREE.BoxGeometry(0.34, 0.24, 0.66);
const chevronPostGeo = new THREE.CylinderGeometry(0.07, 0.07, 1.5, 5);
const chevronBoardGeo = new THREE.BoxGeometry(0.08, 0.75, 1.0);

const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5b3a29, flatShading: true });
const pineMat = new THREE.MeshLambertMaterial({ color: 0x2f6b3f, flatShading: true });
const leafMat = new THREE.MeshLambertMaterial({ color: 0x6cb04a, flatShading: true });
const palmTrunkMat = new THREE.MeshLambertMaterial({ color: 0x8a6a3f, flatShading: true });
const frondMat = new THREE.MeshLambertMaterial({ color: 0x4fae5f, flatShading: true });
const rockMat = new THREE.MeshLambertMaterial({ color: 0x8b8a92, flatShading: true });
const tuftMat = new THREE.MeshLambertMaterial({ color: 0x5f9b48, flatShading: true });
const poleMat = new THREE.MeshLambertMaterial({ color: 0x3b3a44, flatShading: true });
/* Chevron boards are unlit for the same reason the lane markings are: they have
 * to be readable in fog and at night, which is when they matter most. */
const chevronMat = new THREE.MeshBasicMaterial({ color: 0xffd83d });

/* Lamp heads use MeshBasic so they ignore scene lighting and read as self-lit
 * at night without costing a real light each. */
export const lampHeadMat = new THREE.MeshBasicMaterial({ color: 0x6a6552 });
const LAMP_LIT = new THREE.Color(0xfff0c0);
const LAMP_UNLIT = new THREE.Color(0x6a6552);

export function setLampsLit(lit) {
  lampHeadMat.color.copy(lit ? LAMP_LIT : LAMP_UNLIT);
}

const _dummy = new THREE.Object3D();
const _worldUp = new THREE.Vector3(0, 1, 0);

/** Adds an InstancedMesh for `geo`/`mat` with the given transforms. */
function addInstanced(group, geo, mat, transforms, castShadow = true) {
  if (transforms.length === 0) return null;
  const inst = new THREE.InstancedMesh(geo, mat, transforms.length);
  inst.castShadow = castShadow;
  inst.receiveShadow = false;
  transforms.forEach((t, i) => {
    _dummy.position.copy(t.pos);
    _dummy.rotation.set(0, t.yaw ?? 0, 0);
    const s = t.scale ?? 1;
    _dummy.scale.set(s, t.scaleY ?? s, s);
    _dummy.updateMatrix();
    inst.setMatrixAt(i, _dummy.matrix);
  });
  inst.instanceMatrix.needsUpdate = true;
  group.add(inst);
  return inst;
}

/* Must match SKIRT_RINGS in terrain.js closely enough that hillside props land
 * on the visible ground rather than hovering over it or sinking into it. */
function skirtHeightApprox(s, side, dist) {
  const n = octaveNoise((s + (side > 0 ? 4000 : -4000)) * 0.006, 3, 0.5);
  const m = octaveNoise((s + (side > 0 ? 811 : 1907)) * 0.0016, 2, 0.55);
  // interpolate drop/noise between the rings the distance falls between
  const rings = [
    { dist: 8, drop: 1.2, noise: 1.6 },
    { dist: 22, drop: 3.0, noise: 5.0 },
    { dist: 48, drop: 5.0, noise: 12.0 },
    { dist: 95, drop: 6.0, noise: 24.0 },
    { dist: 170, drop: 4.0, noise: 38.0 },
  ];
  let lo = rings[0], hi = rings[0];
  for (let i = 0; i < rings.length; i++) {
    if (rings[i].dist <= dist) lo = rings[i];
    if (rings[i].dist >= dist) { hi = rings[i]; break; }
  }
  const span = hi.dist - lo.dist;
  const t = span > 1e-6 ? (dist - lo.dist) / span : 0;
  const drop = lo.drop + (hi.drop - lo.drop) * t;
  const noise = lo.noise + (hi.noise - lo.noise) * t;
  return -drop + (n * 0.45 + m * 0.75) * noise;
}

/**
 * Builds all roadside props for one chunk.
 * @param {Array<{center:THREE.Vector3, right:THREE.Vector3, roadUp:THREE.Vector3,
 *                s:number, curvature:number}>} frames per-segment road frames
 * @param {number[]} halfWidths tarmac half-width at each frame (it varies now)
 * @param {number} seed chunk index, so placement is deterministic
 */
export function buildChunkScenery(frames, halfWidths, seed) {
  const group = new THREE.Group();
  const lampHeads = [];

  const frameAt = (t) => {
    const fi = Math.min(frames.length - 1, Math.max(0, Math.floor(t * (frames.length - 1))));
    return fi;
  };

  /** A point on the verge, `t` along the chunk, `side` left/right, `inset` from
   *  the tarmac edge at that exact segment. */
  function vergePoint(t, side, inset) {
    const fi = frameAt(t);
    const f = frames[fi];
    const dist = halfWidths[fi] + inset;
    return f.center.clone()
      .addScaledVector(f.right, side * dist)
      .addScaledVector(f.roadUp, -VERGE_DROP);
  }

  /** A point out on the hillside skirt, beyond the verge. */
  function skirtPoint(t, side, beyondVerge) {
    const fi = frameAt(t);
    const f = frames[fi];
    const fromEdge = VERGE_WIDTH + beyondVerge;
    const dist = halfWidths[fi] + fromEdge;
    const h = skirtHeightApprox(f.s ?? 0, side, fromEdge);
    return f.center.clone()
      .addScaledVector(f.right, side * dist)
      .addScaledVector(_worldUp, h);
  }

  const midFrame = frames[Math.floor(frames.length / 2)];
  const kind = sceneryKindAt(midFrame.s ?? midFrame.center.z);

  const isPalm = kind === 'BEACH';
  const isPine = kind === 'FOREST';

  /* ---------------- verge trees ---------------- */
  const trunks = [], canopies = [], fronds = [];
  for (let i = 0; i < TREES_PER_CHUNK; i++) {
    const h = hash1(seed * 131.7 + i * 3.13);
    const h2 = hash1(seed * 57.1 + i * 7.77);
    const h3 = hash1(seed * 19.3 + i * 11.1);
    if (kind === 'NIGHT' && h3 > 0.55) continue;
    const side = h2 < 0.5 ? -1 : 1;
    const inset = 2.4 + h3 * (VERGE_WIDTH - 3.6);
    const pos = vergePoint(h, side, inset);
    const scale = 0.75 + h2 * 0.7;
    const yaw = h * Math.PI * 2;

    if (isPalm) {
      trunks.push({ pos, yaw, scale });
      for (let f = 0; f < 5; f++) {
        fronds.push({ pos: pos.clone().setY(pos.y + 3.3 * scale), yaw: (f / 5) * Math.PI * 2 + yaw, scale });
      }
    } else {
      trunks.push({ pos, yaw, scale });
      canopies.push({ pos: pos.clone().setY(pos.y + (isPine ? 2.7 : 2.4) * scale), yaw, scale });
    }
  }

  /* ---------------- hillside trees ----------------
   * Out on the skirt, larger and more numerous, so the middle distance has
   * something in it. Without these the new hillside is a bare coloured slope. */
  for (let i = 0; i < HILL_TREES_PER_CHUNK; i++) {
    const h = hash1(seed * 211.3 + i * 4.51);
    const h2 = hash1(seed * 83.9 + i * 9.13);
    const h3 = hash1(seed * 37.7 + i * 6.29);
    if (kind === 'BEACH' && h3 > 0.4) continue;       // sparse scrub on the coast
    if (kind === 'NIGHT' && h3 > 0.45) continue;
    const side = h2 < 0.5 ? -1 : 1;
    const beyond = 4 + h3 * 120;
    const pos = skirtPoint(h, side, beyond);
    const scale = 0.9 + h2 * 1.5;
    const yaw = h * Math.PI * 2;
    trunks.push({ pos, yaw, scale });
    if (isPalm) {
      for (let f = 0; f < 5; f++) {
        fronds.push({ pos: pos.clone().setY(pos.y + 3.3 * scale), yaw: (f / 5) * Math.PI * 2 + yaw, scale });
      }
    } else {
      canopies.push({ pos: pos.clone().setY(pos.y + (isPine ? 2.7 : 2.4) * scale), yaw, scale });
    }
  }

  if (isPalm) {
    addInstanced(group, palmTrunkGeo, palmTrunkMat,
      trunks.map(t => ({ ...t, pos: t.pos.clone().setY(t.pos.y + 1.7 * t.scale) })));
    addInstanced(group, frondGeo, frondMat, fronds);
  } else {
    addInstanced(group, trunkGeo, trunkMat,
      trunks.map(t => ({ ...t, pos: t.pos.clone().setY(t.pos.y + 0.7 * t.scale) })));
    addInstanced(group, isPine ? pineGeo : leafGeo, isPine ? pineMat : leafMat, canopies);
  }

  /* ---------------- rocks ---------------- */
  const rocks = [];
  for (let i = 0; i < ROCKS_PER_CHUNK; i++) {
    const h = hash1(seed * 71.3 + i * 5.9);
    const h2 = hash1(seed * 23.9 + i * 13.7);
    const side = h2 < 0.5 ? -1 : 1;
    const pos = h2 > 0.65
      ? skirtPoint(h, side, 2 + h2 * 40)
      : vergePoint(h, side, 1.6 + h2 * (VERGE_WIDTH - 2.4));
    rocks.push({ pos, yaw: h2 * 6.28, scale: 0.4 + h2 * 1.1, scaleY: 0.35 + h * 0.6 });
  }
  addInstanced(group, rockGeo, rockMat, rocks);

  /* ---------------- grass tufts ---------------- */
  const tufts = [];
  for (let i = 0; i < TUFTS_PER_CHUNK; i++) {
    const h = hash1(seed * 41.1 + i * 2.71);
    const h2 = hash1(seed * 97.7 + i * 4.31);
    const side = h2 < 0.5 ? -1 : 1;
    const pos = vergePoint(h, side, 1.0 + h2 * (VERGE_WIDTH - 1.6));
    tufts.push({ pos: pos.clone().setY(pos.y + 0.3), yaw: h * 6.28, scale: 0.7 + h2 * 0.8 });
  }
  addInstanced(group, tuftGeo, tuftMat, tufts, false);

  /* ---------------- street lamps ---------------- */
  const poles = [], arms = [], heads = [];
  for (let i = 0; i < frames.length - 1; i += LAMP_SPACING) {
    const side = (Math.floor(i / LAMP_SPACING) % 2 === 0) ? -1 : 1;
    const f = frames[i];
    const base = f.center.clone()
      .addScaledVector(f.right, side * (halfWidths[i] + 1.3))
      .addScaledVector(f.roadUp, -VERGE_DROP);
    const yaw = Math.atan2(f.right.x, f.right.z);
    poles.push({ pos: base.clone().setY(base.y + 2.6), yaw });
    arms.push({ pos: base.clone().setY(base.y + 5.05).addScaledVector(f.right, -side * 0.8), yaw });
    heads.push({ pos: base.clone().setY(base.y + 4.88).addScaledVector(f.right, -side * 1.55), yaw });
  }
  addInstanced(group, poleGeo, poleMat, poles);
  addInstanced(group, armGeo, poleMat, arms);
  const headInst = addInstanced(group, headGeo, lampHeadMat, heads, false);
  if (headInst) lampHeads.push(...heads.map(h => h.pos));

  /* ---------------- corner chevrons ----------------
   * On the OUTSIDE of the bend: curvature > 0 turns toward +right, so the
   * outside of that corner is -right. This is the side the car is pushed toward
   * and the side it will leave the road on, so it is also where a board is
   * actually visible from. */
  const chevPosts = [], chevBoards = [];
  for (let i = 0; i < frames.length - 1; i += 2) {
    const f = frames[i];
    const k = f.curvature ?? 0;
    if (Math.abs(k) < CHEVRON_CURVATURE) continue;
    const side = k > 0 ? -1 : 1;
    const base = f.center.clone()
      .addScaledVector(f.right, side * (halfWidths[i] + 1.1))
      .addScaledVector(f.roadUp, -VERGE_DROP);
    const yaw = Math.atan2(f.right.x, f.right.z);
    chevPosts.push({ pos: base.clone().setY(base.y + 0.75), yaw });
    chevBoards.push({ pos: base.clone().setY(base.y + 1.35), yaw });
  }
  addInstanced(group, chevronPostGeo, poleMat, chevPosts, false);
  addInstanced(group, chevronBoardGeo, chevronMat, chevBoards, false);

  return { group, lampPositions: lampHeads };
}
