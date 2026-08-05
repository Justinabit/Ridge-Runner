import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { sampleRoadFrame, ROAD_WIDTH } from './roadgen.js';

const CHUNK_LENGTH = 120;       // meters of road per chunk
// FIX: raised from 10. At 12 m per segment the ribbon cut visible corners on
// bends and the physics surface was noticeably faceted, which made the car
// skip. 24 segments (5 m) tracks the curve closely for very little cost.
const SEGMENTS_PER_CHUNK = 24;

const LOAD_AHEAD_BASE = 700;     // minimum road kept loaded ahead, even stationary
const LOAD_AHEAD_PER_SPEED = 8;  // extra meters of buffer per m/s of current speed
const LOAD_BEHIND = 300;         // road kept loaded behind before unloading

// The physics copy of the road is a closed solid rather than the thin visual
// sheet: cannon-es's ray-vs-trimesh test is unreliable against zero-thickness
// surfaces at glancing angles and at chunk seams, where a wheel ray can slip
// past for a frame. A slab gives the ray no "back side" to escape through.
const SLAB_THICKNESS = 4;

/* Guardrails. Previously these were decorative posts with no physics at all,
 * so nothing stopped the car leaving the road: once off the edge there was no
 * ground beneath it and it fell until the "out of the world" check fired. They
 * are now solid, which is what turns a mistake into a recoverable scrape
 * instead of an instant run-ending fall. */
const BARRIER_HEIGHT = 1.2;
const BARRIER_THICKNESS = 0.4;
const BARRIER_STEP = 2;          // one barrier box per N road segments

const roadMat = new THREE.MeshLambertMaterial({ color: 0x4a4453, flatShading: true });
const shoulderMat = new THREE.MeshLambertMaterial({ color: 0x6b4a34, flatShading: true });
const barrierMat = new THREE.MeshLambertMaterial({ color: 0xf2f0e6, flatShading: true });
const barrierGeo = new THREE.BoxGeometry(1, 1, 1);

const _m4 = new THREE.Matrix4();
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);

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

