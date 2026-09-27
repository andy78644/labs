# Neon Runner — Architecture Contract

> Written by the orchestrator **before** any worker started. This file, `src/config.js` and
> `src/events.js` are the contract. Workers implement their modules against the signatures
> below (which exist as stubs in `src/`). Workers **must not** edit files they don't own;
> if the contract is wrong, work around it locally and report the problem.

## 1. Overview

3D endless runner, synthwave style. Three.js **r170** via import map from jsDelivr, pure ES
modules, **no build step**, **zero asset files** (all geometry, textures, audio generated at
runtime). Runs with `python3 -m http.server`. Target 60 fps desktop, playable on mobile.

```
index.html ─ importmap(three, three/addons/) ─ src/main.js (bootstrap + loop)
                                                   │
                         ┌─────────────────────────┼───────────────────────────┐
                    src/game.js  (state machine, rules, score, camera, powerup timers)
          ┌────────┬──────────┬───────────┬─────────┬──────────┬───────────┐
       world.js player.js spawner.js effects.js  hud.js   audio.js   input.js
       textures.js                                (DOM)   (WebAudio)  (DOM events)
                  all talk sideways ONLY via src/events.js (bus) + src/config.js
```

## 2. Coordinate system & units

| | |
|---|---|
| Axes | right-handed, **+x right, +y up, −z forward** (runner faces −z) |
| Units | meters, seconds, radians |
| Ground | y = 0 is the track surface |
| Player | **stays at z = 0** (`CONFIG.player.z`). Only x (lane tween) and y (jump) change. |
| World motion | **the world scrolls toward +z**: every scrolling thing moves `+speed*dt` per step. Obstacles are spawned at `CONFIG.spawner.spawnZ` (−140) and recycled once `z > despawnZ` (+12). |
| Lanes | 3 lanes, index 0/1/2 = left/center/right, x = `CONFIG.lanes.x` = **[−2.4, 0, +2.4]**. Use `laneX(i)`. |
| Object origin | Obstacles/coins/powerups: `position.x` = lane center, `position.z` = center of its depth, `position.y` = 0 for ground-standing meshes (geometry translated so the base sits on the ground). Hitboxes are AABBs computed from CONFIG dimensions, not from mesh geometry. |
| Camera | Perspective, fov 62. Base pose = player position × (`followX` on x) + `CONFIG.camera.offset` (0, 3.3, 6.8), looking at `CONFIG.camera.lookAt` (0, 1.2, −10) — i.e. behind and above, looking down the track. Owned by game.js; effects.js adds shake. |
| Distance | `game.distance` (m) = ∫ speed dt. Score = distance × pointsPerMeter × multiplier + coins × coin.points (the multiplier also applies to coin points while active). |

## 3. Time step & main loop (src/main.js)

* **Fixed step** `CONFIG.sim.step = 1/60 s`. `main.js` accumulates real frame time (clamped to
  `maxFrameDelta = 0.25`), calls `game.update(step)` up to `maxSubSteps = 5` times, then
  `game.render()` once per `requestAnimationFrame`. Every `update(dt, …)` in every module
  receives **exactly `CONFIG.sim.step`** — modules may rely on that for stable physics.
* Order inside `game.update(dt)` while **playing**:
  1. `t += dt`, `speed = speedAt(t)`; emit `speed:changed` when `floor(speed)` changes
  2. `player.update(dt, speed)`
  3. `world.update(dt, speed)`
  4. `spawner.update(dt, speed, { distance, playerPos: player.position, magnet })`
  5. `hits = spawner.collide(player.getBounds())` → game resolves hits and emits events (§6)
  6. power-up timers tick; `powerup:end` on expiry
  7. `effects.update(dt, speed)`
  8. `distance += speed*dt`; update score; emit `score:changed`
* `game.render()`: camera follow (lerp) → `effects.applyCameraShake(camera)` → `hud.update(...)`
  → `world.render()` (world owns the EffectComposer; it renders the whole scene).
* **Title state** runs the same pipeline at `CONFIG.speed.demo` with a demo autopilot
  (game.js reads `spawner.getObstaclesAhead()` and calls `player.moveLeft/Right/jump/slide`);
  collisions are ignored in the demo. **Paused** runs no update, keeps rendering.
  **Over** keeps world/effects animating slowly (optional) but spawner/player frozen.

## 4. Modules, ownership & interfaces

