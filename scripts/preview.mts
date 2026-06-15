// Software renderer for previewing the procedural models without a browser:
// collects world-space triangles from three.js objects, rasterizes with a
// z-buffer, Lambert shading + emissive + optional night mode (fog + viewer
// torch + ACES), writes PNGs. Run: npx tsx scripts/preview.mts

import * as THREE from 'three';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildSoldier } from '../web/src/soldier.js';
import { buildBug } from '../web/src/bugs.js';

const W = 900;
const H = 900;

// ---- PNG ---------------------------------------------------------------------

function crc32(buf: Buffer): number {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(path: string, px: Buffer) {
  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
  console.log(`wrote ${path}`);
}

// ---- triangle collection ---------------------------------------------------------

interface TexRef {
  data: Uint8Array;
  w: number;
  h: number;
  repX: number;
  repY: number;
}

interface Tri {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  uva: THREE.Vector2;
  uvb: THREE.Vector2;
  uvc: THREE.Vector2;
  tex: TexRef | null;
  color: THREE.Color;
  emissive: THREE.Color;
  ei: number;
}

function texRefOf(mat: THREE.MeshStandardMaterial): TexRef | null {
  const map = mat.map as THREE.DataTexture | null;
  if (!map || !(map as { isDataTexture?: boolean }).isDataTexture) return null;
  const img = map.image as { data: Uint8Array; width: number; height: number };
  return { data: img.data, w: img.width, h: img.height, repX: map.repeat.x, repY: map.repeat.y };
}

// nearest-neighbour sample, sRGB -> linear
function sampleTex(tex: TexRef, u: number, v: number, out: THREE.Color) {
  let uu = (u * tex.repX) % 1;
  let vv = (v * tex.repY) % 1;
  if (uu < 0) uu += 1;
  if (vv < 0) vv += 1;
  const x = Math.min(tex.w - 1, Math.floor(uu * tex.w));
  const y = Math.min(tex.h - 1, Math.floor(vv * tex.h));
  const i = (y * tex.w + x) * 4;
  out.setRGB(
    Math.pow(tex.data[i] / 255, 2.2),
    Math.pow(tex.data[i + 1] / 255, 2.2),
    Math.pow(tex.data[i + 2] / 255, 2.2),
  );
}

interface Splat {
  pos: THREE.Vector3;
  scale: number;
  color: THREE.Color;
  opacity: number;
}

// additive glow sprites (bug halos, beacons …) rendered as soft splats
function collectSprites(root: THREE.Object3D): Splat[] {
  root.updateMatrixWorld(true);
  const splats: Splat[] = [];
  root.traverse((o) => {
    const sprite = o as THREE.Sprite;
    if (!(sprite as { isSprite?: boolean }).isSprite || !sprite.visible) return;
    const mat = sprite.material as THREE.SpriteMaterial;
    if ((mat.opacity ?? 1) <= 0.01) return;
    const ws = new THREE.Vector3();
    sprite.getWorldScale(ws);
    splats.push({
      pos: new THREE.Vector3().setFromMatrixPosition(sprite.matrixWorld),
      scale: Math.abs(ws.x),
      color: mat.color ?? new THREE.Color(1, 1, 1),
      opacity: mat.opacity ?? 1,
    });
  });
  return splats;
}

function collect(root: THREE.Object3D): Tri[] {
  root.updateMatrixWorld(true);
  const tris: Tri[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh) return;
    if (!mesh.visible) return;
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.attributes.position as THREE.BufferAttribute;
    if (!pos) return;
    const uv = geom.attributes.uv as THREE.BufferAttribute | undefined;
    const index = geom.index;
    const m = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    const color = m.color ?? new THREE.Color(1, 1, 1);
    const emissive = m.emissive ?? new THREE.Color(0, 0, 0);
    const ei = m.emissiveIntensity ?? 1;
    const tex = uv ? texRefOf(m) : null;
    const uvOf = (idx: number) =>
      uv ? new THREE.Vector2().fromBufferAttribute(uv, idx) : new THREE.Vector2();
    const count = index ? index.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      tris.push({
        a: new THREE.Vector3().fromBufferAttribute(pos, ia).applyMatrix4(mesh.matrixWorld),
        b: new THREE.Vector3().fromBufferAttribute(pos, ib).applyMatrix4(mesh.matrixWorld),
        c: new THREE.Vector3().fromBufferAttribute(pos, ic).applyMatrix4(mesh.matrixWorld),
        uva: uvOf(ia), uvb: uvOf(ib), uvc: uvOf(ic), tex,
        color, emissive, ei,
      });
    }
  });
  return tris;
}

