import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { sampleRoad, sampleRoadFrame, projectToRoad, warmRoad } from './roadgen.js';
import { createTerrainManager, ROAD_MATERIAL, BARRIER_MATERIAL } from './terrain.js';
import { createVehicle, CHASSIS_MATERIAL } from './vehicle.js';
import { createCameraController } from './camera.js';
import { createZoneManager } from './zones.js';
import { createBackground } from './background.js';
import { setLampsLit } from './scenery.js';
import { createPickupManager, PICKUP, FUEL_PER_CAN, BOOST_SECONDS, SHIELD_SECONDS, DOUBLE_SECONDS } from './pickups.js';
import { createTrafficManager } from './traffic.js';
import { createEffects } from './effects.js';
import { createAudio } from './audio.js';

/* ============================== DOM ============================== */
const $ = (id) => document.getElementById(id);
const canvas = $('game-canvas');
const loadingScreen = $('loading-screen');
const loadingFill = $('loading-fill');
const loadingTip = $('loading-tip');
const startScreen = $('start-screen');
const startBtn = $('start-btn');
const hud = $('hud');
const crashScreen = $('crash-screen');
const retryBtn = $('retry-btn');
const menuBtn = $('menu-btn');
const resumeBtn = $('resume-btn');
const quitBtn = $('quit-btn');
const cameraToggleBtn = $('camera-toggle');
const muteBtn = $('mute-toggle');
const pauseScreen = $('pause-screen');

const distanceEl = $('hud-distance');
const scoreEl = $('hud-score');
const bestEl = $('hud-best');
const speedFillEl = $('speed-fill');
const fuelFillEl = $('fuel-fill');
const healthFillEl = $('health-fill');
const zoneTagEl = $('zone-tag');
const airBadgeEl = $('air-badge');
const flipBadgeEl = $('flip-badge');
const toastEl = $('toast');
const powerRowEl = $('power-row');
const crashDistanceEl = $('crash-distance');
const crashScoreEl = $('crash-score');
const crashBestEl = $('crash-best');
const crashReasonEl = $('crash-reason');
const flashEl = $('damage-flash');

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

/* SPAWN_S, not SPAWN_Z: the car's progress is measured as arc length along the
 * road, because on a road that genuinely turns, world z is no longer a measure
 * of how far you have driven. */
const SPAWN_S = 20;
const SPAWN_HEIGHT_OFFSET = 1.5;
const BEST_KEY = 'ridgerunner.best';
const MAX_HEALTH = 100;

/* How far ahead the camera and the HUD look for corner information. */
const LOOK_AHEAD_DISTANCE = 34;

/* ============================== STATE MACHINE ==============================
 * Previously `started`, `gameOver` and `paused` were three loose booleans and
 * Escape only toggled pause, with no way back to the menu. A single explicit
 * state makes the legal transitions obvious and is what the Escape key needs. */
const STATE = { LOADING: 'LOADING', MENU: 'MENU', PLAYING: 'PLAYING', PAUSED: 'PAUSED', OVER: 'OVER' };
let state = STATE.LOADING;

function setState(next) {
  state = next;
  startScreen.classList.toggle('hidden', next !== STATE.MENU);
  hud.classList.toggle('hidden', next !== STATE.PLAYING && next !== STATE.PAUSED);
  pauseScreen.classList.toggle('hidden', next !== STATE.PAUSED);
  crashScreen.classList.toggle('hidden', next !== STATE.OVER);
}

/* ============================== HELPERS ============================== */
function updateProgress(pct, tip) {
  loadingFill.style.width = Math.min(100, pct) + '%';
  if (tip) loadingTip.textContent = tip;
}
function yieldFrame() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}
function loadBest() { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } }
function saveBest(v) { try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* private mode */ } }

/* ============================== GAME STATE ============================== */
let world, terrain, vehicle, cameraController, zoneManager, background,
  pickups, traffic, effects, audio;
