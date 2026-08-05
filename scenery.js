import * as THREE from 'three';
import { hash1 } from './noise.js';
import { sceneryKindAt } from './zones.js';

/* Roadside dressing.
 *
 * Previously zones.js pre-scattered a few dozen trees once, up front, out to a
 * fixed 9 km horizon, positioned up to 30 m from the centreline. The road plus
 * shoulder is only ~19 m wide, so most of those trees stood in empty space with
 * nothing beneath them, and past 9 km there was nothing at all.
 *
 * Scenery is now built per chunk from the same road frame the road mesh uses,
 * and constrained to the verge, so every prop sits on ground by construction
 * and the dressing continues forever. Everything is instanced and merged into a
 * handful of draw calls per chunk. */

export const VERGE_WIDTH = 9;      // metres of grass either side of the tarmac
const VERGE_DROP = 0.18;           // verge sits slightly below the road surface

const LAMP_SPACING = 3;            // one lamp per N road segments, alternating sides
const TREES_PER_CHUNK = 18;
const ROCKS_PER_CHUNK = 10;
const TUFTS_PER_CHUNK = 26;

/* ---------- shared geometry, built once ---------- */
const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1.4, 5);
const pineGeo = new THREE.ConeGeometry(1.15, 3.4, 6);
const leafGeo = new THREE.IcosahedronGeometry(1.35, 0);
const palmTrunkGeo = new THREE.CylinderGeometry(0.13, 0.24, 3.4, 6);
const frondGeo = new THREE.ConeGeometry(0.38, 1.9, 4);
const rockGeo = new THREE.DodecahedronGeometry(0.75, 0);
const tuftGeo = new THREE.ConeGeometry(0.22, 0.7, 4);
const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 5.2, 6);
// NOTE: addInstanced applies a Y rotation of `yaw`, which maps local +Z onto
// the road's `right` vector. So anything meant to point ACROSS the road must be
// long in Z, not X. The arm was 1.5 long in X, which aimed it along the road and
// left the lamp head floating unattached beside it.
const armGeo = new THREE.BoxGeometry(0.14, 0.14, 1.6);
const headGeo = new THREE.BoxGeometry(0.34, 0.24, 0.66);

const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5b3a29, flatShading: true });
const pineMat = new THREE.MeshLambertMaterial({ color: 0x2f6b3f, flatShading: true });
const leafMat = new THREE.MeshLambertMaterial({ color: 0x6cb04a, flatShading: true });
const palmTrunkMat = new THREE.MeshLambertMaterial({ color: 0x8a6a3f, flatShading: true });
const frondMat = new THREE.MeshLambertMaterial({ color: 0x4fae5f, flatShading: true });
const rockMat = new THREE.MeshLambertMaterial({ color: 0x8b8a92, flatShading: true });
const tuftMat = new THREE.MeshLambertMaterial({ color: 0x5f9b48, flatShading: true });
const poleMat = new THREE.MeshLambertMaterial({ color: 0x3b3a44, flatShading: true });

/* Lamp heads use MeshBasic so they ignore scene lighting and read as self-lit
 * at night without costing a real light each. Call setLampsLit() to switch them
 * between lit and unlit; nothing dims them automatically. */
export const lampHeadMat = new THREE.MeshBasicMaterial({ color: 0x6a6552 });
const LAMP_LIT = new THREE.Color(0xfff0c0);
const LAMP_UNLIT = new THREE.Color(0x6a6552);

export function setLampsLit(lit) {
  lampHeadMat.color.copy(lit ? LAMP_LIT : LAMP_UNLIT);
}

const _dummy = new THREE.Object3D();

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

/**
 * Builds all roadside props for one chunk.
 * @param {Array<{center:THREE.Vector3, right:THREE.Vector3, roadUp:THREE.Vector3}>} frames
 *        the same per-segment frames the road mesh was built from
 * @param {number} halfRoadWidth
 * @param {number} seed  chunk index, so placement is deterministic
 */