// ---- rasterizer -------------------------------------------------------------------

interface Shot {
  out: string;
  camPos: [number, number, number];
  lookAt: [number, number, number];
  fov?: number;
  mode: 'studio' | 'night';
}

function aces(x: number): number {
  return Math.max(0, Math.min(1, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
}

function render(root: THREE.Object3D, shot: Shot) {
  const cam = new THREE.PerspectiveCamera(shot.fov ?? 38, W / H, 0.1, 200);
  cam.position.set(...shot.camPos);
  cam.lookAt(new THREE.Vector3(...shot.lookAt));
  cam.updateMatrixWorld(true);
  const view = cam.matrixWorld.clone().invert();
  const proj = cam.projectionMatrix;
  const camPos = new THREE.Vector3(...shot.camPos);
  const camDir = new THREE.Vector3(...shot.lookAt).sub(camPos).normalize();

  const px = Buffer.alloc(W * H * 4);
  const zbuf = new Float32Array(W * H).fill(Infinity);

  // background
  const fogColor = new THREE.Color(0x0a0e16);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const t = y / H;
      const bg = shot.mode === 'night'
        ? new THREE.Color(0x05070c).lerp(new THREE.Color(0x0a0e16), t)
        : new THREE.Color(0x16181d).lerp(new THREE.Color(0x232730), t);
      px[i] = bg.r * 255;
      px[i + 1] = bg.g * 255;
      px[i + 2] = bg.b * 255;
      px[i + 3] = 255;
    }
  }

  const tris = collect(root);
  const v4 = (v: THREE.Vector3) => {
    const p = new THREE.Vector4(v.x, v.y, v.z, 1).applyMatrix4(view).applyMatrix4(proj);
    return p;
  };

  // lights
  const keyDir = new THREE.Vector3(0.55, 0.75, 0.5).normalize();
  const fillDir = new THREE.Vector3(-0.65, 0.2, 0.55).normalize();
  const rimDir = new THREE.Vector3(-0.1, 0.35, -1).normalize();
  const moonDir = new THREE.Vector3(0.3, 0.8, -0.35).normalize();
  const moonCol = new THREE.Color(0x9fb6e8);
  const torchCol = new THREE.Color(0xfff0d4);

  for (const t of tris) {
    const pa = v4(t.a);
    const pb = v4(t.b);
    const pc = v4(t.c);
    if (pa.w <= 0 || pb.w <= 0 || pc.w <= 0) continue;
    const sa = { x: ((pa.x / pa.w) * 0.5 + 0.5) * W, y: (1 - ((pa.y / pa.w) * 0.5 + 0.5)) * H, z: pa.w };
    const sb = { x: ((pb.x / pb.w) * 0.5 + 0.5) * W, y: (1 - ((pb.y / pb.w) * 0.5 + 0.5)) * H, z: pb.w };
    const sc = { x: ((pc.x / pc.w) * 0.5 + 0.5) * W, y: (1 - ((pc.y / pc.w) * 0.5 + 0.5)) * H, z: pc.w };

    // face normal, flipped toward the camera (double-sided shading)
    const n = new THREE.Vector3()
      .crossVectors(
        new THREE.Vector3().subVectors(t.b, t.a),
        new THREE.Vector3().subVectors(t.c, t.a),
      )
      .normalize();
    const centroid = new THREE.Vector3().addVectors(t.a, t.b).add(t.c).multiplyScalar(1 / 3);
    const toCam = new THREE.Vector3().subVectors(camPos, centroid).normalize();
    if (n.dot(toCam) < 0) n.negate();

    // per-face lighting WITHOUT albedo; albedo is sampled per pixel
    let lr: number;
    let lg: number;
    let lb: number;
    if (shot.mode === 'studio') {
      const key = Math.max(0, n.dot(keyDir)) * 1.0;
      const fill = Math.max(0, n.dot(fillDir)) * 0.3;
      const rim = Math.pow(Math.max(0, n.dot(rimDir)), 2) * 0.6;
      const amb = 0.34;
      lr = amb + key + fill * 0.8 + rim * 0.9;
      lg = amb + key + fill * 0.9 + rim * 0.95;
      lb = amb + key + fill * 1.1 + rim;
    } else {
      const amb = 0.085;
      const moon = Math.max(0, n.dot(moonDir)) * 0.4;
      // viewer torch: distance + cone falloff, like a chest flashlight
      const toC = new THREE.Vector3().subVectors(centroid, camPos);
      const d = toC.length();
      toC.normalize();
      const cone = Math.pow(Math.max(0, toC.dot(camDir)), 14);
      const torch = (Math.max(0, n.dot(toCam)) * cone * 30) / (d * d + 6);
      lr = amb + moon * moonCol.r + torch * torchCol.r;
      lg = amb + moon * moonCol.g + torch * torchCol.g;
      lb = amb + moon * moonCol.b + torch * torchCol.b;
    }
    const fogF = shot.mode === 'night'
      ? 1 - Math.exp(-Math.pow(centroid.distanceTo(camPos) * 0.05, 2))
      : 0;

    // rasterize
    const minX = Math.max(0, Math.floor(Math.min(sa.x, sb.x, sc.x)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(sa.x, sb.x, sc.x)));
    const minY = Math.max(0, Math.floor(Math.min(sa.y, sb.y, sc.y)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(sa.y, sb.y, sc.y)));
    const area = (sb.x - sa.x) * (sc.y - sa.y) - (sb.y - sa.y) * (sc.x - sa.x);
    if (Math.abs(area) < 1e-6) continue;
    const texel = new THREE.Color(1, 1, 1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((sb.x - sa.x) * (y + 0.5 - sa.y) - (sb.y - sa.y) * (x + 0.5 - sa.x)) / area;
        const w1 = ((sc.x - sb.x) * (y + 0.5 - sb.y) - (sc.y - sb.y) * (x + 0.5 - sb.x)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = sa.z * w1 + sb.z * w2 + sc.z * w0;
        const idx = y * W + x;
        if (z >= zbuf[idx]) continue;
        zbuf[idx] = z;

        let ar = t.color.r;
        let ag = t.color.g;
        let ab = t.color.b;
        if (t.tex) {
          // vertex weights: a:w1, b:w2, c:w0 (matches the z interpolation)
          const u = t.uva.x * w1 + t.uvb.x * w2 + t.uvc.x * w0;
          const v = t.uva.y * w1 + t.uvb.y * w2 + t.uvc.y * w0;
          sampleTex(t.tex, u, v, texel);
          ar *= texel.r;
          ag *= texel.g;
          ab *= texel.b;
        }
        let r = ar * lr + t.emissive.r * t.ei;
        let g = ag * lg + t.emissive.g * t.ei;
        let b = ab * lb + t.emissive.b * t.ei;
        if (shot.mode === 'night') {
          r = aces((r * (1 - fogF) + fogColor.r * fogF) * 1.4);
          g = aces((g * (1 - fogF) + fogColor.g * fogF) * 1.4);
          b = aces((b * (1 - fogF) + fogColor.b * fogF) * 1.4);
        }
        const i = idx * 4;
        px[i] = Math.min(255, Math.pow(Math.max(0, r), 1 / 2.2) * 255);
        px[i + 1] = Math.min(255, Math.pow(Math.max(0, g), 1 / 2.2) * 255);
        px[i + 2] = Math.min(255, Math.pow(Math.max(0, b), 1 / 2.2) * 255);
        px[i + 3] = 255;
      }
    }
  }
  // splat additive sprites with depth test against the z-buffer
  const fovScale = (H / 2) / Math.tan(((shot.fov ?? 38) * Math.PI) / 360);
  for (const s of collectSprites(root)) {
    const p = new THREE.Vector4(s.pos.x, s.pos.y, s.pos.z, 1).applyMatrix4(view).applyMatrix4(proj);
    if (p.w <= 0) continue;
    const sx = ((p.x / p.w) * 0.5 + 0.5) * W;
    const sy = (1 - ((p.y / p.w) * 0.5 + 0.5)) * H;
    const r = ((s.scale * 0.5) * fovScale) / p.w;
    if (r < 0.5 || r > W) continue;
    const minX = Math.max(0, Math.floor(sx - r));
    const maxX = Math.min(W - 1, Math.ceil(sx + r));
    const minY = Math.max(0, Math.floor(sy - r));
    const maxY = Math.min(H - 1, Math.ceil(sy + r));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const idx = y * W + x;
        if (p.w > zbuf[idx]) continue; // occluded by geometry
        const d = Math.hypot(x - sx, y - sy) / r;
        if (d >= 1) continue;
        const fall = Math.pow(1 - d, 1.6) * s.opacity;
        const i = idx * 4;
        px[i] = Math.min(255, px[i] + s.color.r * fall * 255);
        px[i + 1] = Math.min(255, px[i + 1] + s.color.g * fall * 255);
        px[i + 2] = Math.min(255, px[i + 2] + s.color.b * fall * 255);
      }
    }
  }

  writePng(shot.out, px);
}