const keys = {};
let fuel = 100;
let health = MAX_HEALTH;
let score = 0;
let best = loadBest();
let distance = SPAWN_S;
/* The car's current arc length along the road. Maintained frame to frame and
 * fed back into projectToRoad as a hint, which keeps the search local and cheap
 * and stops a hairpin snapping the projection onto the other side of the bend
 * where the two halves of the corner pass close together. */
let carS = SPAWN_S;
let lastKnownGroundY = 0;
let lastSpeed = 0;
let offRoadTime = 0;

// power-up timers, in seconds remaining
const timers = { boost: 0, shield: 0, double: 0 };

const FUEL_IDLE_BURN = 1.2;
const FUEL_THROTTLE_BURN = 0.9;

/* ============================== BOOT ============================== */
async function boot() {
  updateProgress(2, 'Warming up the engine...');
  await yieldFrame();

  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -18, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.solver.iterations = 12;
  world.defaultContactMaterial.friction = 0.4;

  /* Guardrails are almost frictionless against the chassis, with a little
   * bounce. Previously they used the world default of 0.4, which meant clipping
   * a rail at speed killed nearly all forward momentum and parked the car
   * against the wall. Now it slides along and scrapes. */
  /* Barrier friction is deliberately ZERO. Solver friction against a wall the
   * car is being driven into is violently nonlinear, because the normal force
   * needed to resolve the penetration is huge and the friction force scales
   * with it. Measured, clipping a rail at 122 km/h and straightening up:
   *     mu = 0.40  ->   0% of speed kept (dead stop, the reported bug)
   *     mu = 0.20  ->   0%
   *     mu = 0.02  ->  12%
   *     mu = 0.00  ->  95%
   * There is no usable value between "sticks like glue" and "frictionless", so
   * the wall is frictionless and the cost of scraping is applied as a scripted
   * scrub in step() instead, where it can actually be tuned. */
  world.addContactMaterial(new CANNON.ContactMaterial(CHASSIS_MATERIAL, BARRIER_MATERIAL, {
    friction: 0, restitution: 0.25,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(CHASSIS_MATERIAL, ROAD_MATERIAL, {
    friction: 0.35, restitution: 0,
  }));
  updateProgress(6, 'Setting up physics...');
  await yieldFrame();

  // integrate a good stretch of road before any chunk asks for it, so the
  // first few chunk builds don't each pay to extend the table
  warmRoad(4000);

  terrain = createTerrainManager(scene, world);
  await terrain.ensureRange(SPAWN_S, async (frac) => {
    updateProgress(6 + frac * 52, 'Carving the mountain road...');
    await yieldFrame();
  });
  updateProgress(58, 'Road complete');
  await yieldFrame();

  updateProgress(62, 'Setting the sky...');
  await yieldFrame();
  zoneManager = createZoneManager(scene);
  updateProgress(70, 'Raising the mountains...');
  await yieldFrame();
  background = createBackground(scene);
  updateProgress(76, 'Sky ready');
  await yieldFrame();

  updateProgress(80, 'Assembling the buggy...');
  await yieldFrame();
  const frame = sampleRoadFrame(SPAWN_S);
  vehicle = createVehicle(
    world,
    frame.center.clone().addScaledVector(frame.roadUp, SPAWN_HEIGHT_OFFSET),
    headingOf(frame),
  );
  scene.add(vehicle.sceneGroup);
  lastKnownGroundY = frame.center.y;
  updateProgress(88, 'Buggy ready');
  await yieldFrame();

  pickups = createPickupManager(scene);
  traffic = createTrafficManager(scene);
  effects = createEffects(scene);
  audio = createAudio();
  cameraController = createCameraController(camera);
  bindInput();
  updateProgress(100, 'Ready to ride!');
  await yieldFrame();

  loadingScreen.classList.add('hidden');
  setState(STATE.MENU);
  requestAnimationFrame(animate);
}

/* ============================== INPUT ============================== */
const SWALLOW = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

function bindInput() {
  window.addEventListener('keydown', (e) => {
    if (SWALLOW.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys[e.code] = true;
    if (e.code === 'KeyC') toggleCamera();
    if (e.code === 'KeyR' && state === STATE.PLAYING) respawnPenalty();
    if (e.code === 'KeyM') toggleMute();
    if (e.code === 'KeyP') togglePause();
    if (e.code === 'Escape') onEscape();
  });
  window.addEventListener('keyup', (e) => {
    if (SWALLOW.has(e.code)) e.preventDefault();
    keys[e.code] = false;
  });
  window.addEventListener('blur', () => { for (const k of Object.keys(keys)) keys[k] = false; });

  cameraToggleBtn.addEventListener('click', toggleCamera);
  if (muteBtn) muteBtn.addEventListener('click', toggleMute);

  bindHoldButton('btn-gas', 'KeyW');
  bindHoldButton('btn-brake', 'KeyS');
  bindHoldButton('btn-left', 'KeyA');
  bindHoldButton('btn-right', 'KeyD');

  startBtn.addEventListener('click', () => { audio.start(); audio.uiClick(); beginRun(); });
  retryBtn.addEventListener('click', () => { audio.uiClick(); beginRun(); });
  if (menuBtn) menuBtn.addEventListener('click', () => { audio.uiClick(); toMenu(); });
  if (resumeBtn) resumeBtn.addEventListener('click', () => { audio.uiClick(); togglePause(); });
  if (quitBtn) quitBtn.addEventListener('click', () => { audio.uiClick(); toMenu(); });
}

/* Escape is context-sensitive: it pauses a run, and from the pause screen it
 * goes back to the main menu. Previously it did nothing at all. */
function onEscape() {
  if (state === STATE.PLAYING) togglePause();
  else if (state === STATE.PAUSED) toMenu();
  else if (state === STATE.OVER) toMenu();
}

function toggleCamera() {
  cameraController.toggle();
  cameraToggleBtn.textContent = cameraController.mode === 'chase' ? '\u{1F4F7}' : '\u{1F697}';
}

function toggleMute() {
  if (!audio) return;
  audio.setMuted(!audio.isMuted());
  if (muteBtn) muteBtn.textContent = audio.isMuted() ? '\u{1F507}' : '\u{1F50A}';
}

function togglePause() {
  if (state === STATE.PLAYING) setState(STATE.PAUSED);
  else if (state === STATE.PAUSED) { setState(STATE.PLAYING); audio.resume(); }
}

function readControls() {
  const throttle = (keys['KeyW'] || keys['ArrowUp']) ? 1 : 0;
  const brake = (keys['KeyS'] || keys['ArrowDown']) ? 1 : 0;
  let lateral = 0;
  if (keys['KeyA'] || keys['ArrowLeft']) lateral -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) lateral += 1;
  return {
    throttle, brake,
    steer: lateral, tilt: lateral,
    handbrake: !!keys['Space'],
    boost: timers.boost > 0,
  };
}

function bindHoldButton(id, key) {
  const el = $(id);
  if (!el) return;
  const set = (v) => (keys[key] = v);
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); set(true); el.setPointerCapture?.(e.pointerId); });
  el.addEventListener('pointerup', (e) => { e.preventDefault(); set(false); });
  el.addEventListener('pointercancel', () => set(false));
  el.addEventListener('pointerleave', () => set(false));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

