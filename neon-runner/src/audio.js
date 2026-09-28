// AudioEngine — Web Audio synthesis only (no files). Owned by Agent 4 (Game & UI). See ARCHITECTURE.md §4.8.
//
// Graph:  synth voices ─► synthBus ─► musicFilter ─┐
//         drums ─────────► drumBus ────────────────┼─► musicGain ─┐
//         lead ─► delay (feedback) ─► synthBus      │              ├─► master ─► compressor ─► destination
//         sfx voices ─────────────────────────────► sfxGain ──────┘
import { CONFIG } from './config.js';
import { on, EVENTS } from './events.js';

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

// i–VI–III–VII in A minor (Am F C G), one bar each, 16 sixteenths per bar.
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const BASS_ROOT = [33, 29, 36, 31];
const BASS_PATTERN = [0, 12, 0, 12, 0, 12, 7, 12, 0, 12, 0, 12, 0, 12, 10, 12];
const LEAD_PATTERN = [0, 1, 2, 1, 2, 0, 1, 2, 0, 2, 1, 2, 1, 0, 2, 1];
const LOOKAHEAD = 0.12;      // s scheduled ahead
const TICK_MS = 25;

export class AudioEngine {
  constructor() {
    this.ready = false;
    this.muted = false;
    this.ctx = null;
    this.intensity = 0;
    this.notesScheduled = 0;       // debug / tests
    this._wantMusic = false;
    this._timer = 0;
    this._step = 0;
    this._nextTime = 0;
    this._mode = 'title';          // mirrors game state: title | playing | paused | over
    this._initPromise = null;
    this._unsubs = [];
    this._subscribe();
    this._onVisibility = () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend().catch(() => {});
      else this.ctx.resume().catch(() => {});
    };
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  get running() { return !!this.ctx && this.ctx.state === 'running'; }

