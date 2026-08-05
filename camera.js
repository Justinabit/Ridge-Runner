import * as THREE from 'three';

const CHASE_OFFSET = new THREE.Vector3(0, 3.4, -8.5);
const CHASE_LOOKAT_OFFSET = new THREE.Vector3(0, 1.1, 3);
const COCKPIT_OFFSET = new THREE.Vector3(0, 1.0, 0.6);

export function createCameraController(camera) {
  let mode = 'chase'; // 'chase' | 'cockpit'
  const currentPos = new THREE.Vector3();
  const currentLookAt = new THREE.Vector3();
  let initialized = false;

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
    camera.up.set(0, 1, 0);
    camera.lookAt(currentLookAt);

    const baseFov = mode === 'cockpit' ? 82 : 68;
    const speedBoost = Math.min(14, speed * 0.35);
    const airBoost = airborne ? 6 : 0;
    camera.fov = THREE.MathUtils.lerp(camera.fov, baseFov + speedBoost + airBoost, 0.08);
    camera.updateProjectionMatrix();
  }

  return { update, toggle, setMode, get mode() { return mode; } };
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