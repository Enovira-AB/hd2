// Visual effects: tracers, impacts, muzzle flashes, explosions, orbital
// beams, hellpods, the extraction shuttle, corpses and camera shake.
// Everything is pooled or capped — this must hold 60fps on a phone.

import * as THREE from 'three';
import { buildBug } from './bugs.js';
import { makeGlowSprite, smokeTexture, softCircleTexture } from './textures.js';

interface Tracer {
  mesh: THREE.Mesh;
  dir: THREE.Vector3;
  end: THREE.Vector3;
  speed: number;
  onArrive?: () => void;
  alive: boolean;
}

interface Burst {
  points: THREE.Points;
  vel: Float32Array;
  ttl: number;
  age: number;
  alive: boolean;
}

interface Timed {
  obj: THREE.Object3D;
  age: number;
  ttl: number;
  tick: (t: number) => void; // t = age/ttl 0..1
}

interface Pod {
  group: THREE.Group;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
  landed: boolean;
  onLand?: () => void;
  trail: THREE.Mesh;
}

const TRACER_GEO = new THREE.CylinderGeometry(0.022, 0.022, 1, 5);
TRACER_GEO.rotateX(Math.PI / 2); // length along +Z

export class Effects {
  private scene: THREE.Scene;
  private mobile: boolean;
  private tracers: Tracer[] = [];
  private bursts: Burst[] = [];
  private timed: Timed[] = [];
  private pods: Pod[] = [];
  private beacons = new Map<string, THREE.Group>();
  private corpses: Timed[] = [];
  private flashPool: THREE.PointLight[] = [];
  private trauma = 0;
  shuttle: THREE.Group | null = null;
  private shuttleState: 'hidden' | 'landing' | 'idle' | 'leaving' = 'hidden';
  private shuttleFrom = new THREE.Vector3();
  private shuttleTo = new THREE.Vector3();
  private shuttleT = 0;

  private flashSprites: THREE.Sprite[] = [];

  constructor(scene: THREE.Scene, mobile: boolean) {
    this.scene = scene;
    this.mobile = mobile;
    for (let i = 0; i < (mobile ? 2 : 4); i++) {
      const l = new THREE.PointLight(0xffc46b, 0, 14, 2);
      this.flashPool.push(l);
      scene.add(l);
      const s = makeGlowSprite(0xffd9a0, 1.1, 0);
      this.flashSprites.push(s);
      scene.add(s);
    }
  }

  // ---- camera shake ----------------------------------------------------------

  addShake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  // ---- time control (hitstop / slow-mo) --------------------------------------
  // gameplay dt is multiplied by timeScale(); both count down in real time.

  private hitstopUntil = 0;
  private slowmoUntil = 0;
  private slowmoScale = 1;

  requestHitstop(ms = 45) {
    this.hitstopUntil = Math.max(this.hitstopUntil, performance.now() + ms);
  }

  requestSlowmo(ms: number, scale = 0.35) {
    this.slowmoUntil = performance.now() + ms;
    this.slowmoScale = scale;
  }

  timeScale(): number {
    const now = performance.now();
    if (now < this.hitstopUntil) return 0.03;
    if (now < this.slowmoUntil) return this.slowmoScale;
    return 1;
  }

  shakeOffset(time: number, out: THREE.Vector3): number {
    const s = this.trauma * this.trauma;
    out.set(
      Math.sin(time * 91) * 0.35 * s,
      Math.cos(time * 83) * 0.3 * s,
      Math.sin(time * 71) * 0.25 * s,
    );
    return Math.sin(time * 97) * 0.05 * s; // roll
  }

  // ---- gunfire ----------------------------------------------------------------

  tracer(from: THREE.Vector3, to: THREE.Vector3, onArrive?: () => void) {
    if (this.tracers.filter((t) => t.alive).length > 26) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd28a, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const mesh = new THREE.Mesh(TRACER_GEO, mat);
    const dir = to.clone().sub(from);
    const dist = dir.length();
    dir.normalize();
    mesh.position.copy(from);
    mesh.scale.z = Math.min(7, dist);
    mesh.lookAt(to);
    this.scene.add(mesh);
    this.tracers.push({ mesh, dir, end: to.clone(), speed: 300, onArrive, alive: true });
  }

