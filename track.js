import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { sampleRoad, ROAD_WIDTH } from './roadgen.js';

const RIBBON_STEP = 4; // meters between ribbon samples
const UP = new THREE.Vector3(0, 1, 0);

const ASPHALT_BASE = new THREE.Color(0x4a4453);
const ASPHALT_EDGE = new THREE.Color(0x322d3a);
const DASH_COLOR = new THREE.Color(0xf4e2a0);

/**
 * Builds the drivable ribbon (+ shoulders + guardrails + a dashed centerline)
 * for the z-range [startZ, endZ). Every vertex comes from sampleRoad(z), so a
 * neighboring chunk built for [endZ, endZ+len) will share an identical seam —
 * no cracks, and the physics trimesh always matches what's drawn.
 */
export function buildRoadChunk(startZ, endZ) {
  const steps = Math.max(1, Math.round((endZ - startZ) / RIBBON_STEP));
  const stepLen = (endZ - startZ) / steps;

  const positions = [];
  const colors = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const shoulderPositions = [];
  const shoulderIndices = [];
  const leftEdgePts = [];
  const rightEdgePts = [];
  const centerPts = [];
  const tangents = [];

  for (let i = 0; i <= steps; i++) {
    const z = startZ + i * stepLen;
    const s = sampleRoad(z);
    const sNext = sampleRoad(z + 0.5);
    const sPrev = sampleRoad(z - 0.5);
    const tangent = new THREE.Vector3(sNext.x - sPrev.x, sNext.y - sPrev.y, sNext.z - sPrev.z).normalize();

    let right = new THREE.Vector3().crossVectors(tangent, UP).normalize();
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    const quat = new THREE.Quaternion().setFromAxisAngle(tangent, s.bank);
    right.applyQuaternion(quat);
    const roadUp = new THREE.Vector3().crossVectors(right, tangent).normalize();

    const p = new THREE.Vector3(s.x, s.y, s.z);
    const halfW = ROAD_WIDTH / 2;
    const l = p.clone().addScaledVector(right, -halfW);
    const r = p.clone().addScaledVector(right, halfW);
    leftEdgePts.push(l);
    rightEdgePts.push(r);
    centerPts.push(p);
    tangents.push(tangent);

    positions.push(l.x, l.y, l.z, r.x, r.y, r.z);
    normals.push(roadUp.x, roadUp.y, roadUp.z, roadUp.x, roadUp.y, roadUp.z);
    uvs.push(0, z * 0.15, 1, z * 0.15);

    // subtle asphalt patchiness so the surface isn't a flat single color
    const shade = 0.85 + 0.3 * (Math.sin(z * 0.7 + s.x * 1.3) * 0.5 + 0.5) * 0.3;
    const cL = ASPHALT_EDGE.clone().lerp(ASPHALT_BASE, 0.4).multiplyScalar(shade);
    const cR = ASPHALT_EDGE.clone().lerp(ASPHALT_BASE, 0.4).multiplyScalar(shade);
    colors.push(cL.r, cL.g, cL.b, cR.r, cR.g, cR.b);

    // dirt shoulders (wider strip either side, slightly lower)
    const shHalfW = halfW + 5;
    const sl = p.clone().addScaledVector(right, -shHalfW).addScaledVector(roadUp, -0.15);
    const sr = p.clone().addScaledVector(right, shHalfW).addScaledVector(roadUp, -0.15);
    shoulderPositions.push(sl.x, sl.y, sl.z, l.x, l.y, l.z, r.x, r.y, r.z, sr.x, sr.y, sr.z);

    if (i < steps) {
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
  roadGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  roadGeo.setIndex(indices);
  const roadMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;

  const shoulderGeo = new THREE.BufferGeometry();
  shoulderGeo.setAttribute('position', new THREE.Float32BufferAttribute(shoulderPositions, 3));
  shoulderGeo.setIndex(shoulderIndices);
  shoulderGeo.computeVertexNormals();
  const shoulderMat = new THREE.MeshLambertMaterial({ color: 0x6b4a34, flatShading: true });
  const shoulderMesh = new THREE.Mesh(shoulderGeo, shoulderMat);
  shoulderMesh.receiveShadow = true;

  // guardrail posts along both edges (sparse, low-poly)
  const railGroup = new THREE.Group();
  const postGeo = new THREE.BoxGeometry(0.25, 0.9, 0.25);
  const postMat = new THREE.MeshLambertMaterial({ color: 0xf2f0e6 });
  const railStep = 3;
  const railCount = (Math.ceil(steps / railStep) + 1) * 2;
  const railInst = new THREE.InstancedMesh(postGeo, postMat, railCount);
  railInst.castShadow = true;
  let railI = 0;
  const dummy = new THREE.Object3D();
  for (let i = 0; i < steps; i += railStep) {
    for (const pt of [leftEdgePts[i], rightEdgePts[i]]) {
      dummy.position.set(pt.x, pt.y + 0.45, pt.z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      railInst.setMatrixAt(railI++, dummy.matrix);
    }
  }
  railInst.count = railI;
  railGroup.add(railInst);

  // dashed centerline paint
  const dashGeo = new THREE.BoxGeometry(0.35, 0.03, 2.2);
  const dashMat = new THREE.MeshBasicMaterial({ color: DASH_COLOR });
  const dashStep = 2; // every 2 ribbon samples (~8m) attempt a dash
  const dashCount = Math.ceil(steps / dashStep) + 1;
  const dashInst = new THREE.InstancedMesh(dashGeo, dashMat, dashCount);
  let dashI = 0;
  for (let i = 0; i < steps; i += dashStep) {
    if (Math.floor(i / dashStep) % 2 !== 0) continue; // skip every other slot for the dash gap
    const p = centerPts[i];
    const t = tangents[i];
    const yaw = Math.atan2(t.x, t.z);
    dummy.position.set(p.x, p.y + 0.08, p.z);
    dummy.rotation.set(0, yaw, 0);
    dummy.updateMatrix();
    dashInst.setMatrixAt(dashI++, dummy.matrix);
  }
  dashInst.count = dashI;

  const group = new THREE.Group();
  group.add(shoulderMesh, roadMesh, railGroup, dashInst);

  // ---------------- physics trimesh (matches drivable ribbon exactly) ----------------
  const trimeshShape = new CANNON.Trimesh(positions, indices);
  const roadBody = new CANNON.Body({ mass: 0 });
  roadBody.addShape(trimeshShape);

  return { group, physicsBody: roadBody, leftEdgePts, rightEdgePts, centerPts };
}