| Agent | Files | Responsibility |
|---|---|---|
| 1 · World | `src/world.js`, `src/textures.js` | infinite track via recycled chunks, neon grid ground, sky, sun, mountains, lights, fog, bloom post-processing, renderer tone mapping |
| 2 · Player | `src/player.js`, `src/input.js` | runner model + run/jump/slide/death animation, lane tween, hitbox, keyboard + touch input |
| 3 · Hazards & FX | `src/spawner.js`, `src/effects.js` | obstacle/coin/power-up generation (guaranteed path), object pools, collision queries, particles, camera shake |
| 4 · Game & UI | `index.html`, `styles.css`, `src/main.js`, `src/game.js`, `src/hud.js`, `src/audio.js` | loop, state machine, score, power-up rules, HUD/title/results screens, synthesized SFX + BGM |
| Orchestrator | `ARCHITECTURE.md`, `src/config.js`, `src/events.js`, `dev/launch.mjs`, `README.md` | contract, integration, play-test |

Each worker may also create files under its own `dev/<slice>/` folder (`dev/world/`,
`dev/player/`, `dev/hazards/`, `dev/game/`) for test harnesses. Nothing else.

**Global rules for every module**
* `import * as THREE from 'three'`; addons from `'three/addons/...'` (e.g.
  `three/addons/postprocessing/EffectComposer.js`). No other dependencies.
* Read tunables from `CONFIG`; never hard-code a number that exists in config.
* Communicate across modules only through the method signatures below and the bus.
* No per-frame allocations in hot paths (reuse vectors, pools). Share geometries/materials.
* Neon look: use `MeshBasicMaterial` or `MeshStandardMaterial` with strong `emissive` for
  glowing parts; bloom (threshold `CONFIG.world.bloom.threshold`) makes bright colors glow.
* Every class has `reset()` (new run) and `dispose()`.

### 4.1 World (`src/world.js`) — Agent 1
```js
new World({ renderer, scene, camera })
world.update(dt, speed)   // scroll grid/track/scenery toward +z; recycle chunks of CONFIG.world.chunkLength
world.render()            // EffectComposer: RenderPass → UnrealBloomPass → OutputPass
world.resize(w, h)        // css px; main.js already did renderer.setSize + camera.aspect
world.reset()
world.dispose()
```
World owns: `scene.background`, `scene.fog` (`CONFIG.world.fogNear/Far`), all lights,
`renderer.toneMapping`/exposure, the composer. Sky/sun/mountains are far and do not scroll
(or scroll with slight parallax); ground grid scrolls exactly at `speed` so it matches obstacles.

### 4.1b Textures (`src/textures.js`) — Agent 1
Pure functions returning `THREE.CanvasTexture` (colorSpace sRGB):
`createGridTexture(opts)`, `createSkyTexture(opts)`, `createSunTexture(opts)`,
`createGlowTexture(opts)` (used by effects.js for particle sprites — keep it a soft radial
white→transparent glow), `createMountainTexture(opts)`, `createPanelTexture(opts)`.
Signatures/options are in the stub. Any module may import these.

### 4.2 Player (`src/player.js`) — Agent 2
```js
new Player(scene)                 // adds this.object3d to scene
player.object3d                   // THREE.Group
player.position                   // === object3d.position (live Vector3), z fixed at CONFIG.player.z
player.lane                       // 0 | 1 | 2 (target lane)
player.state                      // 'run' | 'jump' | 'slide' | 'dead'
player.airborne                   // boolean getter
player.shield                     // boolean
player.update(dt, speed)          // lane tween, jump arc, slide timer, run-cycle animation (rate ∝ speed)
player.moveLeft() / moveRight()   // → boolean; emits player:lane {lane, from}
player.jump()                     // → boolean; only when grounded (and not dead); emits player:jump
player.slide()                    // → boolean; on ground: slide for slideDuration; mid-air: fast-fall
                                  //   at CONFIG.player.fastFallSpeed then slide on landing. emits player:slide
player.getBounds(out?)            // THREE.Box3 world AABB: x/z = width/depth − 2*hitboxShrink,
                                  //   y from feet to feet+height (slideHeight while sliding)
player.setShield(on)              // bubble visual on/off
player.die(cause)                 // state 'dead', death animation, ignores inputs until reset()
player.reset()
player.dispose()
```
Physics: gravity `g = 8*jumpHeight/jumpDuration²`, initial vy `= 4*jumpHeight/jumpDuration`.
Emit `player:land {position}` on touchdown. Lane change during jump/slide is allowed. Slide
pressed during a slide restarts the timer; jump during a slide cancels slide and jumps.

