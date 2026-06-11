// Procedural Terminid-style bugs. Two kinds: scavenger (small, fast) and
// warrior (big, armored). Bioluminescent abdomens give them away in the dark.

import * as THREE from 'three';
import { BUG_KINDS } from '../../shared/constants.js';

export interface BugRig {
  group: THREE.Group;
  legs: THREE.Mesh[];
  abdomenMat: THREE.MeshStandardMaterial;
  kind: number;
  phase: number;
}

export function buildBug(kind: number, castShadow: boolean): BugRig {
  const def = BUG_KINDS[kind];
  const scale = def.radius / 0.55;
  const isWarrior = kind === 1;

  const shellMat = new THREE.MeshStandardMaterial({
    color: isWarrior ? 0x231c16 : 0x2e2620, roughness: 0.65, metalness: 0.15, flatShading: true,
  });
  const boneMat = new THREE.MeshStandardMaterial({
    color: 0xcfc6b0, roughness: 0.55, flatShading: true,
  });
  const abdomenMat = new THREE.MeshStandardMaterial({
    color: 0x3a2417, emissive: isWarrior ? 0xff4a16 : 0xff7a26,
    emissiveIntensity: 0.8, roughness: 0.4, flatShading: true,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: isWarrior ? 0xff3333 : 0xffb24a, emissiveIntensity: 1.8,
  });

  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), shellMat);
  body.scale.set(1.1, 0.65, 1.45);
  body.position.y = 0.42;
  group.add(body);

  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.24, 1), shellMat);
  head.position.set(0, 0.42, 0.62);
  head.scale.set(1, 0.85, 1);
  group.add(head);

  if (isWarrior) {
    const crest = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 5), boneMat);
    crest.position.set(0, 0.62, 0.6);
    crest.rotation.x = -0.6;
    group.add(crest);
  }

  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), eyeMat);
    eye.position.set(0.1 * side, 0.46, 0.82);
    group.add(eye);
    const mandible = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.3, 4), boneMat);
    mandible.position.set(0.14 * side, 0.3, 0.78);
    mandible.rotation.x = 1.9;
    mandible.rotation.z = -0.5 * side;
    group.add(mandible);
  }

  const abdomen = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), abdomenMat);
  abdomen.scale.set(1, 0.85, 1.3);
  abdomen.position.set(0, 0.44, -0.58);
  group.add(abdomen);

  const legs: THREE.Mesh[] = [];
  const legGeo = new THREE.CylinderGeometry(0.022, 0.012, 0.62, 5);
  legGeo.translate(0, -0.31, 0); // pivot at the hip
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Mesh(legGeo, shellMat);
      leg.position.set(0.34 * side, 0.45, 0.3 - i * 0.3);
      leg.rotation.z = 0.95 * side;
      leg.userData.baseZ = 0.95 * side;
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
    leg.rotation.x = Math.sin(rig.phase + i * 2.1) * 0.5 * amp;
    leg.rotation.z = (leg.userData.baseZ as number) + Math.cos(rig.phase + i * 2.1) * 0.12 * amp;
  }
  rig.abdomenMat.emissiveIntensity = 0.65 + Math.sin(time * 3 + rig.phase) * 0.3;
}
