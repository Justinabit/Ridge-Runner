import * as THREE from 'three';
import * as CANNON from 'cannon-es';

const CHASSIS_SIZE = new CANNON.Vec3(1.0, 0.35, 2.1);
const WHEEL_RADIUS = 0.45;
const MAX_ENGINE_FORCE = 2600;
const MAX_BRAKE_FORCE = 60;

// FIX: the previous version took (world, roadMaterial, startPos) and built a
// CANNON.ContactMaterial between a wheelMaterial and roadMaterial. But
// RaycastVehicle wheels aren't physical bodies — they're raycasts — so that
// ContactMaterial was never actually attached to anything and had zero
// effect (tire grip comes entirely from wheelInfo.frictionSlip below, which
// this file already set correctly). It's removed here along with the
// now-unnecessary roadMaterial parameter, matching main.js's new
// createVehicle(world, spawnPos) call.
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
    suspensionRestLength: 0.5,
    frictionSlip: 3.2,
    dampingRelaxation: 3.2,
    dampingCompression: 4.6,
    maxSuspensionForce: 100000,
    rollInfluence: 0.01,
    axleLocal: new CANNON.Vec3(1, 0, 0),
    chassisConnectionPointLocal: new CANNON.Vec3(),
    maxSuspensionTravel: 0.35,
    customSlidingRotationalSpeed: -30,
    useCustomSlidingRotationalSpeed: true,
  };

  const wheelConnections = [
    [-0.85, -0.1, 1.5],  // front-left
    [0.85, -0.1, 1.5],   // front-right
    [-0.85, -0.1, -1.5], // rear-left
    [0.85, -0.1, -1.5],  // rear-right
  ];

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

  // simple roll-cage / hood details for silhouette
  const bodyGroup = new THREE.Group();
  bodyGroup.add(chassisMesh);
  const cageMat = new THREE.MeshLambertMaterial({ color: 0x2a2233, flatShading: true });
  const cageGeo = new THREE.BoxGeometry(1.5, 0.5, 1.2);
  const cage = new THREE.Mesh(cageGeo, cageMat);
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
  bodyGroup.add(headlightTarget);
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

  // sceneGroup has identity transform; bodyGroup and wheelMeshes are positioned
  // in world-space directly each frame (see update()), so this must stay un-transformed.
  const sceneGroup = new THREE.Group();
  sceneGroup.add(bodyGroup, ...wheelMeshes);

  // followTarget mirrors the chassis's actual world transform each frame, for
  // things that need to track the car (camera, zone manager) without being
  // fooled by sceneGroup's intentionally-identity transform.
  const followTarget = new THREE.Object3D();

  // ---------------- state ----------------
  let crashed = false;
  let airTime = 0;
  let flipAccum = 0; // radians accumulated while airborne, for flip-stunt detection
  // FIX: this used to be `flipCounted`, which was set true and then reset
  // back to false three lines later in the SAME call — so the justFlipped
  // flag returned to main.js was always false and the flip bonus/badge could
  // never fire. wasGrounded tracks the previous frame's grounded state so
  // the landing check below only fires once, on the exact landing frame.
  let wasGrounded = true;
  const upsideDownTimer = { t: 0 };

  function numWheelsOnGround() {
    return vehicle.wheelInfos.filter((w) => w.isInContact).length;
  }

  function reset(position) {
    chassisBody.position.set(position.x, position.y, position.z);
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    chassisBody.quaternion.set(0, 0, 0, 1);
    crashed = false;
    airTime = 0;
    flipAccum = 0;
    wasGrounded = true;
    upsideDownTimer.t = 0;
  }

  /**
   * @param {{throttle:number, brake:number, tilt:number, handbrake:boolean}} controls
   */
  function update(controls, dt) {
    const grounded = numWheelsOnGround() > 0;

    // engine: rear-wheel drive, throttle forward is negative force along local Z per cannon convention
    const engineForce = -controls.throttle * MAX_ENGINE_FORCE;
    vehicle.applyEngineForce(engineForce, 2);
    vehicle.applyEngineForce(engineForce, 3);

    const brakeForce = controls.brake > 0 ? controls.brake * MAX_BRAKE_FORCE : 0;
    const handBrakeForce = controls.handbrake ? MAX_BRAKE_FORCE * 3 : 0;
    for (let i = 0; i < 4; i++) vehicle.setBrake(brakeForce + handBrakeForce, i);

    // mid-air chassis tilt for balance/landing; justFlipped is computed once,
    // only on the exact landing transition frame
    let justFlipped = false;
    if (!grounded) {
      airTime += dt;
      const torque = controls.tilt * 9.5;
      chassisBody.angularVelocity.x += torque * dt * 6; // pitch (nose up/down)
      flipAccum += chassisBody.angularVelocity.x * dt;
    } else {
      if (!wasGrounded && airTime > 0.35 && Math.abs(flipAccum) > Math.PI * 1.8) {
        justFlipped = true;
      }
      airTime = 0;
      flipAccum = 0;
    }
    wasGrounded = grounded;

    // crash detection: upside down (local up pointing down) for sustained time, or resting on roof
    const localUp = new CANNON.Vec3(0, 1, 0);
    const worldUp = chassisBody.quaternion.vmult(localUp);
    const isUpsideDown = worldUp.y < -0.2;
    if (isUpsideDown && grounded) {
      upsideDownTimer.t += dt;
      if (upsideDownTimer.t > 1.1) crashed = true;
    } else {
      upsideDownTimer.t = Math.max(0, upsideDownTimer.t - dt * 2);
    }

    // sync visuals
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

    spotL.intensity = 0; // toggled externally by zones (night)
    spotR.intensity = 0;

    return {
      speed: chassisBody.velocity.length(),
      grounded,
      airTime,
      crashed,
      justFlipped,
      position: chassisBody.position,
      quaternion: chassisBody.quaternion,
    };
  }

  return {
    chassisBody,
    vehicle,
    sceneGroup,       // add this to the THREE scene
    mesh: followTarget, // read-only world-space transform for camera/zone tracking
    headlights: [spotL, spotR],
    update,
    reset,
    get crashed() { return crashed; },
  };
}