/* ============================== RUN LIFECYCLE ============================== */
/** Yaw (about world Y) that points along a road frame's tangent. */
function headingOf(frame) {
  return Math.atan2(frame.tangent.x, frame.tangent.z);
}

/**
 * Puts the car back on the road at arc length `s`, FACING ALONG THE ROAD.
 * Respawning always pointing down +Z was fine when the road only ever went that
 * way; on a road that turns up to ~77 degrees off axis it can drop the car
 * facing a guardrail, or backwards.
 */
function respawnAt(s) {
  const frame = sampleRoadFrame(s);
  vehicle.reset(
    frame.center.clone().addScaledVector(frame.roadUp, SPAWN_HEIGHT_OFFSET),
    headingOf(frame),
  );
  carS = s;
  terrain.update(s, 0);
  lastKnownGroundY = frame.center.y;
  lastSpeed = 0;
  offRoadTime = 0;
  cameraController.reset();
}

/** Manual respawn (R). Costs health, so it can't be used to cheese traffic. */
function respawnPenalty() {
  respawnAt(Math.max(SPAWN_S, distance - 15));
  health = Math.max(1, health - 10);
  toast('RESPAWN  -10 HP');
}

function beginRun() {
  respawnAt(SPAWN_S);
  pickups.reset();
  traffic.reset();
  effects.reset();
  fuel = 100;
  health = MAX_HEALTH;
  score = 0;
  distance = SPAWN_S;
  timers.boost = timers.shield = timers.double = 0;
  setState(STATE.PLAYING);
  audio.start();
  audio.resume();
}