  muzzleFlash(pos: THREE.Vector3) {
    const i = this.flashPool.findIndex((l) => l.intensity <= 0.5);
    if (i === -1) return;
    this.flashPool[i].position.copy(pos);
    this.flashPool[i].intensity = 170;
    const sprite = this.flashSprites[i];
    sprite.position.copy(pos);
    const mat = sprite.material as THREE.SpriteMaterial;
    mat.opacity = 0.9;
    mat.rotation = Math.random() * Math.PI * 2;
    const sc = 0.8 + Math.random() * 0.5;
    sprite.scale.set(sc, sc, 1);
  }

  impact(pos: THREE.Vector3, kind: 'rock' | 'bug' | 'player' | 'nest' | 'none') {
    if (kind === 'none') return;
    const color = kind === 'bug' ? 0x9aff66 : kind === 'player' ? 0xff6655 : kind === 'nest' ? 0xff7a2a : 0xffb36b;
    this.burst(pos, kind === 'nest' ? 16 : 12, color, 4.5, 0.45, 0.09);
  }

  private burst(pos: THREE.Vector3, n: number, color: number, speed: number, ttl: number, size: number) {
    let b = this.bursts.find((x) => !x.alive);
    if (!b) {
      if (this.bursts.length > 18) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(26 * 3), 3));
      const points = new THREE.Points(geo, new THREE.PointsMaterial({
        map: softCircleTexture(),
        size: 0.09, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      b = { points, vel: new Float32Array(26 * 3), ttl: 0.5, age: 0, alive: false };
      this.bursts.push(b);
      this.scene.add(points);
    }
    const count = Math.min(n, 26);
    const posAttr = b.points.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      posAttr.setXYZ(i, pos.x, pos.y, pos.z);
      const a = Math.random() * Math.PI * 2;
      const e = Math.random() * Math.PI * 0.5;
      const v = speed * (0.4 + Math.random() * 0.6);
      b.vel[i * 3] = Math.cos(a) * Math.cos(e) * v;
      b.vel[i * 3 + 1] = Math.sin(e) * v;
      b.vel[i * 3 + 2] = Math.sin(a) * Math.cos(e) * v;
    }
    b.points.geometry.setDrawRange(0, count);
    posAttr.needsUpdate = true;
    (b.points.material as THREE.PointsMaterial).color.set(color);
    (b.points.material as THREE.PointsMaterial).size = size;
    (b.points.material as THREE.PointsMaterial).opacity = 1;
    b.ttl = ttl;
    b.age = 0;
    b.alive = true;
    b.points.visible = true;
  }

  // ---- explosions ---------------------------------------------------------------

