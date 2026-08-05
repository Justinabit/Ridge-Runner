import * as THREE from 'three';
import { sampleRoad, ROAD_WIDTH } from './roadgen.js';

export const ZONES = [
  {
    name: 'SUNSET HILLS',
    start: 0,
    sky: [0xffb86b, 0xff6a8f, 0x3a2255],
    fog: 0xff9d6c,
    fogDensity: 0.0018,
    ambient: 0xffc9a3,
    ambientIntensity: 0.65,
    sun: 0xffd9a0,
    sunIntensity: 1.2,
    groundTint: 0x8a5b46,
  },
  {
    name: 'FOREST',
    start: 1400,
    sky: [0x9fd8b0, 0x4f8f6a, 0x1f3d2d],
    fog: 0x6fae7f,
    fogDensity: 0.0026,
    ambient: 0xbfe6c4,
    ambientIntensity: 0.55,
    sun: 0xe9ffcf,
    sunIntensity: 1.0,
    groundTint: 0x3c6b3a,
  },
  {
    name: 'BEACH',
    start: 2900,
    sky: [0x9fe0ff, 0x5cb8ff, 0x2a6fbf],
    fog: 0xbfe9ff,
    fogDensity: 0.0014,
    ambient: 0xffffff,
    ambientIntensity: 0.9,
    sun: 0xffffff,
    sunIntensity: 1.35,
    groundTint: 0xd8c48a,
  },
  {
    name: 'NIGHT',
    start: 4300,
    sky: [0x2a2450, 0x171236, 0x07061a],
    fog: 0x1b1640,
    // FIX (night visibility): fog was 0.0032, nearly double the daytime value,
    // while ambient sat at 0.28. Between them the road faded out a few metres
    // ahead and the night zone was effectively unplayable. Fog is now thinner
    // than daytime rather than thicker, and ambient is lifted to a moonlit
    // level. Street lamps (scenery.js) and stronger headlights do the rest.
    fogDensity: 0.0016,
    ambient: 0x8290d8,
    ambientIntensity: 0.62,
    sun: 0x9aa8ff,
    sunIntensity: 0.55,
    groundTint: 0x1c1c33,
  },
];
const TRANSITION_BAND = 350;

/**
 * Ground colour at distance z, blended across zone boundaries. Pure function of
 * z so terrain.js can tint verge vertices without needing the zone manager
 * instance. groundTint was previously declared on every zone and never used.
 */
export function groundTintAt(z, target = new THREE.Color()) {
  let idx = 0;
  for (let i = 0; i < ZONES.length; i++) if (z >= ZONES[i].start) idx = i;
  const zone = ZONES[idx];
  const next = ZONES[idx + 1];
  target.set(zone.groundTint);
  if (next) {
    const bandStart = next.start - TRANSITION_BAND;
    if (z > bandStart) {
      const t = Math.min(1, Math.max(0, (z - bandStart) / TRANSITION_BAND));
      target.lerp(new THREE.Color(next.groundTint), t);
    }
  }
  return target;
}

/** Which scenery belongs at distance z. */
export function sceneryKindAt(z) {
  let idx = 0;
  for (let i = 0; i < ZONES.length; i++) if (z >= ZONES[i].start) idx = i;
  return ZONES[idx].name;
}
// The road itself streams forever via terrain.js, but decorative props are
// simple enough to just pre-scatter once, up front, out to a generous but
// finite horizon — plenty of road for this game's scale (~9km).
const SCENERY_HORIZON = 9000;

function makeSkyDome(colors) {
  const geo = new THREE.SphereGeometry(1400, 24, 16);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      colorTop: { value: new THREE.Color(colors[0]) },
      colorMid: { value: new THREE.Color(colors[1]) },
      colorBottom: { value: new THREE.Color(colors[2]) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vPos;
      uniform vec3 colorTop;
      uniform vec3 colorMid;
      uniform vec3 colorBottom;
      void main() {
        float h = normalize(vPos).y;
        vec3 col = h > 0.0
          ? mix(colorMid, colorTop, smoothstep(0.0, 0.7, h))
          : mix(colorMid, colorBottom, smoothstep(0.0, -0.5, h));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  });
  return new THREE.Mesh(geo, mat);
}

function makeStars(count = 800) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 900 + Math.random() * 400;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI * 0.55; // upper hemisphere mostly
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = Math.abs(r * Math.cos(phi)) + 60;
    pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0 });
  return new THREE.Points(geo, mat);
}

