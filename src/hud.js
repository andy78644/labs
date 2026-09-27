// HUD — DOM overlay inside #ui. Owned by Agent 4 (Game & UI). See ARCHITECTURE.md §4.7.
// Overlays are pointer-events:none (taps fall through to the canvas → input:confirm);
// only buttons are interactive, and they emit ui:* events on the bus.
import { CONFIG, hex } from './config.js';
import { on, emit, EVENTS } from './events.js';

const ICONS = {
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>',
  sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="stroke" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>',
  muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="stroke" d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>',
  magnet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="stroke" d="M6 4v8a6 6 0 0 0 12 0V4"/><path d="M4 3h4v4H4zM16 3h4v4h-4z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5z"/></svg>',
  double: '<svg viewBox="0 0 24 24" aria-hidden="true"><text x="12" y="17" text-anchor="middle" font-size="13" font-weight="900" font-family="inherit">×2</text></svg>',
  coin: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><circle class="coin-mark" cx="12" cy="12" r="5.5"/><path class="coin-shine" d="M8.2 9.3a4.6 4.6 0 0 1 3-2.6"/></svg>',
};
const POWERUP_LABEL = { magnet: 'MAGNET', shield: 'SHIELD', double: 'DOUBLE' };

const fmt = (n) => Math.floor(n).toLocaleString('en-US');

export class Hud {
  /** @param {HTMLElement} root the #ui element */
  constructor(root) {
    this.root = root;
    this.muted = false;
    this.highScore = 0;
    this._last = { score: -1, coins: -1, dist: -1, mult: -1, best: false };
    this._bars = {};
    this._pu = {};
    this._toastTimer = 0;
    this._build();
    this._unsubs = [
      on(EVENTS.COIN_COLLECTED, () => this._pulse(this.el.coinBox)),
      on(EVENTS.POWERUP_START, ({ type }) => this.toast(`${POWERUP_LABEL[type] || type}!`, CONFIG.powerups.color[type])),
      on(EVENTS.SHIELD_BREAK, () => this.toast('SHIELD BROKEN', CONFIG.colors.cyan)),
    ];
  }