function toMenu() {
  setState(STATE.MENU);
  respawnAt(SPAWN_S);
  distance = SPAWN_S;
}

function endRun(reason) {
  if (score > best) { best = score; saveBest(best); }
  crashDistanceEl.textContent = Math.floor(distance - SPAWN_S);
  crashScoreEl.textContent = score;
  if (crashBestEl) crashBestEl.textContent = best;
  if (crashReasonEl) crashReasonEl.textContent = reason;
  audio.crash();
  cameraController.addTrauma(1);
  setState(STATE.OVER);
}

function toast(text) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  toastEl.style.animation = 'none';
  void toastEl.offsetWidth;
  toastEl.style.animation = '';
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.add('hidden'), 1100);
}

function damageFlash() {
  if (!flashEl) return;
  flashEl.style.animation = 'none';
  void flashEl.offsetWidth;
  flashEl.style.animation = 'dmg-flash 0.45s ease-out';
}

/* ============================== MAIN LOOP ============================== */
const clock = new THREE.Clock();
const FIXED_DT = 1 / 120;
const MAX_STEPS = 8;
let accumulator = 0;
const _fwd = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _scrapePoint = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  if (state === STATE.PLAYING) {
    step(dt);
  } else if (state === STATE.MENU) {
    // slow idle orbit behind the parked car, so the menu isn't a static image
    const t = performance.now() * 0.00016;
    const p = sampleRoad(SPAWN_S);
    camera.position.set(p.x + Math.sin(t) * 15, p.y + 6, p.z + Math.cos(t) * 15);
    camera.lookAt(p.x, p.y + 1, p.z);
    const at = new THREE.Vector3(p.x, p.y, p.z);
    zoneManager.moveWithCar(at);
    const zi = zoneManager.update(SPAWN_S);
    background.setPalette(zi.skyColor, zi.groundColor, zi.nightness);
    background.update(at, camera, dt);
  }

  renderer.render(scene, camera);
}

