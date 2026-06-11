// Optional drop-in GLB models with skeletal animation. Put files in
// web/public/models/ (see the README there) and they replace the procedural
// primitives automatically — soldier.glb, bug0.glb, bug1.glb. No file, no
// problem: every entity falls back to its procedural builder.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export interface LoadedModel {
  template: THREE.Group; // normalized: feet at y=0, faces +Z, scaled to target height
  clips: THREE.AnimationClip[];
}

export interface ModelInstance {
  group: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  actions: {
    move?: THREE.AnimationAction;
    idle?: THREE.AnimationAction;
    death?: THREE.AnimationAction;
  };
  current?: THREE.AnimationAction;
}

const registry: { soldier: LoadedModel | null; bugs: (LoadedModel | null)[] } = {
  soldier: null,
  bugs: [null, null],
};

export function getSoldierModel(): LoadedModel | null {
  return registry.soldier;
}
export function getBugModel(kind: number): LoadedModel | null {
  return registry.bugs[kind] ?? null;
}

// Fire-and-forget at boot. Views created after a model resolves use it;
// views created before keep their procedural look until the next mission.
export function preloadModels() {
  void loadOptional('/models/soldier.glb', 1.95).then((m) => (registry.soldier = m));
  void loadOptional('/models/bug0.glb', 0.95).then((m) => (registry.bugs[0] = m));
  void loadOptional('/models/bug1.glb', 1.55).then((m) => (registry.bugs[1] = m));
}

async function loadOptional(url: string, targetHeight: number): Promise<LoadedModel | null> {
  try {
    // probe first: the prod server SPA-falls-back to index.html, so a bare
    // GLTFLoader 404 would surface as a confusing JSON parse error
    const head = await fetch(url, { method: 'HEAD' });
    const type = head.headers.get('content-type') ?? '';
    if (!head.ok || type.includes('text/html')) return null;

    const gltf = await new GLTFLoader().loadAsync(url);
    const wrapper = new THREE.Group();
    wrapper.add(gltf.scene);

    // normalize: scale to target height, feet on the ground
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const s = targetHeight / Math.max(0.01, size.y);
    gltf.scene.scale.setScalar(s);
    box.setFromObject(gltf.scene);
    gltf.scene.position.y -= box.min.y;

    console.info(
      `[models] ${url} loaded (clips: ${gltf.animations.map((c) => c.name).join(', ') || 'none'})`,
    );
    return { template: wrapper, clips: gltf.animations };
  } catch {
    return null;
  }
}

export function instantiate(model: LoadedModel, castShadow: boolean): ModelInstance {
  const group = cloneSkinned(model.template) as THREE.Group;
  if (castShadow) {
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
  }
  let mixer: THREE.AnimationMixer | null = null;
  const actions: ModelInstance['actions'] = {};
  if (model.clips.length > 0) {
    mixer = new THREE.AnimationMixer(group);
    const find = (re: RegExp) => model.clips.find((c) => re.test(c.name));
    const move = find(/run/i) ?? find(/walk/i);
    const idle = find(/idle/i) ?? model.clips[0];
    const death = find(/death|die/i);
    if (move) actions.move = mixer.clipAction(move);
    if (idle) actions.idle = mixer.clipAction(idle);
    if (death) {
      actions.death = mixer.clipAction(death);
      actions.death.setLoop(THREE.LoopOnce, 1);
      actions.death.clampWhenFinished = true;
    }
  }
  return { group, mixer, actions };
}

export function animateInstance(inst: ModelInstance, dt: number, speed: number, dead: boolean) {
  if (dead && !inst.actions.death) {
    // no death clip: keel over like the procedural rig does
    inst.group.rotation.z += (1.5 - inst.group.rotation.z) * Math.min(1, dt * 5);
  } else if (!dead && inst.group.rotation.z !== 0) {
    inst.group.rotation.z += (0 - inst.group.rotation.z) * Math.min(1, dt * 10);
  }
  if (!inst.mixer) return;

  let target = dead
    ? inst.actions.death ?? inst.actions.idle
    : speed > 0.7
      ? inst.actions.move ?? inst.actions.idle
      : inst.actions.idle;
  if (target && inst.current !== target) {
    target.reset().fadeIn(0.18).play();
    inst.current?.fadeOut(0.18);
    inst.current = target;
  }
  if (inst.actions.move && inst.current === inst.actions.move) {
    inst.actions.move.timeScale = Math.max(0.55, speed / 5);
  }
  inst.mixer.update(dt);
}

export function findNode(root: THREE.Object3D, re: RegExp): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && re.test(o.name)) found = o;
  });
  return found;
}
