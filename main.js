import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { sampleRoad } from './roadgen.js';
import { createTerrainManager } from './terrain.js';
import { createVehicle } from './vehicle.js';
import { createCameraController } from './camera.js';
import { createZoneManager } from './zones.js';
import { createPickupManager } from './pickups.js';

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
const pauseScreen = document.getElementById('pause-screen');

const distanceEl = document.getElementById('hud-distance');
const scoreEl = document.getElementById('hud-score');
const bestEl = document.getElementById('hud-best');
const speedFillEl = document.getElementById('speed-fill');
const fuelFillEl = document.getElementById('fuel-fill');
const zoneTagEl = document.getElementById('zone-tag');
const airBadgeEl = document.getElementById('air-badge');
const flipBadgeEl = document.getElementById('flip-badge');
const fuelBadgeEl = document.getElementById('fuel-badge');
const crashDistanceEl = document.getElementById('crash-distance');
const crashScoreEl = document.getElementById('crash-score');
const crashReasonEl = document.getElementById('crash-reason');

/* ============================== THREE SETUP ============================== */
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

const SPAWN_Z = 20;

// FIX: was 4 m, which dropped the car onto the road hard enough to bounce and
// occasionally land badly before the player had touched anything. Now that
// wheel raycasts actually detect the road (see roadgen's handedness fix) the
// suspension settles on its own, so a small clearance is all that is needed.
const SPAWN_HEIGHT_OFFSET = 1.5;

const BEST_KEY = 'ridgerunner.best';

/* ============================== LOADING HELPERS ============================== */
function updateProgress(pct, tip) {
  loadingFill.style.width = Math.min(100, pct) + '%';
  if (tip) loadingTip.textContent = tip;
}
function yieldFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function loadBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}
function saveBest(v) {
  try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* private mode, ignore */ }
}

/* ============================== GAME STATE ============================== */
let world, terrain, vehicle, cameraController, zoneManager, pickups;
const keys = {};
let fuel = 100;
let score = 0;
let best = loadBest();
let distance = SPAWN_Z;
let started = false;
let gameOver = false;
let paused = false;

// height of the road the last time the car was genuinely grounded, used by the
// tunnelling safety net below
let lastKnownGroundY = 0;
let lastSpeed = 0;

/* Fuel burn. The original drained ~2%/s with no way to refuel, emptying a full
 * tank in about 45 s and ending every run the same way. Burn is gentler now and
 * pickups.js scatters cans along the road, so fuel is a reason to keep moving
 * rather than a countdown you cannot affect. */
const FUEL_IDLE_BURN = 1.2;      // per second
const FUEL_THROTTLE_BURN = 0.9;  // extra per second at full throttle

/* ============================== BOOT ============================== */
async function boot() {
  updateProgress(2, 'Warming up the engine...');
  await yieldFrame();

  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -18, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.solver.iterations = 12;
  world.defaultContactMaterial.friction = 0.4;
  updateProgress(5, 'Setting up physics...');
  await yieldFrame();

  terrain = createTerrainManager(scene, world);
  await terrain.ensureRange(SPAWN_Z, async (frac) => {
    updateProgress(5 + frac * 55, 'Carving the mountain road...');
    await yieldFrame();
  });
  updateProgress(60, 'Road complete');
  await yieldFrame();

  updateProgress(64, 'Setting the sky...');
  await yieldFrame();
  zoneManager = createZoneManager(scene);
  updateProgress(78, 'Sky ready');
  await yieldFrame();

  updateProgress(80, 'Assembling the buggy...');
  await yieldFrame();
  const spawnSample = sampleRoad(SPAWN_Z);
  const spawnPos = new THREE.Vector3(spawnSample.x, spawnSample.y + SPAWN_HEIGHT_OFFSET, spawnSample.z);
  vehicle = createVehicle(world, spawnPos);
  scene.add(vehicle.sceneGroup);
  lastKnownGroundY = spawnSample.y;
  updateProgress(90, 'Buggy ready');
  await yieldFrame();

  pickups = createPickupManager(scene);
  cameraController = createCameraController(camera);
  bindInput();
  updateProgress(100, 'Ready to ride!');
  await yieldFrame();

  loadingScreen.classList.add('hidden');
  startScreen.classList.remove('hidden');
  requestAnimationFrame(animate);
}

/* ============================== INPUT ============================== */
// keys the browser would otherwise act on (scrolling the page) while driving
const SWALLOW = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

function bindInput() {
  window.addEventListener('keydown', (e) => {
    if (SWALLOW.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys[e.code] = true;
    if (e.code === 'KeyC') toggleCamera();
    if (e.code === 'KeyR') resetVehicle();
    if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
  });
  window.addEventListener('keyup', (e) => {
    if (SWALLOW.has(e.code)) e.preventDefault();
    keys[e.code] = false;
  });
  // dropping focus (alt-tab) used to leave keys stuck down
  window.addEventListener('blur', () => { for (const k of Object.keys(keys)) keys[k] = false; });

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
  cameraToggleBtn.textContent = cameraController.mode === 'chase' ? '\u{1F4F7}' : '\u{1F697}';
}

function togglePause() {
  if (!started || gameOver) return;
  paused = !paused;
  pauseScreen.classList.toggle('hidden', !paused);
}

function readControls() {
  const throttle = (keys['KeyW'] || keys['ArrowUp']) ? 1 : 0;
  const brake = (keys['KeyS'] || keys['ArrowDown']) ? 1 : 0;
  let lateral = 0;
  if (keys['KeyA'] || keys['ArrowLeft']) lateral -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) lateral += 1;
  const handbrake = !!keys['Space'];
  // A/D now do double duty: they steer the front wheels on the ground and
  // pitch the chassis in the air. vehicle.js decides which applies.
  return { throttle, brake, steer: lateral, tilt: lateral, handbrake };
}

