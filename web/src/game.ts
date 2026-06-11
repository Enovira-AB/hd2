// Client-side game orchestration: local player control and prediction,
// third-person camera, stratagem input, and turning server events into
// effects. The server owns all outcomes; this file makes them feel good.

import * as THREE from 'three';
import { Net } from './net.js';
import { Input, IS_TOUCH } from './input.js';
import { World3D } from './world3d.js';
import { Effects } from './effects.js';
import { Sfx } from './sfx.js';
import { Hud } from './hud.js';
import { buildSoldier, animateSoldier, makeNameSprite, type SoldierRig } from './soldier.js';
import { buildBug, animateBug, type BugRig } from './bugs.js';
import { ANIM, type MissionPhase, type Vec3 } from '../../shared/protocol.js';
import {
  MISSION, ORBITAL_RADIUS, RIFLE, SPRINT_SPEED, STRATAGEMS, WALK_SPEED,
  type StratagemKind,
} from '../../shared/constants.js';
import { resolveCollisions } from '../../shared/world.js';

interface SoldierView {
  rig: SoldierRig;
  lastPos: THREE.Vector3;
  speed: number;
  hideUntil: number;
  colorIdx: number;
}

interface BugView {
  rig: BugRig;
  lastPos: THREE.Vector3;
  speed: number;
}

const BEACON_COLORS: Record<string, number> = {
  REINFORCE: 0x6ab4ff, ORBITAL: 0xff5a48, RESUPPLY: 0x7dd87f,
};

function boomKey(kind: string, pos: Vec3): string {
  return `${kind}|${pos[0].toFixed(0)},${pos[2].toFixed(0)}`;
}

export class Game {
  // local player
  pos = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  private vel = new THREE.Vector3();
  private alive = true;
  private boarded = false;
  private localAmmo: number = RIFLE.magSize;
  private localReserve: number = RIFLE.reserveMax;
  private reloadUntil = 0;
  private nextFireAt = 0;
  private lastStateSent = 0;
  private stratSeq = '';
  private stratBadUntil = 0;

  private views = new Map<string, SoldierView>();
  private bugViews = new Map<number, BugView>();
  private supplyViews = new Map<number, THREE.Group>();
  private colorAssign = new Map<string, number>();
  private pending: { when: number; fn: () => void }[] = [];
  private lastPhase: MissionPhase | '' = '';
  private currentSeed = -1;
  private deathYaw = 0;

  onScreenChange: (s: 'lobby' | 'summary' | null) => void = () => {};

  constructor(
    private net: Net,
    private world: World3D,
    private input: Input,
    private hud: Hud,
    private sfx: Sfx,
    private fx: Effects,
  ) {
    this.wireEvents();
  }

  private selfState() {
    return this.net.latestPlayers.find((p) => p.id === this.net.selfId);
  }

  private active(): boolean {
    const p = this.net.mission?.phase;
    return p === 'DROP' || p === 'KILL' || p === 'EXTRACT' || p === 'DEFEND' || p === 'BOARD';
  }

  // ---- server events → effects -------------------------------------------------

