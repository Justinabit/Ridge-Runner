import * as THREE from 'three';

export const ZONES = [
  {
    name: 'SUNSET HILLS',
    start: 0,
    sky: [0xffb86b, 0xff6a8f, 0x3a2255],
    fog: 0xff9d6c,
    fogDensity: 0.0013,
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
    fogDensity: 0.0019,
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
    fogDensity: 0.0011,
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
    /* Night fog is deliberately THINNER than daytime, not thicker. It was 0.0032
     * against an ambient of 0.28, which between them faded the road out a few
     * metres ahead and made the night zone effectively unplayable. Street lamps,
     * unlit lane markings and stronger headlights carry the mood instead. */
    fogDensity: 0.0013,
    ambient: 0x8290d8,
    ambientIntensity: 0.62,
    sun: 0x9aa8ff,
    sunIntensity: 0.55,
    groundTint: 0x1c1c33,
  },
];
const TRANSITION_BAND = 350;

/* Fog densities above are all lower than they were. The road now has real
 * corners and crests worth seeing coming, and the new distant mountains are the
 * main visual payoff of a hilltop — both are wasted if the view fades out at
 * 200 m. */

/** Index of the zone active at arc length `s`, plus blend info to the next. */
function zoneAt(s) {
  let idx = 0;
  for (let i = 0; i < ZONES.length; i++) if (s >= ZONES[i].start) idx = i;
  const zone = ZONES[idx];
  const next = ZONES[idx + 1];
  let blend = 0;
  let target = zone;
  if (next) {
    const bandStart = next.start - TRANSITION_BAND;
    if (s > bandStart) {
      blend = THREE.MathUtils.clamp((s - bandStart) / TRANSITION_BAND, 0, 1);
      target = next;
    }
  }
  return { zone, target, blend };
}

/**
 * Ground colour at arc length `s`, blended across zone boundaries. A pure
 * function so terrain.js can tint verge and hillside vertices without needing
 * the zone manager instance.
 */
export function groundTintAt(s, out = new THREE.Color()) {
  const { zone, target, blend } = zoneAt(s);
  out.set(zone.groundTint);
  if (blend > 0) out.lerp(new THREE.Color(target.groundTint), blend);
  return out;
}

/** Which scenery belongs at arc length `s`. */
export function sceneryKindAt(s) {
  const { zone, target, blend } = zoneAt(s);
  return blend > 0.5 ? target.name : zone.name;
}

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
  const mesh = new THREE.Mesh(geo, mat);
  // must paint before the distant mountains, which sit "in front of" it
  mesh.renderOrder = -20;
  return mesh;
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
  const mat = new THREE.PointsMaterial({
    color: 0xffffff, size: 2.2, sizeAttenuation: false,
    transparent: true, opacity: 0, fog: false, depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.renderOrder = -19;
  return points;
}

/* NOTE: this used to pre-scatter a few dozen trees up front, out to a fixed
 * 9 km horizon, positioned by sampling the road at a world z. Both halves of
 * that are gone:
 *   - scenery.js now builds roadside props per chunk from the actual road
 *     frames, so props are placed on ground by construction and continue
 *     forever rather than stopping at 9 km;
 *   - and the placement maths could not survive the road becoming a curve
 *     anyway, since it indexed the road by z.
 * What remains here is purely atmosphere: sky, light, fog and the night lamps
 * managed per chunk elsewhere. */

export function createZoneManager(scene) {
  const skyDome = makeSkyDome(ZONES[0].sky);
  scene.add(skyDome);
  const stars = makeStars(500);
  scene.add(stars);

  const ambientLight = new THREE.AmbientLight(ZONES[0].ambient, ZONES[0].ambientIntensity);
  scene.add(ambientLight);

  /* A weak hemisphere light on top of the ambient. Flat ambient light makes
   * every face of a low-poly model exactly the same brightness, which is what
   * made the old hills read as silhouettes; a sky/ground gradient gives upward
   * faces and downward faces different tints for almost no cost. */
  const hemiLight = new THREE.HemisphereLight(ZONES[0].sky[1], ZONES[0].groundTint, 0.45);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(ZONES[0].sun, ZONES[0].sunIntensity);
  sunLight.position.set(-60, 90, -40);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  sunLight.shadow.camera.left = -70;
  sunLight.shadow.camera.right = 70;
  sunLight.shadow.camera.top = 70;
  sunLight.shadow.camera.bottom = -70;
  sunLight.shadow.camera.far = 260;
  sunLight.shadow.bias = -0.0008;
  scene.add(sunLight);
  scene.add(sunLight.target);

  scene.fog = new THREE.FogExp2(ZONES[0].fog, ZONES[0].fogDensity);

  function lerpColor(a, b, t) {
    return new THREE.Color(a).lerp(new THREE.Color(b), t);
  }

  let currentZoneName = ZONES[0].name;
  // exposed so background.js can match its haze to the sky without recomputing
  const skyMid = new THREE.Color(ZONES[0].sky[1]);
  const groundColor = new THREE.Color(ZONES[0].groundTint);
  let nightness = 0;

  /** @param {number} s arc length travelled along the road */
  function update(s) {
    const { zone, target, blend } = zoneAt(s);

    const fogColor = lerpColor(zone.fog, target.fog, blend);
    scene.fog.color.copy(fogColor);
    scene.fog.density = THREE.MathUtils.lerp(zone.fogDensity, target.fogDensity, blend);

    ambientLight.color.copy(lerpColor(zone.ambient, target.ambient, blend));
    ambientLight.intensity = THREE.MathUtils.lerp(zone.ambientIntensity, target.ambientIntensity, blend);

    sunLight.color.copy(lerpColor(zone.sun, target.sun, blend));
    sunLight.intensity = THREE.MathUtils.lerp(zone.sunIntensity, target.sunIntensity, blend);

    skyMid.copy(lerpColor(zone.sky[1], target.sky[1], blend));
    groundColor.copy(lerpColor(zone.groundTint, target.groundTint, blend));
    hemiLight.color.copy(skyMid);
    hemiLight.groundColor.copy(groundColor);

    skyDome.material.uniforms.colorTop.value.copy(lerpColor(zone.sky[0], target.sky[0], blend));
    skyDome.material.uniforms.colorMid.value.copy(skyMid);
    skyDome.material.uniforms.colorBottom.value.copy(lerpColor(zone.sky[2], target.sky[2], blend));

    nightness = zone.name === 'NIGHT' ? 1 - blend : (target.name === 'NIGHT' ? blend : 0);
    stars.material.opacity = nightness;

    currentZoneName = blend > 0.5 ? target.name : zone.name;

    return {
      name: currentZoneName,
      isNight: nightness > 0.5,
      nightness,
      skyColor: skyMid,
      groundColor,
    };
  }

  const sunOffset = new THREE.Vector3(-60, 90, -40);
  function moveWithCar(position) {
    skyDome.position.set(position.x, 0, position.z);
    stars.position.set(position.x, 0, position.z);
    // keep the directional light (and its shadow frustum) centred on the car
    sunLight.position.set(position.x + sunOffset.x, position.y + sunOffset.y, position.z + sunOffset.z);
    sunLight.target.position.set(position.x, position.y, position.z);
    sunLight.target.updateMatrixWorld();
  }

  return {
    update, moveWithCar, sunLight,
    get currentZoneName() { return currentZoneName; },
  };
}