  _build() {
    const r = this.root;
    const pc = CONFIG.powerups.color;
    r.innerHTML = `
<div class="grain"></div>
<section class="screen screen-title" data-screen="title" hidden>
  <div class="title-top">
    <h1 class="logo" aria-label="Neon Runner">
      <span class="logo-neon" data-text="NEON">NEON</span>
      <span class="logo-runner" data-text="RUNNER">RUNNER</span>
    </h1>
    <p class="tagline">outrun the grid</p>
  </div>
  <div class="title-bottom">
    <button class="btn btn-primary" data-ui="start" type="button">${ICONS.play}<span>PLAY</span></button>
    <p class="best-line">BEST <b data-f="titleBest">0</b></p>
    <div class="controls">
      <div class="ctl-row ctl-keys">
        <span class="ctl-label">Keys</span>
        <span class="chip"><kbd>←</kbd><kbd>→</kbd><em>A D</em>lane</span>
        <span class="chip"><kbd>↑</kbd><em>W Space</em>jump</span>
        <span class="chip"><kbd>↓</kbd><em>S</em>slide</span>
        <span class="chip"><kbd>P</kbd>pause</span>
        <span class="chip"><kbd>M</kbd>mute</span>
      </div>
      <div class="ctl-row ctl-touch">
        <span class="ctl-label">Touch</span>
        <span class="chip"><i class="sw sw-h"></i>swipe lane</span>
        <span class="chip"><i class="sw sw-up"></i>jump</span>
        <span class="chip"><i class="sw sw-down"></i>slide</span>
        <span class="chip"><i class="sw sw-tap"></i>tap start</span>
      </div>
    </div>
    <p class="legend">
      <span style="--c:${hex(CONFIG.obstacles.barrier.color)}">fence&nbsp;→&nbsp;jump</span>
      <span style="--c:${hex(CONFIG.obstacles.bar.color)}">beam&nbsp;→&nbsp;slide</span>
      <span style="--c:${hex(CONFIG.obstacles.wall.color)}">wall&nbsp;→&nbsp;dodge</span>
    </p>
  </div>
</section>

<section class="hud" data-screen="hud" hidden>
  <div class="hud-left">
    <div class="score-row">
      <div class="score" data-f="score">0</div>
      <div class="mult" data-f="mult" hidden>×2</div>
    </div>
    <div class="sub-row">
      <span class="dist"><b data-f="dist">0</b> m</span>
      <span class="newbest" data-f="newbest" hidden>NEW BEST</span>
    </div>
    <div class="powerups">
      ${['magnet', 'shield', 'double'].map((t) => `
      <div class="pu" data-pu="${t}" style="--c:${hex(pc[t])}" hidden>
        <span class="pu-icon">${ICONS[t]}</span>
        <span class="pu-body"><span class="pu-name">${POWERUP_LABEL[t]}</span><span class="pu-bar"><i data-bar="${t}"></i></span></span>
      </div>`).join('')}
    </div>
  </div>
  <div class="hud-right">
    <div class="coins" data-f="coinBox"><span class="coin-icon">${ICONS.coin}</span><b data-f="coins">0</b></div>
  </div>
</section>

<div class="corner">
  <button class="icon-btn" data-ui="pause" type="button" aria-label="Pause" hidden>${ICONS.pause}</button>
  <button class="icon-btn" data-ui="mute" type="button" aria-label="Mute">${ICONS.sound}</button>
</div>

<section class="screen screen-pause" data-screen="pause" hidden>
  <div class="panel">
    <h2 class="panel-title">PAUSED</h2>
    <button class="btn btn-primary" data-ui="resume" type="button">${ICONS.play}<span>RESUME</span></button>
    <button class="btn btn-ghost" data-ui="home" type="button"><span>MENU</span></button>
  </div>
</section>

<section class="screen screen-over" data-screen="over" hidden>
  <div class="panel panel-results">
    <h2 class="panel-title glitch" data-text="GAME OVER">GAME OVER</h2>
    <div class="record" data-f="record" hidden>NEW RECORD</div>
    <div class="result-score"><small>SCORE</small><b data-f="rScore">0</b></div>
    <div class="result-grid">
      <div><small>COINS</small><b data-f="rCoins">0</b></div>
      <div><small>DISTANCE</small><b data-f="rDist">0 m</b></div>
      <div><small>BEST</small><b data-f="rBest">0</b></div>
    </div>
    <button class="btn btn-primary" data-ui="restart" type="button">${ICONS.play}<span>RUN AGAIN</span></button>
    <button class="btn btn-ghost" data-ui="home" type="button"><span>MENU</span></button>
  </div>
</section>

<div class="toast" data-f="toast" aria-live="polite"></div>
`;
    const q = (sel) => r.querySelector(sel);
    this.el = {};
    for (const n of r.querySelectorAll('[data-f]')) this.el[n.dataset.f] = n;
    this.screens = {};
    for (const n of r.querySelectorAll('[data-screen]')) this.screens[n.dataset.screen] = n;
    this.btnPause = q('[data-ui="pause"]');
    this.btnMute = q('[data-ui="mute"]');
    for (const t of CONFIG.powerups.types) {
      this._pu[t] = q(`[data-pu="${t}"]`);
      this._bars[t] = q(`[data-bar="${t}"]`);
      this._pu[t]._shown = false; this._pu[t]._frac = -1;
    }

    const ACTIONS = {
      start: EVENTS.UI_START, restart: EVENTS.UI_RESTART, pause: EVENTS.UI_PAUSE,
      resume: EVENTS.UI_PAUSE, mute: EVENTS.UI_MUTE, home: EVENTS.UI_HOME,
    };
    for (const b of r.querySelectorAll('button[data-ui]')) {
      // Never keep focus on a button: input.js ignores keys while a button is focused.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        b.blur();
        emit(ACTIONS[b.dataset.ui], {});
      });
    }
  }

  _show(name, on) {
    const s = this.screens[name];
    if (s && s.hidden === on) s.hidden = !on;
  }

  /** @param {{ highScore: number, muted: boolean }} data */
  showTitle(data) {
    this.highScore = data.highScore || 0;
    this.el.titleBest.textContent = fmt(this.highScore);
    this.el.titleBest.parentElement.hidden = this.highScore <= 0;
    this.setMuted(!!data.muted);
    this._show('title', true); this._show('hud', false); this._show('pause', false); this._show('over', false);
    this.btnPause.hidden = true;
    this.root.dataset.state = 'title';
  }

  showPlaying() {
    this._show('title', false); this._show('hud', true); this._show('pause', false); this._show('over', false);
    this.btnPause.hidden = false;
    this.btnPause.innerHTML = ICONS.pause;
    this._last.best = false;
    this.el.newbest.hidden = true;
    for (const t of CONFIG.powerups.types) { this._pu[t].hidden = true; this._pu[t]._shown = false; }
    this.root.dataset.state = 'playing';
  }

  /** @param {{ score:number, coins:number, distance:number, speed:number, multiplier:number,
   *            powerups: Record<'magnet'|'shield'|'double', number> }} s  remaining seconds (0 = inactive) */
  update(s) {
    const L = this._last, el = this.el;
    const score = Math.floor(s.score);
    if (score !== L.score) { L.score = score; el.score.textContent = fmt(score); }
    if (s.coins !== L.coins) { L.coins = s.coins; el.coins.textContent = fmt(s.coins); }
    const dist = Math.floor(s.distance);
    if (dist !== L.dist) { L.dist = dist; el.dist.textContent = fmt(dist); }
    const mult = s.multiplier > 1 ? s.multiplier : 1;
    if (mult !== L.mult) {
      L.mult = mult; el.mult.hidden = mult <= 1; el.mult.textContent = `×${mult}`;
      el.score.classList.toggle('boosted', mult > 1);
    }
    const hs = s.highScore ?? this.highScore;
    if (!L.best && s.state === 'playing' && hs > 0 && score > hs) {
      L.best = true; el.newbest.hidden = false; this.toast('NEW BEST!', CONFIG.colors.yellow);
    }
    const pu = s.powerups;
    if (pu) {
      for (const t of CONFIG.powerups.types) {
        const left = pu[t] || 0, box = this._pu[t];
        const shown = left > 0;
        if (shown !== box._shown) { box._shown = shown; box.hidden = !shown; }
        if (!shown) continue;
        const frac = Math.round(Math.min(1, left / CONFIG.powerups.duration[t]) * 500) / 500;
        if (frac !== box._frac) {
          box._frac = frac;
          this._bars[t].style.transform = `scaleX(${frac})`;
          box.classList.toggle('ending', left < 2.5);
        }
      }
    }
  }

  /** @param {boolean} paused */
  showPause(paused) {
    this._show('pause', paused);
    this.btnPause.innerHTML = paused ? ICONS.play : ICONS.pause;
    this.btnPause.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    this.root.dataset.state = paused ? 'paused' : 'playing';
  }

  /** @param {{ score:number, coins:number, distance:number, highScore:number, isNewHigh:boolean }} r */
  showResults(r) {
    const el = this.el;
    this.highScore = r.highScore;
    el.rScore.textContent = fmt(r.score);
    el.rCoins.textContent = fmt(r.coins);
    el.rDist.textContent = `${fmt(r.distance)} m`;
    el.rBest.textContent = fmt(r.highScore);
    el.record.hidden = !r.isNewHigh;
    this.screens.over.classList.toggle('is-record', !!r.isNewHigh);
    this._show('pause', false); this._show('hud', false); this._show('over', true);
    this.btnPause.hidden = true;
    this.root.dataset.state = 'over';
  }

  /** @param {boolean} muted */
  setMuted(muted) {
    this.muted = !!muted;
    this.btnMute.innerHTML = this.muted ? ICONS.muted : ICONS.sound;
    this.btnMute.classList.toggle('is-off', this.muted);
    this.btnMute.setAttribute('aria-label', this.muted ? 'Unmute' : 'Mute');
  }

  /** Short centered callout ("SHIELD!", "NEW BEST!"). @param {string} text @param {number} [color] */
  toast(text, color = CONFIG.colors.cyan) {
    const t = this.el.toast;
    t.textContent = text;
    t.style.setProperty('--c', hex(color));
    t.classList.remove('show');
    void t.offsetWidth; // restart the animation
    t.classList.add('show');
  }

  _pulse(node) {
    node.classList.remove('pulse');
    void node.offsetWidth;
    node.classList.add('pulse');
  }

  dispose() {
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    this.root.innerHTML = '';
  }
}
