import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { sampleRoadFrame, ROAD_WIDTH } from './roadgen.js';

const CHUNK_LENGTH = 120;       // meters of road per chunk
const SEGMENTS_PER_CHUNK = 10;  // ribbon segments per chunk (~12m spacing, close to the old track's 13m)
const RAIL_STEP = 2;            // guardrail post every N segments

// FIX: LOAD_AHEAD used to be a flat 700m no matter how fast the car was
// going. Building a chunk isn't free (each one now includes a solid physics
// slab, not just a thin visual sheet — more verts/indices than before), so
// if several chunks need to be built in the same frame, that frame takes
// longer, and a fast-moving or hard-accelerating car could reach ground
// whose physics body hadn't been added to the world yet — i.e. it drives
// onto a hole. LOAD_AHEAD is now a base distance plus a speed-scaled buffer,
// so the faster the car is going, the further ahead terrain streams in.
const LOAD_AHEAD_BASE = 700;     // minimum road kept loaded ahead, even at a standstill
const LOAD_AHEAD_PER_SPEED = 8;  // extra meters of buffer per m/s of current speed
const LOAD_BEHIND = 300;         // road kept loaded behind before unloading it

// FIX: the physics trimesh used to be built straight from the visual road
// ribbon's positions/indices — a single-layer sheet of triangles with zero
// thickness. cannon-es's raycast-vs-trimesh test is unreliable against sheets
// like that: at glancing angles, or right at chunk-boundary seams, a wheel
// raycast can miss the surface for a frame and find no contact, which lets
// the car fall straight through. SLAB_THICKNESS gives the physics-only copy
// of the mesh a solid closed volume (top face + matching bottom face + side
// walls) so there's no "back side" for a ray to slip past. The visual mesh
// is untouched — this only affects what the car collides with.
const SLAB_THICKNESS = 4;

const roadMat = new THREE.MeshLambertMaterial({ color: 0x4a4453, flatShading: true });
const shoulderMat = new THREE.MeshLambertMaterial({ color: 0x6b4a34, flatShading: true });
const postGeo = new THREE.BoxGeometry(0.25, 0.9, 0.25);
const postMat = new THREE.MeshLambertMaterial({ color: 0xf2f0e6 });