  explosion(pos: THREE.Vector3, radius: number, camPos: THREE.Vector3) {
    // flash
    const flash = new THREE.PointLight(0xffa54d, 900, radius * 9, 2);
    flash.position.copy(pos).add(new THREE.Vector3(0, 1.5, 0));
    this.scene.add(flash);
    this.timed.push({
      obj: flash, age: 0, ttl: 0.35,
      tick: (t) => { flash.intensity = 900 * (1 - t) * (1 - t); },
    });

    // fireball
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(1, 14, 10),
      new THREE.MeshBasicMaterial({
        color: 0xffc266, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    ball.position.copy(pos);
    this.scene.add(ball);
    this.timed.push({
      obj: ball, age: 0, ttl: 0.3,
      tick: (t) => {
        ball.scale.setScalar(0.5 + t * radius * 0.85);
        (ball.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - t);
      },
    });

    // shockwave ring
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.07, 6, 36),
      new THREE.MeshBasicMaterial({
        color: 0xffe2a8, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos).add(new THREE.Vector3(0, 0.4, 0));
    this.scene.add(ring);
    this.timed.push({
      obj: ring, age: 0, ttl: 0.5,
      tick: (t) => {
        ring.scale.setScalar(1 + t * radius * 1.6);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - t);
      },
    });

    // glow flash sprite over the fireball
    const glow = makeGlowSprite(0xffb36b, radius * 2.6, 0.95);
    glow.position.copy(pos).add(new THREE.Vector3(0, 1.2, 0));
    this.scene.add(glow);
    this.timed.push({
      obj: glow, age: 0, ttl: 0.45,
      tick: (t) => {
        (glow.material as THREE.SpriteMaterial).opacity = 0.95 * (1 - t);
        const s = radius * (2.6 + t * 1.4);
        glow.scale.set(s, s, 1);
      },
    });

    // rolling smoke sprites: ember-lit at first, cooling to dark
    const warm = new THREE.Color(0x9a5a30);
    const cold = new THREE.Color(0x232a33);
    const smokeN = this.mobile ? 6 : 10;
    for (let i = 0; i < smokeN; i++) {
      const mat = new THREE.SpriteMaterial({
        map: smokeTexture(), transparent: true, opacity: 0.6,
        depthWrite: false, rotation: Math.random() * Math.PI * 2,
      });
      const puff = new THREE.Sprite(mat);
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * radius * 0.5;
      puff.position.copy(pos).add(new THREE.Vector3(Math.cos(a) * r, 0.6 + Math.random(), Math.sin(a) * r));
      const sc0 = 1.2 + Math.random() * 1.4;
      puff.scale.set(sc0, sc0, 1);
      const rise = 1.4 + Math.random() * 2;
      const spin = (Math.random() - 0.5) * 0.9;
      this.scene.add(puff);
      this.timed.push({
        obj: puff, age: 0, ttl: 1.9 + Math.random(),
        tick: (t) => {
          puff.position.y += rise * 0.016;
          const s = sc0 * (1 + t * 2.2);
          puff.scale.set(s, s, 1);
          mat.rotation += spin * 0.016;
          mat.opacity = 0.6 * (1 - t);
          mat.color.copy(warm).lerp(cold, Math.min(1, t * 2.2));
        },
      });
    }

    this.burst(pos, 26, 0xffc46b, radius * 1.6, 0.7, 0.14);
    const d = camPos.distanceTo(pos);
    this.addShake(Math.max(0, 0.9 - d / 50));
  }

  orbitalBeam(pos: THREE.Vector3) {
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.8, 420, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xb8e8ff, transparent: true, opacity: 0.9, fog: false,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    beam.position.copy(pos).add(new THREE.Vector3(0, 210, 0));
    this.scene.add(beam);
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.3, 420, 8),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 1, fog: false,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    core.position.copy(beam.position);
    this.scene.add(core);
    for (const mesh of [beam, core]) {
      this.timed.push({
        obj: mesh, age: 0, ttl: 0.6,
        tick: (t) => {
          (mesh.material as THREE.MeshBasicMaterial).opacity = t < 0.5 ? 1 : 1 - (t - 0.5) * 2;
          mesh.scale.x = mesh.scale.z = 1 - t * 0.4;
        },
      });
    }
  }

  // ---- stratagem beacons ----------------------------------------------------------