// ---- scenes ----------------------------------------------------------------------

mkdirSync('/tmp/preview', { recursive: true });

{
  const rig = buildSoldier(0, false);
  rig.group.rotation.y = 0.55;
  render(rig.group, {
    out: '/tmp/preview/soldier.png',
    camPos: [1.6, 1.55, 3.4], lookAt: [0, 1.02, 0], mode: 'studio',
  });
}
{
  const scav = buildBug(0, false);
  scav.group.rotation.y = 0.8;
  render(scav.group, {
    out: '/tmp/preview/scavenger.png',
    camPos: [1.3, 0.95, 1.9], lookAt: [0, 0.35, 0], mode: 'studio',
  });
}
{
  const war = buildBug(1, false);
  war.group.rotation.y = 0.8;
  render(war.group, {
    out: '/tmp/preview/warrior.png',
    camPos: [2.0, 1.4, 2.9], lookAt: [0, 0.55, 0], mode: 'studio',
  });
}
for (const [kind, name, cam] of [
  [2, 'spitter', [1.5, 1.0, 2.1]],
  [3, 'charger', [2.2, 1.4, 3.1]],
  [4, 'titan', [7.5, 5.2, 10.5]],
] as [number, string, [number, number, number]][]) {
  const b = buildBug(kind, false);
  b.group.rotation.y = 0.7;
  const r = (kind === 4 ? 3.4 : kind === 3 ? 1.15 : 0.72) / 0.55;
  render(b.group, {
    out: `/tmp/preview/${name}.png`,
    camPos: cam, lookAt: [0, 0.4 * r, 0], mode: 'studio',
  });
}
{
  // night beauty shot: soldier + bugs on a ground plane, torch + fog + ACES
  const scene = new THREE.Group();
  // subdivided so triangles behind the camera can be dropped per-cell
  // (this simple rasterizer skips any triangle with a vertex behind the eye)
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40, 16, 16).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x2e3338 }),
  );
  scene.add(ground);
  const rig = buildSoldier(0, false);
  rig.group.position.set(-0.5, 0, 0);
  rig.group.rotation.y = 2.6;
  scene.add(rig.group);
  const s1 = buildBug(0, false);
  s1.group.position.set(1.5, 0, -2.4);
  s1.group.rotation.y = -2.6;
  scene.add(s1.group);
  const s2 = buildBug(0, false);
  s2.group.position.set(2.6, 0, -4.2);
  s2.group.rotation.y = -2.2;
  scene.add(s2.group);
  const w1 = buildBug(1, false);
  w1.group.position.set(-1.6, 0, -5.5);
  w1.group.rotation.y = -2.9;
  scene.add(w1.group);
  render(scene, {
    out: '/tmp/preview/night.png',
    camPos: [0.4, 1.7, 3.4], lookAt: [0.3, 0.9, -3], fov: 50, mode: 'night',
  });
}
