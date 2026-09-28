// Neon Runner — event bus (CONTRACT FILE, owned by the orchestrator).
//
// Tiny synchronous pub/sub. Listeners run in registration order, synchronously,
// inside emit(). Listener exceptions are NOT swallowed (so they surface as console errors).
//
// RULE: only emit names listed in EVENTS. Unknown names log a console.warn once.
// Payload shapes below are the contract — emitters must send exactly these fields
// (extra fields are allowed, missing fields are bugs). `position` is always a plain
// {x, y, z} object (a THREE.Vector3 is fine too) and must not be retained by listeners
// (clone it if you need it later).

export const EVENTS = Object.freeze({
  // ---- game lifecycle (emitter: game.js) --------------------------------
  GAME_TITLE: 'game:title',       // {}                      entered title screen (demo running)
  GAME_START: 'game:start',       // {}                      a new run begins (after reset)
  GAME_PAUSE: 'game:pause',       // { paused: boolean }
  GAME_OVER: 'game:over',         // { score, coins, distance, highScore, isNewHigh }
  GAME_STATE: 'game:state',       // { from, to }            any state transition ('title'|'playing'|'paused'|'over')
  SPEED_CHANGED: 'speed:changed', // { speed, ratio }        ratio = (speed-start)/(max-start) in 0..1
  SCORE_CHANGED: 'score:changed', // { score, coins, distance, multiplier }   at most once per step

  // ---- player (emitter: player.js) --------------------------------------
  PLAYER_LANE: 'player:lane',     // { lane, from }          lane change started
  PLAYER_JUMP: 'player:jump',     // {}                      jump started
  PLAYER_SLIDE: 'player:slide',   // {}                      slide started
  PLAYER_LAND: 'player:land',     // { position }            feet touched ground after a jump

  // ---- collisions & pickups (emitter: game.js, from spawner.collide results) ----
  PLAYER_HIT: 'player:hit',       // { type, position, shielded }   type = 'barrier'|'bar'|'wall'
  COIN_COLLECTED: 'coin:collected',       // { position, total, value }
  POWERUP_COLLECTED: 'powerup:collected', // { type, position }       type = 'magnet'|'shield'|'double'
  POWERUP_START: 'powerup:start', // { type, duration }      (re-emitted when refreshed)
  POWERUP_END: 'powerup:end',     // { type }                expired or consumed (shield)
  SHIELD_BREAK: 'shield:break',   // { position }            shield absorbed a hit

  // ---- input (emitter: input.js) — semantic actions, not raw keys --------
  INPUT_LEFT: 'input:left',       // {}   ← / A / swipe left
  INPUT_RIGHT: 'input:right',     // {}   → / D / swipe right
  INPUT_JUMP: 'input:jump',       // {}   ↑ / W / Space / swipe up
  INPUT_SLIDE: 'input:slide',     // {}   ↓ / S / swipe down
  INPUT_CONFIRM: 'input:confirm', // {}   Enter / Space / tap   (menus: start / restart)
  INPUT_PAUSE: 'input:pause',     // {}   P / Escape
  INPUT_MUTE: 'input:mute',       // {}   M

  // ---- UI (emitter: hud.js) ---------------------------------------------
  UI_START: 'ui:start',           // {}   "PLAY" button on title
  UI_RESTART: 'ui:restart',       // {}   "RUN AGAIN" button on results
  UI_PAUSE: 'ui:pause',           // {}   pause/resume button
  UI_MUTE: 'ui:mute',             // {}   mute toggle button
  UI_HOME: 'ui:home',             // {}   back to title from results/pause
});

const KNOWN = new Set(Object.values(EVENTS));
const warned = new Set();
const listeners = new Map(); // name -> Array<fn>

/** Subscribe. Returns an unsubscribe function. */
export function on(name, fn) {
  if (!KNOWN.has(name)) warnUnknown(name);
  let arr = listeners.get(name);
  if (!arr) listeners.set(name, (arr = []));
  arr.push(fn);
  return () => off(name, fn);
}

/** Unsubscribe a specific listener. */
export function off(name, fn) {
  const arr = listeners.get(name);
  if (!arr) return;
  const i = arr.indexOf(fn);
  if (i >= 0) arr.splice(i, 1);
}

/** Subscribe for a single call. */
export function once(name, fn) {
  const unsub = on(name, (p) => { unsub(); fn(p); });
  return unsub;
}

/** Emit synchronously. payload defaults to {}. */
export function emit(name, payload = {}) {
  if (!KNOWN.has(name)) warnUnknown(name);
  const arr = listeners.get(name);
  if (!arr || arr.length === 0) return;
  for (const fn of arr.slice()) fn(payload);
}

/** Remove every listener (tests / hot reset only). */
export function clearAll() {
  listeners.clear();
}

/** Number of listeners for a name (debug). */
export function listenerCount(name) {
  return listeners.get(name)?.length ?? 0;
}

function warnUnknown(name) {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`[events] unknown event name "${name}" — add it to EVENTS in src/events.js`);
}

export const bus = Object.freeze({ on, off, once, emit, clearAll, listenerCount, EVENTS });
export default bus;