  private wireEvents() {
    const n = this.net;

    n.on('fired', (m) => {
      if (m.type !== 'fired') return;
      const origin = new THREE.Vector3(...m.origin);
      const hit = m.hit ? new THREE.Vector3(...m.hit) : null;
      if (m.id === n.selfId) {
        if (m.hitKind === 'bug' || m.hitKind === 'player') this.hud.hitmarker();
        if (hit) this.fx.impact(hit, m.hitKind);
        return; // own tracer/flash were predicted locally
      }
      const view = this.views.get(m.id);
      const muzzle = new THREE.Vector3();
      if (view) view.rig.muzzle.getWorldPosition(muzzle);
      else muzzle.copy(origin);
      const end = hit ?? origin.clone().addScaledVector(new THREE.Vector3(...m.dir), 120);
      this.fx.tracer(muzzle, end, () => {
        if (hit) this.fx.impact(hit, m.hitKind);
      });
      this.fx.muzzleFlash(muzzle);
      const d = this.pos.distanceTo(origin);
      this.sfx.fire(Math.max(0.15, 1 - d / 80));
      if (view) view.rig.recoil = 1;
    });

    n.on('bugDeath', (m) => {
      if (m.type !== 'bugDeath') return;
      const pos = new THREE.Vector3(...m.pos);
      this.fx.bugCorpse(pos, m.kind);
      this.sfx.screech(Math.max(0.1, 1 - this.pos.distanceTo(pos) / 60));
      const view = this.bugViews.get(m.id);
      if (view) {
        this.world.scene.remove(view.rig.group);
        this.bugViews.delete(m.id);
      }
    });

    n.on('hit', (m) => {
      if (m.type !== 'hit' || m.id !== n.selfId) return;
      this.hud.damageFlash();
      this.sfx.hurt();
      this.fx.addShake(0.3);
    });

    n.on('down', (m) => {
      if (m.type !== 'down') return;
      if (m.id === n.selfId) {
        this.alive = false;
        this.deathYaw = this.yaw;
        this.hud.banner('YOU DIED', 'A SQUADMATE CAN CALL REINFORCE  ▲▼▶◀▲', 5000);
        this.hud.damageFlash(1);
      } else {
        const p = n.latestPlayers.find((q) => q.id === m.id);
        this.hud.banner('HELLDIVER DOWN', `${p?.name ?? 'A SQUADMATE'} NEEDS REINFORCEMENT  T → ▲▼▶◀▲`, 3500);
      }
      this.sfx.hurt();
    });

    n.on('strat', (m) => {
      if (m.type !== 'strat') return;
      const target = new THREE.Vector3(...m.target);
      const key = boomKey(m.kind, m.target);
      this.fx.beacon(key, target, BEACON_COLORS[m.kind] ?? 0xffd94a);
      this.sfx.beep(true);
      const lead = m.kind === 'ORBITAL' ? 420 : 880;
      this.pending.push({
        when: m.at - lead,
        fn: () => {
          if (m.kind === 'ORBITAL') this.fx.orbitalBeam(target);
          else this.fx.hellpod(target.clone(), () => this.sfx.impact(0.8));
          if (m.kind !== 'ORBITAL') this.sfx.pod();
        },
      });
    });

    n.on('boom', (m) => {
      if (m.type !== 'boom') return;
      const pos = new THREE.Vector3(...m.pos);
      this.fx.removeBeacon(boomKey(m.kind, m.pos));
      const dist = this.pos.distanceTo(pos);
      if (m.kind === 'ORBITAL') {
        this.fx.explosion(pos, ORBITAL_RADIUS, this.world.camera.position);
        this.sfx.explosion(Math.max(0.25, 1 - dist / 120));
      } else if (m.kind === 'SHUTTLE') {
        const pad = this.world.layout.pad;
        this.fx.shuttleLand(new THREE.Vector3(pad.x, this.world.terrainY(pad.x, pad.z), pad.z));
        this.hud.banner('SHUTTLE INBOUND', 'GET TO THE PAD');
      } else if (m.kind === 'HELLPOD') {
        // hot join — no strat message preceded this
        this.fx.hellpod(pos, () => this.sfx.impact());
        this.sfx.pod();
      } else {
        this.sfx.impact(Math.max(0.2, 1 - dist / 50));
      }
    });

    n.on('reinforced', (m) => {
      if (m.type !== 'reinforced') return;
      if (m.ids.includes(n.selfId)) {
        this.alive = true;
        this.pos.set(m.pos[0], m.pos[1], m.pos[2]);
        this.hud.banner('REINFORCED', 'GET UP, HELLDIVER');
      } else {
        this.hud.banner('REINFORCEMENTS', 'A SQUADMATE IS BACK IN THE FIGHT', 2200);
      }
      this.sfx.pod();
    });

    n.on('boarded', (m) => {
      if (m.type !== 'boarded') return;
      if (m.id === n.selfId) {
        this.boarded = true;
        this.hud.banner('ABOARD', 'WAITING FOR THE REST OF THE SQUAD');
      }
    });
  }

