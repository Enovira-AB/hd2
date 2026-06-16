// Procedural sound: no audio assets, everything synthesized in WebAudio.
// iOS Safari requires creation inside a user gesture — call ensure() from
// the first touch/click/keydown.

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastFire = 0;
  private lastScreech = 0;

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 8;
    comp.connect(this.ctx.destination);
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(comp);

    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.startWind();
    this.startMusic();
  }

  private env(gain: GainNode, t0: number, peak: number, decay: number) {
    gain.gain.setValueAtTime(peak, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + decay);
  }

  private playNoise(filterType: BiquadFilterType, freq0: number, freq1: number, peak: number, dur: number, when = 0) {
    if (!this.ctx || !this.master || !this.noise) return;
    const t0 = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(freq0, t0);
    if (freq1 !== freq0) filter.frequency.exponentialRampToValueAtTime(freq1, t0 + dur);
    const gain = this.ctx.createGain();
    this.env(gain, t0, peak, dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t0, Math.random());
    src.stop(t0 + dur + 0.05);
  }

  private playOsc(type: OscillatorType, f0: number, f1: number, peak: number, dur: number, when = 0) {
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const gain = this.ctx.createGain();
    this.env(gain, t0, peak, dur);
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  fire(volume = 1) {
    if (!this.ctx) return;
    const now = performance.now();
    if (now - this.lastFire < 35) return;
    this.lastFire = now;
    this.playNoise('lowpass', 3200, 700, 0.5 * volume, 0.09);
    this.playOsc('square', 150, 55, 0.22 * volume, 0.05);
  }

  impact(volume = 1) {
    this.playNoise('lowpass', 1300, 500, 0.16 * volume, 0.06);
  }

  explosion(volume = 1) {
    this.playNoise('lowpass', 900, 110, 1.15 * volume, 1.25);
    this.playOsc('sine', 52, 26, 0.9 * volume, 0.9);
    this.playNoise('highpass', 2500, 2500, 0.2 * volume, 0.3);
  }

  reload() {
    this.playOsc('square', 1900, 1900, 0.1, 0.015);
    this.playOsc('square', 1300, 1300, 0.12, 0.02, 0.5);
    this.playOsc('square', 2200, 2200, 0.12, 0.02, 1.6);
  }

  screech(volume = 1) {
    if (!this.ctx) return;
    const now = performance.now();
    if (now - this.lastScreech < 160) return;
    this.lastScreech = now;
    this.playOsc('sawtooth', 1100 + Math.random() * 400, 240, 0.16 * volume, 0.3);
    this.playNoise('bandpass', 1800, 600, 0.1 * volume, 0.25);
  }

  hurt() {
    this.playNoise('lowpass', 700, 200, 0.4, 0.18);
    this.playOsc('sine', 95, 60, 0.3, 0.18);
  }

  // wet gib burst when a bug pops
  squelch(volume = 1) {
    this.playNoise('lowpass', 900, 180, 0.32 * volume, 0.14);
    this.playNoise('bandpass', 1500, 400, 0.13 * volume, 0.1);
  }

  beep(ok = false) {
    this.playOsc('square', ok ? 1318 : 980, ok ? 1318 : 980, 0.12, 0.07);
  }

  error() {
    this.playOsc('square', 220, 180, 0.15, 0.18);
  }

  pod() {
    this.playNoise('bandpass', 500, 90, 0.5, 0.9);
  }

  thunder() {
    if (!this.ctx) return;
    // deep rolling rumble: low filtered noise + a sub drop
    this.playNoise('lowpass', 320, 60, 1.0, 2.2);
    this.playNoise('lowpass', 140, 45, 0.7, 1.6);
    this.playOsc('sine', 60, 28, 0.5, 1.4);
  }

  // Ominous low pad whose volume tracks nearby threat (0..1). Cheap, persistent.
  private tensionGain: GainNode | null = null;
  setTension(level: number) {
    if (!this.ctx || !this.tensionGain) return;
    const v = Math.max(0, Math.min(1, level));
    this.tensionGain.gain.setTargetAtTime(v * 0.06, this.ctx.currentTime, 0.4);
  }

  // Driving combat pulse (kick + brooding bass riff), gain tracks threat.
  private musicGain: GainNode | null = null;
  private musicTimer: ReturnType<typeof setInterval> | undefined;
  private beat = 0;
  setMusic(level: number) {
    if (!this.ctx || !this.musicGain) return;
    this.musicGain.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.2, this.ctx.currentTime, 0.6);
  }

  private startMusic() {
    if (!this.ctx || !this.master) return;
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0;
    this.musicGain.connect(this.master);
    const bassNotes = [55, 55, 65.41, 49]; // A1 A1 C2 G1 — minor, brooding
    this.musicTimer = setInterval(() => {
      if (!this.ctx || !this.musicGain) return;
      const t = this.ctx.currentTime + 0.02;
      const kick = this.ctx.createOscillator();
      const kg = this.ctx.createGain();
      kick.frequency.setValueAtTime(125, t);
      kick.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      kg.gain.setValueAtTime(0.9, t);
      kg.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      kick.connect(kg).connect(this.musicGain);
      kick.start(t);
      kick.stop(t + 0.2);
      if (this.beat % 2 === 0) {
        const bass = this.ctx.createOscillator();
        bass.type = 'sawtooth';
        bass.frequency.value = bassNotes[(this.beat / 2) % bassNotes.length];
        const bf = this.ctx.createBiquadFilter();
        bf.type = 'lowpass';
        bf.frequency.value = 280;
        const bg = this.ctx.createGain();
        bg.gain.setValueAtTime(0.5, t);
        bg.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
        bass.connect(bf).connect(bg).connect(this.musicGain);
        bass.start(t);
        bass.stop(t + 0.5);
      }
      this.beat++;
    }, 500);
  }

  private startWind() {
    if (!this.ctx || !this.master || !this.noise) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 220;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.05;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.025;
    lfo.connect(lfoGain).connect(gain.gain);
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    lfo.start();

    // tension drone: two detuned low oscillators through a lowpass, gain 0 idle
    this.tensionGain = this.ctx.createGain();
    this.tensionGain.gain.value = 0;
    const tFilter = this.ctx.createBiquadFilter();
    tFilter.type = 'lowpass';
    tFilter.frequency.value = 180;
    for (const f of [55, 55.4]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(tFilter);
      o.start();
    }
    tFilter.connect(this.tensionGain).connect(this.master);
  }
}