export function buildChunkScenery(frames, halfRoadWidth, seed) {
  const group = new THREE.Group();
  const lampHeads = [];

  // a point somewhere on the verge, `t` along the chunk and `side` left/right
  function vergePoint(t, side, inset) {
    const fi = Math.min(frames.length - 1, Math.floor(t * (frames.length - 1)));
    const f = frames[fi];
    const dist = halfRoadWidth + inset;
    return f.center.clone()
      .addScaledVector(f.right, side * dist)
      .addScaledVector(f.roadUp, -VERGE_DROP);
  }

  const zMid = frames[Math.floor(frames.length / 2)].center.z;
  const kind = sceneryKindAt(zMid);

  /* ---------------- trees ---------------- */
  const trunks = [], canopies = [], fronds = [];
  const isPalm = kind === 'BEACH';
  const isPine = kind === 'FOREST';
  for (let i = 0; i < TREES_PER_CHUNK; i++) {
    const h = hash1(seed * 131.7 + i * 3.13);
    const h2 = hash1(seed * 57.1 + i * 7.77);
    const h3 = hash1(seed * 19.3 + i * 11.1);
    if (kind === 'NIGHT' && h3 > 0.55) continue;      // sparser at night
    const side = h2 < 0.5 ? -1 : 1;
    // keep well inside the verge so nothing overhangs the void
    const inset = 2.2 + h3 * (VERGE_WIDTH - 3.4);
    const pos = vergePoint(h, side, inset);
    const scale = 0.75 + h2 * 0.7;
    const yaw = h * Math.PI * 2;

    if (isPalm) {
      trunks.push({ pos, yaw, scale, geo: 'palm' });
      for (let f = 0; f < 5; f++) {
        fronds.push({ pos: pos.clone().setY(pos.y + 3.3 * scale), yaw: (f / 5) * Math.PI * 2 + yaw, scale });
      }
    } else {
      trunks.push({ pos, yaw, scale });
      canopies.push({ pos: pos.clone().setY(pos.y + (isPine ? 2.7 : 2.4) * scale), yaw, scale });
    }
  }

  if (isPalm) {
    addInstanced(group, palmTrunkGeo, palmTrunkMat, trunks.map(t => ({ ...t, pos: t.pos.clone().setY(t.pos.y + 1.7 * t.scale) })));
    addInstanced(group, frondGeo, frondMat, fronds);
  } else {
    addInstanced(group, trunkGeo, trunkMat, trunks.map(t => ({ ...t, pos: t.pos.clone().setY(t.pos.y + 0.7 * t.scale) })));
    addInstanced(group, isPine ? pineGeo : leafGeo, isPine ? pineMat : leafMat, canopies);
  }

  /* ---------------- rocks ---------------- */
  const rocks = [];
  for (let i = 0; i < ROCKS_PER_CHUNK; i++) {
    const h = hash1(seed * 71.3 + i * 5.9);
    const h2 = hash1(seed * 23.9 + i * 13.7);
    const side = h2 < 0.5 ? -1 : 1;
    const pos = vergePoint(h, side, 1.4 + h2 * (VERGE_WIDTH - 2.2));
    rocks.push({ pos, yaw: h2 * 6.28, scale: 0.4 + h2 * 0.7, scaleY: 0.35 + h * 0.5 });
  }
  addInstanced(group, rockGeo, rockMat, rocks);

  /* ---------------- grass tufts ---------------- */
  const tufts = [];
  for (let i = 0; i < TUFTS_PER_CHUNK; i++) {
    const h = hash1(seed * 41.1 + i * 2.71);
    const h2 = hash1(seed * 97.7 + i * 4.31);
    const side = h2 < 0.5 ? -1 : 1;
    const pos = vergePoint(h, side, 0.9 + h2 * (VERGE_WIDTH - 1.4));
    tufts.push({ pos: pos.clone().setY(pos.y + 0.3), yaw: h * 6.28, scale: 0.7 + h2 * 0.8 });
  }
  addInstanced(group, tuftGeo, tuftMat, tufts, false);

  /* ---------------- street lamps ----------------
   * These are the main reason the night zone is now navigable: a regular line
   * of bright heads gives the road an edge you can actually follow. */
  const poles = [], arms = [], heads = [];
  for (let i = 0; i < frames.length - 1; i += LAMP_SPACING) {
    const side = (Math.floor(i / LAMP_SPACING) % 2 === 0) ? -1 : 1;
    const f = frames[i];
    const base = f.center.clone()
      .addScaledVector(f.right, side * (halfRoadWidth + 1.3))
      .addScaledVector(f.roadUp, -VERGE_DROP);
    const yaw = Math.atan2(f.right.x, f.right.z);
    poles.push({ pos: base.clone().setY(base.y + 2.6), yaw });
    arms.push({ pos: base.clone().setY(base.y + 5.05).addScaledVector(f.right, -side * 0.8), yaw });
    const headPos = base.clone().setY(base.y + 4.88).addScaledVector(f.right, -side * 1.55);
    heads.push({ pos: headPos, yaw });
  }
  addInstanced(group, poleGeo, poleMat, poles);
  addInstanced(group, armGeo, poleMat, arms);
  const headInst = addInstanced(group, headGeo, lampHeadMat, heads, false);
  if (headInst) lampHeads.push(...heads.map(h => h.pos));

  return { group, lampPositions: lampHeads };
}
