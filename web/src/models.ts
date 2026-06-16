// Optional drop-in GLB models with skeletal animation. List files in
// web/public/models/manifest.json (see the README there) and they replace the
// procedural primitives automatically. Nothing listed → every entity falls
// back to its procedural builder, with zero failed network requests.

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
    move?: THREE.AnimationAction; // forward locomotion
    idle?: THREE.AnimationAction;
    death?: THREE.AnimationAction;
    back?: THREE.AnimationAction; // moving backward
    strafe?: THREE.AnimationAction; // strafing left
    strafeR?: THREE.AnimationAction; // strafing right
    fire?: THREE.AnimationAction; // additive upper-body firing overlay
  };
  current?: THREE.AnimationAction;
}

const registry: { soldier: LoadedModel | null; bugs: (LoadedModel | null)[] } = {
  soldier: null,
  bugs: [null, null, null, null, null],
};

export function getSoldierModel(): LoadedModel | null {
  return registry.soldier;
}
export function getBugModel(kind: number): LoadedModel | null {
  return registry.bugs[kind] ?? null;
}

// Normalized display height per logical model, keyed by manifest field.
const TARGET_HEIGHT: Record<string, number> = {
  soldier: 1.95, bug0: 0.95, bug1: 1.55, bug2: 1.4, bug3: 2.4, bug4: 6.0,
};

// A manifest entry is a filename, or an object for tuning facing/height and
// adding extra animation clips without touching code:
//   { "file": "x.glb", "yaw": 3.14159, "height": 2,
//     "anims": { "back": "anims/run_back.glb", "strafe": "anims/strafe.glb" } }
// `yaw` rotates the model if it faces the wrong way (glTF forward is +Z; if a
// model walks backwards, set yaw to Math.PI ≈ 3.14159). `anims` merges extra
// skeletal clips (e.g. Mixamo directional anims) onto the same rig by name.
type ManifestEntry =
  | string
  | { file: string; yaw?: number; height?: number; anims?: Record<string, string> }
  | null;

// Fire-and-forget at boot. Reads /models/manifest.json (always shipped, so no
// 404s) and only loads the GLBs it actually lists; anything unlisted keeps its
// procedural look. Views created after a model resolves pick it up.
export async function preloadModels() {
  let manifest: Record<string, ManifestEntry> = {};
  try {
    const res = await fetch('/models/manifest.json');
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return;
    manifest = await res.json();
  } catch {
    return; // no manifest, no custom models — procedural everywhere
  }
  const load = (key: string, set: (m: LoadedModel) => void) => {
    const entry = manifest[key];
    const file = typeof entry === 'string' ? entry : entry?.file;
    if (!file) return;
    const obj = typeof entry === 'object' && entry ? entry : null;
    const yaw = obj?.yaw ?? 0;
    const height = obj?.height ?? TARGET_HEIGHT[key] ?? 1.8;
    const extraAnims = obj?.anims
      ? Object.entries(obj.anims).map(([k, f]) => ({ key: k, file: f }))
      : [];
    void loadModel(`/models/${file}`, height, yaw, extraAnims).then((m) => {
      if (m) set(m);
    });
  };
  load('soldier', (m) => (registry.soldier = m));
  load('bug0', (m) => (registry.bugs[0] = m));
  load('bug1', (m) => (registry.bugs[1] = m));
  load('bug2', (m) => (registry.bugs[2] = m));
  load('bug3', (m) => (registry.bugs[3] = m));
  load('bug4', (m) => (registry.bugs[4] = m));
}

