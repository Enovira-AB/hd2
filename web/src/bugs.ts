// Procedural Terminid-style bugs: layered carapace plates, jointed spider
// legs, bioluminescent abdomen with a dark dorsal shell so the glow leaks at
// the seams. Iterated against scripts/preview.mts renders.

import * as THREE from 'three';
import { BUG_KINDS } from '../../shared/constants.js';

export interface BugRig {
  group: THREE.Group;
  legs: THREE.Object3D[];
  abdomenMat: THREE.MeshStandardMaterial;
  kind: number;
  phase: number;
}

// a cylinder running from the local origin toward `dir` with length `len`
function segment(r0: number, r1: number, len: number, dir: THREE.Vector3, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(r1, r0, len, 6);
  geo.translate(0, len / 2, 0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return mesh;
}

export function buildBug(kind: number, castShadow: boolean): BugRig {
  const def = BUG_KINDS[kind];
  const scale = def.radius / 0.55;
  const isWarrior = kind === 1;

  const shellMat = new THREE.MeshStandardMaterial({
    color: isWarrior ? 0x261e16 : 0x322a22, roughness: 0.6, metalness: 0.15, flatShading: true,
  });
  const shellDark = new THREE.MeshStandardMaterial({
    color: isWarrior ? 0x1a1410 : 0x241d16, roughness: 0.7, metalness: 0.1, flatShading: true,
  });
  const boneMat = new THREE.MeshStandardMaterial({
    color: 0xcfc6b0, roughness: 0.55, flatShading: true,
  });
  const abdomenMat = new THREE.MeshStandardMaterial({
    color: 0x4a2a14, emissive: isWarrior ? 0xff4a16 : 0xff7a26,
    emissiveIntensity: 0.9, roughness: 0.4, flatShading: true,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: isWarrior ? 0xff3333 : 0xffb24a, emissiveIntensity: 1.8,
  });

  const group = new THREE.Group();

  // two overlapping carapace segments
  const seg1 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 1), shellMat);
  seg1.scale.set(1.05, 0.62, 1.1);
  seg1.position.set(0, 0.4, 0.12);
  const seg2 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.36, 1), shellDark);
  seg2.scale.set(1.0, 0.58, 0.95);
  seg2.position.set(0, 0.42, -0.26);
  group.add(seg1, seg2);

  // head with armored brow
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 1), shellDark);
  head.scale.set(0.95, 0.8, 1.0);
  head.position.set(0, 0.34, 0.54);
  const brow = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 1), isWarrior ? boneMat : shellMat);
  brow.scale.set(1.1, 0.45, 0.85);
  brow.position.set(0, 0.45, 0.5);
  group.add(head, brow);

  // four small mean eyes
  for (const side of [-1, 1]) {
    const eyeBig = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 5), eyeMat);
    eyeBig.position.set(0.08 * side, 0.36, 0.69);
    const eyeSmall = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 5), eyeMat);
    eyeSmall.position.set(0.125 * side, 0.4, 0.62);
    group.add(eyeBig, eyeSmall);
  }

  // mandibles curving inward, antennae sweeping back
  for (const side of [-1, 1]) {
    const mandible = new THREE.Mesh(
      new THREE.ConeGeometry(isWarrior ? 0.05 : 0.035, isWarrior ? 0.3 : 0.22, 5),
      boneMat,
    );
    mandible.position.set(0.1 * side, 0.25, 0.68);
    mandible.rotation.x = 1.25;
    mandible.rotation.z = -0.7 * side;
    const antenna = segment(0.012, 0.004, 0.32, new THREE.Vector3(0.25 * side, 0.55, 0.8), shellDark);
    antenna.position.set(0.06 * side, 0.46, 0.6);
    group.add(mandible, antenna);
  }

  // abdomen: glowing core under a dark dorsal shell — light leaks at the seams
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), abdomenMat);
  core.scale.set(1.08, 0.95, 1.5);
  core.position.set(0, 0.36, -0.66);
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 1), shellDark);
  shell.scale.set(1.0, 0.62, 1.12);
  shell.position.set(0, 0.52, -0.56);
  group.add(core, shell);

  if (isWarrior) {
    const crest = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.42, 5), boneMat);
    crest.position.set(0, 0.6, 0.3);
    crest.rotation.x = 0.55; // sweeps back over the body
    group.add(crest);
    for (const side of [-1, 1]) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.3, 5), boneMat);
      spike.position.set(0.16 * side, 0.6, -0.2);
      spike.rotation.x = 0.5;
      spike.rotation.z = -0.35 * side;
      group.add(spike);
    }
  }

  // six jointed legs: femur up-out from the hip, tibia down to the ground
  const legs: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Group();
      leg.position.set(0.26 * side, 0.38, 0.3 - i * 0.28);
      const femurDir = new THREE.Vector3(0.8 * side, 0.6, 0.05);
      const femur = segment(0.026, 0.02, 0.32, femurDir, shellMat);
      const knee = new THREE.Mesh(new THREE.SphereGeometry(0.028, 6, 5), shellDark);
      const kneePos = femurDir.clone().normalize().multiplyScalar(0.32);
      knee.position.copy(kneePos);
      const tibia = segment(0.018, 0.006, 0.62, new THREE.Vector3(0.16 * side, -0.98, 0), shellDark);
      tibia.position.copy(kneePos);
      leg.add(femur, knee, tibia);
      leg.userData.baseZ = 0;
      leg.userData.idx = i + (side > 0 ? 3 : 0);
      legs.push(leg);
      group.add(leg);
    }
  }

  group.scale.setScalar(scale);
  if (castShadow) {
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
  }

  return { group, legs, abdomenMat, kind, phase: Math.random() * 10 };
}

export function animateBug(rig: BugRig, dt: number, speed: number, time: number) {
  rig.phase += dt * (4 + speed * 2.2);
  const amp = Math.min(1, speed / 3 + 0.15);
  for (const leg of rig.legs) {
    const i = leg.userData.idx as number;
    leg.rotation.y = Math.sin(rig.phase + i * 2.1) * 0.45 * amp;
    leg.rotation.x = Math.cos(rig.phase + i * 2.1) * 0.1 * amp;
  }
  rig.abdomenMat.emissiveIntensity = 0.7 + Math.sin(time * 3 + rig.phase) * 0.3;
}
