import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { sampleRoad } from './roadgen.js';
import { createTerrainManager } from './terrain.js';
import { createVehicle } from './vehicle.js';
import { createCameraController } from './camera.js';
import { createZoneManager } from './zones.js';

/* ============================== DOM ============================== */
const canvas = document.getElementById('game-canvas');
const loadingScreen = document.getElementById('loading-screen');
const loadingFill = document.getElementById('loading-fill');
const loadingTip = document.getElementById('loading-tip');
const startScreen = document.getElementById('start-screen');
const startBtn = document.getElementById('start-btn');
const hud = document.getElementById('hud');
const crashScreen = document.getElementById('crash-screen');
const retryBtn = document.getElementById('retry-btn');
const cameraToggleBtn = document.getElementById('camera-toggle');

const distanceEl = document.getElementById('hud-distance');
const scoreEl = document.getElementById('hud-score');
const speedFillEl = document.getElementById('speed-fill');
const fuelFillEl = document.getElementById('fuel-fill');
const zoneTagEl = document.getElementById('zone-tag');
const airBadgeEl = document.getElementById('air-badge');
const flipBadgeEl = document.getElementById('flip-badge');
const crashDistanceEl = document.getElementById('crash-distance');
const crashScoreEl = document.getElementById('crash-score');

/* ============================== THREE SETUP (cheap, runs immediately) ====== */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.1, 1600);

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// the car spawns here — chosen well inside the first streamed chunk (not right
// at z=0) so there's a full chunk's width of road behind it too, in case the
// player brakes/reverses right at the start.
const SPAWN_Z = 20;

// FIX: raised from 1.2 — the vehicle's resting ground clearance (wheel
// connection y-offset + suspension rest length + wheel radius) is ~1.05m, so
// 1.2 left almost no margin and could start the car partially embedded on
// sloped/banked road. This also gives cannon-es's solver a couple of extra
// frames of fall time to settle suspension before first contact.
const SPAWN_HEIGHT_OFFSET = 4;

/* ============================== LOADING PROGRESS HELPERS ============================== */
function updateProgress(pct, tip) {
  loadingFill.style.width = Math.min(100, pct) + '%';
  if (tip) loadingTip.textContent = tip;
}
function yieldFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/* ============================== GAME STATE (populated during boot) ========= */
let world, terrain, vehicle, cameraController, zoneManager;
const keys = {};
let fuel = 100;
let score = 0;
let distance = SPAWN_Z;
let started = false;
let gameOver = false;
let wasAirborne = false;

// FIX: tracks the y-height of the road surface as of the last frame the
// vehicle was actually grounded. Used by the tunneling-glitch safety check
// below — a real jump follows the terrain's rough shape, but a fall-through
// bug sends position.y plunging far below wherever the ground last was.
let lastKnownGroundY = 0;

// FIX: terrain.update() needs the car's current speed to widen its lookahead
// (see terrain.js), but that update() call happens before vehicle.update()
// runs for this frame — so it uses last frame's speed. One frame of lag on a
// buffer distance is irrelevant; this just needs to be roughly right.
let lastSpeed = 0;

/* ============================== BOOT SEQUENCE ============================== */
async function boot() {
  updateProgress(2, 'Warming up the engine…');
  await yieldFrame();

  /* ---- physics world (fast) ---- */
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -18, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.solver.iterations = 12;
  world.defaultContactMaterial.friction = 0.4;
  updateProgress(5, 'Setting up physics…');
  await yieldFrame();

  /* ---- terrain: preload a window of chunks around the spawn point ---- */
  terrain = createTerrainManager(scene, world);
  await terrain.ensureRange(SPAWN_Z, async (frac) => {
    updateProgress(5 + frac * 55, 'Carving the mountain road…');
    await yieldFrame();
  });
  updateProgress(60, 'Road complete');
  await yieldFrame();

  /* ---- atmosphere / lighting (weight 60 -> 78) ---- */
  updateProgress(64, 'Setting the sky…');
  await yieldFrame();
  zoneManager = createZoneManager(scene);
  updateProgress(78, 'Sky ready');
  await yieldFrame();

  /* ---- vehicle (weight 78 -> 92) ----
     Spawn position comes from the exact same sampleRoad() the terrain chunks
     used to build their geometry, so the ground is guaranteed to be there —
     no more falling through gaps between "where we think the road is" and
     "where the road mesh actually got built". */
  updateProgress(80, 'Assembling the buggy…');
  await yieldFrame();
  const spawnSample = sampleRoad(SPAWN_Z);
  const spawnPos = new THREE.Vector3(spawnSample.x, spawnSample.y + SPAWN_HEIGHT_OFFSET, spawnSample.z);
  vehicle = createVehicle(world, spawnPos);
  scene.add(vehicle.sceneGroup);
  lastKnownGroundY = spawnSample.y;
  updateProgress(92, 'Buggy ready');
  await yieldFrame();

  /* ---- final wiring (weight 92 -> 100) ---- */
  cameraController = createCameraController(camera);
  bindInput();
  updateProgress(100, 'Ready to ride!');
  await yieldFrame();

  loadingScreen.classList.add('hidden');
  startScreen.classList.remove('hidden');
  requestAnimationFrame(animate);
}

