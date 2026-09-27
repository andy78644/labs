// STUB — owned by Agent 4 (Game & UI). Web Audio synthesis only (no files). See ARCHITECTURE.md §4.8.
export class AudioEngine {
  constructor() { this.ready = false; this.muted = false; }
  /** Create/resume AudioContext. MUST be called from a user gesture. Idempotent. @returns {Promise<void>} */
  async init() {}
  /** @param {'coin'|'jump'|'slide'|'lane'|'hit'|'powerup'|'shield'|'start'|'over'|'click'} name */
  play(name) {}
  startMusic() {}
  stopMusic() {}
  /** Music tempo/filter intensity. @param {number} ratio 0..1 */
  setIntensity(ratio) {}
  /** @param {boolean} muted */
  setMuted(muted) { this.muted = muted; }
}
