import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { sampleRoadFrame, roadHalfWidthAt } from './roadgen.js';
import { buildChunkScenery, VERGE_WIDTH } from './scenery.js';
import { groundTintAt } from './zones.js';
import { hash1, octaveNoise } from './noise.js';

/* Chunks are now indexed by ARC LENGTH along the road, not by world z. On a
 * road that genuinely turns those are different quantities, and indexing by z
 * would tear the world apart at every hairpin: two stretches of road hundreds of
 * metres apart can share a z, so they would fight over the same chunk slot. */
const CHUNK_LENGTH = 120;        // metres of road per chunk
/* Raised from 24. Real corners get down to a ~45 m radius, and at 5 m per
 * segment the ribbon visibly cut the apex and the physics surface was faceted
 * enough to unsettle the car mid-corner. 40 segments (3 m) tracks a hairpin to
 * within 25 mm. */
const SEGMENTS_PER_CHUNK = 40;

const LOAD_AHEAD_BASE = 700;
const LOAD_AHEAD_PER_SPEED = 9;
const LOAD_BEHIND = 260;

const SLAB_THICKNESS = 4;

export const ROAD_MATERIAL = new CANNON.Material('road');
export const BARRIER_MATERIAL = new CANNON.Material('barrier');

const BARRIER_HEIGHT = 1.15;
const BARRIER_THICKNESS = 0.4;
const BARRIER_STEP = 3;          // one barrier box per N road segments

/* ---------------------------------------------------------------------------
 * Hillside skirt
 *
 * The road used to end at the verge, with nothing beyond it: from the car you
 * were driving along a ribbon floating in fog. The skirt extends the ground
 * outward in rings, rising into a hillside on one side and falling into a
 * valley on the other, which both fills the void and gives the corners
 * something to be cut into.
 * ------------------------------------------------------------------------ */
const SKIRT_RINGS = [
  { dist: 8, drop: 1.2, noise: 1.6 },
  { dist: 22, drop: 3.0, noise: 5.0 },
  { dist: 48, drop: 5.0, noise: 12.0 },
  { dist: 95, drop: 6.0, noise: 24.0 },
  { dist: 170, drop: 4.0, noise: 38.0 },
];

const roadMat = new THREE.MeshLambertMaterial({ color: 0x4a4453, flatShading: true });
const shoulderMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const skirtMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const barrierMat = new THREE.MeshLambertMaterial({ color: 0xf2f0e6, flatShading: true });
/* Markings are unlit so they stay legible at night and in fog, which is exactly
 * when you most need to see where the road goes. */
const markingMat = new THREE.MeshBasicMaterial({ color: 0xe8e4d4, transparent: true, opacity: 0.9 });
const barrierGeo = new THREE.BoxGeometry(1, 1, 1);

const MARKING_LIFT = 0.035;      // metres above the tarmac, to beat z-fighting
const EDGE_LINE_WIDTH = 0.28;
const CENTRE_DASH_WIDTH = 0.22;
const CENTRE_DASH_ON = 4;        // segments painted
const CENTRE_DASH_OFF = 4;       // segments skipped

const _m4 = new THREE.Matrix4();
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _tint = new THREE.Color();

/** Orientation whose local +Z runs along `dir` and whose local +Y is roughly up. */
function orientAlong(dir) {
  _zAxis.copy(dir).normalize();
  _xAxis.crossVectors(_worldUp, _zAxis);
  if (_xAxis.lengthSq() < 1e-6) _xAxis.set(1, 0, 0);
  _xAxis.normalize();
  _yAxis.crossVectors(_zAxis, _xAxis).normalize();
  _m4.makeBasis(_xAxis, _yAxis, _zAxis);
  return new THREE.Quaternion().setFromRotationMatrix(_m4);
}

/** Terrain height offset for a point `d` metres to `side` of the road at `s`. */
function skirtHeight(s, side, ring) {
  // Two independent noise fields so the two sides of the road are never mirror
  // images of each other, which reads as obviously artificial.
  const n = octaveNoise((s + (side > 0 ? 4000 : -4000)) * 0.006, 3, 0.5);
  const m = octaveNoise((s + (side > 0 ? 811 : 1907)) * 0.0016, 2, 0.55);
  return -ring.drop + (n * 0.45 + m * 0.75) * ring.noise;
}

/**
 * Builds one chunk: road ribbon, painted markings, verge, hillside skirt,
 * guardrails and scenery, plus the single static physics body for all of it.
 */
