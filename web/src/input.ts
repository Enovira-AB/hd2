// Unified input: keyboard/mouse with pointer lock on desktop, dual virtual
// sticks + buttons on touch. Stratagem arrows are queued and consumed by Game.

export const IS_TOUCH = matchMedia('(pointer: coarse)').matches;

export class Input {
  moveX = 0; // -1..1 strafe
  moveY = 0; // -1..1 forward
  lookDX = 0;
  lookDY = 0;
  fireHeld = false;
  sprint = false;
  stratOpen = false;

  private keys = new Set<string>();
  private arrowQueue: string[] = [];
  private reloadEdge = false;
  private interactEdge = false;
  private canvas: HTMLCanvasElement;
  private stickId = -1;
  private lookId = -1;
  private stickOrigin = { x: 0, y: 0 };
  enabled = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.bindKeyboard();
    this.bindMouse();
    if (IS_TOUCH) this.bindTouch();
  }

  consumeArrows(): string[] {
    const a = this.arrowQueue;
    this.arrowQueue = [];
    return a;
  }
  consumeReload(): boolean {
    const r = this.reloadEdge;
    this.reloadEdge = false;
    return r;
  }
  consumeInteract(): boolean {
    const r = this.interactEdge;
    this.interactEdge = false;
    return r;
  }
  consumeLook(): { dx: number; dy: number } {
    const r = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0;
    this.lookDY = 0;
    return r;
  }

  // ---- keyboard / mouse ----------------------------------------------------

  private bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.repeat) return;
      const k = e.code;
      this.keys.add(k);

      if (this.stratOpen) {
        const map: Record<string, string> = {
          KeyW: 'U', ArrowUp: 'U',
          KeyS: 'D', ArrowDown: 'D',
          KeyA: 'L', ArrowLeft: 'L',
          KeyD: 'R', ArrowRight: 'R',
        };
        if (map[k]) {
          this.arrowQueue.push(map[k]);
          e.preventDefault();
          return;
        }
      }
      if (k === 'KeyT') this.stratOpen = !this.stratOpen;
      if (k === 'Escape') this.stratOpen = false;
      if (k === 'KeyR') this.reloadEdge = true;
      if (k === 'KeyE' || k === 'KeyF') this.interactEdge = true;
      this.refreshMove();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.refreshMove();
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.refreshMove();
      this.fireHeld = false;
    });
  }

  private refreshMove() {
    if (IS_TOUCH) return;
    if (this.stratOpen) {
      this.moveX = 0;
      this.moveY = 0;
      return;
    }
    this.moveX = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    this.moveY = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    this.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  private bindMouse() {
    if (IS_TOUCH) return;
    this.canvas.addEventListener('click', () => {
      if (this.enabled && document.pointerLockElement !== this.canvas) {
        this.canvas.requestPointerLock();
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.canvas) {
        this.lookDX += e.movementX;
        this.lookDY += e.movementY;
      }
    });
    window.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement === this.canvas && e.button === 0) this.fireHeld = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
    });
  }

  get pointerLocked(): boolean {
    return IS_TOUCH || document.pointerLockElement === this.canvas;
  }

  // ---- touch ----------------------------------------------------------------

  private bindTouch() {
    const stickZone = document.getElementById('stick-zone')!;
    const lookZone = document.getElementById('look-zone')!;
    const base = document.getElementById('stick-base')!;
    const nub = document.getElementById('stick-nub')!;

    const setNub = (dx: number, dy: number) => {
      nub.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    };

    stickZone.addEventListener('touchstart', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.stickId !== -1) continue;
        this.stickId = t.identifier;
        this.stickOrigin = { x: t.clientX, y: t.clientY };
        base.style.left = `${t.clientX - 55}px`;
        base.style.top = `${t.clientY - 55}px`;
        base.style.bottom = 'auto';
      }
      e.preventDefault();
    }, { passive: false });

    lookZone.addEventListener('touchstart', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.lookId !== -1) continue;
        this.lookId = t.identifier;
        (lookZone as HTMLElement & { _lx?: number; _ly?: number })._lx = t.clientX;
        (lookZone as HTMLElement & { _lx?: number; _ly?: number })._ly = t.clientY;
      }
      e.preventDefault();
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stickId) {
          const dx = t.clientX - this.stickOrigin.x;
          const dy = t.clientY - this.stickOrigin.y;
          const len = Math.hypot(dx, dy);
          const max = 52;
          const cl = len > max ? max / len : 1;
          setNub(dx * cl, dy * cl);
          this.moveX = (dx * cl) / max;
          this.moveY = -(dy * cl) / max;
        } else if (t.identifier === this.lookId) {
          const zone = document.getElementById('look-zone') as HTMLElement & { _lx?: number; _ly?: number };
          this.lookDX += (t.clientX - (zone._lx ?? t.clientX)) * 2.4;
          this.lookDY += (t.clientY - (zone._ly ?? t.clientY)) * 2.4;
          zone._lx = t.clientX;
          zone._ly = t.clientY;
        }
      }
      e.preventDefault();
    }, { passive: false });

    const endTouch = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stickId) {
          this.stickId = -1;
          this.moveX = 0;
          this.moveY = 0;
          setNub(0, 0);
          base.style.left = '70px';
          base.style.top = 'auto';
          base.style.bottom = '90px';
        }
        if (t.identifier === this.lookId) this.lookId = -1;
      }
    };
    window.addEventListener('touchend', endTouch);
    window.addEventListener('touchcancel', endTouch);

    const hold = (id: string, down: () => void, up?: () => void) => {
      const el = document.getElementById(id)!;
      el.addEventListener('touchstart', (e) => { down(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
      if (up) {
        el.addEventListener('touchend', (e) => { up(); e.preventDefault(); }, { passive: false });
        el.addEventListener('touchcancel', () => up());
      }
    };
    hold('btn-fire', () => (this.fireHeld = true), () => (this.fireHeld = false));
    hold('btn-reload', () => (this.reloadEdge = true));
    hold('btn-sprint', () => (this.sprint = !this.sprint));
    hold('btn-interact', () => (this.interactEdge = true));
    hold('btn-strat', () => {
      this.stratOpen = !this.stratOpen;
      document.getElementById('strat-pad')!.classList.toggle('hidden', !this.stratOpen);
    });
    document.getElementById('strat-cancel')!.addEventListener('touchstart', (e) => {
      this.stratOpen = false;
      document.getElementById('strat-pad')!.classList.add('hidden');
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false });
    for (const btn of Array.from(document.querySelectorAll<HTMLElement>('.pad-btn[data-d]'))) {
      btn.addEventListener('touchstart', (e) => {
        this.arrowQueue.push(btn.dataset.d!);
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });
    }
  }

  closeStrat() {
    this.stratOpen = false;
    if (IS_TOUCH) document.getElementById('strat-pad')!.classList.add('hidden');
  }
}
