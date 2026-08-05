import * as THREE from 'three';
import * as CANNON from 'cannon-es';

const CHASSIS_SIZE = new CANNON.Vec3(1.0, 0.35, 2.1);
const WHEEL_RADIUS = 0.45;

/* ---------------------------------------------------------------------------
 * Drivetrain tuning
 *
 * FIX (top speed): the old values were 2600 N of engine force on a 165 kg
 * chassis, about 15.7 m/s^2 or 0-100 km/h in under two seconds. Worse,
 * cannon-es's RaycastVehicle models no aerodynamic drag at all, so nothing
 * ever opposed that force: the car accelerated without bound and was doing
 * ~880 km/h after twenty seconds of simulation.
 *
 * That was not only a feel problem, it directly caused the car to fall
 * through the road. A wheel only senses ground via a raycast reaching
 * suspensionRestLength + radius (~1.0 m) below its mount. At 60 Hz anything
 * faster than ~60 m/s travels further than that between steps, so the ray
 * starts and ends below the road and the car tunnels through solid geometry.
 *
 * Capping speed keeps per-step movement well inside the ray, which is what
 * makes contact stable. DRAG_COEFF is chosen so drag balances the engine
 * force right at TOP_SPEED.
 * ------------------------------------------------------------------------- */
const MAX_ENGINE_FORCE = 1500;
const TOP_SPEED = 34;                 // m/s, ~122 km/h
const REVERSE_TOP_SPEED = 9;
const DRAG_COEFF = MAX_ENGINE_FORCE / (TOP_SPEED * TOP_SPEED);
const ROLLING_RESISTANCE = 12;        // gentle coast-down when off the throttle

// FIX (brakes): was 60 N per wheel. Across a 165 kg car that is 1.45 m/s^2,
// so stopping from 100 km/h took ~19 s and ~260 m and braking felt inert.
// 350 N/wheel gives roughly 8.5 m/s^2, comparable to a real car.
const MAX_BRAKE_FORCE = 350;
const HANDBRAKE_FORCE = 1100;         // rear axle only, so it breaks traction

/* Steering */
const MAX_STEER = 0.55;               // radians (~31 deg) of front-wheel lock
const STEER_SPEED_FALLOFF = 0.62;     // fraction of lock removed at TOP_SPEED
const STEER_RESPONSE = 0.0009;        // lerp base; smaller = snappier