function buildChunk(chunkIndex) {
  const startS = chunkIndex * CHUNK_LENGTH;

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const shoulderPositions = [];
  const shoulderIndices = [];
  const shoulderColors = [];
  const markPositions = [];
  const markIndices = [];
  const skirtPositions = [];
  const skirtIndices = [];
  const skirtColors = [];

  const frames = [];
  const halfWidths = [];
  const leftEdge = [];
  const rightEdge = [];
  const ups = [];

  const ringCount = SKIRT_RINGS.length;
  // one column per side per ring, plus the two verge-edge columns they hang off
  const skirtCols = (ringCount + 1) * 2;

  for (let i = 0; i <= SEGMENTS_PER_CHUNK; i++) {
    // sampleRoadFrame is a pure function of s, and neighbouring chunks sample
    // the identical s at their shared boundary, so chunks meet with no seam.
    const s = startS + (i / SEGMENTS_PER_CHUNK) * CHUNK_LENGTH;
    const frame = sampleRoadFrame(s);
    const halfW = roadHalfWidthAt(s);
    frames.push(frame);
    halfWidths.push(halfW);

    const l = frame.center.clone().addScaledVector(frame.right, -halfW);
    const r = frame.center.clone().addScaledVector(frame.right, halfW);
    leftEdge.push(l);
    rightEdge.push(r);
    ups.push(frame.roadUp.clone());

    positions.push(l.x, l.y, l.z, r.x, r.y, r.z);
    normals.push(
      frame.roadUp.x, frame.roadUp.y, frame.roadUp.z,
      frame.roadUp.x, frame.roadUp.y, frame.roadUp.z,
    );
    uvs.push(0, s * 0.15, 1, s * 0.15);

    /* ---- verge ---- */
    const shHalfW = halfW + VERGE_WIDTH;
    const sl = frame.center.clone().addScaledVector(frame.right, -shHalfW).addScaledVector(frame.roadUp, -0.18);
    const sr = frame.center.clone().addScaledVector(frame.right, shHalfW).addScaledVector(frame.roadUp, -0.18);
    shoulderPositions.push(sl.x, sl.y, sl.z, l.x, l.y, l.z, r.x, r.y, r.z, sr.x, sr.y, sr.z);

    groundTintAt(s, _tint);
    const v = 0.82 + 0.36 * hash1(s * 0.37);
    for (let k = 0; k < 4; k++) shoulderColors.push(_tint.r * v, _tint.g * v, _tint.b * v);

    /* ---- hillside skirt ----
     * Columns run left-outermost -> left-inner -> right-inner -> right-outermost
     * so the strip triangulation below is a simple march across the row. */
    const rowStart = i * skirtCols;
    const cols = [];
    for (let ri = ringCount - 1; ri >= 0; ri--) {
      const ring = SKIRT_RINGS[ri];
      cols.push({ side: -1, dist: shHalfW + ring.dist, h: skirtHeight(s, -1, ring), far: ri });
    }
    cols.push({ side: -1, dist: shHalfW, h: -0.18, far: -1 });
    cols.push({ side: 1, dist: shHalfW, h: -0.18, far: -1 });
    for (let ri = 0; ri < ringCount; ri++) {
      const ring = SKIRT_RINGS[ri];
      cols.push({ side: 1, dist: shHalfW + ring.dist, h: skirtHeight(s, 1, ring), far: ri });
    }

    for (const c of cols) {
      const p = frame.center.clone()
        .addScaledVector(frame.right, c.side * c.dist)
        .addScaledVector(_worldUp, c.h);
      skirtPositions.push(p.x, p.y, p.z);
      // Distant ground darkens and desaturates slightly, which reads as aerial
      // perspective and stops the far hills competing with the road for
      // attention.
      const fade = c.far < 0 ? 1 : 1 - 0.1 * (c.far / Math.max(1, ringCount - 1));
      const jitter = 0.86 + 0.28 * hash1(s * 0.21 + c.dist * 1.7);
      skirtColors.push(_tint.r * fade * jitter, _tint.g * fade * jitter, _tint.b * fade * jitter);
    }

    /* ---- painted markings ----
     * Built as their own thin quads rather than a texture: the road is a raw
     * BufferGeometry with no UV atlas, and a handful of extra triangles is far
     * cheaper than introducing a texture pipeline for two stripes. */
    const lift = MARKING_LIFT;
    const pushStrip = (offset, width) => {
      const a = frame.center.clone()
        .addScaledVector(frame.right, offset - width / 2)
        .addScaledVector(frame.roadUp, lift);
      const b = frame.center.clone()
        .addScaledVector(frame.right, offset + width / 2)
        .addScaledVector(frame.roadUp, lift);
      markPositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    };
    pushStrip(-halfW + 0.55, EDGE_LINE_WIDTH);
    pushStrip(0, CENTRE_DASH_WIDTH);
    pushStrip(halfW - 0.55, EDGE_LINE_WIDTH);

    if (i < SEGMENTS_PER_CHUNK) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);

      const base = i * 4;
      shoulderIndices.push(base, base + 4, base + 1, base + 1, base + 4, base + 5);
      shoulderIndices.push(base + 2, base + 6, base + 3, base + 3, base + 6, base + 7);

      const nextRow = rowStart + skirtCols;
      for (let c2 = 0; c2 < skirtCols - 1; c2++) {
        const p0 = rowStart + c2, p1 = rowStart + c2 + 1;
        const q0 = nextRow + c2, q1 = nextRow + c2 + 1;
        skirtIndices.push(p0, q0, p1, p1, q0, q1);
      }

      // 3 strips x 2 verts per row
      const mBase = i * 6;
      const mNext = (i + 1) * 6;
      for (let stripI = 0; stripI < 3; stripI++) {
        // the centre strip is dashed; edge lines are continuous
        if (stripI === 1) {
          const period = CENTRE_DASH_ON + CENTRE_DASH_OFF;
          if (i % period >= CENTRE_DASH_ON) continue;
        }
        const a0 = mBase + stripI * 2, b0 = a0 + 1;
        const a1 = mNext + stripI * 2, b1 = a1 + 1;
        markIndices.push(a0, a1, b0, b0, a1, b1);
      }
    }
  }

  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  roadGeo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  roadGeo.setIndex(indices);
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;

  const markGeo = new THREE.BufferGeometry();
  markGeo.setAttribute('position', new THREE.Float32BufferAttribute(markPositions, 3));
  markGeo.setIndex(markIndices);
  markGeo.computeVertexNormals();
  const markMesh = new THREE.Mesh(markGeo, markingMat);

  const shoulderGeo = new THREE.BufferGeometry();
  shoulderGeo.setAttribute('position', new THREE.Float32BufferAttribute(shoulderPositions, 3));
  shoulderGeo.setAttribute('color', new THREE.Float32BufferAttribute(shoulderColors, 3));
  shoulderGeo.setIndex(shoulderIndices);
  shoulderGeo.computeVertexNormals();
  const shoulderMesh = new THREE.Mesh(shoulderGeo, shoulderMat);
  shoulderMesh.receiveShadow = true;

  const skirtGeo = new THREE.BufferGeometry();
  skirtGeo.setAttribute('position', new THREE.Float32BufferAttribute(skirtPositions, 3));
  skirtGeo.setAttribute('color', new THREE.Float32BufferAttribute(skirtColors, 3));
  skirtGeo.setIndex(skirtIndices);
  skirtGeo.computeVertexNormals();
  const skirtMesh = new THREE.Mesh(skirtGeo, skirtMat);

  /* ---------------- physics: road slab + solid guardrails ----------------
   * Only the tarmac is collidable. The skirt is scenery: making 170 m of noisy
   * hillside per chunk collidable would multiply the trimesh cost for terrain
   * the guardrails already prevent the car from reaching. */
  const topVertCount = positions.length / 3;
  const physPositions = positions.slice();
  const physIndices = indices.slice();

  for (let i = 0; i < topVertCount; i++) {
    physPositions.push(positions[i * 3], positions[i * 3 + 1] - SLAB_THICKNESS, positions[i * 3 + 2]);
  }
  for (let i = 0; i < SEGMENTS_PER_CHUNK; i++) {
    const aT = i * 2, bT = i * 2 + 1, cT = (i + 1) * 2, dT = (i + 1) * 2 + 1;
    const aB = aT + topVertCount, bB = bT + topVertCount, cB = cT + topVertCount, dB = dT + topVertCount;
    physIndices.push(aT, cT, aB, aB, cT, cB);   // left wall
    physIndices.push(bT, bB, dT, dT, bB, dB);   // right wall
    physIndices.push(aB, bB, cB, cB, bB, dB);   // bottom cap
  }

  const roadBody = new CANNON.Body({ mass: 0 });
  const roadShape = new CANNON.Trimesh(physPositions, physIndices);
  roadShape.material = ROAD_MATERIAL;
  roadBody.addShape(roadShape);

  const barrierTransforms = [];
  for (let i = 0; i + BARRIER_STEP <= SEGMENTS_PER_CHUNK; i += BARRIER_STEP) {
    for (const [edge, outward] of [[leftEdge, -1], [rightEdge, 1]]) {
      const a = edge[i];
      const b = edge[i + BARRIER_STEP];
      const dir = new THREE.Vector3().subVectors(b, a);
      const length = dir.length();
      if (length < 1e-4) continue;

      const up = ups[i];
      const right = new THREE.Vector3()
        .crossVectors(dir.clone().normalize(), up).normalize().multiplyScalar(-outward);
      /* The barrier is pushed slightly OUTWARD from the tarmac edge as well as
       * up. On a corner the road widens, so a rail sitting exactly on the edge
       * of segment i overlaps the driving surface of segment i+1 and clips the
       * car for no visible reason. */
      const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
        .addScaledVector(up, BARRIER_HEIGHT / 2)
        .addScaledVector(right, BARRIER_THICKNESS / 2 + 0.12);
      const quat = orientAlong(dir);

      const barrierShape = new CANNON.Box(
        new CANNON.Vec3(BARRIER_THICKNESS / 2, BARRIER_HEIGHT / 2, length / 2),
      );
      barrierShape.material = BARRIER_MATERIAL;
      roadBody.addShape(
        barrierShape,
        new CANNON.Vec3(mid.x, mid.y, mid.z),
        new CANNON.Quaternion(quat.x, quat.y, quat.z, quat.w),
      );
      barrierTransforms.push({ mid, quat, length });
    }
  }

  const barrierInst = new THREE.InstancedMesh(barrierGeo, barrierMat, barrierTransforms.length);
  barrierInst.castShadow = true;
  const dummy = new THREE.Object3D();
  barrierTransforms.forEach((t, i) => {
    dummy.position.copy(t.mid);
    dummy.quaternion.copy(t.quat);
    dummy.scale.set(BARRIER_THICKNESS, BARRIER_HEIGHT, t.length);
    dummy.updateMatrix();
    barrierInst.setMatrixAt(i, dummy.matrix);
  });
  barrierInst.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.add(skirtMesh, shoulderMesh, roadMesh, markMesh, barrierInst);

  const scenery = buildChunkScenery(frames, halfWidths, chunkIndex);
  group.add(scenery.group);

  return { mesh: group, physicsBody: roadBody, lampPositions: scenery.lampPositions };
}