  /** Create/resume AudioContext. MUST be called from a user gesture. Idempotent. @returns {Promise<void>} */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !document.hidden) return this.ctx.resume().catch(() => {});
      return this._initPromise || Promise.resolve();
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return Promise.resolve();
    try {
      this.ctx = new AC();
      this._build();
    } catch (err) {
      console.warn('[audio] Web Audio unavailable:', err);
      this.ctx = null;
      return Promise.resolve();
    }
    this.ready = true;
    this.setMuted(this.muted);
    this.setIntensity(this.intensity);
    const resumed = this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
    this._initPromise = Promise.resolve(resumed).catch(() => {}).then(() => {
      if (this._wantMusic) this._startScheduler();
    });
    return this._initPromise;
  }

  /** @param {'coin'|'jump'|'slide'|'lane'|'hit'|'powerup'|'shield'|'start'|'over'|'click'} name */
  play(name) {
    if (!this.ready || !this.ctx || this.muted) return;
    const fn = SFX[name];
    if (!fn) return;
    try { fn(this, this.ctx.currentTime + 0.005); } catch (err) { console.warn('[audio] sfx failed', name, err); }
  }

  startMusic() {
    this._wantMusic = true;
    if (this.ready && this.ctx) this._startScheduler();
  }

  stopMusic() {
    this._wantMusic = false;
    if (this._timer) { clearInterval(this._timer); this._timer = 0; }
  }

  /** Music tempo/filter intensity. @param {number} ratio 0..1 */
  setIntensity(ratio) {
    this.intensity = Math.min(1, Math.max(0, +ratio || 0));
    this._applyFilter();
  }

  /** @param {boolean} muted */
  setMuted(muted) {
    this.muted = !!muted;
    if (!this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.muted ? 0 : CONFIG.audio.master, t, 0.03);
  }

  dispose() {
    this.stopMusic();
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null; this.ready = false;
  }

  // ---------------------------------------------------------------------------
  // graph
  // ---------------------------------------------------------------------------

  _build() {
    const ctx = this.ctx, a = CONFIG.audio;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : a.master;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);

    this.musicGain = ctx.createGain(); this.musicGain.gain.value = a.music;
    this.musicGain.connect(this.master);
    this.sfxGain = ctx.createGain(); this.sfxGain.gain.value = a.sfx;
    this.sfxGain.connect(this.master);

    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass'; this.musicFilter.Q.value = 3; this.musicFilter.frequency.value = 900;
    this.musicFilter.connect(this.musicGain);
    this.synthBus = ctx.createGain(); this.synthBus.gain.value = 1;
    this.synthBus.connect(this.musicFilter);
    this.drumBus = ctx.createGain(); this.drumBus.gain.value = 0.9;
    this.drumBus.connect(this.musicGain);

    // Dotted-eighth echo for the lead.
    const beat = 60 / a.bpm;
    this.delay = ctx.createDelay(1.5); this.delay.delayTime.value = beat * 0.75;
    const fb = ctx.createGain(); fb.gain.value = 0.35;
    const wet = ctx.createGain(); wet.gain.value = 0.45;
    this.delay.connect(fb).connect(this.delay);
    this.delay.connect(wet).connect(this.synthBus);
    this.leadBus = ctx.createGain(); this.leadBus.gain.value = 1;
    this.leadBus.connect(this.synthBus); this.leadBus.connect(this.delay);

    // 1 s of white noise, shared by all noise voices.
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  _applyFilter() {
    if (!this.musicFilter) return;
    const r = this.intensity;
    const base = this._mode === 'over' ? 500 : this._mode === 'title' ? 1100 : 1400;
    const f = this._mode === 'over' ? base : base + 5200 * r * r + 900 * r;
    this.musicFilter.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.4);
  }

  _setMode(mode) {
    this._mode = mode;
    if (!this.musicGain) return;
    const t = this.ctx.currentTime, vol = CONFIG.audio.music;
    this.musicGain.gain.setTargetAtTime(mode === 'paused' ? vol * 0.3 : mode === 'over' ? vol * 0.7 : vol, t, 0.15);
    this._applyFilter();
  }

  // ---------------------------------------------------------------------------
  // music scheduler
  // ---------------------------------------------------------------------------

  _startScheduler() {
    if (this._timer || !this.ctx) return;
    this._nextTime = this.ctx.currentTime + 0.08;
    this._step = 0;
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._tick();
  }

  _tick() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const sixteenth = 60 / CONFIG.audio.bpm / 4;
    // After throttling (background tab) resync instead of bursting a backlog of notes.
    if (this._nextTime < ctx.currentTime - 0.05) this._nextTime = ctx.currentTime + 0.05;
    while (this._nextTime < ctx.currentTime + LOOKAHEAD) {
      this._scheduleStep(this._step, this._nextTime, sixteenth);
      this._nextTime += sixteenth;
      this._step = (this._step + 1) % 64;
    }
  }

  _scheduleStep(step, t, dur) {
    const bar = (step >> 4) & 3, s = step & 15;
    const mode = this._mode, r = this.intensity;
    const playing = mode === 'playing' || mode === 'paused';
    const full = playing || mode === 'title';

    // Pad: one chord per bar.
    if (s === 0) this._pad(CHORDS[bar], t, dur * 16);
    // Bass: octave arpeggio on sixteenths (eighths on the title / results screen).
    if (mode !== 'over' || s % 4 === 0) {
      if (playing || s % 2 === 0) this._bass(BASS_ROOT[bar] + BASS_PATTERN[s], t, dur * (playing ? 0.9 : 1.8));
    }
    if (!full) return;
    // Drums.
    if (s % 4 === 0) this._kick(t);
    if (s === 4 || s === 12) this._snare(t);
    const hats = playing ? (r > 0.55 ? 16 : r > 0.2 ? 8 : 4) : 4;
    if (hats === 16 || (hats === 8 && s % 2 === 0) || (hats === 4 && s % 4 === 2)) {
      this._hat(t, s % 4 === 2 && r > 0.55 ? 0.16 : 0.035, s % 4 === 0 ? 0.12 : 0.2);
    }
    // Lead arpeggio once the run heats up.
    if (playing && r > 0.3 && s % 2 === 0) {
      const chord = CHORDS[bar];
      this._lead(chord[LEAD_PATTERN[s]] + 12 + (s >= 8 && r > 0.7 ? 12 : 0), t, dur * 1.6);
    }
  }

  // ---- music voices ----
  _env(g, t, peak, attack, hold, release) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    return t + attack + hold + release + 0.02;
  }

  _bass(note, t, len) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(note);
    const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = midi(note); o2.detune.value = -7;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 6;
    f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(260, t + len);
    const g = ctx.createGain();
    const end = this._env(g, t, 0.26, 0.005, len * 0.3, len * 0.7);
    o.connect(f); o2.connect(f); f.connect(g).connect(this.synthBus);
    o.start(t); o2.start(t); o.stop(end); o2.stop(end);
    this.notesScheduled++;
  }

  _pad(chord, t, len) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const end = this._env(g, t, 0.05, len * 0.3, len * 0.45, len * 0.4);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1600; f.Q.value = 0.7;
    f.connect(g).connect(this.synthBus);
    for (const n of chord) {
      for (const det of [-9, 9]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(n); o.detune.value = det;
        o.connect(f); o.start(t); o.stop(end);
      }
    }
    this.notesScheduled++;
  }

  _lead(note, t, len) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = midi(note);
    const g = ctx.createGain();
    const end = this._env(g, t, 0.045, 0.004, len * 0.2, len * 0.8);
    o.connect(g).connect(this.leadBus); o.start(t); o.stop(end);
    this.notesScheduled++;
  }

  _kick(t) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(155, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.95, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    o.connect(g).connect(this.drumBus); o.start(t); o.stop(t + 0.34);
    this.notesScheduled++;
  }

  _noise(t, len, filterType, freq, peak, dest, q = 0.8) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5); src.stop(t + len + 0.02);
    return { src, f, g };
  }

  _snare(t) {
    this._noise(t, 0.2, 'bandpass', 1900, 0.5, this.drumBus, 0.6);
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g).connect(this.drumBus); o.start(t); o.stop(t + 0.12);
    this.notesScheduled++;
  }

  _hat(t, len, peak) {
    this._noise(t, len, 'highpass', 7500, peak, this.drumBus);
    this.notesScheduled++;
  }

  // ---------------------------------------------------------------------------
  // bus → SFX
  // ---------------------------------------------------------------------------

  _subscribe() {
    const inRun = () => this._mode === 'playing';
    const u = this._unsubs;
    u.push(on(EVENTS.GAME_STATE, ({ to }) => this._setMode(to)));
    u.push(on(EVENTS.GAME_TITLE, () => this._setMode('title')));
    u.push(on(EVENTS.SPEED_CHANGED, ({ ratio }) => this.setIntensity(ratio)));
    u.push(on(EVENTS.GAME_START, () => this.play('start')));
    u.push(on(EVENTS.GAME_OVER, () => this.play('over')));
    u.push(on(EVENTS.COIN_COLLECTED, () => { if (inRun()) this.play('coin'); }));
    u.push(on(EVENTS.PLAYER_JUMP, () => { if (inRun()) this.play('jump'); }));
    u.push(on(EVENTS.PLAYER_SLIDE, () => { if (inRun()) this.play('slide'); }));
    u.push(on(EVENTS.PLAYER_LANE, () => { if (inRun()) this.play('lane'); }));
    u.push(on(EVENTS.PLAYER_HIT, ({ shielded }) => { if (inRun()) this.play(shielded ? 'shield' : 'hit'); }));
    u.push(on(EVENTS.POWERUP_COLLECTED, () => { if (inRun()) this.play('powerup'); }));
    for (const e of [EVENTS.UI_START, EVENTS.UI_RESTART, EVENTS.UI_PAUSE, EVENTS.UI_MUTE, EVENTS.UI_HOME]) {
      u.push(on(e, () => this.play('click')));
    }
  }
}

