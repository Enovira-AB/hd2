// Procedural helldiver model built from primitives. Reads well at night:
// glowing visor, yellow accent stripes, team-colored cape, chest flashlight.
// Iterated against scripts/preview.mts renders — keep proportions verified
// there when changing anything.

import * as THREE from 'three';
import { armorMaps, capeTexture } from './textures.js';

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

function cyl(r: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 8), mat);
  mesh.position.set(x, y, z);
  return mesh;
}

export function buildSoldier(colorIndex: number, castShadow: boolean): SoldierRig {
  const plate = armorMaps();
  const normalScale = new THREE.Vector2(0.6, 0.6);
  const armor = new THREE.MeshStandardMaterial({
    color: 0x565d66, map: plate.map, normalMap: plate.normalMap, normalScale,
    roughness: 0.55, metalness: 0.35,
  });
  const armorLight = new THREE.MeshStandardMaterial({
    color: 0x6c757f, map: plate.map, normalMap: plate.normalMap, normalScale,
    roughness: 0.5, metalness: 0.4,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x2b2f35, map: plate.map, roughness: 0.8, metalness: 0.2,
  });
  const stripe = new THREE.MeshStandardMaterial({
    color: 0xd9a834, emissive: 0xd9a834, emissiveIntensity: 0.3, roughness: 0.5,
  });
  const visorMat = new THREE.MeshStandardMaterial({
    color: 0x0c0f12, emissive: 0x86d9ff, emissiveIntensity: 2.0, roughness: 0.3,
  });
  const capeMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: capeTexture(CAPE_COLORS[colorIndex % CAPE_COLORS.length]),
    roughness: 1, side: THREE.DoubleSide,
  });
  const gunMat = new THREE.MeshStandardMaterial({
    color: 0x23262b, map: plate.map, normalMap: plate.normalMap, normalScale,
    roughness: 0.6, metalness: 0.5,
  });

  const group = new THREE.Group();

  // legs: thigh + knee pad + shin + guard + boot, pivot at the hip
  const makeLeg = (side: number) => {
    const leg = new THREE.Group();
    leg.position.set(0.13 * side, 0.98, 0);
    leg.add(
      box(0.16, 0.42, 0.19, armor, 0, -0.22, 0),
      box(0.13, 0.1, 0.12, armorLight, 0, -0.45, 0.05),
      box(0.13, 0.42, 0.16, dark, 0, -0.69, 0),
      box(0.1, 0.3, 0.05, armor, 0, -0.66, 0.09),
      box(0.16, 0.11, 0.27, dark, 0, -0.925, 0.04),
    );
    return leg;
  };
  const legL = makeLeg(-1);
  const legR = makeLeg(1);
  group.add(legL, legR);

  // hips + belt with pouches
  group.add(
    box(0.36, 0.16, 0.24, armor, 0, 1.06, 0),
    box(0.4, 0.09, 0.28, dark, 0, 1.17, 0),
    box(0.09, 0.1, 0.06, dark, -0.12, 1.14, 0.16),
    box(0.09, 0.1, 0.06, dark, 0.12, 1.14, 0.16),
  );
  for (const side of [-1, 1]) {
    const hipPlate = box(0.12, 0.2, 0.2, armorLight, 0.21 * side, 1.04, 0);
    hipPlate.rotation.z = -0.18 * side;
    group.add(hipPlate);
  }

  // torso: under-suit + chest plate + abdomen plate + back plate + stripe
  group.add(
    box(0.4, 0.5, 0.24, dark, 0, 1.42, 0),
    box(0.44, 0.3, 0.3, armorLight, 0, 1.53, 0.01),
    box(0.38, 0.17, 0.27, armor, 0, 1.31, 0.01),
    box(0.42, 0.34, 0.12, armor, 0, 1.5, -0.14),
    box(0.45, 0.05, 0.31, stripe, 0, 1.445, 0.015),
  );

  // backpack: pack + scrubber + antenna + status lamp
  group.add(
    box(0.34, 0.42, 0.16, dark, 0, 1.45, -0.26),
    cyl(0.07, 0.2, armor, 0.1, 1.69, -0.26),
    cyl(0.008, 0.36, dark, -0.12, 1.82, -0.28),
    box(0.05, 0.05, 0.02, new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: 0x9fffb0, emissiveIntensity: 1.6,
    }), 0.1, 1.56, -0.355),
  );

  // pauldrons, two layers each, with stripes
  for (const side of [-1, 1]) {
    const top = box(0.2, 0.12, 0.24, armorLight, 0.31 * side, 1.66, 0);
    top.rotation.z = -0.14 * side;
    const low = box(0.17, 0.1, 0.21, armor, 0.36 * side, 1.57, 0);
    low.rotation.z = -0.3 * side;
    const st = box(0.21, 0.035, 0.25, stripe, 0.31 * side, 1.62, 0);
    st.rotation.z = -0.14 * side;
    group.add(top, low, st);
  }

  // head: neck, helmet, jaw guard, visor slit, comm antenna
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 10), armorLight);
  helmet.position.set(0, 1.8, 0);
  helmet.scale.set(1, 1.06, 1.12);
  const jaw = box(0.17, 0.1, 0.15, armor, 0, 1.72, 0.03);
  const visor = box(0.15, 0.045, 0.02, visorMat, 0, 1.81, 0.125);
  group.add(cyl(0.05, 0.09, dark, 0, 1.69, 0), helmet, jaw, visor, cyl(0.008, 0.12, dark, -0.13, 1.84, -0.01));

  // arms + rifle pivot together for aim pitch
  const arms = new THREE.Group();
  arms.position.set(0, 1.6, 0.05);
  const upperR = box(0.1, 0.1, 0.3, armor, 0.3, -0.05, 0.16);
  const foreR = box(0.09, 0.09, 0.3, armor, 0.27, -0.13, 0.36);
  foreR.rotation.y = 0.12;
  const handR = box(0.07, 0.09, 0.1, dark, 0.245, -0.16, 0.5);
  const upperL = box(0.1, 0.1, 0.26, armor, -0.27, -0.06, 0.14);
  upperL.rotation.y = 0.45;
  const foreL = box(0.08, 0.08, 0.3, armor, -0.1, -0.15, 0.34);
  foreL.rotation.y = 0.65;
  const handL = box(0.07, 0.08, 0.09, dark, 0.08, -0.16, 0.46);

  const rifle = new THREE.Group();
  const mag = box(0.045, 0.16, 0.08, gunMat, 0, -0.12, 0.05);
  mag.rotation.x = 0.18;
  rifle.add(
    box(0.06, 0.11, 0.46, gunMat, 0, 0, 0),
    box(0.05, 0.1, 0.18, dark, 0, -0.01, -0.3),
    box(0.04, 0.09, 0.05, dark, 0, -0.1, -0.16),
    mag,
    box(0.05, 0.05, 0.07, gunMat, 0, 0.025, 0.52),
  );
  const barrel = cyl(0.022, 0.3, gunMat, 0, 0.025, 0.36);
  barrel.rotation.x = Math.PI / 2;
  const scope = cyl(0.03, 0.1, dark, 0, 0.095, 0.0);
  scope.rotation.x = Math.PI / 2;
  const sight = box(0.018, 0.018, 0.018, new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: 0xff4444, emissiveIntensity: 1.8,
  }), 0, 0.1, -0.06);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.025, 0.56);
  rifle.add(barrel, scope, sight, muzzle);
  rifle.position.set(0.24, -0.12, 0.3);
  rifle.userData.baseZ = 0.3;
  arms.add(upperR, foreR, handR, upperL, foreL, handL, rifle);
  group.add(arms);

  // cape, pivot at the shoulders
  const capeGeo = new THREE.PlaneGeometry(0.55, 0.85, 1, 5);
  capeGeo.translate(0, -0.42, 0);
  const cape = new THREE.Mesh(capeGeo, capeMat);
  cape.position.set(0, 1.64, -0.31);
  cape.rotation.x = 0.16;
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
  const baseZ = (rig.rifle.userData.baseZ as number) ?? 0.3;
  rig.rifle.position.z = baseZ - rig.recoil * 0.07;

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