function step(dt) {
  /* Everything downstream is indexed by arc length, so the first thing each
   * frame does is re-derive it from the car's world position. The previous
   * value is passed as a hint so the search stays local. */
  const proj = projectToRoad(vehicle.chassisBody.position, carS, 70);
  carS = proj.s;
  terrain.update(carS, lastSpeed);

  accumulator += dt;
  let steps = 0;
  while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
    world.step(FIXED_DT);
    accumulator -= FIXED_DT;
    steps++;
  }
  if (steps === MAX_STEPS) accumulator = 0;

  // tick power-up timers
  for (const k of Object.keys(timers)) timers[k] = Math.max(0, timers[k] - dt);

  const controls = readControls();

  fuel = Math.max(0, fuel - dt * FUEL_IDLE_BURN - controls.throttle * dt * FUEL_THROTTLE_BURN);
  if (fuel <= 0) controls.throttle *= 0.15;

  const st = vehicle.update(controls, dt);
  lastSpeed = st.speed;

  /* ---- pickups ---- */
  const { taken } = pickups.update(st.position, carS, dt, performance.now());
  for (const type of taken) {
    audio.pickup(type);
    if (type === PICKUP.FUEL) { fuel = Math.min(100, fuel + FUEL_PER_CAN); toast('FUEL +' + FUEL_PER_CAN); }
    else if (type === PICKUP.BOOST) { timers.boost = BOOST_SECONDS; audio.boostStart(); toast('BOOST!'); }
    else if (type === PICKUP.SHIELD) { timers.shield = SHIELD_SECONDS; toast('SHIELD UP'); }
    else if (type === PICKUP.DOUBLE) { timers.double = DOUBLE_SECONDS; toast('DOUBLE SCORE'); }
    score += 60;
  }

  /* ---- traffic ----
   * The obstacle is a moving vehicle now, not a static hazard, so what the
   * player is dodging is genuinely traffic: same-direction cars and trucks
   * they have to find a way past, and oncoming ones closing fast in the
   * other lane. A hit still knocks the car off line, same as a hazard used
   * to, just harder — this is a collision with another vehicle, not a rock. */
  const { impacts } = traffic.update(st.position, carS, dt);
  for (const hit of impacts) {
    effects.impactSparks(st.position);
    if (timers.shield > 0) {
      audio.impact(0.6);
      cameraController.addTrauma(0.35);
      toast('SHIELD ABSORBED');
    } else {
      health -= hit.damage;
      audio.impact(1);
      cameraController.addTrauma(0.8);
      damageFlash();
      toast(hit.kind + ' HIT!');
      // knock the car off line, so a hit costs you time as well as health
      const b = vehicle.chassisBody;
      b.angularVelocity.y += (Math.random() - 0.5) * 5;
      b.velocity.scale(0.68, b.velocity);
    }
  }

  /* ---- scoring ----
   * Progress is arc length, not world z. Scoring off z would pay almost nothing
   * for a hard left-hander (where z barely increases while the car covers a lot
   * of road) and could even run backwards through a hairpin. */
  const mult = timers.double > 0 ? 2 : 1;
  distance = Math.max(distance, carS);
  score += Math.floor(st.speed * dt * 1.2) * mult;
  if (!st.grounded) score += Math.floor(dt * 40) * mult;
  else lastKnownGroundY = st.position.y;
  if (st.justFlipped) { score += 500 * mult; showBadge(flipBadgeEl); audio.pickup('BOOST'); }
  // reward holding a slide through a corner rather than merely surviving it
  if (st.drifting) score += Math.floor(st.slipAngle * st.speed * dt * 6) * mult;

  /* ---- world / camera / effects ----
   * Zone (sky/fog/lighting) must track the car's CURRENT arc length, same as
   * terrain/pickups/traffic — using the high-water-mark `distance` instead
   * would leave the sky showing the farthest zone reached even after the car
   * drives back into an earlier one. */
  const zoneInfo = zoneManager.update(carS);
  zoneManager.moveWithCar(vehicle.mesh.position);
  background.setPalette(zoneInfo.skyColor, zoneInfo.groundColor, zoneInfo.nightness);
  background.update(vehicle.mesh.position, camera, dt);
  zoneTagEl.textContent = zoneInfo.name;
  setLampsLit(zoneInfo.isNight);
  vehicle.headlights.forEach((l) => {
    l.intensity = zoneInfo.isNight ? 6.5 : 0.35;
    l.distance = zoneInfo.isNight ? 110 : 40;
  });

  /* Wall scrape / off-road. Measured by projecting onto the road frame rather
   * than from contact events: it is cheap, deterministic, and gives a contact
   * point to throw sparks from without digging through the solver's contact
   * list. `proj` was already computed at the top of this frame.
   *
   * The threshold is the LOCAL half-width, because the road widens through
   * corners now — a fixed ROAD_WIDTH/2 would report a scrape in the middle of
   * every wide bend. */
  const frame = proj.frame;
  const lateral = proj.lateral;
  const edge = frame.halfWidth - 1.25;
  const scraping = Math.abs(lateral) > edge && st.speed > 4 && st.grounded;
  if (scraping) {
    const side = Math.sign(lateral);
    _scrapePoint.copy(st.position).addScaledVector(frame.right, side * 0.9);
    effects.impactSparks(_scrapePoint, 3);
    cameraController.addTrauma(0.035);
    // Scripted cost of riding the rail: a predictable ~18%/s speed scrub plus a
    // slow hull bleed. Doing it here rather than through solver friction is what
    // keeps a glancing hit from becoming a dead stop.
    const b = vehicle.chassisBody;
    b.velocity.scale(Math.pow(0.82, dt), b.velocity);
    health -= dt * 2.5;
  }

  /* Stuck-detection: if the car somehow ends up well outside the barriers (a
   * bad landing on top of a rail, say) it used to sit there until the fuel ran
   * out, since the fall-through check only fires for a big drop. */
  if (Math.abs(lateral) > frame.halfWidth + 6) {
    offRoadTime += dt;
    if (offRoadTime > 2.5) {
      respawnAt(Math.max(SPAWN_S, carS - 8));
      health = Math.max(1, health - 5);
      toast('BACK ON TRACK  -5 HP');
    }
  } else {
    offRoadTime = 0;
  }

  effects.wheelDust(st.wheelPositions, st.speed, st.grounded, dt);
  if (timers.boost > 0) {
    _fwd.set(0, 0, 1).applyQuaternion(vehicle.mesh.quaternion);
    effects.boostTrail(st.position, _fwd, dt);
  }
  effects.update(dt);

  cameraController.setBoost(timers.boost > 0);
  cameraController.update(vehicle.mesh, st.speed, !st.grounded, dt);

  audio.update({
    speed: st.speed, throttle: controls.throttle, grounded: st.grounded,
    sliding: st.sliding, shielded: timers.shield > 0, boosting: timers.boost > 0,
    scraping,
  }, st.topSpeed);

  /* ---- end conditions ---- */
  if (!st.grounded && st.airTime > 3 && st.position.y < lastKnownGroundY - 10) {
    respawnAt(Math.max(SPAWN_S, carS));
  } else if (health <= 0) {
    endRun('Your buggy fell apart');
  } else if (st.position.y < lastKnownGroundY - 150) {
    endRun('You went over the edge');
  } else if (st.crashed) {
    endRun('You landed on your roof');
  }

  updateHud(st);
}