/* touch / pointer controls */
function bindHoldButton(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  const set = (v) => (keys[key] = v);
  // FIX: only touchstart/touchend were bound, so the on-screen buttons did
  // nothing for mouse or stylus users. Pointer events cover all three.
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); set(true); el.setPointerCapture?.(e.pointerId); });
  el.addEventListener('pointerup', (e) => { e.preventDefault(); set(false); });
  el.addEventListener('pointercancel', () => set(false));
  el.addEventListener('pointerleave', () => set(false));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

/* ============================== RESET HELPERS ============================== */
function respawnAt(z) {
  const s = sampleRoad(z);
  vehicle.reset(new THREE.Vector3(s.x, s.y + SPAWN_HEIGHT_OFFSET, z));
  terrain.update(z, 0);
  lastKnownGroundY = s.y;
  lastSpeed = 0;
}

function resetVehicle() {
  if (!started) return;
  respawnAt(Math.max(SPAWN_Z, distance - 15));
  fuel = Math.max(fuel, 30);
  gameOver = false;
  crashScreen.classList.add('hidden');
  // FIX: this hid the crash screen but never restored the HUD, so pressing R
  // after a crash resumed play with no distance/score/speed/fuel readout.
  hud.classList.remove('hidden');
}

function fullReset() {
  respawnAt(SPAWN_Z);
  pickups.reset();
  fuel = 100;
  score = 0;
  distance = SPAWN_Z;
  gameOver = false;
  paused = false;
  pauseScreen.classList.add('hidden');
  crashScreen.classList.add('hidden');
}

function endRun(reason) {
  gameOver = true;
  if (score > best) { best = score; saveBest(best); }
  crashDistanceEl.textContent = Math.floor(distance - SPAWN_Z);
  crashScoreEl.textContent = score;
  if (crashReasonEl) crashReasonEl.textContent = reason;
  crashScreen.classList.remove('hidden');
  hud.classList.add('hidden');
}

/* ============================== MAIN LOOP ============================== */
const clock = new THREE.Clock();
// FIX: halved from 1/60. Wheel contact is a raycast reaching ~1 m below each
// wheel, so the shorter the step the less distance the car covers between
// contact tests and the harder it is to slip through the road on a fast
// landing. MAX_STEPS stops a stalled tab from trying to catch up all at once.
const FIXED_DT = 1 / 120;
const MAX_STEPS = 8;
let accumulator = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  if (started && !gameOver && !paused) {
    // stream chunks in around the car's ACTUAL position before stepping
    // physics. FIX: this used to be passed `distance`, which only ever
    // increases, so reversing or being knocked backwards could put the car on
    // road that had already been unloaded.
    const carZ = vehicle.chassisBody.position.z;
    terrain.update(carZ, lastSpeed);

    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      world.step(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) accumulator = 0;

    const controls = readControls();

    // fuel is spent before physics consumes the throttle, so running dry
    // actually affects this frame's driving
    fuel = Math.max(0, fuel - dt * FUEL_IDLE_BURN - controls.throttle * dt * FUEL_THROTTLE_BURN);
    if (fuel <= 0) controls.throttle *= 0.15;

    const state = vehicle.update(controls, dt);
    lastSpeed = state.speed;

    const reward = pickups.update(state.position, dt);
    if (reward.collected > 0) {
      fuel = Math.min(100, fuel + reward.fuel);
      score += reward.score;
      showBadge(fuelBadgeEl);
    }

    distance = Math.max(distance, state.position.z);
    score += Math.floor(state.speed * dt * 1.2);

    if (!state.grounded) {
      score += Math.floor(dt * 40); // air-time bonus
    } else {
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

    // Safety net for physics tunnelling. A real jump never drops far below the
    // terrain it left; a tunnelling bug free-falls well past it. Snap back onto
    // the road rather than let it become a bogus "fell out of the world".
    if (!state.grounded && state.airTime > 3 && state.position.y < lastKnownGroundY - 10) {
      respawnAt(Math.max(SPAWN_Z, state.position.z));
    } else if (state.position.y < lastKnownGroundY - 150) {
      endRun('You went over the edge');
    } else if (state.crashed) {
      endRun('You landed on your roof');
    }

    updateHud(state);
  }

  renderer.render(scene, camera);
}

function updateHud(state) {
  distanceEl.innerHTML = Math.floor(distance - SPAWN_Z) + '<span class="hud-unit">m</span>';
  scoreEl.textContent = score;
  if (bestEl) bestEl.textContent = Math.max(best, score);
  const speedKmh = state.speed * 3.6;
  speedFillEl.style.width = Math.min(100, (speedKmh / 140) * 100) + '%';
  fuelFillEl.style.width = fuel + '%';
  fuelFillEl.style.background = fuel < 20 ? 'var(--fuel-color-low)' : 'var(--fuel-color)';

  if (!state.grounded && state.airTime > 0.45) {
    airBadgeEl.classList.remove('hidden');
  } else {
    airBadgeEl.classList.add('hidden');
  }
}

function showBadge(el) {
  if (!el) return;
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 900);
}

boot();