  // ---- phases -------------------------------------------------------------------

  private onPhaseChange(phase: MissionPhase) {
    const m = this.net.mission!;
    switch (phase) {
      case 'DROP': {
        this.onScreenChange(null);
        this.hud.banner('HELLPODS AWAY', 'DELIVERING DEMOCRACY', 2800);
        this.sfx.pod();
        this.world.setPadMode('off');
        this.fx.shuttleHide();
        this.boarded = false;
        this.alive = true;
        this.localAmmo = RIFLE.magSize;
        this.localReserve = RIFLE.reserveMax;
        const self = this.selfState();
        if (self) this.pos.set(...self.pos);
        for (const p of this.net.latestPlayers) {
          const at = new THREE.Vector3(...p.pos);
          this.fx.hellpod(at, () => this.sfx.impact());
          const v = this.views.get(p.id);
          if (v) v.hideUntil = performance.now() + 900;
        }
        break;
      }
      case 'KILL':
        this.hud.banner('ERADICATE THE TERMINIDS', `${m.killTarget} CONFIRMED KILLS REQUIRED`);
        break;
      case 'EXTRACT':
        this.hud.banner('OBJECTIVE COMPLETE', 'PROCEED TO THE EXTRACTION BEACON');
        this.world.setPadMode('on');
        this.sfx.beep(true);
        break;
      case 'DEFEND':
        this.hud.banner('EXTRACTION CALLED', 'HOLD THE PAD UNTIL THE SHUTTLE ARRIVES');
        this.world.setPadMode('blink');
        break;
      case 'BOARD':
        this.hud.banner('BOARD THE SHUTTLE', 'DO NOT MISS YOUR RIDE');
        this.world.setPadMode('on');
        break;
      case 'COMPLETE':
        this.fx.shuttleDepart();
        window.setTimeout(() => {
          this.hud.showSummary(this.net.mission!, this.net.latestPlayers);
          this.onScreenChange('summary');
        }, 1400);
        break;
      case 'FAILED':
        this.hud.showSummary(m, this.net.latestPlayers);
        this.onScreenChange('summary');
        break;
      case 'LOBBY':
        this.onScreenChange('lobby');
        this.world.setPadMode('off');
        this.fx.shuttleHide();
        break;
    }
  }

  // ---- per-frame -------------------------------------------------------------------

  update(dt: number, time: number) {
    const m = this.net.mission;
    if (!m) return;

    if (m.seed !== this.currentSeed) {
      this.currentSeed = m.seed;
      this.world.buildWorld(m.seed);
      for (const v of this.views.values()) this.world.scene.remove(v.rig.group);
      for (const b of this.bugViews.values()) this.world.scene.remove(b.rig.group);
      for (const s of this.supplyViews.values()) this.world.scene.remove(s);
      this.views.clear();
      this.bugViews.clear();
      this.supplyViews.clear();
      const self = this.selfState();
      if (self) this.pos.set(...self.pos);
      this.pos.y = this.world.terrainY(this.pos.x, this.pos.z);
    }

    if (m.phase !== this.lastPhase) {
      this.lastPhase = m.phase;
      this.onPhaseChange(m.phase);
    }

    // scheduled effects (beams, pod drops) on the server clock
    const sNow = this.net.serverNow();
    this.pending = this.pending.filter((p) => {
      if (sNow >= p.when) {
        p.fn();
        return false;
      }
      return true;
    });

    this.updateStratagemInput();
    this.updateMovement(dt);
    this.updateCamera(dt, time);
    this.updateCombat();
    this.updateInteract();
    this.reconcileViews(dt, time);
    this.updateHud();
    this.sendState();
  }

