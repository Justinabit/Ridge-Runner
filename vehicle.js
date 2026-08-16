import * as THREE from 'three';
import * as CANNON from 'cannon-es';

/* =============================================================================
 * VEHICLE
 *
 * Reworked alongside the curved road. The old car was tuned for a road that
 * only ever went straight, so almost none of it survived contact with a real
 * corner: it rolled over on turn-in, understeered off every apex, and had no
 * way to rotate the car deliberately.
 *
 * The changes that matter, in rough order of how much they are felt:
 *
 *  1. Centre of mass lowered below the chassis centre. This is the single
 *     biggest anti-roll measure available and it costs nothing: a box body's
 *     COM defaults to its geometric centre, ~0.5 m up, which on a banked corner
 *     produces a large tipping moment.
 *  2. An explicit anti-roll bar per axle. RaycastVehicle has no sway bar at all,
 *     so suspension travel on one side is completely independent of the other
 *     and the car leans as far as the springs allow.
 *  3. Speed-dependent downforce, so grip rises with speed instead of falling.
 *  4. All-wheel drive with a rear bias, and brake bias to the front.
 *  5. Per-wheel load-sensitive friction, so the inside wheel of a corner stops
 *     providing grip it physically cannot have.
 *  6. Air stabilisation that damps tumble and levels the car toward flat,
 *     because a road with jumps and crests now launches the car constantly.
 * ========================================================================== */

const CHASSIS_SIZE = new CANNON.Vec3(1.0, 0.35, 2.1);
const CHASSIS_MASS = 165;

export const CHASSIS_MATERIAL = new CANNON.Material('chassis');
const WHEEL_RADIUS = 0.45;

/* ---------------------------------------------------------------------------
 * Drivetrain
 *
 * Speed is still capped, and it still matters for more than feel: a wheel only
 * senses ground via a raycast reaching suspensionRestLength + radius (~1.0 m)
 * below its mount, so a car that moves further than that in one step starts and
 * ends its ray below the road and tunnels straight through. The fixed timestep
 * is 1/120, giving ~120 m/s of headroom, and TOP_SPEED sits far below it.
 * ------------------------------------------------------------------------ */
const MAX_ENGINE_FORCE = 1750;
const TOP_SPEED = 36;                 // m/s, ~130 km/h
const REVERSE_TOP_SPEED = 9;
const DRAG_COEFF = MAX_ENGINE_FORCE / (TOP_SPEED * TOP_SPEED);
const ROLLING_RESISTANCE = 12;

/* Rear-biased AWD. Pure RWD spins up out of hairpins under the new power, and
 * pure FWD washes wide; 35/65 puts power down out of a slow corner while still
 * rotating on throttle. */
const FRONT_DRIVE_SHARE = 0.35;

const MAX_BRAKE_FORCE = 420;
/* Brake bias forward, like every real car: rearward bias makes the back axle
 * lock first, which spins the car under braking into a corner. */
const FRONT_BRAKE_SHARE = 0.62;
const HANDBRAKE_FORCE = 1300;         // rear axle only, so it breaks traction

/* Engine braking, applied on a closed throttle. Without it, lifting off does
 * nothing but coast, so corner entry has no weight transfer and the car never
 * settles onto its nose before a turn. */
const ENGINE_BRAKE = 220;

/* ---------------------------------------------------------------------------
 * Steering
 * ------------------------------------------------------------------------ */
const MAX_STEER = 0.62;               // radians (~36 deg) of front-wheel lock
/* Was 0.62 — i.e. 62% of lock removed at top speed, which left far too little
 * authority to make a real corner. The road now genuinely turns, so the car has
 * to be able to. Roll is kept in check by the anti-roll bar and low COM rather
 * than by refusing to let the player steer. */
const STEER_SPEED_FALLOFF = 0.42;
const STEER_RESPONSE_IN = 0.0016;     // turning in: quick
const STEER_RESPONSE_OUT = 0.00002;   // returning to centre: very quick
/* Countersteer assist: while the car is sliding, a little steering angle is
 * added in the direction of the slide. This is what makes a drift catchable
 * with a keyboard, where there is no analogue precision to catch it manually. */
const COUNTERSTEER_GAIN = 0.55;
const COUNTERSTEER_MAX = 0.28;

