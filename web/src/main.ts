// Boot: menu wiring, connection, screen flow and the render loop.
// The menu floats over a live render of a demo planet, so the first thing
// you see is the game's atmosphere.

import { Net } from './net.js';
import { Input, IS_TOUCH } from './input.js';
import { World3D } from './world3d.js';
import { Effects } from './effects.js';
import { Sfx } from './sfx.js';
import { Hud } from './hud.js';
import { Game } from './game.js';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hud = new Hud();
const sfx = new Sfx();
const world = new World3D(canvas, IS_TOUCH);
const effects = new Effects(world.scene, IS_TOUCH);
const input = new Input(canvas);
const net = new Net();
const game = new Game(net, world, input, hud, sfx, effects);

let inGame = false;

// demo world behind the menu
world.buildWorld(1337);

// unlock audio on the first gesture (iOS requirement)
const unlock = () => sfx.ensure();
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

// ---- menu ------------------------------------------------------------------

const nameInput = document.getElementById('name-input') as HTMLInputElement;
const roomInput = document.getElementById('room-input') as HTMLInputElement;
nameInput.value = localStorage.getItem('callsign') ?? '';
roomInput.value = location.hash.replace('#', '').toUpperCase().slice(0, 4);

async function join(room?: string) {
  const name = nameInput.value.trim() || 'Helldiver';
  localStorage.setItem('callsign', name);
  hud.menuError('');
  try {
    await net.connect(name, room);
    location.hash = net.room;
    updateLobby();
    // if the squad is mid-mission, drop straight in
    if (net.mission && net.mission.phase !== 'LOBBY') {
      enterGame();
    } else {
      hud.showScreen('lobby');
    }
  } catch (e) {
    hud.menuError((e as Error).message.toUpperCase());
  }
}

document.getElementById('btn-create')!.addEventListener('click', () => void join());
document.getElementById('btn-join')!.addEventListener('click', () => {
  const code = roomInput.value.trim().toUpperCase();
  if (code.length !== 4) {
    hud.menuError('SQUAD CODES ARE 4 LETTERS');
    return;
  }
  void join(code);
});
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') (document.getElementById('btn-join') as HTMLButtonElement).click();
});
document.getElementById('btn-start')!.addEventListener('click', () => net.send({ type: 'start' }));

// ---- screen flow ----------------------------------------------------------------

function updateLobby() {
  hud.updateLobby(net.latestPlayers, net.selfId, net.hostId, net.room);
}

function enterGame() {
  inGame = true;
  hud.showScreen(null);
  hud.setTouchVisible(IS_TOUCH);
}

net.on('joined', updateLobby);
net.on('left', updateLobby);
const maybeEnter = () => {
  const p = net.mission?.phase;
  if (!inGame && p && p !== 'LOBBY' && p !== 'COMPLETE' && p !== 'FAILED') enterGame();
};
net.on('snapshot', maybeEnter);
net.on('phase', maybeEnter);
net.on('error', (m) => {
  if (m.type !== 'error') return;
  if (!net.connected) {
    hud.showScreen('menu');
    hud.menuError(m.reason.toUpperCase());
    inGame = false;
  }
});

game.onScreenChange = (screen) => {
  if (screen === null) {
    enterGame();
    return;
  }
  if (document.pointerLockElement) document.exitPointerLock();
  if (screen === 'lobby') {
    inGame = false;
    updateLobby();
    hud.showScreen('lobby');
    hud.setTouchVisible(false);
  }
  // 'summary' keeps rendering the world behind the overlay
};

input.enabled = true;

// ---- render loop -------------------------------------------------------------------

const menuCam = { angle: 0 };
let last = performance.now();

function frame(nowMs: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (nowMs - last) / 1000);
  last = nowMs;
  const time = nowMs / 1000;

  if (inGame && net.mission) {
    game.update(dt, time);
    world.update(dt, time, game.pos);
  } else {
    // slow cinematic orbit for menu / lobby backdrop
    menuCam.angle += dt * 0.045;
    const r = 26;
    const cx = Math.sin(menuCam.angle) * r;
    const cz = Math.cos(menuCam.angle) * r;
    world.camera.position.set(cx, world.terrainY(cx, cz) + 7, cz);
    world.camera.lookAt(0, 2, 0);
    world.update(dt, time, world.camera.position);
  }

  effects.update(dt, time);
  world.render();
}
requestAnimationFrame(frame);

// keep canvas crisp on rotation / resize
window.addEventListener('orientationchange', () => setTimeout(() => world.resize(), 250));

// avoid pull-to-refresh etc. on iOS
document.body.addEventListener('touchmove', (e) => {
  if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault();
}, { passive: false });