function makeTree(kind) {
  const g = new THREE.Group();
  if (kind === 'pine') {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1.2, 5), new THREE.MeshLambertMaterial({ color: 0x5b3a29 }));
    trunk.position.y = 0.6;
    const leaves = new THREE.Mesh(new THREE.ConeGeometry(1.1, 3.2, 6), new THREE.MeshLambertMaterial({ color: 0x2f6b3f, flatShading: true }));
    leaves.position.y = 2.6;
    g.add(trunk, leaves);
  } else if (kind === 'palm') {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, 3.2, 6), new THREE.MeshLambertMaterial({ color: 0x8a6a3f }));
    trunk.position.y = 1.6;
    trunk.rotation.z = 0.12;
    const frondMat = new THREE.MeshLambertMaterial({ color: 0x4fae5f, flatShading: true });
    for (let i = 0; i < 5; i++) {
      const frond = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.8, 4), frondMat);
      frond.position.y = 3.2;
      frond.rotation.z = Math.PI / 2.4;
      frond.rotation.y = (i / 5) * Math.PI * 2;
      g.add(frond);
    }
    g.add(trunk);
  } else {
    // deciduous
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 1.4, 5), new THREE.MeshLambertMaterial({ color: 0x5b3a29 }));
    trunk.position.y = 0.7;
    const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(1.3, 0), new THREE.MeshLambertMaterial({ color: 0x6cb04a, flatShading: true }));
    leaves.position.y = 2.3;
    g.add(trunk, leaves);
  }
  return g;
}