/* ---------------------------------------------------------------------------
 * Grip
 * ------------------------------------------------------------------------ */
const BASE_FRICTION = 3.6;
const HANDBRAKE_REAR_FRICTION = 1.25; // rear grip while the handbrake is down
/* Downforce as a fraction of weight at top speed. 0.55 means the car presses
 * down with 1.55x its own weight flat out, which is what lets a fast sweeper be
 * taken faster than a slow one. */
const DOWNFORCE_AT_TOP = 0.55;

/* Anti-roll bar stiffness, N per metre of suspension travel difference across
 * an axle. Rear stiffer than front, which reduces understeer. */
const ANTIROLL_FRONT = 12000;
const ANTIROLL_REAR = 15000;

/* Air control */
const AIR_PITCH_TORQUE = 9.5;
const AIR_ANGULAR_DAMP = 0.6;         // per second, damps uncommanded tumble
const AIR_LEVEL_TORQUE = 2.4;         // rights the car toward level in the air

export function createVehicle(world, startPos = new THREE.Vector3(0, 6, 0), startYaw = 0) {
  // ---------------- physics chassis ----------------
  const chassisShape = new CANNON.Box(CHASSIS_SIZE);
  chassisShape.material = CHASSIS_MATERIAL;
  const chassisBody = new CANNON.Body({ mass: CHASSIS_MASS });
  /* Offsetting the SHAPE upward within the body is how you move the body's
   * centre of mass DOWN relative to the visible car: cannon treats the body
   * origin as the COM, so lifting the collision box means the origin sits low in
   * it. Everything that depends on the body origin (the mesh, wheel mounts, the
   * camera target) is offset to match. */
  chassisBody.addShape(chassisShape, new CANNON.Vec3(0, 0.32, 0));
  chassisBody.position.set(startPos.x, startPos.y, startPos.z);
  chassisBody.angularVelocity.set(0, 0, 0);
  chassisBody.linearDamping = 0.02;
  chassisBody.angularDamping = 0.35;

  const vehicle = new CANNON.RaycastVehicle({
    chassisBody,
    indexRightAxis: 0,
    indexUpAxis: 1,
    indexForwardAxis: 2,
  });

  const wheelOptions = {
    radius: WHEEL_RADIUS,
    directionLocal: new CANNON.Vec3(0, -1, 0),
    /* Softer and better damped than before (was 32 / 3.2 / 4.6). A stiff spring
     * on a bumpy mountain road skips the wheel off the surface, and a wheel out
     * of contact provides exactly zero grip and zero drive. */
    suspensionStiffness: 28,
    suspensionRestLength: 0.6,
    frictionSlip: BASE_FRICTION,
    dampingRelaxation: 2.6,
    dampingCompression: 3.6,
    maxSuspensionForce: 100000,
    /* rollInfluence models how much lateral tyre force acts at road level
     * (tipping the car) rather than through the roll centre. 0.01 was
     * essentially "no body roll at all", which felt inert. 0.06 gives visible
     * lean into a corner without threatening a rollover, now that the anti-roll
     * bars and the low COM are there to catch it. */
    rollInfluence: 0.06,
    axleLocal: new CANNON.Vec3(1, 0, 0),
    chassisConnectionPointLocal: new CANNON.Vec3(),
    maxSuspensionTravel: 0.5,
    customSlidingRotationalSpeed: -30,
    useCustomSlidingRotationalSpeed: true,
  };

  /* Slightly wider track than before (0.85 -> 0.95). Track width is the lever
   * arm resisting roll, so widening it is free stability. */
  const wheelConnections = [
    [-0.95, -0.05, 1.5],  // front-left
    [0.95, -0.05, 1.5],   // front-right
    [-0.95, -0.05, -1.5], // rear-left
    [0.95, -0.05, -1.5],  // rear-right
  ];
  const FRONT_WHEELS = [0, 1];
  const REAR_WHEELS = [2, 3];
  const AXLES = [
    { wheels: FRONT_WHEELS, stiffness: ANTIROLL_FRONT },
    { wheels: REAR_WHEELS, stiffness: ANTIROLL_REAR },
  ];

  for (const [x, y, z] of wheelConnections) {
    wheelOptions.chassisConnectionPointLocal.set(x, y, z);
    vehicle.addWheel({ ...wheelOptions });
  }
  vehicle.addToWorld(world);
  vehicle.wheelInfos.forEach((w) => { w.frictionSlip = BASE_FRICTION; });

  // ---------------- visual meshes ----------------
  /* All body art is lifted by BODY_VISUAL_LIFT so it lines up with the collision
   * box, which was itself offset up to lower the COM. */
  const BODY_VISUAL_LIFT = 0.32;

  const chassisGeo = new THREE.BoxGeometry(CHASSIS_SIZE.x * 2, CHASSIS_SIZE.y * 2, CHASSIS_SIZE.z * 2);
  const chassisMat = new THREE.MeshLambertMaterial({ color: 0xff6a3d, flatShading: true });
  const chassisMesh = new THREE.Mesh(chassisGeo, chassisMat);
  chassisMesh.position.y = BODY_VISUAL_LIFT;
  chassisMesh.castShadow = true;

  const bodyGroup = new THREE.Group();
  bodyGroup.add(chassisMesh);
  const cageMat = new THREE.MeshLambertMaterial({ color: 0x2a2233, flatShading: true });
  const cage = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1.2), cageMat);
  cage.position.set(0, 0.55 + BODY_VISUAL_LIFT, -0.2);
  cage.castShadow = true;
  bodyGroup.add(cage);

  const headlightGeo = new THREE.SphereGeometry(0.14, 8, 8);
  const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfff2c9 });
  const headlightL = new THREE.Mesh(headlightGeo, headlightMat);
  const headlightR = headlightL.clone();
  headlightL.position.set(-0.65, 0.1 + BODY_VISUAL_LIFT, 2.05);
  headlightR.position.set(0.65, 0.1 + BODY_VISUAL_LIFT, 2.05);
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

  /* Brake lights. Cheap, and they make the car read as a car from the chase
   * camera, which is the view the player spends the whole game in. */
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0x3a1010 });
  const brakeGeo = new THREE.BoxGeometry(0.35, 0.12, 0.08);
  const brakeL = new THREE.Mesh(brakeGeo, brakeMat);
  const brakeR = new THREE.Mesh(brakeGeo, brakeMat);
  brakeL.position.set(-0.6, 0.18 + BODY_VISUAL_LIFT, -2.08);
  brakeR.position.set(0.6, 0.18 + BODY_VISUAL_LIFT, -2.08);
  bodyGroup.add(brakeL, brakeR);
  const BRAKE_ON = new THREE.Color(0xff3020);
  const BRAKE_OFF = new THREE.Color(0x3a1010);

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
  let slipAngle = 0;
  const upsideDownTimer = { t: 0 };

  // scratch vectors reused every frame so the loop allocates nothing
  const _fwd = new CANNON.Vec3();
  const _right = new CANNON.Vec3();
  const _up = new CANNON.Vec3();
  const _tmp = new CANNON.Vec3();
  const _drag = new CANNON.Vec3();
  const _force = new CANNON.Vec3();
  const LOCAL_FWD = new CANNON.Vec3(0, 0, 1);
  const LOCAL_RIGHT = new CANNON.Vec3(1, 0, 0);
  const LOCAL_UP = new CANNON.Vec3(0, 1, 0);

  function numWheelsOnGround() {
    let n = 0;
    for (const w of vehicle.wheelInfos) if (w.isInContact) n++;
    return n;
  }

  /**
   * @param {THREE.Vector3} position
   * @param {number} yaw heading to face, radians about world Y. Respawning
   *        always pointing down +Z was survivable on a straight road; on a road
   *        that turns it can drop the car facing a wall.
   */
  function reset(position, yaw = 0) {
    chassisBody.position.set(position.x, position.y, position.z);
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
    crashed = false;
    airTime = 0;
    flipAccum = 0;
    steer = 0;
    slipAngle = 0;
    wasGrounded = true;
    upsideDownTimer.t = 0;
    // stale engine/brake/steer values must not survive a reset, or the car
    // lurches or pulls to one side immediately after respawning
    for (let i = 0; i < 4; i++) {
      vehicle.applyEngineForce(0, i);
      vehicle.setBrake(0, i);
      vehicle.setSteeringValue(0, i);
      const w = vehicle.wheelInfos[i];
      w.suspensionLength = w.suspensionRestLength;
      w.suspensionForce = 0;
      w.deltaRotation = 0;
    }
  }

  /**
   * @param {{throttle:number, brake:number, steer:number, tilt:number,
   *          handbrake:boolean, boost:boolean, gripScale:number}} controls
   */
  function update(controls, dt) {
    const groundedWheels = numWheelsOnGround();
    const grounded = groundedWheels > 0;

    chassisBody.quaternion.vmult(LOCAL_FWD, _fwd);
    chassisBody.quaternion.vmult(LOCAL_RIGHT, _right);
    chassisBody.quaternion.vmult(LOCAL_UP, _up);

    const v = chassisBody.velocity;
    const speed = v.length();
    // signed speed along the car's own nose, so reversing reads negative
    const forwardSpeed = v.dot(_fwd);
    const lateralSpeed = v.dot(_right);

    const boost = controls.boost ? 1 : 0;
    const topSpeed = TOP_SPEED * (boost ? 1.28 : 1);
    const gripScale = controls.gripScale ?? 1;

    /* ---------------- slip angle ----------------
     * The angle between where the car is pointing and where it is actually
     * going. This is what "drifting" means numerically, and it drives the
     * countersteer assist, the tyre-squeal audio and the drift scoring. */
    slipAngle = Math.abs(forwardSpeed) > 2
      ? Math.atan2(lateralSpeed, Math.abs(forwardSpeed))
      : 0;

    /* ---------------- grip ---------------- */
    const handbrake = !!controls.handbrake;
    const targetGrip = BASE_FRICTION * gripScale;
    if (targetGrip !== lastGripScale || handbrake) {
      for (let i = 0; i < 4; i++) {
        const isRear = i >= 2;
        vehicle.wheelInfos[i].frictionSlip =
          (handbrake && isRear) ? HANDBRAKE_REAR_FRICTION * gripScale : targetGrip;
      }
      lastGripScale = targetGrip;
    }

    /* ---------------- steering ----------------
     * SIGN: the car drives toward +Z and the camera sits behind it looking the
     * same way, which puts world +X on the LEFT of the screen. A right-handed
     * frame viewed along +Z is mirrored relative to the usual view along -Z, so
     * a positive controls.steer (D, "right" to the player) must produce a turn
     * toward -X. Hence the negation. Verified by reading the camera's local +X
     * axis in world space: it is (-1, 0, 0) in both camera modes. */
    const speedFrac = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / topSpeed, 0, 1);
    const steerLimit = MAX_STEER * (1 - STEER_SPEED_FALLOFF * speedFrac);
    let steerTarget = -controls.steer * steerLimit;

    if (grounded && Math.abs(forwardSpeed) > 5) {
      // steer INTO the slide, proportional to how far the back is out
      const assist = THREE.MathUtils.clamp(
        slipAngle * Math.sign(lateralSpeed) * COUNTERSTEER_GAIN,
        -COUNTERSTEER_MAX, COUNTERSTEER_MAX,
      );
      steerTarget = THREE.MathUtils.clamp(steerTarget + assist, -MAX_STEER, MAX_STEER);
    }

    // returning to centre is faster than turning in, which is how a real
    // self-centring rack behaves and stops the car feeling like it is on rails
    const returning = Math.abs(steerTarget) < Math.abs(steer);
    const response = returning ? STEER_RESPONSE_OUT : STEER_RESPONSE_IN;
    steer = THREE.MathUtils.lerp(steer, steerTarget, 1 - Math.pow(response, dt));
    for (const i of FRONT_WHEELS) vehicle.setSteeringValue(steer, i);

    /* ---------------- engine ----------------
     * SIGN: in cannon-es a wheel's forward direction is surfaceNormal x axle,
     * which for an upright car with a +X axle points along -Z. Negative engine
     * force therefore drives the car toward +Z. Verified in simulation. */
    let engineForce = 0;
    if (controls.throttle > 0 && forwardSpeed < topSpeed) {
      /* Torque curve: full force from a standstill tapers as the car
       * approaches its top speed, instead of full force right up to the cap and
       * then nothing. Makes acceleration feel like it has gears' worth of
       * character rather than a single flat shove. */
      const curve = 1 - 0.35 * speedFrac * speedFrac;
      engineForce = -controls.throttle * MAX_ENGINE_FORCE * curve * (boost ? 1.45 : 1);
    } else if (controls.brake > 0 && forwardSpeed < 0.5 && forwardSpeed > -REVERSE_TOP_SPEED) {
      // brake doubles as reverse once essentially stopped, so a bad landing
      // against a barrier is recoverable instead of stranding the player
      engineForce = controls.brake * MAX_ENGINE_FORCE * 0.45;
    }
    for (const i of FRONT_WHEELS) vehicle.applyEngineForce(engineForce * FRONT_DRIVE_SHARE, i);
    for (const i of REAR_WHEELS) vehicle.applyEngineForce(engineForce * (1 - FRONT_DRIVE_SHARE), i);

    /* ---------------- brakes ---------------- */
    const braking = controls.brake > 0 && forwardSpeed > 0.5;
    const coasting = controls.throttle === 0 && !braking && forwardSpeed > 1;
    let frontBrake = 0;
    let rearBrake = 0;
    if (braking) {
      frontBrake = controls.brake * MAX_BRAKE_FORCE * FRONT_BRAKE_SHARE;
      rearBrake = controls.brake * MAX_BRAKE_FORCE * (1 - FRONT_BRAKE_SHARE);
    } else if (coasting) {
      frontBrake = rearBrake = ENGINE_BRAKE * 0.5;
    }
    for (const i of FRONT_WHEELS) vehicle.setBrake(frontBrake, i);
    for (const i of REAR_WHEELS) vehicle.setBrake(rearBrake, i);
    if (handbrake) for (const i of REAR_WHEELS) vehicle.setBrake(HANDBRAKE_FORCE, i);

    brakeMat.color.copy(braking || handbrake ? BRAKE_ON : BRAKE_OFF);

    /* ---------------- anti-roll bars ----------------
     * RaycastVehicle gives each corner a fully independent spring, so on a
     * corner the loaded side compresses and the unloaded side droops with
     * nothing tying them together, and the car leans until it trips over itself.
     * A sway bar transfers force from the compressed side to the extended one,
     * proportional to the difference in travel. This is the standard fix and it
     * is what makes the car stable enough to use the extra steering lock above.
     *
     * travel is 0 when fully compressed and 1 when the wheel is off the ground;
     * a wheel out of contact contributes its full droop, which is what makes the
     * bar also resist lifting the inside wheel. */
    for (const axle of AXLES) {
      const [li, ri] = axle.wheels;
      const wl = vehicle.wheelInfos[li];
      const wr = vehicle.wheelInfos[ri];
      const travelL = wl.isInContact
        ? (wl.suspensionLength - wl.suspensionRestLength) / wl.maxSuspensionTravel : 1;
      const travelR = wr.isInContact
        ? (wr.suspensionLength - wr.suspensionRestLength) / wr.maxSuspensionTravel : 1;
      const antiRoll = (travelL - travelR) * axle.stiffness;
      if (Math.abs(antiRoll) < 1e-3) continue;

      // push down on the drooping side, lift the compressed side
      for (const [wheelIdx, sign] of [[li, -1], [ri, 1]]) {
        const w = vehicle.wheelInfos[wheelIdx];
        if (!w.isInContact) continue;
        _up.scale(antiRoll * sign, _force);
        /* applyForce's second argument is a point RELATIVE to the centre of
         * mass, not a world position: passing a world position makes cannon
         * compute relativePoint x force as torque, which at any distance from
         * the origin fabricates enormous fictitious moments and destroys the
         * simulation. The contact point minus the body position is the correct
         * relative point. */
        w.raycastResult.hitPointWorld.vsub(chassisBody.position, _tmp);
        chassisBody.applyForce(_force, _tmp);
      }
    }

    /* ---------------- downforce ----------------
     * Applied along the car's own up axis, not world up, so on a banked corner
     * it presses the car into the road surface rather than merely toward the
     * ground. Scales with the square of speed like real aero. */
    if (grounded && speed > 4) {
      const load = DOWNFORCE_AT_TOP * (speed / TOP_SPEED) ** 2;
      _up.scale(-load * CHASSIS_MASS * 18, _force);   // 18 = |gravity|
      chassisBody.applyForce(_force);
    }

    /* ---------------- load-sensitive tyre grip ----------------
     * A tyre's grip depends on how hard it is pressed into the road. Without
     * this, the unloaded inside wheel of a fast corner keeps generating full
     * lateral force out of thin air, which makes the car turn in ways nothing
     * about its weight transfer justifies. */
    const nominalLoad = CHASSIS_MASS * 18 / 4;
    for (let i = 0; i < 4; i++) {
      const w = vehicle.wheelInfos[i];
      if (!w.isInContact) continue;
      const isRear = i >= 2;
      const base = (handbrake && isRear) ? HANDBRAKE_REAR_FRICTION * gripScale : BASE_FRICTION * gripScale;
      const loadRatio = THREE.MathUtils.clamp(w.suspensionForce / nominalLoad, 0.25, 2);
      // sqrt: grip grows with load but with diminishing returns, which is the
      // real behaviour and is why a lightly loaded wheel is disproportionately
      // useful compared to a heavily loaded one
      w.frictionSlip = base * Math.sqrt(loadRatio);
    }

    /* ---------------- drag + rolling resistance ----------------
     * This is what actually gives the car a top speed: RaycastVehicle models no
     * aerodynamic drag at all, so without it the engine force is unopposed and
     * the car accelerates without bound — which breaks collision outright, per
     * the note on TOP_SPEED. */
    if (speed > 0.01) {
      /* Gravity on a long descent can push the car well past its notional top
       * speed. Rather than hard-clamping the velocity (which fights the solver
       * and feels like hitting a wall), any excess over topSpeed gets its own
       * steep quadratic term that pulls it back smoothly. */
      const over = Math.max(0, speed - topSpeed);
      const dragMag = DRAG_COEFF * speed * speed * (boost ? 0.78 : 1)
        + over * over * 20
        + (grounded ? ROLLING_RESISTANCE : 0);
      v.scale(-dragMag / speed, _drag);
      // drag acts through the centre of mass, so no relative point is passed
      chassisBody.applyForce(_drag);
    }

    /* ---------------- mid-air attitude ---------------- */
    let justFlipped = false;
    if (!grounded) {
      airTime += dt;
      const av = chassisBody.angularVelocity;

      // player pitch control, about the car's own right axis so it behaves the
      // same whatever direction the car happens to be facing
      const torque = controls.tilt * AIR_PITCH_TORQUE * dt * 6;
      av.x += _right.x * torque;
      av.y += _right.y * torque;
      av.z += _right.z * torque;

      /* Damp tumble and level toward flat. A road with crests launches the car
       * constantly now, and an uncontrolled tumble means landing on the roof,
       * which ends the run. This keeps a jump readable without removing the
       * player's ability to deliberately flip for points. */
      const damp = Math.max(0, 1 - AIR_ANGULAR_DAMP * dt);
      av.scale(damp, av);

      if (airTime > 0.25 && Math.abs(controls.tilt) < 0.01) {
        /* Torque that rotates the car's up axis back toward world up. The axis
         * to rotate about is cross(carUp, worldUp), which for worldUp = (0,1,0)
         * simplifies to (up.z, 0, -up.x) — its magnitude is sin(tilt angle), so
         * the correction is naturally proportional to how far off level the car
         * is and vanishes to nothing once it is flat. */
        const level = AIR_LEVEL_TORQUE * dt;
        av.x += _up.z * level;
        av.z += -_up.x * level;
      }

      flipAccum += av.dot(_right) * dt;
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
    // a real drift is a big slip angle at speed, not just a spinning wheel
    const drifting = grounded && speed > 9 && slipAngle > 0.22;

    return {
      speed,
      forwardSpeed,
      lateralSpeed,
      slipAngle,
      drifting,
      sliding: sliding || drifting,
      topSpeed,
      wheelPositions: vehicle.wheelInfos.map((w) => w.worldTransform.position),
      groundedWheels,
      grounded,
      airTime,
      crashed,
      justFlipped,
      steer,
      braking: braking || handbrake,
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
