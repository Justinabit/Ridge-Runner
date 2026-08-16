import * as THREE from 'three';
import { octaveNoise, hash1 } from './noise.js';

/* =============================================================================
 * BACKGROUND
 *
 * Everything beyond the playable world: layered mountain ranges, a cloud deck,
 * and a sun/moon disc.
 *
 * All of it is parented to a single group that is re-centred on the car every
 * frame, so it never gets closer no matter how far you drive — the standard
 * skybox trick, and the only way to have "distant" geometry in a world that
 * streams forever without either running out of mountains or paying to build
 * new ones.
 *
 * Two consequences of that follow from parallax, and both are deliberate:
 *  - The ranges are rebuilt as rings around the origin rather than as a flat
 *    backdrop, so they still look correct when the road turns 70 degrees off
 *    axis. A single billboard plane facing +Z would swing out of view in the
 *    first hairpin.
 *  - They are excluded from fog and drawn behind everything else, because a
 *    mountain at a nominal 900 m that never approaches must not fade the way
 *    real geometry at 900 m would.
 * ========================================================================== */

const RANGES = [
  // radius, height, segments, colour blend toward sky, vertical offset
  { radius: 1150, height: 260, segments: 96, haze: 0.62, y: -40, roughness: 1.0 },
  { radius: 850, height: 190, segments: 80, haze: 0.42, y: -30, roughness: 1.5 },
  { radius: 620, height: 130, segments: 64, haze: 0.22, y: -22, roughness: 2.2 },
];

const CLOUD_COUNT = 26;

/**
 * One ring of mountains: a closed strip of triangles whose top edge is a noisy
 * silhouette and whose bottom edge sits below the horizon.
 *
 * Rendered with vertex colours so the peaks can be lighter than the bases,
 * which is what sells aerial perspective far more cheaply than any lighting
 * would — these meshes use MeshBasicMaterial and are never lit at all.
 */
function makeRange(spec) {
  const { radius, height, segments, y, roughness } = spec;
  const positions = [];
  const colors = [];
  const indices = [];
  const base = y - 300;   // extends well below the horizon so no gap can show

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const angle = t * Math.PI * 2;
    // Sampling the noise on the CIRCLE (by angle) rather than by index is what
    // makes the silhouette seamless where the ring closes: at i = 0 and
    // i = segments the angle differs by exactly 2pi, so the same noise
    // coordinate is sampled and the two ends meet exactly.
    const n1 = octaveNoise(Math.cos(angle) * roughness * 3 + 11.3, 3, 0.55);
    const n2 = octaveNoise(Math.sin(angle) * roughness * 3 + 47.7, 3, 0.55);
    const ridge = (n1 * 0.6 + n2 * 0.4);
    // abs() then curve: gives sharp peaks and broad valleys instead of a
    // symmetric wobble, which is what a mountain silhouette actually looks like
    const peak = Math.pow(Math.abs(ridge), 0.75) * height + height * 0.12;

    const x = Math.sin(angle) * radius;
    const z = Math.cos(angle) * radius;
    positions.push(x, y + peak, z);
    positions.push(x, base, z);

    // peaks slightly lighter than bases
    const lift = 0.18 * (peak / height);
    colors.push(lift, lift, lift);   // placeholder, tinted per-frame below
    colors.push(0, 0, 0);

    if (i < segments) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    fog: false,          // see the note at the top: these never get closer
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  /* Drawn before everything else with no depth write, so real geometry always
   * paints over them regardless of the nominal distances involved. */
  mesh.renderOrder = -10;
  return { mesh, geo, spec };
}

/** A soft, flat-bottomed cloud built from a few overlapping spheres. */
function makeCloudGeometry() {
  const parts = [];
  const count = 3 + Math.floor(hash1(Math.random() * 999) * 3);
  for (let i = 0; i < count; i++) {
    const r = 18 + Math.random() * 26;
    const geo = new THREE.SphereGeometry(r, 7, 5);
    geo.translate(
      (Math.random() - 0.5) * 70,
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 40,
    );
    parts.push(geo);
  }
  // merge by hand: BufferGeometryUtils is an addon and this avoids the import
  let total = 0;
  for (const g of parts) total += g.attributes.position.count;
  const positions = new Float32Array(total * 3);
  const indices = [];
  let vOffset = 0;
  let pOffset = 0;
  for (const g of parts) {
    const p = g.attributes.position.array;
    positions.set(p, pOffset);
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i++) indices.push(idx[i] + vOffset);
    vOffset += g.attributes.position.count;
    pOffset += p.length;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setIndex(indices);
  return merged;
}

