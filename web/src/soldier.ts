// Procedural helldiver model built from primitives. Reads well at night:
// glowing visor, yellow accent stripes, team-colored cape, chest flashlight.

import * as THREE from 'three';

export const CAPE_COLORS = [0x6b2127, 0x1f3a63, 0x2a5a32, 0x5a4a1f];

export interface SoldierRig {
  group: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  arms: THREE.Group;
  rifle: THREE.Group;
  muzzle: THREE.Object3D;
  cape: THREE.Mesh;
  flashlight: THREE.SpotLight;
  flashTarget: THREE.Object3D;
  phase: number;
  recoil: number;
  deadLerp: number;
}

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  return mesh;
}

export function buildSoldier(colorIndex: number, castShadow: boolean): SoldierRig {
  const armor = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.55, metalness: 0.35 });
  const armorLight = new THREE.MeshStandardMaterial({ color: 0x596169, roughness: 0.5, metalness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.8, metalness: 0.2 });
  const stripe = new THREE.MeshStandardMaterial({
    color: 0xd9a834, emissive: 0xd9a834, emissiveIntensity: 0.3, roughness: 0.5,
  });
  const visorMat = new THREE.MeshStandardMaterial({
    color: 0x0c0f12, emissive: 0x86d9ff, emissiveIntensity: 2.0, roughness: 0.3,
  });
  const capeMat = new THREE.MeshStandardMaterial({
    color: CAPE_COLORS[colorIndex % CAPE_COLORS.length], roughness: 1, side: THREE.DoubleSide,
  });
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.6, metalness: 0.5 });

  const group = new THREE.Group();

  // legs pivot at the hip
  const makeLeg = (side: number) => {
    const leg = new THREE.Group();
    leg.position.set(0.13 * side, 0.98, 0);
    const thigh = box(0.17, 0.5, 0.2, armor, 0, -0.25, 0);
    const shin = box(0.15, 0.48, 0.18, dark, 0, -0.7, 0.02);
    const boot = box(0.17, 0.12, 0.28, dark, 0, -0.95, 0.05);
    leg.add(thigh, shin, boot);
    return leg;
  };
  const legL = makeLeg(-1);
  const legR = makeLeg(1);
  group.add(legL, legR);

  const pelvis = box(0.4, 0.2, 0.27, dark, 0, 1.06, 0);
  const torso = box(0.46, 0.52, 0.3, armor, 0, 1.42, 0);
  const chest = box(0.48, 0.28, 0.34, armorLight, 0, 1.52, 0.01);
  const chestStripe = box(0.49, 0.05, 0.35, stripe, 0, 1.44, 0.015);
  const backpack = box(0.36, 0.44, 0.18, dark, 0, 1.45, -0.26);
  const packLamp = box(0.05, 0.05, 0.02, new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: 0x9fffb0, emissiveIntensity: 1.6,
  }), 0.1, 1.58, -0.36);
  group.add(pelvis, torso, chest, chestStripe, backpack, packLamp);

  const shoulderL = box(0.18, 0.14, 0.22, armorLight, -0.33, 1.65, 0);
  const shoulderR = box(0.18, 0.14, 0.22, armorLight, 0.33, 1.65, 0);
  const shStripeL = box(0.19, 0.04, 0.23, stripe, -0.33, 1.6, 0);
  const shStripeR = box(0.19, 0.04, 0.23, stripe, 0.33, 1.6, 0);
  group.add(shoulderL, shoulderR, shStripeL, shStripeR);

  // helmet + visor
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), armorLight);
  helmet.position.set(0, 1.84, 0);
  helmet.scale.set(1, 1.08, 1.05);
  const visor = box(0.17, 0.06, 0.03, visorMat, 0, 1.85, 0.145);
  group.add(helmet, visor);

  // arms + rifle pivot together for aim pitch
  const arms = new THREE.Group();
  arms.position.set(0, 1.62, 0.05);
  const armR = box(0.11, 0.11, 0.42, armor, 0.27, -0.06, 0.2);
  const armL = box(0.11, 0.11, 0.38, armor, -0.18, -0.13, 0.26);
  armL.rotation.y = 0.5;
  const rifle = new THREE.Group();
  const receiver = box(0.07, 0.13, 0.52, gunMat, 0, 0, 0);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.34, 8), gunMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.03, 0.4);
  const mag = box(0.05, 0.18, 0.09, gunMat, 0, -0.13, 0.08);
  const stock = box(0.06, 0.11, 0.16, dark, 0, -0.02, -0.3);
  const sight = box(0.02, 0.02, 0.02, new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: 0xff4444, emissiveIntensity: 1.8,
  }), 0, 0.085, 0.12);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.03, 0.6);
  rifle.add(receiver, barrel, mag, stock, sight, muzzle);
  rifle.position.set(0.22, -0.1, 0.42);
  arms.add(armR, armL, rifle);
  group.add(arms);

  // cape, pivot at the shoulders
  const capeGeo = new THREE.PlaneGeometry(0.52, 0.85, 1, 4);
  capeGeo.translate(0, -0.42, 0);
  const cape = new THREE.Mesh(capeGeo, capeMat);
  cape.position.set(0, 1.66, -0.33);
  cape.rotation.x = 0.14;
  group.add(cape);

  // chest flashlight (no shadows: cost)
  const flashlight = new THREE.SpotLight(0xfff0d4, 0, 46, 0.34, 0.5, 1.7);
  flashlight.position.set(0, 1.52, 0.2);
  const flashTarget = new THREE.Object3D();
  flashTarget.position.set(0, 1.2, 12);
  flashlight.target = flashTarget;
  group.add(flashlight, flashTarget);

  if (castShadow) {
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
  }

  return {
    group, legL, legR, arms, rifle, muzzle, cape, flashlight, flashTarget,
    phase: Math.random() * 10, recoil: 0, deadLerp: 0,
  };
}

