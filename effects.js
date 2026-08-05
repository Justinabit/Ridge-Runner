import * as THREE from 'three';

/* Particle effects, all drawn from one pooled buffer per system so the whole
 * lot costs a handful of draw calls regardless of how much is happening. */

const MAX = 320;

function makeSystem(color, size, opacity = 0.9) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MAX * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setDrawRange(0, 0);
  const mat = new THREE.PointsMaterial({
    color, size, sizeAttenuation: true, transparent: true,
    opacity, depthWrite: false, blending: THREE.NormalBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, geo, pos, live: [] };
}

export function createEffects(scene) {
  const dust = makeSystem(0xc9b79a, 0.5, 0.55);
  const sparks = makeSystem(0xffc46b, 0.32, 1.0);
  const trail = makeSystem(0xff7a45, 0.6, 0.85);
  scene.add(dust.points, sparks.points, trail.points);

  function emit(sys, x, y, z, vx, vy, vz, life) {
    if (sys.live.length >= MAX) sys.live.shift();
    sys.live.push({ x, y, z, vx, vy, vz, life, max: life });
  }

  function stepSystem(sys, dt, gravity) {
    let n = 0;
    for (let i = sys.live.length - 1; i >= 0; i--) {
      const p = sys.live[i];
      p.life -= dt;
      if (p.life <= 0) { sys.live.splice(i, 1); continue; }
      p.vy += gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    }
    for (const p of sys.live) {
      sys.pos[n * 3] = p.x; sys.pos[n * 3 + 1] = p.y; sys.pos[n * 3 + 2] = p.z;
      n++;
    }
    sys.geo.attributes.position.needsUpdate = true;
    sys.geo.setDrawRange(0, n);
  }

  /** Dust kicked up by the wheels; scales with speed and stops when airborne. */
  function wheelDust(wheelPositions, speed, grounded, dt) {
    if (!grounded || speed < 6) return;
    const rate = Math.min(1, speed / 30);
    if (Math.random() > rate * 0.9) return;
    for (const wp of wheelPositions) {
      if (Math.random() > 0.5) continue;
      emit(dust, wp.x, wp.y + 0.1, wp.z,
        (Math.random() - 0.5) * 1.6, 0.6 + Math.random() * 1.2, (Math.random() - 0.5) * 1.6 - speed * 0.12,
        0.45 + Math.random() * 0.4);
    }
  }

  function impactSparks(pos, count = 22) {
    for (let i = 0; i < count; i++) {
      emit(sparks, pos.x, pos.y + 0.4, pos.z,
        (Math.random() - 0.5) * 9, Math.random() * 6, (Math.random() - 0.5) * 9,
        0.3 + Math.random() * 0.35);
    }
  }

  function boostTrail(pos, forward, dt) {
    for (let i = 0; i < 2; i++) {
      emit(trail, pos.x - forward.x * 1.9, pos.y + 0.15, pos.z - forward.z * 1.9,
        (Math.random() - 0.5) * 1.4 - forward.x * 6, 0.4 + Math.random(), (Math.random() - 0.5) * 1.4 - forward.z * 6,
        0.35 + Math.random() * 0.3);
    }
  }

  function update(dt) {
    stepSystem(dust, dt, -3.2);
    stepSystem(sparks, dt, -14);
    stepSystem(trail, dt, 1.2);
  }

  function reset() {
    dust.live.length = 0; sparks.live.length = 0; trail.live.length = 0;
    update(0);
  }

  return { wheelDust, impactSparks, boostTrail, update, reset };
}
