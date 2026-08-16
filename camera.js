import * as THREE from 'three';

const CHASE_OFFSET = new THREE.Vector3(0, 3.6, -9.0);
const CHASE_LOOKAT_OFFSET = new THREE.Vector3(0, 1.2, 6);
const COCKPIT_OFFSET = new THREE.Vector3(0, 1.0, 0.6);

/* On a road that genuinely turns, a camera rigidly locked behind the car shows
 * you the outside of every corner and none of the road you are about to drive
 * on. These two let it lead into the bend instead. */
const CORNER_LOOK_AHEAD = 26;    // metres of extra look-ahead into a corner
const CORNER_SWING = 5.0;        // metres the camera swings toward the inside

export function createCameraController(camera) {
  let mode = 'chase'; // 'chase' | 'cockpit'
  const currentPos = new THREE.Vector3();
  const currentLookAt = new THREE.Vector3();
  let initialized = false;

  /* Trauma-based shake: callers add trauma, and the actual shake is trauma
   * squared. Squaring means small knocks are barely felt while a real impact is
   * violent, and the decay is smooth rather than a hard cut-off. */
  let trauma = 0;
  let shakeSeed = Math.random() * 1000;
  let boostBlend = 0;

  // smoothed road-curvature reading, so the camera eases into a bend rather
  // than snapping the instant the curvature value changes
  let curveBlend = 0;
  let leanBlend = 0;

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

  const _aheadPoint = new THREE.Vector3();
  const _sideways = new THREE.Vector3();

  /**
   * @param {THREE.Object3D} target vehicle group (position+quaternion synced)
   * @param {number} speed current speed (m/s), drives dynamic FOV
   * @param {boolean} airborne
   * @param {number} dt
   * @param {object} [road] optional road info ahead of the car:
   *        {curvature, aheadPoint} — lets the camera look into the corner
   */
  function update(target, speed, airborne, dt, road = null) {
    trauma = Math.max(0, trauma - dt * 1.5);
    const targetPos = target.position;
    const targetQuat = target.quaternion;

    /* Curvature is signed: positive turns toward the road frame's `right`.
     * Normalised against a fairly tight radius so an ordinary bend already
     * produces most of the effect and a hairpin just saturates it. */
    const rawCurve = road ? THREE.MathUtils.clamp(road.curvature / 0.014, -1, 1) : 0;
    curveBlend = THREE.MathUtils.lerp(curveBlend, rawCurve, 1 - Math.pow(0.02, dt));
    leanBlend = THREE.MathUtils.lerp(leanBlend, rawCurve, 1 - Math.pow(0.35, dt));

    let desiredPos, lookAt;

    if (mode === 'cockpit') {
      desiredPos = COCKPIT_OFFSET.clone().applyQuaternion(targetQuat).add(targetPos);
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(targetQuat);
      lookAt = desiredPos.clone().add(forward.multiplyScalar(10));
      // in cockpit view, glance into the corner rather than moving the camera
      if (road?.aheadPoint) {
        lookAt.lerp(road.aheadPoint, 0.35 * Math.abs(curveBlend));
      }
    } else {
      // during flips, blend the chase offset's "up" toward world-up so the
      // camera doesn't spin wildly with the chassis
      const flatQuat = flattenQuaternion(targetQuat);
      desiredPos = CHASE_OFFSET.clone().applyQuaternion(flatQuat).add(targetPos);
      lookAt = CHASE_LOOKAT_OFFSET.clone().applyQuaternion(flatQuat).add(targetPos);

      /* Swing the camera toward the INSIDE of the bend and aim it further up the
       * road. Together these show the corner exit well before the car reaches
       * the apex, which is the difference between a corner you can drive and one
       * you can only memorise. */
      if (road) {
        _sideways.set(1, 0, 0).applyQuaternion(flatQuat);
        desiredPos.addScaledVector(_sideways, -curveBlend * CORNER_SWING);

        if (road.aheadPoint) {
          _aheadPoint.copy(road.aheadPoint);
          _aheadPoint.y += 1.2;
          lookAt.lerp(_aheadPoint, 0.5 * Math.abs(curveBlend));
        } else {
          const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(flatQuat);
          lookAt.addScaledVector(fwd, Math.abs(curveBlend) * CORNER_LOOK_AHEAD * 0.3);
        }
      }
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

    /* Camera roll. A slight lean into the corner, plus the shake roll. Both go
     * through camera.up, so they have to be composed rather than assigned — the
     * shake branch used to overwrite `up` outright, which would silently discard
     * the corner lean whenever anything was shaking. */
    let upX = -leanBlend * 0.06;
    let upZ = 0;

    // shake displaces the camera and rolls it slightly; smooth noise rather than
    // pure random keeps it from looking like a strobe
    if (trauma > 0.001) {
      const s2 = trauma * trauma;
      shakeSeed += dt * 34;
      const nx = Math.sin(shakeSeed * 1.7) * Math.sin(shakeSeed * 0.53);
      const ny = Math.sin(shakeSeed * 2.3 + 1.7) * Math.sin(shakeSeed * 0.61);
      const nz = Math.sin(shakeSeed * 1.13 + 3.1) * Math.sin(shakeSeed * 0.47);
      camera.position.x += nx * s2 * 1.5;
      camera.position.y += ny * s2 * 1.1;
      camera.position.z += nz * s2 * 0.9;
      upX += nx * s2 * 0.28;
      upZ += nz * s2 * 0.12;
    }
    camera.up.set(upX, 1, upZ).normalize();
    camera.lookAt(currentLookAt);

    const baseFov = mode === 'cockpit' ? 82 : 68;
    const speedBoost = Math.min(14, speed * 0.35);
    const airBoost = airborne ? 6 : 0;
    const boostKick = boostBlend * 12;          // FOV punch while boosting
    const traumaKick = trauma * trauma * 4;
    const targetFov = baseFov + speedBoost + airBoost + boostKick + traumaKick;
    // frame-rate independent, unlike a fixed per-frame lerp
    camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, 1 - Math.pow(0.02, dt));
    camera.updateProjectionMatrix();
  }

  function reset() {
    initialized = false;
    trauma = 0;
    curveBlend = 0;
    leanBlend = 0;
  }

  return { update, toggle, setMode, addTrauma, setBoost, reset, get mode() { return mode; } };
}

// projects a quaternion's yaw (rotation about world Y) only, ignoring pitch and
// roll, so the chase camera stays upright and stable during flips
function flattenQuaternion(q) {
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1);
  forward.normalize();
  const yaw = Math.atan2(forward.x, forward.z);
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
}