function updateHud(st) {
  distanceEl.innerHTML = Math.floor(distance - SPAWN_S) + '<span class="hud-unit">m</span>';
  scoreEl.textContent = score;
  if (bestEl) bestEl.textContent = Math.max(best, score);
  speedFillEl.style.width = Math.min(100, (st.speed * 3.6 / 200) * 100) + '%';
  fuelFillEl.style.width = fuel + '%';
  fuelFillEl.style.background = fuel < 20 ? 'var(--fuel-color-low)' : 'var(--fuel-color)';
  if (healthFillEl) {
    healthFillEl.style.width = Math.max(0, health) + '%';
    healthFillEl.style.background = health < 30 ? 'var(--fuel-color-low)' : 'var(--health-color)';
  }

  if (powerRowEl) {
    powerRowEl.innerHTML =
      (timers.boost > 0 ? `<span class="pip pip-boost">BOOST ${timers.boost.toFixed(1)}</span>` : '') +
      (timers.shield > 0 ? `<span class="pip pip-shield">SHIELD ${timers.shield.toFixed(1)}</span>` : '') +
      (timers.double > 0 ? `<span class="pip pip-double">2x ${timers.double.toFixed(1)}</span>` : '');
  }

  airBadgeEl.classList.toggle('hidden', !(!st.grounded && st.airTime > 0.45));
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