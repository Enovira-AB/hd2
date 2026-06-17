// DOM HUD: squad list, objective, ammo, stratagem uplink, banners, screens.

import type { MissionState, PlayerState } from '../../shared/protocol.js';
import { STRATAGEMS } from '../../shared/constants.js';

const ARROW: Record<string, string> = { U: '▲', D: '▼', L: '◀', R: '▶' };

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export class Hud {
  private bannerTimer = 0;

  constructor() {
    this.setStratList(Object.keys(STRATAGEMS));
  }

  // The in-game stratagem cheat-sheet lists only what you brought.
  setStratList(kinds: string[]) {
    el('strat-list').innerHTML = kinds
      .filter((k) => k in STRATAGEMS)
      .map((k) => {
        const s = STRATAGEMS[k as keyof typeof STRATAGEMS];
        return `<div>${s.label.toUpperCase()} <b>${[...s.code].map((c) => ARROW[c]).join(' ')}</b></div>`;
      })
      .join('');
  }

  setWeapon(name: string) {
    el('weapon-name').textContent = name;
  }

  // ---- screens ----------------------------------------------------------------

  showScreen(name: 'menu' | 'lobby' | 'summary' | null) {
    el('menu').classList.toggle('hidden', name !== 'menu');
    el('lobby').classList.toggle('hidden', name !== 'lobby');
    el('summary').classList.toggle('hidden', name !== 'summary');
    el('hud').classList.toggle('hidden', name !== null);
  }

  setTouchVisible(v: boolean) {
    el('touch').classList.toggle('hidden', !v);
  }

  menuError(text: string) {
    el('menu-error').textContent = text;
  }

  updateLobby(players: PlayerState[], selfId: string, hostId: string, code: string) {
    el('lobby-code').textContent = code;
    el('lobby-players').innerHTML = players
      .map((p) => `<li><span>${esc(p.name)}</span>${p.id === selfId ? '<span class="you">YOU</span>' : ''}</li>`)
      .join('');
    const isHost = selfId === hostId;
    el('btn-start').classList.toggle('hidden', !isHost);
    el('lobby-wait').classList.toggle('hidden', isHost);
  }

  showSummary(mission: MissionState, players: PlayerState[]) {
    const won = mission.phase === 'COMPLETE';
    el('summary-title').textContent = won ? 'MISSION COMPLETE' : 'MISSION FAILED';
    (el('summary-title') as HTMLElement).style.color = won ? 'var(--yellow)' : 'var(--red)';
    el('summary-sub').textContent = won
      ? 'DEMOCRACY HAS BEEN DELIVERED'
      : 'LIBERTY WEEPS — BUT SUPER EARTH REMEMBERS';
    el('summary-players').innerHTML = players
      .map((p) => `<li><span>${esc(p.name)}</span><span>${p.kills} KILLS</span></li>`)
      .join('');
    this.showScreen('summary');
  }

  // ---- in-game -----------------------------------------------------------------

  updateSquad(players: PlayerState[], selfId: string) {
    el('squad').innerHTML = players
      .map((p) => {
        const dead = (p.anim & 16) !== 0;
        return `<div class="squad-row${dead ? ' dead' : ''}">
          <div class="squad-name"><span>${esc(p.name)}${p.id === selfId ? ' ◂' : ''}</span><span class="k">${p.kills}</span></div>
          <div class="squad-hp"><div style="width:${dead ? 100 : p.hp}%"></div></div>
        </div>`;
      })
      .join('');
  }

  setObjective(title: string, sub: string) {
    el('objective-title').textContent = title;
    el('objective-sub').textContent = sub;
  }

  setAmmo(mag: number, reserve: number) {
    el('ammo-mag').textContent = String(mag);
    el('ammo-reserve').textContent = String(reserve);
    el('ammo').classList.toggle('low', mag <= 5);
  }

  setHp(hp: number) {
    el('hp-fill').style.width = `${Math.max(0, hp)}%`;
    (el('hp-fill') as HTMLElement).style.background = hp < 30 ? 'var(--red)' : 'var(--yellow)';
  }

  setStratDisplay(open: boolean, seq: string, bad: boolean) {
    el('strat-display').classList.toggle('hidden', !open);
    if (open) {
      el('strat-arrows').innerHTML = seq
        ? [...seq].map((c) => `<span class="ok">${ARROW[c]}</span>`).join(' ')
        : '<span style="opacity:0.3">ENTER CODE</span>';
      if (bad) el('strat-arrows').innerHTML = '<span style="color:var(--red)">✕ INVALID</span>';
    }
  }

  setBoss(boss: { hp: number; hpMax: number } | null) {
    el('boss-bar').classList.toggle('hidden', !boss);
    if (boss) {
      const frac = Math.max(0, Math.min(1, boss.hp / Math.max(1, boss.hpMax)));
      (el('boss-fill') as HTMLElement).style.width = `${frac * 100}%`;
    }
  }

  interactPrompt(text: string | null) {
    const p = el('interact-prompt');
    p.classList.toggle('hidden', !text);
    if (text) p.textContent = text;
    el('btn-interact').classList.toggle('hidden', !text);
  }

  banner(title: string, sub = '', ms = 2600) {
    el('banner-title').textContent = title;
    el('banner-sub').textContent = sub;
    el('center-banner').classList.remove('hidden');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => el('center-banner').classList.add('hidden'), ms);
  }

  hitmarker(kill = false) {
    const h = el('hitmarker');
    h.classList.toggle('kill', kill);
    h.classList.add('show');
    setTimeout(() => h.classList.remove('show'), kill ? 160 : 90);
  }

  damageFlash(strength = 0.8) {
    const v = el('damage-vignette') as HTMLElement;
    v.style.opacity = String(strength);
    setTimeout(() => (v.style.opacity = '0'), 130);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