// FIX: main.js now calls `createZoneManager(scene)` directly, without
// `await` — so this must be synchronous, not async. It no longer takes a
// `track` object either (there's no whole-track curve anymore now that the
// road streams via terrain.js), so prop placement uses sampleRoad(z) from
// roadgen.js instead of track.curve.getPointAt(t), and ROAD_WIDTH is
// imported directly instead of coming from track.roadWidth.
export function createZoneManager(scene) {
  const skyDome = makeSkyDome(ZONES[0].sky);
  scene.add(skyDome);
  const stars = makeStars(500);
  scene.add(stars);

  const ambientLight = new THREE.AmbientLight(ZONES[0].ambient, ZONES[0].ambientIntensity);
  scene.add(ambientLight);

  const sunLight = new THREE.DirectionalLight(ZONES[0].sun, ZONES[0].sunIntensity);
  sunLight.position.set(-60, 90, -40);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  sunLight.shadow.camera.left = -60;
  sunLight.shadow.camera.right = 60;
  sunLight.shadow.camera.top = 60;
  sunLight.shadow.camera.bottom = -60;
  sunLight.shadow.camera.far = 250;
  scene.add(sunLight);
  scene.add(sunLight.target);

  scene.fog = new THREE.FogExp2(ZONES[0].fog, ZONES[0].fogDensity);

  // ---------------- instanced props per zone ----------------
  const propGroup = new THREE.Group();
  scene.add(propGroup);

  function scatterProps(kind, zoneStart, zoneEnd, count, sideRange) {
    const proto = makeTree(kind);
    const meshes = [];
    // FIX: trunk/leaves/frond parts are never added to a rendered scene
    // graph, so three.js never calls updateMatrix() on them and their
    // .matrix stayed at the identity default even after position/rotation
    // were set above. Without this, every part of every instanced tree
    // collapsed onto the same point instead of forming a tree.
    proto.traverse((c) => { if (c.isMesh) { c.updateMatrix(); meshes.push(c); } });
    const instanced = meshes.map((m) => {
      const inst = new THREE.InstancedMesh(m.geometry, m.material, count);
      inst.castShadow = true;
      propGroup.add(inst);
      return { inst, localMatrix: m.matrix.clone() };
    });

    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const z = zoneStart + Math.random() * (zoneEnd - zoneStart);
      const sample = sampleRoad(z); // FIX: was track.curve.getPointAt(t)
      const side = Math.random() < 0.5 ? -1 : 1;
      const dist = ROAD_WIDTH / 2 + 4 + Math.random() * sideRange; // FIX: was track.roadWidth
      dummy.position.set(sample.x + side * dist, sample.y - 0.2, sample.z);
      const s = 0.7 + Math.random() * 0.8;
      dummy.scale.set(s, s, s);
      dummy.rotation.y = Math.random() * Math.PI * 2;
      dummy.updateMatrix();
      for (const { inst, localMatrix } of instanced) {
        const m = dummy.matrix.clone().multiply(localMatrix);
        inst.setMatrixAt(i, m);
      }
    }
    instanced.forEach(({ inst }) => (inst.instanceMatrix.needsUpdate = true));
  }

  // seed props across each zone range (using the *next* zone's start as the end)
  const scatterJobs = [];
  for (let i = 0; i < ZONES.length; i++) {
    const zone = ZONES[i];
    const end = i + 1 < ZONES.length ? ZONES[i + 1].start : SCENERY_HORIZON; // FIX: was track.length
    if (zone.name === 'FOREST') {
      scatterJobs.push(() => scatterProps('pine', zone.start, end, 55, 22));
      scatterJobs.push(() => scatterProps('deciduous', zone.start, end, 24, 26));
    } else if (zone.name === 'BEACH') {
      scatterJobs.push(() => scatterProps('palm', zone.start, end, 28, 20));
    } else if (zone.name === 'SUNSET HILLS') {
      scatterJobs.push(() => scatterProps('deciduous', zone.start, end, 14, 30));
    }
    // NIGHT zone: sparse glowing "campfire" point lights instead of trees, added below
  }

  // night campfires / distant town lights (simple emissive spheres + point lights, sparse)
  const nightZone = ZONES[ZONES.length - 1];
  const fireGroup = new THREE.Group();
  scene.add(fireGroup);
  scatterJobs.push(() => {
    const fireMat = new THREE.MeshBasicMaterial({ color: 0xff8a3d });
    for (let i = 0; i < 10; i++) {
      const z = nightZone.start + Math.random() * (SCENERY_HORIZON - nightZone.start);
      const sample = sampleRoad(z); // FIX: was track.curve.getPointAt(t)
      const side = Math.random() < 0.5 ? -1 : 1;
      const dist = ROAD_WIDTH / 2 + 10 + Math.random() * 40;
      const fire = new THREE.Mesh(new THREE.SphereGeometry(0.4, 6, 6), fireMat);
      fire.position.set(sample.x + side * dist, sample.y + 0.3, sample.z);
      const glow = new THREE.PointLight(0xff8a3d, 0, 12);
      glow.position.copy(fire.position);
      fireGroup.add(fire, glow);
    }
  });

  // FIX: no longer awaited/async — main.js calls createZoneManager(scene)
  // directly and uses the return value immediately, so all scattering runs
  // synchronously here. This is cheap (just placing InstancedMesh matrices,
  // no heavy geometry work) so it doesn't need to yield across frames.
  scatterJobs.forEach((job) => job());

  function lerpColor(a, b, t) {
    return new THREE.Color(a).lerp(new THREE.Color(b), t);
  }

  let currentZoneName = ZONES[0].name;

  function update(distance) {
    // find current & next zone
    let idx = 0;
    for (let i = 0; i < ZONES.length; i++) if (distance >= ZONES[i].start) idx = i;
    const zone = ZONES[idx];
    const next = ZONES[idx + 1];

    let blend = 0;
    let target = zone;
    if (next) {
      const bandStart = next.start - TRANSITION_BAND;
      if (distance > bandStart) {
        blend = THREE.MathUtils.clamp((distance - bandStart) / TRANSITION_BAND, 0, 1);
        target = next;
      }
    }

    const fogColor = lerpColor(zone.fog, target.fog, blend);
    const fogDensity = THREE.MathUtils.lerp(zone.fogDensity, target.fogDensity, blend);
    scene.fog.color.copy(fogColor);
    scene.fog.density = fogDensity;

    ambientLight.color.copy(lerpColor(zone.ambient, target.ambient, blend));
    ambientLight.intensity = THREE.MathUtils.lerp(zone.ambientIntensity, target.ambientIntensity, blend);

    sunLight.color.copy(lerpColor(zone.sun, target.sun, blend));
    sunLight.intensity = THREE.MathUtils.lerp(zone.sunIntensity, target.sunIntensity, blend);

    skyDome.material.uniforms.colorTop.value.copy(lerpColor(zone.sky[0], target.sky[0], blend));
    skyDome.material.uniforms.colorMid.value.copy(lerpColor(zone.sky[1], target.sky[1], blend));
    skyDome.material.uniforms.colorBottom.value.copy(lerpColor(zone.sky[2], target.sky[2], blend));

    const isNightish = zone.name === 'NIGHT' ? 1 - blend : (target.name === 'NIGHT' ? blend : 0);
    stars.material.opacity = isNightish;
    fireGroup.children.forEach((c) => {
      if (c.isPointLight) c.intensity = isNightish * 2.2;
    });

    currentZoneName = blend > 0.5 ? target.name : zone.name;

    return { name: currentZoneName, isNight: isNightish > 0.5 };
  }

  const sunOffset = new THREE.Vector3(-60, 90, -40);
  function moveWithCar(position) {
    skyDome.position.set(position.x, 0, position.z);
    stars.position.set(position.x, 0, position.z);
    // keep the directional light (and its shadow frustum) centered on the car
    sunLight.position.set(position.x + sunOffset.x, sunOffset.y, position.z + sunOffset.z);
    sunLight.target.position.set(position.x, position.y, position.z);
    sunLight.target.updateMatrixWorld();
  }

  return { update, moveWithCar, sunLight, get currentZoneName() { return currentZoneName; } };
}