export function createTerrainManager(scene, world) {
  const chunks = new Map();

  const chunkIndexForS = (s) => Math.floor(s / CHUNK_LENGTH);

  function loadChunk(idx) {
    if (idx < 0 || chunks.has(idx)) return;
    const chunk = buildChunk(idx);
    scene.add(chunk.mesh);
    world.addBody(chunk.physicsBody);
    chunks.set(idx, chunk);
  }

  function unloadChunk(idx) {
    const chunk = chunks.get(idx);
    if (!chunk) return;
    scene.remove(chunk.mesh);
    world.removeBody(chunk.physicsBody);
    // materials are module-level and shared, so only per-chunk geometry and
    // instance buffers are freed here
    chunk.mesh.traverse((obj) => {
      if (obj.isInstancedMesh) obj.dispose();
      else if (obj.geometry) obj.geometry.dispose();
    });
    chunks.delete(idx);
  }

  /**
   * Streams chunks in ahead of arc length `s`, drops old ones behind it.
   * @param {number} s current arc length along the road
   * @param {number} speed m/s, widens the lookahead so a fast car always has
   *        more loaded road ahead than it can cover before the next update
   */
  function update(s, speed = 0) {
    const lookAhead = LOAD_AHEAD_BASE + Math.max(0, speed) * LOAD_AHEAD_PER_SPEED;
    const minIdx = Math.max(0, chunkIndexForS(s - LOAD_BEHIND));
    const maxIdx = chunkIndexForS(s + lookAhead);
    for (let i = minIdx; i <= maxIdx; i++) loadChunk(i);
    for (const idx of Array.from(chunks.keys())) {
      if (idx < minIdx || idx > maxIdx) unloadChunk(idx);
    }
  }

  /** Preloads the window of chunks around the spawn point, reporting progress. */
  async function ensureRange(centerS, onProgress = () => Promise.resolve()) {
    const minIdx = Math.max(0, chunkIndexForS(centerS - LOAD_BEHIND));
    const maxIdx = chunkIndexForS(centerS + LOAD_AHEAD_BASE);
    const total = Math.max(1, maxIdx - minIdx + 1);
    let done = 0;
    for (let i = minIdx; i <= maxIdx; i++) {
      loadChunk(i);
      done++;
      await onProgress(done / total);
    }
  }

  return { update, ensureRange };
}