function buildChunk(chunkIndex) {
  const startZ = chunkIndex * CHUNK_LENGTH;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const shoulderPositions = [];
  const shoulderIndices = [];
  const railPts = [];

  for (let i = 0; i <= SEGMENTS_PER_CHUNK; i++) {
    // NOTE: this samples the exact same z values a neighboring chunk would
    // sample at its shared boundary, and sampleRoadFrame is a pure function
    // of z — so consecutive chunks always meet with zero seam gap, both
    // visually and in the physics trimesh.
    const z = startZ + (i / SEGMENTS_PER_CHUNK) * CHUNK_LENGTH;
    const frame = sampleRoadFrame(z);
    const halfW = ROAD_WIDTH / 2;
    const l = frame.center.clone().addScaledVector(frame.right, -halfW);
    const r = frame.center.clone().addScaledVector(frame.right, halfW);

    positions.push(l.x, l.y, l.z, r.x, r.y, r.z);
    normals.push(frame.roadUp.x, frame.roadUp.y, frame.roadUp.z, frame.roadUp.x, frame.roadUp.y, frame.roadUp.z);
    uvs.push(0, z * 0.15, 1, z * 0.15);

    const shHalfW = halfW + 5;
    const sl = frame.center.clone().addScaledVector(frame.right, -shHalfW).addScaledVector(frame.roadUp, -0.15);
    const sr = frame.center.clone().addScaledVector(frame.right, shHalfW).addScaledVector(frame.roadUp, -0.15);
    shoulderPositions.push(sl.x, sl.y, sl.z, l.x, l.y, l.z, r.x, r.y, r.z, sr.x, sr.y, sr.z);

    if (i % RAIL_STEP === 0) railPts.push(l, r);

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

  const railGroup = new THREE.Group();
  if (railPts.length > 0) {
    const railInst = new THREE.InstancedMesh(postGeo, postMat, railPts.length);
    railInst.castShadow = true;
    const dummy = new THREE.Object3D();
    railPts.forEach((pt, i) => {
      dummy.position.set(pt.x, pt.y + 0.45, pt.z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      railInst.setMatrixAt(i, dummy.matrix);
    });
    railGroup.add(railInst);
  }

  const group = new THREE.Group();
  group.add(shoulderMesh, roadMesh, railGroup);

  // ---------------- physics trimesh (solid slab, NOT the thin visual sheet) ----------------
  // Top layer = identical to the visual road surface, so what the car drives
  // on lines up exactly with what you see. Bottom layer is the same x/z,
  // offset straight down by SLAB_THICKNESS. Side walls + a bottom cap stitch
  // the two layers into a single closed solid.
  const topVertCount = positions.length / 3;
  const physPositions = positions.slice();
  const physIndices = indices.slice();

  for (let i = 0; i < topVertCount; i++) {
    physPositions.push(
      positions[i * 3],
      positions[i * 3 + 1] - SLAB_THICKNESS,
      positions[i * 3 + 2]
    );
  }

  for (let i = 0; i < SEGMENTS_PER_CHUNK; i++) {
    const aT = i * 2, bT = i * 2 + 1, cT = (i + 1) * 2, dT = (i + 1) * 2 + 1;
    const aB = aT + topVertCount, bB = bT + topVertCount, cB = cT + topVertCount, dB = dT + topVertCount;
    // left-edge wall (between the l-verts of consecutive rows)
    physIndices.push(aT, aB, cT, cT, aB, cB);
    // right-edge wall (between the r-verts of consecutive rows)
    physIndices.push(bT, dT, bB, bB, dT, dB);
    // bottom cap
    physIndices.push(aB, cB, bB, bB, cB, dB);
  }

  const trimeshShape = new CANNON.Trimesh(physPositions, physIndices);
  const roadBody = new CANNON.Body({ mass: 0 });
  roadBody.addShape(trimeshShape);

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
    // TEMP DEBUG — remove once the fall-through issue is confirmed fixed
    const shape = chunk.physicsBody.shapes[0];
    console.log(
      `[terrain] loaded chunk ${idx} | body pos`, chunk.physicsBody.position,
      '| shape.type:', shape.type, '(Trimesh should be 32768? or check CANNON.Shape.types.TRIMESH)',
      '| trimesh verts:', shape.vertices.length / 3,
      '| trimesh tris:', shape.indices.length / 3,
      '| world.bodies.length now:', world.bodies.length
    );
  }

  function unloadChunk(idx) {
    const chunk = chunks.get(idx);
    if (!chunk) return;
    scene.remove(chunk.mesh);
    world.removeBody(chunk.physicsBody);
    chunk.mesh.traverse((obj) => { if (obj.geometry) obj.geometry.dispose(); });
    chunks.delete(idx);
  }

  /**
   * Called every frame: streams chunks in ahead of `distance`, drops old ones
   * behind it. `speed` (m/s, optional) widens the lookahead so a fast car
   * always has more loaded road in front of it than it can cover before the
   * next update() call — a stalled frame no longer means driving into a gap.
   */
  function update(distance, speed = 0) {
    const lookAhead = LOAD_AHEAD_BASE + Math.max(0, speed) * LOAD_AHEAD_PER_SPEED;
    const minIdx = Math.max(0, chunkIndexForZ(distance - LOAD_BEHIND));
    const maxIdx = chunkIndexForZ(distance + lookAhead);
    for (let i = minIdx; i <= maxIdx; i++) loadChunk(i);
    for (const idx of Array.from(chunks.keys())) {
      if (idx < minIdx || idx > maxIdx) unloadChunk(idx);
    }
  }

  /** Called once at boot to preload the window of chunks around the spawn point, reporting progress. */
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