async function loadModel(
  url: string,
  targetHeight: number,
  faceYaw: number,
  extraAnims: { key: string; file: string }[] = [],
): Promise<LoadedModel | null> {
  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    const wrapper = new THREE.Group();
    wrapper.add(gltf.scene);

    // normalize: scale to target height, feet on the ground, face +Z
    gltf.scene.rotation.y += faceYaw;
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const s = targetHeight / Math.max(0.01, size.y);
    gltf.scene.scale.setScalar(s);
    box.setFromObject(gltf.scene);
    gltf.scene.position.y -= box.min.y;

    // merge extra animation-only clips (same skeleton, bound by bone name).
    // Strip root/hip translation so the clip drives pose only — the game owns
    // position, otherwise the model double-moves / slides.
    const clips = [...gltf.animations];
    for (const a of extraAnims) {
      try {
        const ag = await loader.loadAsync(`/models/${a.file}`);
        const clip = ag.animations[0];
        if (clip) {
          clip.name = a.key;
          // Strip root/hip translation on looping locomotion so the game owns
          // position (no sliding). Keep it for death so the body actually
          // stumbles and falls instead of collapsing in place.
          if (!/death|die/i.test(a.key)) {
            clip.tracks = clip.tracks.filter(
              (t) => !(t.name.endsWith('.position') && /Hips|RootNode/.test(t.name)),
            );
          }
          clips.push(clip);
        }
      } catch {
        /* missing extra anim is non-fatal */
      }
    }

    console.info(`[models] ${url} loaded (clips: ${clips.map((c) => c.name).join(', ') || 'none'})`);
    return { template: wrapper, clips };
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
    // prefer purpose-made rifle clips over a model's generic built-ins
    const move = find(/rifle_run/i) ?? find(/run/i) ?? find(/walk/i);
    const idle = find(/rifle_idle/i) ?? find(/idle/i) ?? model.clips[0];
    const death = find(/death|die/i);
    const back = find(/^back$/i) ?? find(/back/i);
    const strafe = find(/^strafe$/i);
    const strafeR = find(/strafe_r/i);
    if (move) actions.move = mixer.clipAction(move);
    if (idle) actions.idle = mixer.clipAction(idle);
    if (back) actions.back = mixer.clipAction(back);
    if (strafe) actions.strafe = mixer.clipAction(strafe);
    if (strafeR) actions.strafeR = mixer.clipAction(strafeR);
    if (death) {
      actions.death = mixer.clipAction(death);
      actions.death.setLoop(THREE.LoopOnce, 1);
      actions.death.clampWhenFinished = true;
    }
    // firing as an additive overlay so the upper body fires while the legs
    // keep running/strafing. Clone per-instance: makeClipAdditive mutates.
    const fire = find(/^fire$/i);
    if (fire) {
      const additive = THREE.AnimationUtils.makeClipAdditive(fire.clone());
      actions.fire = mixer.clipAction(additive, group, THREE.AdditiveAnimationBlendMode);
      actions.fire.setLoop(THREE.LoopRepeat, Infinity);
      actions.fire.weight = 0;
      actions.fire.play();
    }
  }
  return { group, mixer, actions };
}

// `dir` (optional) is local-space velocity: forward>0 ahead, strafe = lateral.
// When directional clips exist it picks forward/back/strafe; otherwise it
// falls back to the single move clip.
export function animateInstance(
  inst: ModelInstance,
  dt: number,
  speed: number,
  dead: boolean,
  dir?: { forward: number; strafe: number },
  firing = false,
) {
  if (dead && !inst.actions.death) {
    // no death clip: keel over like the procedural rig does
    inst.group.rotation.z += (1.5 - inst.group.rotation.z) * Math.min(1, dt * 5);
  } else if (!dead && inst.group.rotation.z !== 0) {
    inst.group.rotation.z += (0 - inst.group.rotation.z) * Math.min(1, dt * 10);
  }
  if (!inst.mixer) return;
  const a = inst.actions;

  let target: THREE.AnimationAction | undefined;
  if (dead) {
    target = a.death ?? a.idle;
  } else if (speed <= 0.7) {
    target = a.idle;
  } else if (dir && (a.back || a.strafe || a.strafeR)) {
    const af = Math.abs(dir.forward);
    const as = Math.abs(dir.strafe);
    if (as > af && (a.strafe || a.strafeR)) {
      // strafe right uses strafeR, left uses strafe; fall back to either
      target = (dir.strafe > 0 ? a.strafeR : a.strafe) ?? a.strafe ?? a.strafeR;
    } else if (dir.forward < -0.15 && a.back) {
      target = a.back;
    } else {
      target = a.move ?? a.idle;
    }
  } else {
    target = a.move ?? a.idle;
  }

  if (target && inst.current !== target) {
    target.reset().fadeIn(0.16).play();
    inst.current?.fadeOut(0.16);
    inst.current = target;
  }
  // speed-scale whichever locomotion clip is playing
  if (inst.current && inst.current !== a.idle && inst.current !== a.death) {
    inst.current.timeScale = Math.max(0.6, speed / 4.5);
  }
  // ramp the additive firing overlay in/out
  if (a.fire) {
    const targetW = firing && !dead ? 1 : 0;
    a.fire.weight += (targetW - a.fire.weight) * Math.min(1, dt * 14);
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