export interface SoldierAnimState {
  speed: number;
  pitch: number;
  reloading: boolean;
  dead: boolean;
  time: number;
}

export function animateSoldier(rig: SoldierRig, dt: number, s: SoldierAnimState) {
  // walk cycle
  const speedF = Math.min(1, s.speed / 5);
  rig.phase += dt * (3 + s.speed * 1.6);
  const swing = Math.sin(rig.phase) * 0.55 * speedF;
  rig.legL.rotation.x = swing;
  rig.legR.rotation.x = -swing;

  // aim pitch + reload dip + recoil
  const targetPitch = s.reloading ? 0.7 : -s.pitch * 0.85;
  rig.arms.rotation.x += (targetPitch - rig.arms.rotation.x) * Math.min(1, dt * 14);
  rig.recoil = Math.max(0, rig.recoil - dt * 9);
  rig.rifle.position.z = 0.42 - rig.recoil * 0.07;

  // cape sway
  rig.cape.rotation.x = 0.13 + speedF * 0.38 + Math.sin(s.time * 2.3 + rig.phase * 0.3) * 0.045;

  // death: fall over and settle
  const target = s.dead ? 1 : 0;
  rig.deadLerp += (target - rig.deadLerp) * Math.min(1, dt * (s.dead ? 5 : 12));
  rig.group.rotation.z = rig.deadLerp * 1.5;
  rig.group.rotation.x = rig.deadLerp * 0.12;
  rig.flashlight.intensity = s.dead ? 0 : rig.flashlight.intensity;
}

// floating nametag for squadmates
export function makeNameSprite(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 56;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '700 26px Arial';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 217, 74, 0.92)';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 6;
  ctx.fillText(name.toUpperCase().slice(0, 14), 128, 38);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false,
  }));
  sprite.scale.set(2.1, 0.46, 1);
  sprite.position.y = 2.25;
  return sprite;
}