  private updateStratagemInput() {
    const arrows = this.input.consumeArrows();
    if (!this.input.stratOpen) {
      this.stratSeq = '';
      this.hud.setStratDisplay(false, '', false);
      return;
    }
    for (const a of arrows) {
      this.stratSeq += a;
      this.sfx.beep(false);
      const entries = Object.entries(STRATAGEMS) as [StratagemKind, { code: string }][];
      const exact = entries.find(([, s]) => s.code === this.stratSeq);
      const prefix = entries.some(([, s]) => s.code.startsWith(this.stratSeq));
      if (exact) {
        this.callStratagem(exact[0]);
        this.stratSeq = '';
        this.input.closeStrat();
      } else if (!prefix) {
        this.sfx.error();
        this.stratSeq = '';
        this.stratBadUntil = performance.now() + 500;
      }
    }
    this.hud.setStratDisplay(true, this.stratSeq, performance.now() < this.stratBadUntil);
  }

  private callStratagem(kind: StratagemKind) {
    // throw the beacon at the ground point under the crosshair, capped at 40m
    const cam = this.world.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    let target: THREE.Vector3 | null = null;
    for (let t = 3; t < 42; t += 1.2) {
      const p = cam.position.clone().addScaledVector(dir, t);
      if (p.y <= this.world.terrainY(p.x, p.z)) {
        target = p;
        break;
      }
    }
    if (!target) {
      target = this.pos.clone().add(new THREE.Vector3(Math.sin(this.yaw) * 9, 0, Math.cos(this.yaw) * 9));
    }
    target.y = this.world.terrainY(target.x, target.z);
    this.net.send({ type: 'stratagem', kind, target: [target.x, target.y, target.z] });
    this.hud.banner(STRATAGEMS[kind].label.toUpperCase(), 'STRATAGEM INBOUND', 1600);
  }

  private updateMovement(dt: number) {
    if (!this.alive || this.boarded || !this.active()) {
      this.vel.set(0, 0, 0);
      return;
    }
    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    const wish = forward.multiplyScalar(this.input.moveY).addScaledVector(right, this.input.moveX);
    if (wish.lengthSq() > 1) wish.normalize();
    let speed = this.input.sprint ? SPRINT_SPEED : WALK_SPEED;
    if (this.input.fireHeld) speed *= 0.6;
    wish.multiplyScalar(speed);
    const k = 1 - Math.exp(-11 * dt);
    this.vel.lerp(wish, k);
    this.pos.addScaledVector(this.vel, dt);
    const [x, z] = resolveCollisions(this.pos.x, this.pos.z, 0.45, this.world.layout.rocks);
    this.pos.x = x;
    this.pos.z = z;
    this.pos.y = this.world.terrainY(x, z);
  }