### 4.3 Input (`src/input.js`) — Agent 2
```js
new Input(target = window)   // target receives pointer/touch gestures (main passes the canvas)
input.setEnabled(on)
input.dispose()
```
Emits **only** semantic bus events; never touches the player or game:
| Source | Event |
|---|---|
| ← / A, swipe left | `input:left` |
| → / D, swipe right | `input:right` |
| ↑ / W / Space, swipe up | `input:jump` |
| ↓ / S, swipe down | `input:slide` |
| Enter / Space, tap (short touch/click without swipe) | `input:confirm` (Space emits BOTH jump and confirm) |
| P / Escape | `input:pause` |
| M | `input:mute` |
Ignore key auto-repeat. `preventDefault` on arrow keys/space (no page scroll). Swipe thresholds
in `CONFIG.input`. Swipe is detected on move (fire as soon as threshold crossed, once per touch)
for responsiveness. Ignore keys while focus is in an `<input>`/`<button>` (Space on a button).

### 4.4 Spawner (`src/spawner.js`) — Agent 3
```js
new Spawner(scene)
spawner.reset()                               // everything back to pools; next row at spawner.firstRowZ
spawner.update(dt, speed, { distance, playerPos, magnet })
spawner.collide(playerBox) → Hit[]            // see stub typedef; coins/powerups auto-removed,
                                              //   obstacles reported once (flagged)
spawner.getObstaclesAhead(zMin, zMax) → [{type, lane, z}]   // zMin > zMax (e.g. −1, −40), nearest first
spawner.spawnRow(z, [a, b, c])                // debug: each = 'barrier'|'bar'|'wall'|'coin'|'magnet'|'shield'|'double'|null
spawner.setEnabled(on)                        // false: stop generating, keep moving/recycling
spawner.stats() → { obstacles, coins, powerups }
spawner.dispose()
```
Obstacle semantics (dimensions in `CONFIG.obstacles`, hitboxes are AABBs from those numbers):
* **barrier** — low fence, y ∈ [0, 0.9] → only **jump** clears it (running/sliding hit it).
* **bar** — overhead beam, solid y ∈ [1.15, 3.2] → only **slide** clears it (a 1.7 m runner or a
  jumper hits it). Draw with side posts for readability; posts are **not** solid.
* **wall** — y ∈ [0, 3.2], deep block → only **changing lane** avoids it.
Generation rules (must guarantee a path — see comments in `CONFIG.spawner`):
row gap = `clamp(speed*rowGapTime, rowGapMin, rowGapMax)` (+ jitter); ≥ 1 wall-free lane per row;
full 3-lane rows contain no wall and one type; the safe lane must be reachable from the previous
row's safe lanes (if the next row is very close, keep a common safe lane). Coin trails run along
safe lanes (arcing over barriers at jump height). Power-ups: `powerupChance` per row, spaced by
≥ `powerupMinDistance` m, placed in a safe lane. Magnet: when `ctx.magnet`, coins within
`CONFIG.powerups.magnetRadius` of `ctx.playerPos` move toward it at `magnetPullSpeed`.
Pools sized by `CONFIG.spawner.poolSize` (grow if exhausted, never crash).

### 4.5 Effects (`src/effects.js`) — Agent 3
```js
new Effects(scene, camera)   // subscribes to bus events itself (below)
effects.burst(position, { color, count, speed, life, size })
effects.shake(amplitude, decay?)
effects.update(dt, speed)    // particles live in world space and also scroll +z with the world
effects.applyCameraShake(camera)   // add offset AFTER game set the base pose (every render)
effects.reset(); effects.dispose()
```
Self-subscriptions: `coin:collected` → small gold sparkle; `powerup:collected` → burst in the
power-up color; `player:hit` → big burst + `shake(CONFIG.camera.shake.hit)` (or `.shield` if
`shielded`); `shield:break` → cyan ring burst; `player:land` → small dust/spark;
`game:start` → reset(). Use a single `THREE.Points` (or InstancedMesh) with additive blending and
`createGlowTexture()`; cap at `CONFIG.effects.maxParticles`. Optional: speed lines when ratio high.

