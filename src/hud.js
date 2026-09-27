// STUB — owned by Agent 4 (Game & UI). DOM overlay. See ARCHITECTURE.md §4.7.
export class Hud {
  /** @param {HTMLElement} root the #ui element */
  constructor(root) { this.root = root; }
  /** @param {{ highScore: number, muted: boolean }} data */
  showTitle(data) {}
  showPlaying() {}
  /** @param {{ score:number, coins:number, distance:number, speed:number, multiplier:number,
   *            powerups: Record<'magnet'|'shield'|'double', number> }} s  remaining seconds (0 = inactive) */
  update(s) {}
  /** @param {boolean} paused */
  showPause(paused) {}
  /** @param {{ score:number, coins:number, distance:number, highScore:number, isNewHigh:boolean }} r */
  showResults(r) {}
  /** @param {boolean} muted */
  setMuted(muted) {}
}