/* ============================== INPUT ============================== */
function bindInput() {
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'KeyC') toggleCamera();
    if (e.code === 'KeyR') resetVehicle();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });

  cameraToggleBtn.addEventListener('click', toggleCamera);

  bindHoldButton('btn-gas', 'KeyW');
  bindHoldButton('btn-brake', 'KeyS');
  bindHoldButton('btn-left', 'KeyA');
  bindHoldButton('btn-right', 'KeyD');

  startBtn.addEventListener('click', () => {
    startScreen.classList.add('hidden');
    hud.classList.remove('hidden');
    started = true;
  });
  retryBtn.addEventListener('click', () => {
    fullReset();
    hud.classList.remove('hidden');
  });
}

function toggleCamera() {
  cameraController.toggle();
  cameraToggleBtn.textContent = cameraController.mode === 'chase' ? '📷' : '🚗';
}

function readControls() {
  const throttle = (keys['KeyW'] || keys['ArrowUp']) ? 1 : 0;
  const brake = (keys['KeyS'] || keys['ArrowDown']) ? 1 : 0;
  let tilt = 0;
  if (keys['KeyA'] || keys['ArrowLeft']) tilt -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) tilt += 1;
  const handbrake = !!keys['Space'];
  return { throttle, brake, tilt, handbrake };
}

/* touch controls (mobile) */
function bindHoldButton(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  const set = (v) => (keys[key] = v);
  el.addEventListener('touchstart', (e) => { e.preventDefault(); set(true); }, { passive: false });
  el.addEventListener('touchend', (e) => { e.preventDefault(); set(false); }, { passive: false });
}

/* ============================== RESET HELPERS ============================== */
function resetVehicle() {
  const z = Math.max(SPAWN_Z, distance - 15);
  const s = sampleRoad(z);
  vehicle.reset(new THREE.Vector3(s.x, s.y + SPAWN_HEIGHT_OFFSET, z));
  terrain.update(z, 0); // make sure the ground we're resetting onto is actually loaded
  lastKnownGroundY = s.y;
  lastSpeed = 0;
  fuel = Math.max(fuel, 30);
  gameOver = false;
  crashScreen.classList.add('hidden');
  // FIX: this hid the crash screen but never brought the HUD back — only the
  // "TRY AGAIN" button's own click handler did that. Pressing R right after
  // a crash used to resume gameplay with no distance/score/speed/fuel UI.
  hud.classList.remove('hidden');
}

function fullReset() {
  const s = sampleRoad(SPAWN_Z);
  vehicle.reset(new THREE.Vector3(s.x, s.y + SPAWN_HEIGHT_OFFSET, SPAWN_Z));
  terrain.update(SPAWN_Z, 0);
  lastKnownGroundY = s.y;
  lastSpeed = 0;
  fuel = 100;
  score = 0;
  distance = SPAWN_Z;
  gameOver = false;
  crashScreen.classList.add('hidden');
}

