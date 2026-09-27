// STUB — owned by Agent 2 (Player). Replace bodies, keep signatures. See ARCHITECTURE.md §4.3.
// Input NEVER calls the player directly: it only emits semantic input:* events.
import { emit, EVENTS } from './events.js';

export class Input {
  /** @param {HTMLElement|Window} [target=window] element that receives touch gestures */
  constructor(target = window) {
    this.enabled = true;
    this._onKey = (e) => {
      if (!this.enabled || e.repeat) return;
      const map = { ArrowLeft: EVENTS.INPUT_LEFT, ArrowRight: EVENTS.INPUT_RIGHT, ArrowUp: EVENTS.INPUT_JUMP, ArrowDown: EVENTS.INPUT_SLIDE, Enter: EVENTS.INPUT_CONFIRM };
      if (map[e.key]) emit(map[e.key]);
    };
    window.addEventListener('keydown', this._onKey);
  }
  /** @param {boolean} on */
  setEnabled(on) { this.enabled = on; }
  dispose() { window.removeEventListener('keydown', this._onKey); }
}