export function createBackground(scene) {
  /* One group, re-centred on the car every frame. Everything inside it is
   * positioned relative to the viewer, which is what makes it "infinitely far
   * away" without any of it actually being far away. */
  const group = new THREE.Group();
  scene.add(group);

  const ranges = RANGES.map((spec) => {
    const r = makeRange(spec);
    group.add(r.mesh);
    return r;
  });

  /* ---------------- clouds ---------------- */
  const cloudMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.55, fog: false, depthWrite: false,
  });
  const cloudGroup = new THREE.Group();
  cloudGroup.renderOrder = -9;
  group.add(cloudGroup);

  const clouds = [];
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const geo = makeCloudGeometry();
    const mesh = new THREE.Mesh(geo, cloudMat);
    const angle = (i / CLOUD_COUNT) * Math.PI * 2 + Math.random() * 0.4;
    const radius = 400 + Math.random() * 600;
    mesh.position.set(
      Math.sin(angle) * radius,
      190 + Math.random() * 190,
      Math.cos(angle) * radius,
    );
    const s = 0.8 + Math.random() * 1.8;
    mesh.scale.set(s, s * 0.55, s);
    mesh.frustumCulled = false;
    cloudGroup.add(mesh);
    clouds.push({ mesh, drift: 2 + Math.random() * 5, angle, radius });
  }

  /* ---------------- sun / moon ----------------
   * Positioned to match the directional light's direction in zones.js
   * (-60, 90, -40) so the shading and the visible light source agree. Nothing
   * looks more obviously wrong than shadows pointing away from the sun. */
  const sunDir = new THREE.Vector3(-60, 90, -40).normalize();
  const sunGroup = new THREE.Group();
  group.add(sunGroup);

  const sunDisc = new THREE.Mesh(
    new THREE.CircleGeometry(46, 24),
    new THREE.MeshBasicMaterial({ color: 0xfff0c0, fog: false, transparent: true, depthWrite: false }),
  );
  const sunGlow = new THREE.Mesh(
    new THREE.CircleGeometry(120, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffcf8a, fog: false, transparent: true, opacity: 0.18, depthWrite: false,
    }),
  );
  sunGroup.add(sunGlow, sunDisc);
  sunGroup.position.copy(sunDir).multiplyScalar(1000);
  sunGroup.renderOrder = -11;
  sunDisc.frustumCulled = false;
  sunGlow.frustumCulled = false;

  const _rangeTop = new THREE.Color();
  const _rangeBottom = new THREE.Color();
  const _sky = new THREE.Color();

  /**
   * Retints the background to match the current zone.
   * @param {THREE.Color} skyColor mid-sky colour, what the haze blends toward
   * @param {THREE.Color} groundColor the zone's ground tint
   * @param {number} nightness 0 by day, 1 at night
   */
  function setPalette(skyColor, groundColor, nightness) {
    _sky.copy(skyColor);
    for (const { geo, spec } of ranges) {
      /* Haze: distant ranges sit closer to the sky colour, near ones closer to
       * the ground colour. This is the whole depth cue — without it the three
       * rings read as one flat silhouette. */
      _rangeBottom.copy(groundColor).lerp(_sky, spec.haze);
      _rangeTop.copy(_rangeBottom).lerp(_sky, 0.22);
      // rocky peaks lift toward grey/white rather than toward the ground tint
      _rangeTop.lerp(new THREE.Color(0xffffff), 0.12 * (1 - nightness));

      const colors = geo.attributes.color;
      for (let i = 0; i < colors.count; i += 2) {
        colors.setXYZ(i, _rangeTop.r, _rangeTop.g, _rangeTop.b);
        colors.setXYZ(i + 1, _rangeBottom.r, _rangeBottom.g, _rangeBottom.b);
      }
      colors.needsUpdate = true;
    }

    cloudMat.color.copy(_sky).lerp(new THREE.Color(0xffffff), 0.7 - 0.55 * nightness);
    cloudMat.opacity = 0.5 - 0.22 * nightness;

    // the sun becomes a small pale moon at night
    sunDisc.material.color.set(nightness > 0.5 ? 0xdfe6ff : 0xfff0c0);
    sunGlow.material.opacity = 0.18 * (1 - nightness * 0.7);
    sunDisc.scale.setScalar(1 - 0.45 * nightness);
  }

  const _camPos = new THREE.Vector3();

  /**
   * @param {THREE.Vector3} carPosition
   * @param {THREE.Camera} camera clouds and the sun disc billboard toward this
   * @param {number} dt
   */
  function update(carPosition, camera, dt) {
    // recentre on the car, but keep the vertical origin at world 0 so the
    // mountains don't bob up and down with every hill the car crests
    group.position.set(carPosition.x, 0, carPosition.z);

    camera.getWorldPosition(_camPos);
    sunDisc.lookAt(_camPos);
    sunGlow.lookAt(_camPos);

    for (const c of clouds) {
      // slow orbital drift, so the sky is never completely static
      c.angle += (c.drift * 0.0006) * dt;
      c.mesh.position.x = Math.sin(c.angle) * c.radius;
      c.mesh.position.z = Math.cos(c.angle) * c.radius;
    }
  }

  function dispose() {
    for (const { geo } of ranges) geo.dispose();
    for (const c of clouds) c.mesh.geometry.dispose();
  }

  return { update, setPalette, dispose, group };
}