### 4.6 Game (`src/game.js`) — Agent 4
```js
new Game({ renderer, scene, camera, world, player, spawner, effects, hud, audio, input })
game.state        // 'title' | 'playing' | 'paused' | 'over'
game.update(dt); game.render()
game.start()      // reset all modules, state → playing, emit game:start
game.setPaused(b) // emit game:pause
game.gameOver()   // state → over, save high score (localStorage CONFIG.score.storageKeyHigh), emit game:over
game.toTitle()    // state → title (demo), emit game:title
game.score, game.coins, game.distance, game.speed, game.time
game.powerups     // { magnet: secondsLeft, shield: secondsLeft, double: secondsLeft }
game.highScore
game.debug        // { grantPowerup(type), setInvincible(bool), setTime(t) }  — test hooks
```
Game subscribes to `input:*` and `ui:*` and routes them: in `playing` → player actions;
`title`/`over` → confirm/start/restart; `input:pause`/`ui:pause` toggles pause; mute toggles audio
(persist in `CONFIG.score.storageKeyMuted`). Auto-pause on `document.visibilitychange` hidden.
Hit resolution (step 5 of §3): see §6. Death: `player.die(type)`, keep scene alive ~1 s for the
death animation/particles, then `gameOver()`.

### 4.7 HUD (`src/hud.js`) — Agent 4
DOM overlay inside `#ui` (pointer-events none except interactive elements). Title (logo,
high score, controls help, PLAY button), in-game HUD (score, coins, ×2 badge, power-up timers
with bars, pause + mute buttons), pause overlay, results (score, coins, distance, best,
NEW RECORD, RUN AGAIN / MENU buttons). Buttons emit `ui:*` events. Signatures in stub.

### 4.8 Audio (`src/audio.js`) — Agent 4
Web Audio only. `init()` must be triggered from a user gesture (main.js registers a one-time
pointerdown/keydown listener). SFX names in stub. BGM: synthwave loop (bass arp + pad + drums)
scheduled with a lookahead scheduler; `setIntensity(ratio)` opens a filter / adds hats as speed
rises. Audio may subscribe to bus events directly to trigger SFX.

### 4.9 main.js / index.html — Agent 4
Creates renderer (`antialias`, pixel ratio capped by `CONFIG.world.maxPixelRatio[Mobile]`),
scene, camera, all modules, runs the loop (§3), handles resize, and exposes the **test hook**:
```js
window.__NEON__ = { game, bus, CONFIG, THREE, world, player, spawner, effects, hud, audio, input }
```
The hook is part of the contract (headless play-tests depend on it).

## 5. Events (src/events.js)

The authoritative list with payloads is in `src/events.js` (`EVENTS`). Emitters:
| Emitter | Events |
|---|---|
| game.js | `game:title`, `game:start`, `game:pause`, `game:over`, `game:state`, `speed:changed`, `score:changed`, `player:hit`, `coin:collected`, `powerup:collected`, `powerup:start`, `powerup:end`, `shield:break` |
| player.js | `player:lane`, `player:jump`, `player:slide`, `player:land` |
| input.js | `input:left/right/jump/slide/confirm/pause/mute` |
| hud.js | `ui:start`, `ui:restart`, `ui:pause`, `ui:mute`, `ui:home` |
| Listeners | effects.js (fx), audio.js (sfx), game.js (input/ui), hud.js (optional popups) |

## 6. Collision & power-up rules (game.js)

For each `Hit` from `spawner.collide()`:
* `coin` → `coins += value`; emit `coin:collected {position, total, value}`.
* `powerup` → emit `powerup:collected {type, position}`; set timer to
  `CONFIG.powerups.duration[type]` (refresh if active); emit `powerup:start {type, duration}`;
  shield → `player.setShield(true)`.
* `obstacle` → if shield active or grace timer > 0: emit `player:hit {type, position, shielded:true}`;
  if shield was active: shield off, `player.setShield(false)`, emit `shield:break` and
  `powerup:end {type:'shield'}`, grace = `shieldGraceTime`. Otherwise: emit
  `player:hit {…, shielded:false}`, `player.die(type)`, begin death sequence.
* `double` → multiplier `CONFIG.powerups.scoreMultiplier` while active. `magnet` → pass
  `magnet: true` to `spawner.update`.

## 7. Testing expectations for workers

* Serve the game folder with `python3 -m http.server <your port>` (World 8101, Player 8102,
  Hazards 8103, Game 8104). Kill your server when done.
* Headless browser: Playwright is installed locally. Use the shared launcher:
  `import { launch } from '../launch.mjs'` (from `dev/<slice>/`) → `const browser = await launch();`
  (headless Chromium with SwiftShader WebGL). Scripts are `.mjs`, run with `node`.
* Test your slice in a harness page in `dev/<slice>/` that imports your module plus the stubs /
  current versions of the others. Other workers are editing their files **at the same time**, so
  other modules may be mid-change; keep your harness robust (your module is what you verify).
* Required: zero console errors from your module; take screenshots and actually look at them.