  private updateCamera(dt: number, time: number) {
    const look = this.input.consumeLook();
    const sens = 0.0023;
    if (this.alive) {
      this.yaw -= look.dx * sens;
      this.pitch -= look.dy * sens;
      this.pitch = Math.max(-0.55, Math.min(1.1, this.pitch));
    }

    const cam = this.world.camera;
    const pivot = this.pos.clone().add(new THREE.Vector3(0, 1.62, 0));
    let camPos: THREE.Vector3;
    let lookAt: THREE.Vector3;

    if (!this.alive) {
      // slow orbit over your corpse while you wait for reinforcement
      this.deathYaw += dt * 0.25;
      camPos = pivot.clone().add(new THREE.Vector3(
        Math.sin(this.deathYaw) * 7, 4.5, Math.cos(this.deathYaw) * 7,
      ));
      lookAt = pivot;
    } else {
      const f3 = new THREE.Vector3(
        Math.sin(this.yaw) * Math.cos(this.pitch),
        Math.sin(this.pitch),
        Math.cos(this.yaw) * Math.cos(this.pitch),
      );
      const right = new THREE.Vector3().crossVectors(
        new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)),
        new THREE.Vector3(0, 1, 0),
      );
      camPos = pivot.clone().addScaledVector(f3, -4.7).addScaledVector(right, 0.85);
      camPos.y += 0.25;
      lookAt = pivot.clone().addScaledVector(f3, 9).addScaledVector(right, 0.85);
    }

    const minY = this.world.terrainY(camPos.x, camPos.z) + 0.35;
    if (camPos.y < minY) camPos.y = minY;

    const shake = new THREE.Vector3();
    const roll = this.fx.shakeOffset(time, shake);
    cam.position.copy(camPos).add(shake);
    cam.lookAt(lookAt);
    cam.rotateZ(roll);
  }

  private updateCombat() {
    const now = performance.now();

    if (this.input.consumeReload()) this.tryReload(now);

    const wantFire =
      this.input.fireHeld && this.alive && !this.boarded && !this.input.stratOpen &&
      this.active() && this.net.mission?.phase !== 'DROP' && this.input.pointerLocked;
    if (!wantFire) return;

    if (this.localAmmo <= 0) {
      this.tryReload(now);
      return;
    }
    if (now < this.nextFireAt || now < this.reloadUntil) return;

    this.nextFireAt = now + RIFLE.fireInterval * 1000;
    this.localAmmo--;

    const cam = this.world.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const eye = this.pos.clone().add(new THREE.Vector3(0, 1.55, 0));
    const aimPoint = cam.position.clone().addScaledVector(dir, 95);
    const fireDir = aimPoint.sub(eye).normalize();
    this.net.send({
      type: 'fire',
      origin: [eye.x, eye.y, eye.z],
      dir: [fireDir.x, fireDir.y, fireDir.z],
    });

    // predicted local feedback; the server's `fired` echo is skipped for self
    const view = this.views.get(this.net.selfId);
    const muzzle = new THREE.Vector3();
    if (view) {
      view.rig.muzzle.getWorldPosition(muzzle);
      view.rig.recoil = 1;
    } else {
      muzzle.copy(eye);
    }
    this.fx.tracer(muzzle, eye.clone().addScaledVector(fireDir, 120));
    this.fx.muzzleFlash(muzzle);
    this.sfx.fire();
    this.fx.addShake(0.045);
    this.pitch += 0.0032;
  }

  private tryReload(now: number) {
    if (!this.alive || now < this.reloadUntil) return;
    if (this.localAmmo >= RIFLE.magSize || this.localReserve <= 0) return;
    this.net.send({ type: 'reload' });
    this.reloadUntil = now + RIFLE.reloadTime * 1000;
    this.sfx.reload();
  }

  private updateInteract() {
    const m = this.net.mission!;
    let prompt: string | null = null;
    const useKey = IS_TOUCH ? '' : '  [E]';

    for (const s of this.net.latestSupplies) {
      if (Math.hypot(s.pos[0] - this.pos.x, s.pos[2] - this.pos.z) < 2.4) {
        prompt = `TAKE SUPPLIES${useKey}`;
        break;
      }
    }
    if (!prompt && this.alive && !this.boarded) {
      const pad = this.world.layout.pad;
      const d = Math.hypot(pad.x - this.pos.x, pad.z - this.pos.z);
      if (m.phase === 'EXTRACT' && d < MISSION.extractPadRadius) prompt = `ACTIVATE EXTRACTION BEACON${useKey}`;
      if (m.phase === 'BOARD' && d < MISSION.extractPadRadius + 2) prompt = `BOARD SHUTTLE${useKey}`;
    }
    this.hud.interactPrompt(this.boarded ? null : prompt);
    if (this.input.consumeInteract() && prompt) this.net.send({ type: 'interact' });
  }

  // ---- views ------------------------------------------------------------------------

  private reconcileViews(dt: number, time: number) {
    const { players, bugs } = this.net.sample();
    const now = performance.now();
    const seen = new Set<string>();

    for (const p of players) {
      seen.add(p.id);
      let view = this.views.get(p.id);
      if (!view) {
        if (!this.colorAssign.has(p.id)) this.colorAssign.set(p.id, this.colorAssign.size % 4);
        const colorIdx = this.colorAssign.get(p.id)!;
        const rig = buildSoldier(colorIdx, !this.world.mobile);
        if (p.id !== this.net.selfId) rig.group.add(makeNameSprite(p.name));
        this.world.scene.add(rig.group);
        view = { rig, lastPos: new THREE.Vector3(...p.pos), speed: 0, hideUntil: 0, colorIdx };
        this.views.set(p.id, view);
      }

      const isSelf = p.id === this.net.selfId;
      const dead = (p.anim & ANIM.DEAD) !== 0;

      if (isSelf) {
        // server authority over life/death and big corrections
        if (this.alive && dead) this.alive = false;
        if (!this.alive && !dead) this.alive = true;
        const serverPos = new THREE.Vector3(...p.pos);
        if (serverPos.distanceTo(this.pos) > 6) this.pos.copy(serverPos);
        // accept server ammo on large drift or right after a reload lands
        const justReloaded = this.reloadUntil > 0 && now > this.reloadUntil && now < this.reloadUntil + 700;
        if (Math.abs(p.ammo - this.localAmmo) > 2 || justReloaded) {
          this.localAmmo = p.ammo;
        }
        this.localReserve = p.reserve;
        this.boarded = p.boarded;

        view.rig.group.position.copy(this.pos);
        view.rig.group.rotation.y = this.yaw;
        view.speed = this.vel.length();
        animateSoldier(view.rig, dt, {
          speed: view.speed,
          pitch: this.pitch,
          reloading: now < this.reloadUntil,
          dead: !this.alive,
          time,
        });
        view.rig.flashlight.intensity = this.alive ? 320 : 0;
      } else {
        const target = new THREE.Vector3(...p.pos);
        view.speed = view.speed * 0.8 + (target.distanceTo(view.lastPos) / Math.max(dt, 1e-3)) * 0.2;
        view.lastPos.copy(target);
        view.rig.group.position.copy(target);
        view.rig.group.rotation.y = p.yaw;
        animateSoldier(view.rig, dt, {
          speed: Math.min(view.speed, 9),
          pitch: p.pitch,
          reloading: (p.anim & ANIM.RELOADING) !== 0,
          dead,
          time,
        });
        view.rig.flashlight.intensity = dead ? 0 : 210;
      }
      view.rig.group.visible = !p.boarded && now >= view.hideUntil;
    }

    for (const [id, view] of this.views) {
      if (!seen.has(id)) {
        this.world.scene.remove(view.rig.group);
        this.views.delete(id);
      }
    }

    const seenBugs = new Set<number>();
    for (const b of bugs) {
      seenBugs.add(b.id);
      let view = this.bugViews.get(b.id);
      if (!view) {
        const rig = buildBug(b.kind, !this.world.mobile && this.bugViews.size < 24);
        this.world.scene.add(rig.group);
        view = { rig, lastPos: new THREE.Vector3(...b.pos), speed: 0 };
        this.bugViews.set(b.id, view);
      }
      const target = new THREE.Vector3(b.pos[0], b.pos[1] - 0.42, b.pos[2]);
      view.speed = view.speed * 0.8 + (target.distanceTo(view.lastPos) / Math.max(dt, 1e-3)) * 0.2;
      view.lastPos.copy(target);
      view.rig.group.position.copy(target);
      view.rig.group.rotation.y = b.yaw;
      animateBug(view.rig, dt, Math.min(view.speed, 8), time);
    }
    for (const [id, view] of this.bugViews) {
      if (!seenBugs.has(id)) {
        this.world.scene.remove(view.rig.group);
        this.bugViews.delete(id);
      }
    }

    const seenSupplies = new Set<number>();
    for (const s of this.net.latestSupplies) {
      seenSupplies.add(s.id);
      if (!this.supplyViews.has(s.id)) {
        const g = new THREE.Group();
        const boxMesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.75, 0.7, 0.75),
          new THREE.MeshStandardMaterial({ color: 0x39414a, metalness: 0.5, roughness: 0.5 }),
        );
        boxMesh.position.y = 0.35;
        const stripeMesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.78, 0.16, 0.78),
          new THREE.MeshStandardMaterial({
            color: 0xd9a834, emissive: 0xd9a834, emissiveIntensity: 0.9,
          }),
        );
        stripeMesh.position.y = 0.35;
        g.add(boxMesh, stripeMesh);
        g.position.set(...s.pos);
        this.world.scene.add(g);
        this.supplyViews.set(s.id, g);
      }
    }
    for (const [id, g] of this.supplyViews) {
      if (!seenSupplies.has(id)) {
        this.world.scene.remove(g);
        this.supplyViews.delete(id);
      }
    }
  }

  // ---- HUD + state -------------------------------------------------------------------

  private updateHud() {
    const m = this.net.mission!;
    const self = this.selfState();
    this.hud.updateSquad(this.net.latestPlayers, this.net.selfId);
    this.hud.setAmmo(this.localAmmo, this.localReserve);
    this.hud.setHp(self?.hp ?? 100);

    const sNow = this.net.serverNow();
    const pad = this.world.layout.pad;
    const padDist = Math.round(Math.hypot(pad.x - this.pos.x, pad.z - this.pos.z));
    const anyDead = this.net.latestPlayers.some((p) => (p.anim & ANIM.DEAD) !== 0);
    const reinforceHint = anyDead && m.reinforceLeft > 0 ? `  ·  REINFORCE ×${m.reinforceLeft}` : '';

    switch (m.phase) {
      case 'DROP':
        this.hud.setObjective('DEPLOYING', 'BRACE FOR IMPACT');
        break;
      case 'KILL':
        this.hud.setObjective('ERADICATE TERMINIDS', `${m.kills} / ${m.killTarget}${reinforceHint}`);
        break;
      case 'EXTRACT':
        this.hud.setObjective('REACH EXTRACTION', `BEACON ${padDist}m${reinforceHint}`);
        break;
      case 'DEFEND': {
        const s = Math.max(0, Math.ceil((m.phaseEndsAt - sNow) / 1000));
        this.hud.setObjective('DEFEND THE PAD', `SHUTTLE IN ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${reinforceHint}`);
        break;
      }
      case 'BOARD': {
        const s = Math.max(0, Math.ceil((m.phaseEndsAt - sNow) / 1000));
        this.hud.setObjective('BOARD THE SHUTTLE', `DEPARTS IN ${s}s — PAD ${padDist}m`);
        break;
      }
      default:
        this.hud.setObjective('', '');
    }
  }

  private sendState() {
    const now = performance.now();
    if (now - this.lastStateSent < 50 || !this.net.connected) return;
    this.lastStateSent = now;
    let anim = 0;
    if (this.vel.length() > 0.5) anim |= ANIM.MOVING;
    if (this.input.sprint) anim |= ANIM.SPRINT;
    if (this.input.fireHeld) anim |= ANIM.FIRING;
    if (now < this.reloadUntil) anim |= ANIM.RELOADING;
    if (this.input.stratOpen) anim |= ANIM.STRAT;
    this.net.send({
      type: 'state',
      pos: [this.pos.x, this.pos.y, this.pos.z],
      yaw: this.yaw,
      pitch: this.pitch,
      anim,
    });
  }
}