  beacon(key: string, pos: THREE.Vector3, color: number) {
    this.removeBeacon(key);
    const g = new THREE.Group();
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 8, 6),
      new THREE.MeshBasicMaterial({ color, fog: false }),
    );
    ball.position.y = 0.35;
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 0.35, 5),
      new THREE.MeshStandardMaterial({ color: 0x444a52 }),
    );
    stem.position.y = 0.17;
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 60, 6, 1, true),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.22, fog: false,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    pillar.position.y = 30;
    const halo = makeGlowSprite(color, 1.8, 0.5);
    halo.position.y = 0.35;
    g.add(ball, stem, pillar, halo);
    g.position.copy(pos);
    g.userData.ball = ball;
    this.scene.add(g);
    this.beacons.set(key, g);
  }

  removeBeacon(key: string) {
    const g = this.beacons.get(key);
    if (g) {
      this.scene.remove(g);
      this.beacons.delete(key);
    }
  }

  // ---- hellpods --------------------------------------------------------------------

  hellpod(target: THREE.Vector3, onLand?: () => void) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.5, 1.7, 6),
      new THREE.MeshStandardMaterial({ color: 0x3a4047, metalness: 0.6, roughness: 0.4 }),
    );
    body.position.y = 0.85;
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(0.42, 0.5, 6),
      new THREE.MeshStandardMaterial({ color: 0x2c3138, metalness: 0.6, roughness: 0.4 }),
    );
    tip.position.y = 1.95;
    const fins = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.3, 0.06),
      new THREE.MeshStandardMaterial({ color: 0xd9a834, emissive: 0xd9a834, emissiveIntensity: 0.4 }),
    );
    fins.position.y = 0.3;
    group.add(body, tip, fins);

    const trail = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.05, 9, 6, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffa54d, transparent: true, opacity: 0.8, fog: false,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    trail.position.y = 6.5;
    group.add(trail);

    const from = target.clone().add(new THREE.Vector3(9, 130, 5));
    group.position.copy(from);
    this.scene.add(group);
    this.pods.push({ group, from, to: target.clone(), t: 0, dur: 0.85, landed: false, onLand, trail });
  }

  // ---- shuttle (Pelican) --------------------------------------------------------------

  private buildShuttle(): THREE.Group {
    const g = new THREE.Group();
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x3c434b, metalness: 0.55, roughness: 0.4 });
    const hull = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.0, 7.5), hullMat);
    hull.position.y = 1.6;
    const nose = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.5, 2.2), hullMat);
    nose.position.set(0, 1.5, 4.6);
    const cockpit = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.6, 0.8),
      new THREE.MeshStandardMaterial({ color: 0x0c0f12, emissive: 0x69d7ff, emissiveIntensity: 1.2 }),
    );
    cockpit.position.set(0, 1.9, 5.4);
    const wingMat = new THREE.MeshStandardMaterial({ color: 0x32383f, metalness: 0.5, roughness: 0.5 });
    const wingL = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.25, 2.4), wingMat);
    wingL.position.set(-3.4, 2.2, -1);
    wingL.rotation.z = 0.18;
    const wingR = wingL.clone();
    wingR.position.x = 3.4;
    wingR.rotation.z = -0.18;
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(4.45, 0.25, 7.55),
      new THREE.MeshStandardMaterial({ color: 0xd9a834, emissive: 0xd9a834, emissiveIntensity: 0.35 }),
    );
    stripe.position.y = 2.3;
    g.add(hull, nose, cockpit, wingL, wingR, stripe);

    for (const side of [-1, 1]) {
      const engine = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 10, 8),
        new THREE.MeshBasicMaterial({
          color: 0x9fd0ff, transparent: true, opacity: 0.9,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      engine.position.set(2.6 * side, 1.7, -2.6);
      engine.name = 'engine';
      g.add(engine);
      const engineGlow = makeGlowSprite(0x9fd0ff, 2.6, 0.55);
      engineGlow.position.set(2.6 * side, 1.7, -2.6);
      g.add(engineGlow);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.4, 0.25), wingMat);
      leg.position.set(1.6 * side, 0.4, 0);
      g.add(leg);
    }
    const glow = new THREE.PointLight(0x9fd0ff, 140, 26, 2);
    glow.position.y = 2;
    g.add(glow);
    g.visible = false;
    this.scene.add(g);
    return g;
  }

  shuttleLand(pad: THREE.Vector3) {
    if (!this.shuttle) this.shuttle = this.buildShuttle();
    this.shuttle.visible = true;
    this.shuttleFrom.copy(pad).add(new THREE.Vector3(-30, 110, -40));
    this.shuttleTo.copy(pad).add(new THREE.Vector3(0, 0.6, 0));
    this.shuttleT = 0;
    this.shuttleState = 'landing';
  }

  shuttleDepart() {
    if (!this.shuttle || this.shuttleState === 'hidden') return;
    this.shuttleFrom.copy(this.shuttle.position);
    this.shuttleTo.copy(this.shuttle.position).add(new THREE.Vector3(25, 130, 35));
    this.shuttleT = 0;
    this.shuttleState = 'leaving';
  }

  shuttleHide() {
    if (this.shuttle) this.shuttle.visible = false;
    this.shuttleState = 'hidden';
  }

  // ---- corpses ---------------------------------------------------------------------

  bugCorpse(pos: THREE.Vector3, kind: number) {
    if (this.corpses.length > 12) {
      const oldest = this.corpses.shift()!;
      this.scene.remove(oldest.obj);
    }
    const rig = buildBug(kind, false);
    rig.group.position.copy(pos);
    rig.group.position.y = Math.max(0, pos.y - 0.2);
    rig.group.rotation.set(Math.PI * 0.92, Math.random() * Math.PI * 2, 0);
    this.scene.add(rig.group);
    const entry: Timed = {
      obj: rig.group, age: 0, ttl: 7,
      tick: (t) => {
        if (t > 0.7) rig.group.position.y -= 0.012; // sink into the dirt
      },
    };
    this.corpses.push(entry);
    this.gore(pos, kind);
  }

  // Flying chunks + a blood spray + a lingering ground splat, scaled by enemy.
  gore(pos: THREE.Vector3, kind: number) {
    const big = kind === 1 || kind === 3;
    const titan = kind === 4;
    const scale = titan ? 3 : big ? 1.5 : 1;
    const green = 0x9aff3a;

    this.burst(pos, titan ? 40 : 22, green, 6 * scale, 0.7, 0.13 * scale);

    // chunks: small dark-green shards flung out with gravity, then they fade
    const n = this.mobile ? 4 : titan ? 14 : big ? 8 : 5;
    for (let i = 0; i < n; i++) {
      const chunk = new THREE.Mesh(
        new THREE.TetrahedronGeometry((0.08 + Math.random() * 0.12) * scale),
        new THREE.MeshStandardMaterial({ color: 0x2c3a16, roughness: 0.8, flatShading: true }),
      );
      chunk.position.copy(pos).add(new THREE.Vector3(0, 0.3 * scale, 0));
      const a = Math.random() * Math.PI * 2;
      const e = 0.3 + Math.random() * 0.9;
      const sp = (3 + Math.random() * 4) * scale;
      const vel = new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e) * 1.4, Math.sin(a) * Math.cos(e)).multiplyScalar(sp);
      const spin = new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12);
      const groundY = pos.y - 0.2;
      this.scene.add(chunk);
      this.timed.push({
        obj: chunk, age: 0, ttl: 1.6 + Math.random() * 0.8,
        tick: (t) => {
          const dt = 0.016;
          vel.y -= 16 * dt;
          chunk.position.addScaledVector(vel, dt);
          if (chunk.position.y < groundY) { chunk.position.y = groundY; vel.set(0, 0, 0); }
          chunk.rotation.x += spin.x * dt;
          chunk.rotation.y += spin.y * dt;
          if (t > 0.7) (chunk.material as THREE.MeshStandardMaterial).transparent = true;
          if (t > 0.7) (chunk.material as THREE.MeshStandardMaterial).opacity = (1 - t) / 0.3;
        },
      });
    }

    // ground gore splat (additive green decal)
    const splat = new THREE.Mesh(
      new THREE.CircleGeometry((0.7 + Math.random() * 0.5) * scale, 12).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x4aff1a, transparent: true, opacity: 0.5, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false,
      }),
    );
    splat.position.set(pos.x, pos.y - 0.18, pos.z);
    this.scene.add(splat);
    this.timed.push({
      obj: splat, age: 0, ttl: titan ? 8 : 4,
      tick: (t) => { (splat.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - t); },
    });
  }

  // ---- acid projectiles --------------------------------------------------------------

  private globs = new Map<number, THREE.Mesh>();

  // Reconcile the in-flight acid globs with the latest (extrapolated) set.
  syncProjectiles(list: { id: number; kind: number; pos: [number, number, number] }[]) {
    const seen = new Set<number>();
    for (const p of list) {
      seen.add(p.id);
      let mesh = this.globs.get(p.id);
      if (!mesh) {
        const big = p.kind === 1;
        mesh = new THREE.Mesh(
          new THREE.IcosahedronGeometry(big ? 0.34 : 0.2, 0),
          new THREE.MeshStandardMaterial({
            color: 0x4a6b1a, emissive: 0x9aff3a, emissiveIntensity: 1.4, roughness: 0.4, flatShading: true,
          }),
        );
        mesh.add(makeGlowSprite(0x9aff3a, big ? 1.6 : 1.0, 0.6));
        this.scene.add(mesh);
        this.globs.set(p.id, mesh);
      }
      mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
      mesh.rotation.x += 0.3;
      mesh.rotation.y += 0.2;
    }
    for (const [id, mesh] of this.globs) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        this.globs.delete(id);
      }
    }
  }

  acidSplat(pos: THREE.Vector3, kind: number) {
    const big = kind === 1;
    this.burst(pos, big ? 22 : 14, 0x9aff3a, big ? 6 : 4.5, 0.6, big ? 0.16 : 0.11);
    const light = new THREE.PointLight(0x9aff3a, big ? 60 : 28, big ? 10 : 6, 2);
    light.position.copy(pos).add(new THREE.Vector3(0, 0.4, 0));
    this.scene.add(light);
    this.timed.push({ obj: light, age: 0, ttl: 0.4, tick: (t) => { light.intensity = (big ? 60 : 28) * (1 - t); } });
    // a lingering scorch decal on the ground
    const decal = new THREE.Mesh(
      new THREE.CircleGeometry(big ? 1.6 : 0.9, 12).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x6aff2a, transparent: true, opacity: 0.4, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false,
      }),
    );
    decal.position.copy(pos).add(new THREE.Vector3(0, 0.06, 0));
    this.scene.add(decal);
    this.timed.push({
      obj: decal, age: 0, ttl: 2.5,
      tick: (t) => { (decal.material as THREE.MeshBasicMaterial).opacity = 0.4 * (1 - t); },
    });
  }

  // ---- napalm fire zones + recon ping ------------------------------------------------

  private fireZones = new Map<number, { group: THREE.Group; light: THREE.PointLight; sprites: THREE.Sprite[] }>();

  syncFires(list: { id: number; pos: [number, number, number]; radius: number }[], time: number) {
    const seen = new Set<number>();
    for (const f of list) {
      seen.add(f.id);
      let z = this.fireZones.get(f.id);
      if (!z) {
        const group = new THREE.Group();
        group.position.set(f.pos[0], f.pos[1], f.pos[2]);
        const sprites: THREE.Sprite[] = [];
        const n = this.mobile ? 10 : 20;
        for (let i = 0; i < n; i++) {
          const s = makeGlowSprite(i % 3 === 0 ? 0xffd23a : 0xff5a16, 1.4, 0.6);
          const a = Math.random() * Math.PI * 2;
          const r = Math.random() * f.radius * 0.92;
          s.position.set(Math.cos(a) * r, 0.4, Math.sin(a) * r);
          s.userData.phase = Math.random() * 10;
          s.userData.base = 1.2 + Math.random() * 1.6;
          group.add(s);
          sprites.push(s);
        }
        const light = new THREE.PointLight(0xff5a1a, 40, f.radius * 2.6, 2);
        light.position.y = 1.6;
        group.add(light);
        this.scene.add(group);
        z = { group, light, sprites };
        this.fireZones.set(f.id, z);
      }
      for (const s of z.sprites) {
        const ph = s.userData.phase as number;
        const rise = ((time * 0.6 + ph) % 1);
        s.position.y = 0.3 + rise * 1.8;
        const sc = (s.userData.base as number) * (1 - rise * 0.5);
        s.scale.set(sc, sc, 1);
        (s.material as THREE.SpriteMaterial).opacity = 0.7 * (1 - rise);
      }
      z.light.intensity = 34 + Math.sin(time * 14) * 16;
    }
    for (const [id, z] of this.fireZones) {
      if (!seen.has(id)) {
        this.scene.remove(z.group);
        this.fireZones.delete(id);
      }
    }
  }

  reconPing(pos: THREE.Vector3) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.7, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x69d7ff, transparent: true, opacity: 0.9, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      }),
    );
    ring.position.copy(pos).add(new THREE.Vector3(0, 0.6, 0));
    this.scene.add(ring);
    this.timed.push({
      obj: ring, age: 0, ttl: 1.4,
      tick: (t) => {
        const s = 1 + t * 70;
        ring.scale.set(s, s, s);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
      },
    });
    const light = new THREE.PointLight(0x69d7ff, 50, 30, 2);
    light.position.copy(pos).add(new THREE.Vector3(0, 2, 0));
    this.scene.add(light);
    this.timed.push({ obj: light, age: 0, ttl: 0.5, tick: (t) => { light.intensity = 50 * (1 - t); } });
  }

  // ---- update ------------------------------------------------------------------------

  update(dt: number, time: number) {
    this.trauma = Math.max(0, this.trauma - dt * 1.4);

    for (let i = 0; i < this.flashPool.length; i++) {
      const l = this.flashPool[i];
      if (l.intensity > 0) l.intensity = Math.max(0, l.intensity - dt * 2600);
      const mat = this.flashSprites[i].material as THREE.SpriteMaterial;
      if (mat.opacity > 0) mat.opacity = Math.max(0, mat.opacity - dt * 16);
    }

    for (const t of this.tracers) {
      if (!t.alive) continue;
      const step = t.speed * dt;
      const remaining = t.mesh.position.distanceTo(t.end);
      if (step >= remaining) {
        t.alive = false;
        this.scene.remove(t.mesh);
        (t.mesh.material as THREE.Material).dispose();
        t.onArrive?.();
      } else {
        t.mesh.position.addScaledVector(t.dir, step);
      }
    }
    this.tracers = this.tracers.filter((t) => t.alive);

    for (const b of this.bursts) {
      if (!b.alive) continue;
      b.age += dt;
      if (b.age >= b.ttl) {
        b.alive = false;
        b.points.visible = false;
        continue;
      }
      const posAttr = b.points.geometry.attributes.position as THREE.BufferAttribute;
      const n = b.points.geometry.drawRange.count;
      for (let i = 0; i < n; i++) {
        b.vel[i * 3 + 1] -= 9.8 * dt;
        posAttr.setXYZ(
          i,
          posAttr.getX(i) + b.vel[i * 3] * dt,
          posAttr.getY(i) + b.vel[i * 3 + 1] * dt,
          posAttr.getZ(i) + b.vel[i * 3 + 2] * dt,
        );
      }
      posAttr.needsUpdate = true;
      (b.points.material as THREE.PointsMaterial).opacity = 1 - b.age / b.ttl;
    }

    this.timed = this.timed.filter((x) => {
      x.age += dt;
      const t = x.age / x.ttl;
      if (t >= 1) {
        this.scene.remove(x.obj);
        return false;
      }
      x.tick(t);
      return true;
    });

    this.corpses = this.corpses.filter((x) => {
      x.age += dt;
      const t = x.age / x.ttl;
      if (t >= 1) {
        this.scene.remove(x.obj);
        return false;
      }
      x.tick(t);
      return true;
    });

    for (const p of this.pods) {
      if (p.landed) continue;
      p.t += dt / p.dur;
      if (p.t >= 1) {
        p.landed = true;
        p.group.position.copy(p.to);
        p.trail.visible = false;
        this.burst(p.to.clone().add(new THREE.Vector3(0, 0.4, 0)), 20, 0xc9b690, 6, 0.6, 0.12);
        p.onLand?.();
        // pod stays as set dressing, fades later
        this.timed.push({
          obj: p.group, age: 0, ttl: 25,
          tick: () => {},
        });
      } else {
        const e = p.t * p.t; // accelerate downward
        p.group.position.lerpVectors(p.from, p.to, e);
      }
    }
    this.pods = this.pods.filter((p) => !p.landed || p.group.parent !== null);

    for (const g of this.beacons.values()) {
      const ball = g.userData.ball as THREE.Mesh;
      const on = Math.sin(time * 9) > 0;
      (ball.material as THREE.MeshBasicMaterial).color.setScalar(on ? 1 : 0.25);
      (ball.material as THREE.MeshBasicMaterial).color.multiply(new THREE.Color(0xffd94a));
    }

    if (this.shuttle && this.shuttleState !== 'hidden') {
      if (this.shuttleState === 'landing' || this.shuttleState === 'leaving') {
        this.shuttleT = Math.min(1, this.shuttleT + dt / 4);
        const e = this.shuttleState === 'landing'
          ? 1 - (1 - this.shuttleT) * (1 - this.shuttleT)
          : this.shuttleT * this.shuttleT;
        this.shuttle.position.lerpVectors(this.shuttleFrom, this.shuttleTo, e);
        if (this.shuttleT >= 1) {
          if (this.shuttleState === 'landing') this.shuttleState = 'idle';
          else this.shuttleHide();
        }
      }
      this.shuttle.position.y += Math.sin(time * 1.8) * 0.004;
      for (const child of this.shuttle.children) {
        if (child.name === 'engine') {
          child.scale.setScalar(0.9 + Math.sin(time * 21 + child.position.x) * 0.15);
        }
      }
    }
  }
}
