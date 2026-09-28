// Input — owned by Agent 2. Keyboard + pointer/touch gestures → semantic bus events. See ARCHITECTURE.md §4.3.
// Input NEVER calls the player directly: it only emits semantic input:* events.
import { CONFIG } from './config.js';
import { emit, EVENTS } from './events.js';

// KeyboardEvent.code → events (layout-independent for letters). Space emits jump AND confirm.
const CODE_MAP = {
  ArrowLeft: [EVENTS.INPUT_LEFT], KeyA: [EVENTS.INPUT_LEFT],
  ArrowRight: [EVENTS.INPUT_RIGHT], KeyD: [EVENTS.INPUT_RIGHT],
  ArrowUp: [EVENTS.INPUT_JUMP], KeyW: [EVENTS.INPUT_JUMP],
  ArrowDown: [EVENTS.INPUT_SLIDE], KeyS: [EVENTS.INPUT_SLIDE],
  Space: [EVENTS.INPUT_JUMP, EVENTS.INPUT_CONFIRM],
  Enter: [EVENTS.INPUT_CONFIRM], NumpadEnter: [EVENTS.INPUT_CONFIRM],
  KeyP: [EVENTS.INPUT_PAUSE], Escape: [EVENTS.INPUT_PAUSE],
  KeyM: [EVENTS.INPUT_MUTE],
};
// Fallback on KeyboardEvent.key (some virtual keyboards / synthetic events have no code).
const KEY_MAP = {
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  ' ': 'Space', Spacebar: 'Space', Enter: 'Enter', Escape: 'Escape', Esc: 'Escape',
  a: 'KeyA', d: 'KeyD', w: 'KeyW', s: 'KeyS', p: 'KeyP', m: 'KeyM',
};
const NO_SCROLL = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']);

function isTextField(el) {
  if (!el || !el.tagName) return false;
  const t = el.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable === true;
}

export class Input {
  /** @param {HTMLElement|Window} [target=window] element that receives touch gestures */
  constructor(target = window) {
    this.enabled = true;
    this.target = target;
    // gesture tracking (single primary pointer)
    this._pid = -1;
    this._sx = 0; this._sy = 0; this._st = 0; this._downT = 0;
    this._fired = false;
    this._maxDist = 0;

    this._onKey = (e) => this._handleKey(e);
    this._onDown = (e) => this._pointerDown(e);
    this._onMove = (e) => this._pointerMove(e);
    this._onUp = (e) => this._pointerUp(e);
    this._onCancel = (e) => { if (e.pointerId === this._pid) this._pid = -1; };
    this._onBlur = () => { this._pid = -1; };
    this._onTouchMove = (e) => { if (e.cancelable) e.preventDefault(); };

    window.addEventListener('keydown', this._onKey);
    target.addEventListener('pointerdown', this._onDown);
    // move/up on window so a swipe that leaves the element still completes
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onCancel);
    window.addEventListener('blur', this._onBlur);
    if (target !== window && target.style) {
      this._prevTouchAction = target.style.touchAction;
      target.style.touchAction = 'none'; // no browser pan/zoom on the game canvas
      target.addEventListener('touchmove', this._onTouchMove, { passive: false });
    }
  }

  /** @param {boolean} on */
  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this._pid = -1;
  }

  dispose() {
    const t = this.target;
    window.removeEventListener('keydown', this._onKey);
    t.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onCancel);
    window.removeEventListener('blur', this._onBlur);
    if (t !== window && t.style) {
      t.style.touchAction = this._prevTouchAction || '';
      t.removeEventListener('touchmove', this._onTouchMove);
    }
    this._pid = -1;
  }

  // ---------------------------------------------------------------- keyboard
  _handleKey(e) {
    if (!this.enabled || e.ctrlKey || e.metaKey || e.altKey) return;
    const code = CODE_MAP[e.code] ? e.code : KEY_MAP[e.key] || KEY_MAP[(e.key || '').toLowerCase()];
    const evs = code && CODE_MAP[code];
    if (!evs) return;
    const focus = document.activeElement;
    if (isTextField(focus)) return; // typing in a field
    // A focused <button> handles Space/Enter itself (native click) — don't double-fire.
    // Other keys still work so gameplay continues after clicking a HUD button.
    if (focus && focus.tagName === 'BUTTON' && (code === 'Space' || code === 'Enter' || code === 'NumpadEnter')) return;
    if (NO_SCROLL.has(code)) e.preventDefault();
    if (e.repeat) return;
    for (let i = 0; i < evs.length; i++) emit(evs[i], {});
  }

  // ---------------------------------------------------------------- gestures
  _pointerDown(e) {
    if (!this.enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this._pid !== -1 && e.pointerId !== this._pid) return; // ignore extra fingers
    this._pid = e.pointerId;
    this._sx = e.clientX; this._sy = e.clientY; this._st = e.timeStamp || performance.now();
    this._downT = this._st;
    this._fired = false;
    this._maxDist = 0;
  }

  _pointerMove(e) {
    if (e.pointerId !== this._pid || !this.enabled) return;
    const dx = e.clientX - this._sx, dy = e.clientY - this._sy;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    const d = ax > ay ? ax : ay;
    if (d > this._maxDist) this._maxDist = d;
    if (this._fired) return;
    const cfg = CONFIG.input;
    const elapsed = (e.timeStamp || performance.now()) - this._st;
    if (elapsed > cfg.swipeMaxTime) {
      // too slow for a swipe: restart the gesture from here so a later flick still counts
      this._sx = e.clientX; this._sy = e.clientY; this._st = e.timeStamp || performance.now();
      return;
    }
    if (d < cfg.swipeMinDistance) return;
    this._fired = true;
    if (ax > ay) emit(dx < 0 ? EVENTS.INPUT_LEFT : EVENTS.INPUT_RIGHT, {});
    else emit(dy < 0 ? EVENTS.INPUT_JUMP : EVENTS.INPUT_SLIDE, {});
  }

  _pointerUp(e) {
    if (e.pointerId !== this._pid) return;
    this._pid = -1;
    if (!this.enabled || this._fired) return;
    const d = Math.max(this._maxDist, Math.abs(e.clientX - this._sx), Math.abs(e.clientY - this._sy));
    const elapsed = (e.timeStamp || performance.now()) - this._downT;
    if (d <= CONFIG.input.tapMaxDistance && elapsed <= CONFIG.input.swipeMaxTime) emit(EVENTS.INPUT_CONFIRM, {});
  }
}