/* ============================== MAIN LOOP ============================== */
const clock = new THREE.Clock();
const FIXED_DT = 1 / 60;
let accumulator = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  if (started && !gameOver) {
    // stream terrain/road chunks in around the car before stepping physics,
    // so the ground the wheels are about to raycast against already exists.
    // Passing speed widens the lookahead at high speed — see terrain.js.
    terrain.update(distance, lastSpeed);

    accumulator += dt;
    while (accumulator >= FIXED_DT) {
      world.step(FIXED_DT);
      accumulator -= FIXED_DT;
    }

    const controls = readControls();

    // FIX: fuel-out "sputtering" used to reduce controls.throttle AFTER
    // vehicle.update(controls, dt) had already consumed it for this frame,
    // so running out of fuel never actually affected driving. Fuel is now
    // calculated and the throttle penalty applied before physics uses it.
    fuel = Math.max(0, fuel - dt * 1.15 - controls.throttle * dt * 0.9);
    if (fuel <= 0) controls.throttle *= 0.15;

    const state = vehicle.update(controls, dt);
    lastSpeed = state.speed;

    // TEMP DEBUG — remove once the fall-through issue is confirmed fixed.
    // Logs roughly twice a second so the console doesn't get flooded.
    if (Math.floor(performance.now() / 500) !== window.__lastDbgTick) {
      window.__lastDbgTick = Math.floor(performance.now() / 500);
      const wheelDebug = vehicle.vehicle.wheelInfos.map(w => ({
        hasHit: w.raycastResult && w.raycastResult.hasHit,
        dist: w.raycastResult ? Number(w.raycastResult.distance).toFixed(2) : 'n/a',
        suspensionLength: w.suspensionLength !== undefined ? Number(w.suspensionLength).toFixed(2) : 'n/a',
      }));
      console.log(
        '[vehicle]', 'grounded:', state.grounded,
        '| pos:', state.position.x.toFixed(2), state.position.y.toFixed(2), state.position.z.toFixed(2),
        '| world.bodies:', world.bodies.length
      );
      console.table(wheelDebug);
    }

    distance = Math.max(distance, state.position.z);

    score += Math.floor(state.speed * dt * 1.2);
    if (!state.grounded) {
      wasAirborne = true;
      score += Math.floor(dt * 40); // air-time bonus
    } else {
      wasAirborne = false;
      // FIX: only trust position.y as "the ground" while actually grounded —
      // this is what the tunneling safety-net check below compares against.
      lastKnownGroundY = state.position.y;
    }
    if (state.justFlipped) {
      score += 500;
      showBadge(flipBadgeEl);
    }

    const zoneInfo = zoneManager.update(distance);
    zoneManager.moveWithCar(vehicle.mesh.position);
    zoneTagEl.textContent = zoneInfo.name;
    vehicle.headlights.forEach((l) => { l.intensity = zoneInfo.isNight ? 3.2 : 0; });

    cameraController.update(vehicle.mesh, state.speed, !state.grounded, dt);

    // falling out of the world (e.g. off a canyon edge with no bridge underneath)
    // is a valid crash, not a bug — catch it the same way as flipping
    if (state.position.y < -80) {
      state.crashed = true;
    }

    // FIX: safety net for physics tunneling glitches (e.g. a wheel raycast
    // slipping through a chunk seam for a frame). A real jump stays airborne
    // for a couple seconds at most and never drops far below the terrain it
    // just left; a tunneling bug keeps free-falling well past that. Rather
    // than let it turn into a "fell out of the world" crash 80m down, just
    // snap the car back onto the road near where it lost contact.
    if (!state.grounded && state.airTime > 3 && state.position.y < lastKnownGroundY - 10) {
      vehicle.reset(new THREE.Vector3(state.position.x, sampleRoad(state.position.z).y + SPAWN_HEIGHT_OFFSET, state.position.z));
    }

    if (state.crashed) {
      gameOver = true;
      crashDistanceEl.textContent = Math.floor(distance);
      crashScoreEl.textContent = score;
      crashScreen.classList.remove('hidden');
      hud.classList.add('hidden');
    }

    updateHud(state);
  }

  renderer.render(scene, camera);
}

function updateHud(state) {
  distanceEl.innerHTML = Math.floor(distance - SPAWN_Z) + '<span class="hud-unit">m</span>';
  scoreEl.textContent = score;
  const speedKmh = state.speed * 3.6;
  speedFillEl.style.width = Math.min(100, (speedKmh / 140) * 100) + '%';
  fuelFillEl.style.width = fuel + '%';
  fuelFillEl.style.background = fuel < 20 ? 'var(--fuel-color-low)' : 'var(--fuel-color)';

  if (!state.grounded && state.airTime > 0.45) {
    airBadgeEl.classList.remove('hidden');
    airBadgeEl.style.animation = 'none';
    void airBadgeEl.offsetWidth;
    airBadgeEl.style.animation = '';
  } else {
    airBadgeEl.classList.add('hidden');
  }
}

function showBadge(el) {
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 900);
}

boot();