export function createVehicle(world, startPos = new THREE.Vector3(0, 6, 0)) {
  // ---------------- physics chassis ----------------
  const chassisShape = new CANNON.Box(CHASSIS_SIZE);
  const chassisBody = new CANNON.Body({ mass: 165 });
  chassisBody.addShape(chassisShape);
  chassisBody.position.set(startPos.x, startPos.y, startPos.z);
  chassisBody.angularVelocity.set(0, 0, 0);
  chassisBody.linearDamping = 0.02;
  chassisBody.angularDamping = 0.4;

  const vehicle = new CANNON.RaycastVehicle({
    chassisBody,
    indexRightAxis: 0,
    indexUpAxis: 1,
    indexForwardAxis: 2,
  });

  const wheelOptions = {
    radius: WHEEL_RADIUS,
    directionLocal: new CANNON.Vec3(0, -1, 0),
    suspensionStiffness: 32,
    // FIX: lengthened from 0.5. The wheel raycast reaches
    // suspensionRestLength + radius below its mount, so a longer rest length
    // literally lets the wheels see further down: more tolerance for landing
    // after a jump and for crossing chunk seams without losing contact.
    suspensionRestLength: 0.55,
    frictionSlip: 3.2,
    dampingRelaxation: 3.2,
    dampingCompression: 4.6,
    maxSuspensionForce: 100000,
    rollInfluence: 0.01,
    axleLocal: new CANNON.Vec3(1, 0, 0),
    chassisConnectionPointLocal: new CANNON.Vec3(),
    maxSuspensionTravel: 0.4,
    customSlidingRotationalSpeed: -30,
    useCustomSlidingRotationalSpeed: true,
  };

  // wheels 0/1 are the front axle (+Z is the nose) and are the steered pair;
  // 2/3 are the driven rear axle.
  const wheelConnections = [
    [-0.85, -0.1, 1.5],  // front-left
    [0.85, -0.1, 1.5],   // front-right
    [-0.85, -0.1, -1.5], // rear-left
    [0.85, -0.1, -1.5],  // rear-right
  ];
  const FRONT_WHEELS = [0, 1];
  const REAR_WHEELS = [2, 3];

  for (const [x, y, z] of wheelConnections) {
    wheelOptions.chassisConnectionPointLocal.set(x, y, z);
    vehicle.addWheel({ ...wheelOptions });
  }
  vehicle.addToWorld(world);
  vehicle.wheelInfos.forEach((w) => { w.frictionSlip = 3.2; });

  // ---------------- visual meshes ----------------
  const chassisGeo = new THREE.BoxGeometry(CHASSIS_SIZE.x * 2, CHASSIS_SIZE.y * 2, CHASSIS_SIZE.z * 2);
  const chassisMat = new THREE.MeshLambertMaterial({ color: 0xff6a3d, flatShading: true });
  const chassisMesh = new THREE.Mesh(chassisGeo, chassisMat);
  chassisMesh.castShadow = true;

  const bodyGroup = new THREE.Group();
  bodyGroup.add(chassisMesh);
  const cageMat = new THREE.MeshLambertMaterial({ color: 0x2a2233, flatShading: true });
  const cage = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1.2), cageMat);
  cage.position.set(0, 0.55, -0.2);
  cage.castShadow = true;
  bodyGroup.add(cage);

  const headlightGeo = new THREE.SphereGeometry(0.14, 8, 8);
  const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfff2c9 });
  const headlightL = new THREE.Mesh(headlightGeo, headlightMat);
  const headlightR = headlightL.clone();
  headlightL.position.set(-0.65, 0.1, 2.05);
  headlightR.position.set(0.65, 0.1, 2.05);
  bodyGroup.add(headlightL, headlightR);

  const headlightTarget = new THREE.Object3D();
  headlightTarget.position.set(0, -0.5, 20);
  const spotL = new THREE.SpotLight(0xfff2c9, 0, 40, Math.PI / 6, 0.5, 1.2);
  const spotR = spotL.clone();
  spotL.position.copy(headlightL.position);
  spotR.position.copy(headlightR.position);
  spotL.target = headlightTarget;
  spotR.target = headlightTarget;
  bodyGroup.add(spotL, spotR, headlightTarget);

  const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.35, 10);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x1c1720, flatShading: true });
  const wheelMeshes = wheelConnections.map(() => {
    const m = new THREE.Mesh(wheelGeo, wheelMat);
    m.castShadow = true;
    return m;
  });

  const sceneGroup = new THREE.Group();
  sceneGroup.add(bodyGroup, ...wheelMeshes);

  const followTarget = new THREE.Object3D();

  // ---------------- state ----------------
  let crashed = false;
  let airTime = 0;
  let flipAccum = 0;
  let wasGrounded = true;
  let steer = 0;
  let lastGripScale = 1;
  const upsideDownTimer = { t: 0 };

  // scratch vectors reused every frame so the loop allocates nothing
  const _fwd = new CANNON.Vec3();
  const _right = new CANNON.Vec3();
  const _up = new CANNON.Vec3();
  const _drag = new CANNON.Vec3();
  const LOCAL_FWD = new CANNON.Vec3(0, 0, 1);
  const LOCAL_RIGHT = new CANNON.Vec3(1, 0, 0);
  const LOCAL_UP = new CANNON.Vec3(0, 1, 0);

  function numWheelsOnGround() {
    let n = 0;
    for (const w of vehicle.wheelInfos) if (w.isInContact) n++;
    return n;
  }

  function reset(position) {
    chassisBody.position.set(position.x, position.y, position.z);
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    chassisBody.quaternion.set(0, 0, 0, 1);
    crashed = false;
    airTime = 0;
    flipAccum = 0;
    steer = 0;
    wasGrounded = true;
    upsideDownTimer.t = 0;
    // FIX: stale engine/brake/steer values used to survive a reset, so the car
    // could lurch or pull to one side immediately after respawning.
    for (let i = 0; i < 4; i++) {
      vehicle.applyEngineForce(0, i);
      vehicle.setBrake(0, i);
      vehicle.setSteeringValue(0, i);
    }
  }

  /**
   * @param {{throttle:number, brake:number, steer:number, tilt:number, handbrake:boolean}} controls
   */
  function update(controls, dt) {
    const grounded = numWheelsOnGround() > 0;

    chassisBody.quaternion.vmult(LOCAL_FWD, _fwd);
    chassisBody.quaternion.vmult(LOCAL_RIGHT, _right);
    chassisBody.quaternion.vmult(LOCAL_UP, _up);

    // signed speed along the car's own nose, so reversing reads negative
    const forwardSpeed = chassisBody.velocity.dot(_fwd);

    /* ---------------- steering (NEW) ----------------
     * The road wanders up to +/-26 m sideways, but the original vehicle never
     * called setSteeringValue at all; A/D only pitched the car in mid-air. The
     * car drove dead straight down +Z while the road curved away beneath it and
     * left the tarmac within seconds regardless of input. This is the single
     * biggest reason the game was unplayable.
     *
     * Lock falls off with speed: full lock at 120 km/h would spin or roll the
     * car, and it makes small high-speed corrections feel twitchy. */
    // power-ups and hazards can scale grip and top speed for a while
    const boost = controls.boost ? 1 : 0;
    const topSpeed = TOP_SPEED * (boost ? 1.28 : 1);
    const gripScale = controls.gripScale ?? 1;
    if (gripScale !== lastGripScale) {
      const g = 3.2 * gripScale;
      for (const w of vehicle.wheelInfos) w.frictionSlip = g;
      lastGripScale = gripScale;
    }

    const speedFrac = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / topSpeed, 0, 1);
    const steerLimit = MAX_STEER * (1 - STEER_SPEED_FALLOFF * speedFrac);
    // SIGN: the car drives toward +Z and the camera sits behind it looking the
    // same way, which puts world +X on the LEFT of the screen. A right-handed
    // system viewed along +Z is mirrored compared to the usual view along -Z,
    // which is easy to get backwards. Verified by reading the camera's local +X
    // axis in world space: it is (-1, 0, 0) in both chase and cockpit modes.
    // So a positive controls.steer -- the D key, meaning "right" to the player
    // -- must produce a turn toward -X. Hence the negation.
    const steerTarget = -controls.steer * steerLimit;
    // frame-rate independent smoothing, so steering feels identical at 30 and 144 fps
    steer = THREE.MathUtils.lerp(steer, steerTarget, 1 - Math.pow(STEER_RESPONSE, dt));
    for (const i of FRONT_WHEELS) vehicle.setSteeringValue(steer, i);

    /* ---------------- engine + brakes ----------------
     * Note the negative sign: in cannon-es a wheel's forward direction is
     * surfaceNormal x axle, which for an upright car with a +X axle points
     * along -Z. Negative engine force therefore drives the car toward +Z, the
     * direction terrain streams in. Verified in simulation rather than assumed;
     * the original sign was correct and is deliberately unchanged. */
    let engineForce = 0;
    if (controls.throttle > 0 && forwardSpeed < topSpeed) {
      engineForce = -controls.throttle * MAX_ENGINE_FORCE * (boost ? 1.45 : 1);
    } else if (controls.brake > 0 && forwardSpeed < 0.5 && forwardSpeed > -REVERSE_TOP_SPEED) {
      // brake doubles as reverse once essentially stopped, so a bad landing
      // against a barrier is recoverable instead of stranding the player
      engineForce = controls.brake * MAX_ENGINE_FORCE * 0.45;
    }
    for (const i of REAR_WHEELS) vehicle.applyEngineForce(engineForce, i);

    const braking = controls.brake > 0 && forwardSpeed > 0.5;
    const brakeForce = braking ? controls.brake * MAX_BRAKE_FORCE : 0;
    for (let i = 0; i < 4; i++) vehicle.setBrake(brakeForce, i);
    if (controls.handbrake) {
      for (const i of REAR_WHEELS) vehicle.setBrake(HANDBRAKE_FORCE, i);
    }

    /* ---------------- drag + rolling resistance (NEW) ----------------
     * This is what actually gives the car a top speed. Without it engine force
     * is unopposed and the car accelerates forever, which broke collision
     * detection outright: see the note on TOP_SPEED above. */
    const v = chassisBody.velocity;
    const speed = v.length();
    if (speed > 0.01) {
      // Gravity on a downhill can push the car well past its notional top
      // speed, and boost made that much worse: measured 220 km/h, enough to
      // launch clean over the guardrails and trigger the fall-through safety
      // net eight times in a four-minute run. Rather than hard-clamping the
      // velocity (which fights the solver and feels like hitting a wall), any
      // excess over topSpeed gets its own steep quadratic drag term, which
      // pulls the car back down smoothly.
      const over = Math.max(0, speed - topSpeed);
      const dragMag = DRAG_COEFF * speed * speed * (boost ? 0.78 : 1)
        + over * over * 20
        + (grounded ? ROLLING_RESISTANCE : 0);
      v.scale(-dragMag / speed, _drag);
      // NOTE: applyForce's second argument is a point RELATIVE to the centre of
      // mass, not a world position. Passing the body's world position here makes
      // cannon compute relativePoint x force as torque, which at z = 250 m works
      // out to ~375,000 Nm of pure fiction: it rolls the car onto its roof and
      // then blows the solver up entirely. Drag acts through the centre of mass,
      // so the point is omitted (it defaults to zero).
      chassisBody.applyForce(_drag);
    }

    /* ---------------- mid-air attitude control ---------------- */
    let justFlipped = false;
    if (!grounded) {
      airTime += dt;
      // FIX: this used to add torque to angularVelocity.x, the WORLD x axis, so
      // mid-air tilt only pitched the car correctly while it happened to be
      // pointing down +Z. Rotating about the car's own right axis makes the
      // control behave identically whatever direction it faces.
      const torque = controls.tilt * 9.5 * dt * 6;
      chassisBody.angularVelocity.x += _right.x * torque;
      chassisBody.angularVelocity.y += _right.y * torque;
      chassisBody.angularVelocity.z += _right.z * torque;
      flipAccum += chassisBody.angularVelocity.dot(_right) * dt;
    } else {
      if (!wasGrounded && airTime > 0.35 && Math.abs(flipAccum) > Math.PI * 1.8) {
        justFlipped = true;
      }
      airTime = 0;
      flipAccum = 0;
    }
    wasGrounded = grounded;

    /* ---------------- crash detection ---------------- */
    const isUpsideDown = _up.y < -0.2;
    if (isUpsideDown && grounded) {
      upsideDownTimer.t += dt;
      if (upsideDownTimer.t > 1.6) crashed = true;
    } else {
      upsideDownTimer.t = Math.max(0, upsideDownTimer.t - dt * 2);
    }

    /* ---------------- sync visuals ---------------- */
    bodyGroup.position.copy(chassisBody.position);
    bodyGroup.quaternion.copy(chassisBody.quaternion);
    followTarget.position.copy(bodyGroup.position);
    followTarget.quaternion.copy(bodyGroup.quaternion);

    for (let i = 0; i < vehicle.wheelInfos.length; i++) {
      vehicle.updateWheelTransform(i);
      const t = vehicle.wheelInfos[i].worldTransform;
      wheelMeshes[i].position.copy(t.position);
      wheelMeshes[i].quaternion.copy(t.quaternion);
    }

    // any wheel exceeding its friction budget counts as sliding, which drives
    // the tyre-squeal audio and the dust effect
    let sliding = false;
    for (const w of vehicle.wheelInfos) if (w.sliding) { sliding = true; break; }

    return {
      speed,
      forwardSpeed,
      sliding,
      topSpeed,
      wheelPositions: vehicle.wheelInfos.map((w) => w.worldTransform.position),
      grounded,
      airTime,
      crashed,
      justFlipped,
      steer,
      position: chassisBody.position,
      quaternion: chassisBody.quaternion,
    };
  }

  return {
    chassisBody,
    vehicle,
    sceneGroup,
    mesh: followTarget,
    headlights: [spotL, spotR],
    update,
    reset,
    get crashed() { return crashed; },
  };
}
