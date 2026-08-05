import * as THREE from 'three';

const CHASE_OFFSET = new THREE.Vector3(0, 3.4, -8.5);
const CHASE_LOOKAT_OFFSET = new THREE.Vector3(0, 1.1, 3);
const COCKPIT_OFFSET = new THREE.Vector3(0, 1.0, 0.6);

export function createCameraController(camera) {
  let mode = 'chase'; // 'chase' | 'cockpit'
  const currentPos = new THREE.Vector3();
  const currentLookAt = new THREE.Vector3();
  let initialized = false;

  /* Trauma-based shake: callers add trauma, and the actual shake is trauma
   * squared. Squaring means small knocks are barely felt while a real impact
   * is violent, and the decay is smooth rather than a hard cut-off. */
  let trauma = 0;
  let shakeSeed = Math.random() * 1000;
  let boostBlend = 0;

  function addTrauma(amount) {
    trauma = THREE.MathUtils.clamp(trauma + amount, 0, 1);
  }
  function setBoost(active) {
    boostBlend = THREE.MathUtils.clamp(boostBlend + (active ? 0.12 : -0.08), 0, 1);
  }

  function toggle() {
    mode = mode === 'chase' ? 'cockpit' : 'chase';
    return mode;
  }

  function setMode(m) { mode = m; }

  /**
   * @param {THREE.Object3D} target vehicle group (position+quaternion already synced)
   * @param {number} speed current speed (m/s) used for dynamic FOV
   * @param {boolean} airborne
   * @param {number} dt
   */
  function update(target, speed, airborne, dt) {
    trauma = Math.max(0, trauma - dt * 1.5);
    const targetPos = target.position;
    const targetQuat = target.quaternion;

    let desiredPos, lookAt;

    if (mode === 'cockpit') {
      desiredPos = COCKPIT_OFFSET.clone().applyQuaternion(targetQuat).add(targetPos);
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(targetQuat);
      lookAt = desiredPos.clone().add(forward.multiplyScalar(10));
    } else {
      // during flips, blend the chase offset's "up" toward world-up so the camera
      // doesn't spin wildly with the chassis
      const flatQuat = flattenQuaternion(targetQuat);
      desiredPos = CHASE_OFFSET.clone().applyQuaternion(flatQuat).add(targetPos);
      lookAt = CHASE_LOOKAT_OFFSET.clone().applyQuaternion(flatQuat).add(targetPos);
    }

    if (!initialized) {
      currentPos.copy(desiredPos);
      currentLookAt.copy(lookAt);
      initialized = true;
    }

    const posLerp = mode === 'cockpit' ? 1 : 1 - Math.pow(0.0025, dt);
    const lookLerp = mode === 'cockpit' ? 1 : 1 - Math.pow(0.001, dt);
    currentPos.lerp(desiredPos, THREE.MathUtils.clamp(posLerp, 0, 1));
    currentLookAt.lerp(lookAt, THREE.MathUtils.clamp(lookLerp, 0, 1));

    camera.position.copy(currentPos);

    // shake displaces the camera and rolls it slightly; using smooth noise
    // rather than pure random keeps it from looking like a strobe
    if (trauma > 0.001) {
      const s2 = trauma * trauma;
      shakeSeed += dt * 34;
      const nx = Math.sin(shakeSeed * 1.7) * Math.sin(shakeSeed * 0.53);
      const ny = Math.sin(shakeSeed * 2.3 + 1.7) * Math.sin(shakeSeed * 0.61);
      const nz = Math.sin(shakeSeed * 1.13 + 3.1) * Math.sin(shakeSeed * 0.47);
      camera.position.x += nx * s2 * 1.5;
      camera.position.y += ny * s2 * 1.1;
      camera.position.z += nz * s2 * 0.9;
      camera.up.set(nx * s2 * 0.28, 1, 0).normalize();
    } else {
      camera.up.set(0, 1, 0);
    }
    camera.lookAt(currentLookAt);

    const baseFov = mode === 'cockpit' ? 82 : 68;
    const speedBoost = Math.min(14, speed * 0.35);
    const airBoost = airborne ? 6 : 0;
    const boostKick = boostBlend * 12;          // FOV punch while boosting
    const traumaKick = trauma * trauma * 4;
    const targetFov = baseFov + speedBoost + airBoost + boostKick + traumaKick;
    // frame-rate independent, unlike the old fixed 0.08 lerp
    camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, 1 - Math.pow(0.02, dt));
    camera.updateProjectionMatrix();
  }

  return { update, toggle, setMode, addTrauma, setBoost, get mode() { return mode; } };
}

// projects a quaternion's yaw (rotation about world Y) only, ignoring pitch/roll,
// so the chase camera stays upright and stable during flips/rolls.
function flattenQuaternion(q) {
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1);
  forward.normalize();
  const yaw = Math.atan2(forward.x, forward.z);
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
}