function buildChunk(chunkIndex) {
  const startZ = chunkIndex * CHUNK_LENGTH;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const shoulderPositions = [];
  const shoulderIndices = [];
  const leftEdge = [];
  const rightEdge = [];
  const ups = [];

  for (let i = 0; i <= SEGMENTS_PER_CHUNK; i++) {
    // sampleRoadFrame is a pure function of z and neighbouring chunks sample
    // the identical z at their shared boundary, so chunks meet with no seam.
    const z = startZ + (i / SEGMENTS_PER_CHUNK) * CHUNK_LENGTH;
    const frame = sampleRoadFrame(z);
    const halfW = ROAD_WIDTH / 2;
    const l = frame.center.clone().addScaledVector(frame.right, -halfW);
    const r = frame.center.clone().addScaledVector(frame.right, halfW);
    leftEdge.push(l);
    rightEdge.push(r);
    ups.push(frame.roadUp.clone());

    positions.push(l.x, l.y, l.z, r.x, r.y, r.z);
    normals.push(frame.roadUp.x, frame.roadUp.y, frame.roadUp.z, frame.roadUp.x, frame.roadUp.y, frame.roadUp.z);
    uvs.push(0, z * 0.15, 1, z * 0.15);

    const shHalfW = halfW + 5;
    const sl = frame.center.clone().addScaledVector(frame.right, -shHalfW).addScaledVector(frame.roadUp, -0.15);
    const sr = frame.center.clone().addScaledVector(frame.right, shHalfW).addScaledVector(frame.roadUp, -0.15);
    shoulderPositions.push(sl.x, sl.y, sl.z, l.x, l.y, l.z, r.x, r.y, r.z, sr.x, sr.y, sr.z);

    if (i < SEGMENTS_PER_CHUNK) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
      const base = i * 4;
      shoulderIndices.push(base, base + 4, base + 1, base + 1, base + 4, base + 5);
      shoulderIndices.push(base + 2, base + 6, base + 3, base + 3, base + 6, base + 7);
    }
  }

  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  roadGeo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  roadGeo.setIndex(indices);
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;

  const shoulderGeo = new THREE.BufferGeometry();
  shoulderGeo.setAttribute('position', new THREE.Float32BufferAttribute(shoulderPositions, 3));
  shoulderGeo.setIndex(shoulderIndices);
  shoulderGeo.computeVertexNormals();
  const shoulderMesh = new THREE.Mesh(shoulderGeo, shoulderMat);
  shoulderMesh.receiveShadow = true;

  // ---------------- physics body: road slab + solid guardrails ----------------
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
  roadBody.addShape(new CANNON.Trimesh(physPositions, physIndices));

  // guardrails: one box per BARRIER_STEP segments, on both edges, added as
  // extra shapes on the same static body so no additional bodies are created
  const barrierTransforms = [];
  for (let i = 0; i + BARRIER_STEP <= SEGMENTS_PER_CHUNK; i += BARRIER_STEP) {
    for (const [edge, outward] of [[leftEdge, -1], [rightEdge, 1]]) {
      const a = edge[i];
      const b = edge[i + BARRIER_STEP];
      const dir = new THREE.Vector3().subVectors(b, a);
      const length = dir.length();
      if (length < 1e-4) continue;

      const up = ups[i];
      const right = new THREE.Vector3().crossVectors(dir.clone().normalize(), up).normalize().multiplyScalar(-outward);
      const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
        .addScaledVector(up, BARRIER_HEIGHT / 2)
        .addScaledVector(right, BARRIER_THICKNESS / 2);
      const quat = orientAlong(dir);

      roadBody.addShape(
        new CANNON.Box(new CANNON.Vec3(BARRIER_THICKNESS / 2, BARRIER_HEIGHT / 2, length / 2)),
        new CANNON.Vec3(mid.x, mid.y, mid.z),
        new CANNON.Quaternion(quat.x, quat.y, quat.z, quat.w)
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
  group.add(shoulderMesh, roadMesh, barrierInst);

  return { mesh: group, physicsBody: roadBody };
}

export function createTerrainManager(scene, world) {
  const chunks = new Map();

  function chunkIndexForZ(z) {
    return Math.floor(z / CHUNK_LENGTH);
  }

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
    // FIX: geometry was disposed but InstancedMesh instances were not released
    // and materials are module-level shared, so only per-chunk geometry should
    // be freed. Also dispose the instanced barrier meshes explicitly.
    chunk.mesh.traverse((obj) => {
      if (obj.isInstancedMesh) obj.dispose();
      else if (obj.geometry) obj.geometry.dispose();
    });
    chunks.delete(idx);
  }

  /**
   * Streams chunks in ahead of `position`, drops old ones behind it. `speed`
   * (m/s) widens the lookahead so a fast car always has more loaded road ahead
   * than it can cover before the next update.
   */
  function update(position, speed = 0) {
    const lookAhead = LOAD_AHEAD_BASE + Math.max(0, speed) * LOAD_AHEAD_PER_SPEED;
    const minIdx = Math.max(0, chunkIndexForZ(position - LOAD_BEHIND));
    const maxIdx = chunkIndexForZ(position + lookAhead);
    for (let i = minIdx; i <= maxIdx; i++) loadChunk(i);
    for (const idx of Array.from(chunks.keys())) {
      if (idx < minIdx || idx > maxIdx) unloadChunk(idx);
    }
  }

  /** Preloads the window of chunks around the spawn point, reporting progress. */
  async function ensureRange(centerZ, onProgress = () => Promise.resolve()) {
    const minIdx = Math.max(0, chunkIndexForZ(centerZ - LOAD_BEHIND));
    const maxIdx = chunkIndexForZ(centerZ + LOAD_AHEAD_BASE);
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
