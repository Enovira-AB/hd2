// Scene, atmosphere and static world geometry. The dark cinematic look lives
// here: night fog, moonlight, bloom and a film grade pass. Terrain and rock
// placement come from shared/world.ts so they match the server exactly.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { generateLayout, terrainHeight, mulberry32, type WorldLayout } from '../../shared/world.js';
import { MAP_HALF } from '../../shared/constants.js';
import { makeGlowSprite, softCircleTexture, terrainSpeckleTexture } from './textures.js';

// custom sky: vertical gradient, horizon glow band and slow aurora curtains
const SkyShader = {
  uniforms: { uTime: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    varying vec3 vDir;
    void main() {
      vec3 dir = normalize(vDir);
      float h = max(dir.y, 0.0);
      vec3 zenith = vec3(0.010, 0.014, 0.028);
      vec3 horizon = vec3(0.045, 0.068, 0.110);
      vec3 col = mix(horizon, zenith, pow(h, 0.55));
      // cold glow hugging the horizon
      float band = exp(-pow((dir.y - 0.02) * 9.0, 2.0));
      col += vec3(0.045, 0.085, 0.105) * band;
      // slow aurora curtains high in the sky
      float a = sin(dir.x * 5.0 + uTime * 0.05) * sin(dir.z * 3.5 - uTime * 0.037);
      float curtains = smoothstep(0.18, 0.75, dir.y) * max(a, 0.0);
      col += vec3(0.010, 0.135, 0.085) * curtains * 0.5;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const FilmGradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      // subtle cool grade in the shadows
      col = mix(col, col * vec3(0.92, 1.0, 1.12), 0.25 * (1.0 - smoothstep(0.0, 0.6, col.g)));
      // vignette
      float d = distance(vUv, vec2(0.5));
      col *= 1.0 - smoothstep(0.42, 0.86, d) * 0.55;
      // animated grain
      float g = hash(vUv * vec2(1920.0, 1080.0) + fract(time) * 100.0) - 0.5;
      col += g * 0.035;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class World3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly mobile: boolean;
  layout!: WorldLayout;
  seed = 0;

  private composer: EffectComposer;
  private film: ShaderPass;
  private moon: THREE.DirectionalLight;
  private worldGroup = new THREE.Group();
  private dust!: THREE.Points;
  private mist: THREE.Sprite[] = [];
  private skyMat!: THREE.ShaderMaterial;
  private nestGlows: THREE.Mesh[] = [];
  private nestHalos: THREE.Sprite[] = [];
  private padRing!: THREE.Mesh;
  private padPillar!: THREE.Mesh;
  private padLight!: THREE.PointLight;
  private padHalo!: THREE.Sprite;
  private padMode: 'off' | 'on' | 'blink' = 'off';

  constructor(canvas: HTMLCanvasElement, mobile: boolean) {
    this.mobile = mobile;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = !mobile;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070c);
    this.scene.fog = new THREE.FogExp2(0x0a0e16, 0.0145);

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 1200);
    this.camera.position.set(0, 3, 8);

    const hemi = new THREE.HemisphereLight(0x2a3a5f, 0x0b0d10, 0.38);
    this.scene.add(hemi);

    this.moon = new THREE.DirectionalLight(0x9fb6e8, 0.72);
    this.moon.position.set(40, 70, 25);
    if (!mobile) {
      this.moon.castShadow = true;
      this.moon.shadow.mapSize.set(2048, 2048);
      const c = this.moon.shadow.camera;
      c.left = -60; c.right = 60; c.top = 60; c.bottom = -60;
      c.near = 10; c.far = 220;
      this.moon.shadow.bias = -0.0006;
    }
    this.scene.add(this.moon, this.moon.target);

    this.buildSky();
    this.buildDust();
    this.scene.add(this.worldGroup);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(512, 512),
      mobile ? 0.65 : 0.85,
      0.55,
      0.45,
    );
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());
    this.film = new ShaderPass(FilmGradeShader);
    this.composer.addPass(this.film);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.mobile ? 1.6 : 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---- sky -------------------------------------------------------------------

  private buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      ...SkyShader,
      uniforms: { uTime: { value: 0 } },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(840, 32, 18), this.skyMat);
    dome.renderOrder = -1;
    dome.frustumCulled = false;
    this.scene.add(dome);

    const rng = mulberry32(77);
    const starPos: number[] = [];
    const starCount = this.mobile ? 900 : 1600;
    for (let i = 0; i < starCount; i++) {
      // half the stars cluster into a milky-way band
      const band = i % 2 === 0;
      let theta = rng() * Math.PI * 2;
      let phi = Math.acos(rng() * 0.95); // upper dome
      if (band) {
        const along = rng() * Math.PI * 2;
        const off = (rng() - 0.5) * 0.5;
        theta = along;
        phi = Math.PI / 2 - 0.5 + off + Math.sin(along * 2) * 0.18;
        phi = Math.max(0.12, Math.min(Math.PI / 2, phi));
      }
      const r = 760;
      starPos.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi) + 20,
        r * Math.sin(phi) * Math.sin(theta),
      );
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({
        color: 0xcdd8ee, size: 1.5, sizeAttenuation: false, fog: false,
        transparent: true, opacity: 0.85,
      }),
    );
    this.scene.add(stars);

    const bright = new THREE.Points(
      starGeo.clone(),
      new THREE.PointsMaterial({
        color: 0xffffff, size: 2.6, sizeAttenuation: false, fog: false,
        transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    bright.geometry.setDrawRange(0, 90);
    this.scene.add(bright);

    // a dead red planet on the horizon — pure set dressing
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(130, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0x451f22, fog: false }),
    );
    planet.position.set(-440, 120, -580);
    this.scene.add(planet);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(140, 32, 24),
      new THREE.MeshBasicMaterial({
        color: 0x6b2d31, fog: false, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
      }),
    );
    glow.position.copy(planet.position);
    this.scene.add(glow);

    const moonBall = new THREE.Mesh(
      new THREE.SphereGeometry(42, 24, 18),
      new THREE.MeshBasicMaterial({ color: 0xc3cfe2, fog: false }),
    );
    moonBall.position.set(380, 260, -620);
    this.scene.add(moonBall);
  }

  private buildDust() {
    const rng = mulberry32(9);
    const n = this.mobile ? 260 : 480;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (rng() - 0.5) * 90;
      pos[i * 3 + 1] = rng() * 14;
      pos[i * 3 + 2] = (rng() - 0.5) * 90;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        map: softCircleTexture(),
        color: 0x8fa8cc, size: 0.09, transparent: true, opacity: 0.45,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    this.scene.add(this.dust);

    // rolling ground mist: a handful of huge faint sprites drifting low
    const mistRng = mulberry32(31);
    for (let i = 0; i < (this.mobile ? 5 : 9); i++) {
      const s = makeGlowSprite(0x36465e, 16 + mistRng() * 18, 0.05);
      s.position.set((mistRng() - 0.5) * 70, 0.8 + mistRng() * 1.6, (mistRng() - 0.5) * 70);
      s.userData.drift = [(mistRng() - 0.5) * 0.4, (mistRng() - 0.5) * 0.4];
      this.mist.push(s);
      this.scene.add(s);
    }
  }

  // ---- world from seed ---------------------------------------------------------

  buildWorld(seed: number) {
    this.seed = seed;
    this.layout = generateLayout(seed);
    this.worldGroup.clear();
    this.nestGlows = [];
    this.nestHalos = [];

    // terrain with vertex-color variation and slope shading
    const segs = this.mobile ? 96 : 128;
    const size = MAP_HALF * 2 + 30;
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const posAttr = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(posAttr.count * 3);
    const base = new THREE.Color(0x2e3338);
    const lichen = new THREE.Color(0x27403a);
    const tint = new THREE.Color();
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);
      posAttr.setY(i, terrainHeight(seed, x, z));
      const v = terrainHeight(seed ^ 0x1234, x * 3.1 + 500, z * 3.1 + 500) * 0.06;
      const l = Math.max(0, Math.min(1, terrainHeight(seed ^ 0x77aa, x * 0.8 + 900, z * 0.8 + 900) * 0.22 - 0.45));
      tint.copy(base).lerp(lichen, l).multiplyScalar(0.85 + v);
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
    }
    geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const speckle = terrainSpeckleTexture();
    speckle.repeat.set(70, 70);
    const terrain = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true, map: speckle, roughness: 0.96, metalness: 0.02,
      }),
    );
    terrain.receiveShadow = !this.mobile;
    this.worldGroup.add(terrain);

    // rocks, instanced
    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x3b4148, roughness: 0.95, flatShading: true });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, this.layout.rocks.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const rng = mulberry32(seed ^ 0xfeed);
    this.layout.rocks.forEach((rock, i) => {
      const y = terrainHeight(seed, rock.x, rock.z);
      q.setFromEuler(new THREE.Euler(rng() * 0.4, rng() * Math.PI * 2, rng() * 0.4));
      m.compose(
        new THREE.Vector3(rock.x, y + rock.h * 0.12, rock.z),
        q,
        new THREE.Vector3(rock.r * 1.06, rock.h, rock.r * (0.85 + rng() * 0.4)),
      );
      rocks.setMatrixAt(i, m);
    });
    rocks.castShadow = !this.mobile;
    rocks.receiveShadow = !this.mobile;
    this.worldGroup.add(rocks);

    // bug nests: glowing mounds
    for (const nest of this.layout.nests) {
      const y = terrainHeight(seed, nest.x, nest.z);
      const mound = new THREE.Mesh(
        new THREE.IcosahedronGeometry(2.6, 1),
        new THREE.MeshStandardMaterial({
          color: 0x33251c, roughness: 0.9, flatShading: true,
          emissive: 0xff5a1f, emissiveIntensity: 0.55,
        }),
      );
      mound.position.set(nest.x, y - 0.6, nest.z);
      mound.scale.y = 0.55;
      this.worldGroup.add(mound);
      this.nestGlows.push(mound);
      const halo = makeGlowSprite(0xff5a1f, 7, 0.35);
      halo.position.set(nest.x, y + 1.4, nest.z);
      this.worldGroup.add(halo);
      this.nestHalos.push(halo);
      if (!this.mobile) {
        const l = new THREE.PointLight(0xff5a1f, 26, 17, 2);
        l.position.set(nest.x, y + 1.6, nest.z);
        this.worldGroup.add(l);
      }
      // scatter chitinous spikes around the mound
      const spikes = new THREE.InstancedMesh(
        new THREE.ConeGeometry(0.22, 1.7, 5),
        new THREE.MeshStandardMaterial({ color: 0x2a211a, roughness: 0.85, flatShading: true }),
        7,
      );
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + rng();
        const r = 2.6 + rng() * 1.8;
        const sx = nest.x + Math.cos(a) * r;
        const sz = nest.z + Math.sin(a) * r;
        q.setFromEuler(new THREE.Euler((rng() - 0.5) * 0.7, 0, (rng() - 0.5) * 0.7));
        m.compose(
          new THREE.Vector3(sx, terrainHeight(seed, sx, sz) + 0.5, sz),
          q,
          new THREE.Vector3(1, 0.8 + rng(), 1),
        );
        spikes.setMatrixAt(i, m);
      }
      this.worldGroup.add(spikes);
    }

    // extraction pad
    const pad = this.layout.pad;
    const padY = terrainHeight(seed, pad.x, pad.z);
    const padBase = new THREE.Mesh(
      new THREE.CylinderGeometry(6, 6.6, 0.5, 24),
      new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.6, metalness: 0.55 }),
    );
    padBase.position.set(pad.x, padY + 0.22, pad.z);
    padBase.receiveShadow = !this.mobile;
    this.worldGroup.add(padBase);

    this.padRing = new THREE.Mesh(
      new THREE.TorusGeometry(5.2, 0.14, 8, 40),
      new THREE.MeshStandardMaterial({
        color: 0x111111, emissive: 0xffd94a, emissiveIntensity: 0.0,
      }),
    );
    this.padRing.rotation.x = -Math.PI / 2;
    this.padRing.position.set(pad.x, padY + 0.5, pad.z);
    this.worldGroup.add(this.padRing);

    this.padPillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.55, 240, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffd94a, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        side: THREE.DoubleSide,
      }),
    );
    this.padPillar.position.set(pad.x, padY + 120, pad.z);
    this.worldGroup.add(this.padPillar);

    this.padLight = new THREE.PointLight(0xffd94a, 0, 24, 2);
    this.padLight.position.set(pad.x, padY + 3, pad.z);
    this.worldGroup.add(this.padLight);

    this.padHalo = makeGlowSprite(0xffd94a, 9, 0);
    this.padHalo.position.set(pad.x, padY + 2.2, pad.z);
    this.worldGroup.add(this.padHalo);

    // console terminal by the pad
    const term = new THREE.Group();
    const stand = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 1.1, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x32383f, metalness: 0.5, roughness: 0.5 }),
    );
    stand.position.y = 0.55;
    const screen = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.45, 0.08),
      new THREE.MeshStandardMaterial({
        color: 0x111418, emissive: 0x69d7ff, emissiveIntensity: 1.4,
      }),
    );
    screen.position.set(0, 1.18, 0);
    screen.rotation.x = -0.35;
    term.add(stand, screen);
    term.position.set(pad.x + 6.5, padY, pad.z);
    term.lookAt(pad.x, padY, pad.z);
    this.worldGroup.add(term);
  }

  setPadMode(mode: 'off' | 'on' | 'blink') {
    this.padMode = mode;
  }

  terrainY(x: number, z: number): number {
    return terrainHeight(this.seed, x, z);
  }

  // ---- per-frame ---------------------------------------------------------------

  update(dt: number, time: number, focus: THREE.Vector3) {
    // keep the shadow camera tight around the action
    this.moon.position.set(focus.x + 42, focus.y + 72, focus.z + 26);
    this.moon.target.position.copy(focus);
    this.moon.target.updateMatrixWorld();

    // drifting dust follows the player
    this.dust.position.set(focus.x, 0, focus.z);
    this.dust.rotation.y = time * 0.004;

    this.skyMat.uniforms.uTime.value = time;

    // mist drifts slowly and stays loosely centered on the player
    for (const m of this.mist) {
      const [dx, dz] = m.userData.drift as [number, number];
      m.position.x += dx * dt;
      m.position.z += dz * dt;
      if (Math.hypot(m.position.x - focus.x, m.position.z - focus.z) > 55) {
        m.position.x = focus.x + (focus.x > m.position.x ? 45 : -45);
        m.position.z = focus.z + (Math.random() - 0.5) * 70;
      }
    }

    for (let i = 0; i < this.nestGlows.length; i++) {
      const mat = this.nestGlows[i].material as THREE.MeshStandardMaterial;
      const pulse = Math.sin(time * 2.1 + i * 1.7);
      mat.emissiveIntensity = 0.45 + pulse * 0.2;
      const halo = this.nestHalos[i];
      if (halo) (halo.material as THREE.SpriteMaterial).opacity = 0.3 + pulse * 0.1;
    }

    if (this.padRing) {
      const ringMat = this.padRing.material as THREE.MeshStandardMaterial;
      const pillarMat = this.padPillar.material as THREE.MeshBasicMaterial;
      const haloMat = this.padHalo.material as THREE.SpriteMaterial;
      if (this.padMode === 'off') {
        ringMat.emissiveIntensity = 0;
        pillarMat.opacity = 0;
        this.padLight.intensity = 0;
        haloMat.opacity = 0;
      } else if (this.padMode === 'on') {
        ringMat.emissiveIntensity = 1.6;
        pillarMat.opacity = 0.075;
        this.padLight.intensity = 40;
        haloMat.opacity = 0.4;
      } else {
        const blink = Math.sin(time * 6) > 0 ? 1 : 0.15;
        ringMat.emissiveIntensity = 1.8 * blink;
        pillarMat.opacity = 0.085 * blink;
        this.padLight.intensity = 48 * blink;
        haloMat.opacity = 0.45 * blink;
      }
    }

    this.film.uniforms.time.value = time;
  }

  render() {
    this.composer.render();
  }
}