// ---------------------------------------------------------------------------
// SFX recipes: (engine, startTime) => void
// ---------------------------------------------------------------------------

function tone(e, t, { type = 'square', f0, f1 = f0, len, peak = 0.3, attack = 0.004, curve = 'exp', dest = e.sfxGain, detune = 0 }) {
  const ctx = e.ctx;
  const o = ctx.createOscillator(); o.type = type; o.detune.value = detune;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) {
    if (curve === 'exp') o.frequency.exponentialRampToValueAtTime(f1, t + len);
    else o.frequency.linearRampToValueAtTime(f1, t + len);
  }
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(dest); o.start(t); o.stop(t + len + 0.02);
  return o;
}

const SFX = {
  coin(e, t) {
    tone(e, t, { type: 'square', f0: midi(83), len: 0.07, peak: 0.16 });
    tone(e, t + 0.06, { type: 'square', f0: midi(88), len: 0.16, peak: 0.16 });
  },
  jump(e, t) {
    tone(e, t, { type: 'square', f0: 260, f1: 720, len: 0.16, peak: 0.14 });
    tone(e, t, { type: 'sine', f0: 520, f1: 1440, len: 0.14, peak: 0.1 });
  },
  slide(e, t) {
    const n = e._noise(t, 0.26, 'bandpass', 2600, 0.35, e.sfxGain, 2);
    n.f.frequency.setValueAtTime(2600, t); n.f.frequency.exponentialRampToValueAtTime(350, t + 0.24);
  },
  lane(e, t) {
    tone(e, t, { type: 'triangle', f0: 540, f1: 860, len: 0.07, peak: 0.16 });
  },
  hit(e, t) {
    e._noise(t, 0.5, 'lowpass', 1400, 0.9, e.sfxGain, 0.5);
    tone(e, t, { type: 'sawtooth', f0: 170, f1: 38, len: 0.55, peak: 0.45 });
    tone(e, t, { type: 'square', f0: 90, f1: 30, len: 0.4, peak: 0.3 });
  },
  powerup(e, t) {
    [72, 76, 79, 84, 88].forEach((n, i) => tone(e, t + i * 0.055, { type: 'square', f0: midi(n), len: 0.12, peak: 0.12 }));
    tone(e, t, { type: 'sawtooth', f0: 300, f1: 1200, len: 0.3, peak: 0.06 });
  },
  shield(e, t) {
    tone(e, t, { type: 'sine', f0: 1600, f1: 280, len: 0.35, peak: 0.3 });
    tone(e, t, { type: 'triangle', f0: 2400, f1: 900, len: 0.25, peak: 0.15, detune: 25 });
    e._noise(t, 0.3, 'highpass', 4000, 0.3, e.sfxGain);
  },
  start(e, t) {
    tone(e, t, { type: 'sawtooth', f0: 110, f1: 880, len: 0.45, peak: 0.16 });
    [69, 72, 76, 81].forEach((n, i) => tone(e, t + 0.05 + i * 0.07, { type: 'square', f0: midi(n), len: 0.2, peak: 0.1 }));
  },
  over(e, t) {
    [76, 72, 69, 64].forEach((n, i) => tone(e, t + i * 0.16, { type: 'sawtooth', f0: midi(n), f1: midi(n - 1), len: 0.3, peak: 0.14 }));
    tone(e, t, { type: 'sine', f0: 220, f1: 55, len: 1.0, peak: 0.25 });
  },
  click(e, t) {
    tone(e, t, { type: 'sine', f0: 1200, f1: 900, len: 0.05, peak: 0.18 });
  },
};
