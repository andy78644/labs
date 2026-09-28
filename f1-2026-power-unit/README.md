# The 50/50 Engine — inside the 2026 F1 power unit

An interactive, single-file web lab that explains the 2026 Formula 1 power unit to a general audience: how it works, what changed from 2014–2025, and where the energy goes.

![overview](docs/screenshots/01-overview.png)

## Run it

```bash
cd labs/f1-2026-power-unit
python3 -m http.server 8000
# open http://localhost:8000/
```

Everything is in `index.html`. There is no build step. Three.js r0.186.1 loads from jsDelivr through an import map, and fonts (Barlow, Barlow Condensed, IBM Plex Mono) come from Google Fonts, so the first load needs a network connection. There are no asset files: every model, texture, shader and sound is generated in code.

## Features

**3D scene (procedural, Three.js)**
- A stylised but mechanically consistent V6 power unit:
  - 90° V, bore 80 mm, stroke about 53 mm, 120 mm con-rods
  - a crankshaft with 3 shared pins and counterweighted webs
  - 6 pistons and rods from proper slider-crank kinematics, and 4 valves per cylinder
  - DOHC camshafts with phased lobes, turning at ½ crank speed
  - carbon cam covers with coil packs, the intake plenum and trumpets, and a 3-into-1 exhaust per bank
  - a turbo with a compressor wheel, a gold-foil turbine housing, the shaft and the tailpipe
  - the MGU-K with a gear train (the idler gear is placed by circle intersection so the gears really mesh), plus a copper stator and rotor visible in X-ray
  - the Energy Store with a live SoC light strip and 84 cells, the control electronics, the HV cables and the fuel cell
  - the gearbox, rear axle and drilled brake discs
- Firing order is derived from the geometry. The code brute-forces the 64 possible cycle assignments. The result is the uneven **90°/150°** V6 beat, in the order A1 → B1 → A3 → B3 → A2 → B2.
- Rendering:
  - ACES tone mapping, shadows, GTAO ambient occlusion, bloom, PMREM room environment
  - procedural carbon-weave, cast and brushed textures
  - an HDR sanitise pass before bloom (it removes NaN/Inf values and clamps specular spikes)
  - adaptive quality: AO switches off, then the pixel ratio drops, if FPS sags
- **My own shaders:**
  - X-ray fresnel shell
  - combustion gas that follows the 4-stroke phase (blue intake → warming compression → spark → flame front → exhaust)
  - energy conduits with travelling pulses and glowing energy packets (with a faint see-through pass)
  - heat-tinted exhaust with blackbody glow that tracks ICE power
  - brake-disc incandescence under braking
  - fuel volume
  - drafting floor lines (dash-dot centre lines, a datum circle and a fine grid)

**Interaction**
- Drag to orbit, scroll or pinch to zoom, right-drag to pan. Hover a part to see its name. Click a part to open its lesson.
- **RPM slider** (4,000–15,000). Dragging it switches to Dyno mode. Pistons, rods, crank, cams, valves, gears, MGU-K rotor and turbo all move in sync. Motion is slowed ÷200 / ÷50 / ÷10 so it doesn't strobe; sound and simulation stay real-time.
- **Sound** is off by default and turns on with the button or M. Web Audio builds a PeriodicWave from the real uneven firing pattern. Its fundamental is rpm/120, so the firing frequency is rpm/60 × 3. On top of that the synth adds waveshaping, a throttle-dependent low-pass, exhaust-noise rasp, a turbo whistle and an MGU-K inverter whine.
- **X-ray / cutaway** (X), **Exploded view** with labelled parts and leader lines (E), **Energy flow** (F).
- **Four modes:** Qualifying / Race / Recharge (lift-and-coast + super-clipping) / Overtake. Also **2025 ⇄ 2026 rules** (Y): the MGU-H grows onto the turbo shaft, the MGU-K limit, the harvest/deploy caps and turbo lag all change, and so do the power-split bars.
- **Lap simulation** (bonus). A procedural circuit gives corner speeds from curvature. The model adds a braking envelope, 8 gears, drag with Straight/Corner-mode aero, per-lap harvest caps, SoC, clipping and super-clipping. It draws a live track map coloured by deploy/harvest, a speed trace against the previous lap, and lap/best times per mode.
- **Telemetry:**
  - RPM, speed, gear
  - ICE kW, MGU-K kW (±), MGU-H kW (2025)
  - ICE/electric split, ES SoC
  - harvested and deployed MJ this lap
  - fuel energy flow against the limit, turbo rpm
  - status chips (deploying, harvesting, clipping, super-clipping, Straight/Corner mode, overtake armed…)
- **Seven numbered lessons.** Each one flies the camera to its part, pulses a highlight and shows labels. Some also switch views (X-ray, Dyno, Lap). The lessons include live widgets:
  - a firing-order strip (card 2)
  - a hold-to-lift turbo-lag demo (card 3)
  - 2025/2026 power bars (card 4)
  - a flow legend (card 5)
  - a fuel energy-flow limit chart with a live rpm dot (card 6)
  - mode buttons (card 7)
- **Cinematic camera** (C): six orbiting shots with letterbox bars and lower-third captions. **Hide UI** (/). **Help** (H or ?). **English ⇄ 繁體中文** (I or the toggle).
- **Mobile:**
  - telemetry becomes a row of chips
  - lessons become a single sheet with 1–7 navigation
  - the dock scrolls horizontally
  - the camera pulls back for portrait screens

**Keys:** 1–7 lessons · Q/R/G/O modes · Y rules year · X X-ray · E explode · F flow · L lap/dyno · ↑↓ rpm · Space (hold) lift · M sound · C cinematic · / hide UI · I language · H/? help · Esc close/reset.

**URL parameters** (these were used for testing): `card=2&instant`, `xray`, `explode`, `mode=quali|race|recharge|overtake`, `era=2025`, `drive=dyno`, `rpm=12000`, `slow=200`, `flow=0`, `lang=zh`, `warm=20` (pre-simulate N seconds), `cam=x,y,z,tx,ty,tz`, `noao`, `lowq`. `window.PU` exposes the state and setters for automated tests.

## 2026 rule numbers used, and sources

| Item | Value used | Source / note |
|---|---|---|
| Engine layout | 1.6 L (1600 cc), 6 cylinders, 90° V, 4 valves/cyl, 3 crank pins | FIA 2026 PU Technical Regulations, Art. 5.3.2, 5.3.3, 5.3.4, 5.3.6 |
| Bore / rod length | 80 mm bore; rod ≈ 120 mm | FIA 2026 PU regs Art. 5.6.1 and 5.6.9 |
| Compression ratio | ≤ 16.0 (was 18) | FIA Art. 5.6.3; Honda |
| Rev ceiling | 15,000 rpm (slider max) | Motor Sport Magazine. **Note:** I found no explicit crank-speed article in the Issue 2 PU regs; the fuel-flow cap stops rising at 10,500 rpm, so real engines run well below this. Treat it as approximate. |
| Turbo speed | ≤ 150,000 rpm (2025: 125,000) | FIA Art. 5.5.6; Honda (2015–22 page) |
| Fuel energy flow | ≤ 3,000 MJ/h; below 10,500 rpm EF = 0.27·N + 165 | FIA Art. 5.4.3 / 5.4.4 |
| 2025 fuel flow | 100 kg/h (≈ 4,300 MJ/h using ~43 MJ/kg, **approx.**) | Motor Sport Magazine; Honda. The 0.009·N + 5.5 kg/h curve below 10,500 rpm is from the 2014+ rules. |
| MGU-K power | 350 kW (2025: 120 kW) | FIA Art. 5.4.6; formula1.com |
| MGU-K speed taper | Simplified: 350 kW to 290 km/h, then falls to 150 kW at 340 km/h. Overtake keeps 350 kW to 337 km/h. | **Approx.** FIA Art. 5.4.7 (Issue 2 formula P = 1850 − 5·v) plus the F1/FIA 2024 update (taper from 290 km/h; overtake to 337 km/h) |
| ES state-of-charge window | 4 MJ | FIA Art. 5.4.8 |
| Energy harvest per lap | ≈ 8.5 MJ (2025: 2 MJ; the 2025 deploy cap of 4 MJ is also modelled) | formula1.com and Honda say ≈ 8.5 MJ. FIA Issue 2 (2023) said 9 MJ. Raceteq reports circuit-dependent limits of 5–9 MJ after 2026 revisions. **Approx.** |
| ICE power | ≈ 400 kW (2025: ≈ 550–560 kW) | formula1.com; Honda; Motor Sport Magazine. In the model it comes from fuel-flow × efficiency (**approx.** 48 % BTE). |
| MGU-H | Removed in 2026 (2014–25: unlimited energy per lap) | formula1.com; Honda |
| Overtake mode | +0.5 MJ; 350 kW to 337 km/h; available within 1 s of the car ahead; replaces DRS | formula1.com; Motor Sport Magazine (mode names); F1 Chronicle |
| Active aero | Straight Mode (low drag) / Corner Mode (downforce) | Motor Sport Magazine (official names) |
| Fuel | 100 % advanced sustainable fuel | formula1.com; Honda |

Links:
- FIA, *2026 Formula 1 Power Unit Technical Regulations*, Issue 2 (3 Mar 2023): https://api.fia.com/sites/default/files/fia_2026_formula_1_technical_regulations_pu_-_issue_2_-_2023-03-03.pdf
- Formula 1, "2026 regulations explained: all you need to know about F1's new power units": https://www.formula1.com/en/latest/article/2026-regulations-explained-all-you-need-to-know-about-f1s-new-power-units.14jfv7a36905uDJDdNyfQd
- Formula 1, "Explained: 2026 power unit regulations" (6 Jun 2024): https://www.formula1.com/en/latest/article/explained-2026-power-unit-regulations-fia.68izKQ2tn1voQPWvgLVMXN
- Honda, "2026 Formula 1 Regulations Overview": https://global.honda/en/F1/features/2026_Commentary/regulations/
- Honda, "Evolution of Hybrid Technologies (MGU-H, MGU-K) – 2015 to 2022" (for the 2014–2025 ERS limits): https://global.honda/en/tech/motorsports/Formula-1/Powertrain_MGU-H_MGU-K/
- Motor Sport Magazine, "All the key aspects changing on F1's 2026 engines": https://www.motorsportmagazine.com/articles/single-seaters/f1/all-the-key-aspects-changing-on-f1s-2026-engines/
- Motor Sport Magazine, "Explained: the new mode names for active aero and energy boost": https://www.motorsportmagazine.com/articles/single-seaters/f1/explained-the-new-mode-names-for-active-aero-and-energy-boost-for-f1-2026/
- Raceteq, "MGU-K, megajoules, and managing the battery: F1's 2026 energy system explained": https://www.raceteq.com/articles/2026/05/f1s-2026-energy-system-explained
- F1 Chronicle, "Overtake Mode explained": https://f1chronicle.com/f1-overtake-mode-2026-explained/

**The simulation is illustrative, not a team model.** Efficiencies, the circuit, the harvest/deploy strategy, drag and grip are invented, and the numbers are chosen to produce plausible behaviour. The 90°/150° firing rhythm follows from the modelled crank layout; real manufacturers' crank phasing and firing orders are not public.

## Design decisions (made without asking)

- **Dyno vs Lap.** The rpm slider drives a "dyno bench" (the engine held at a set rpm, full throttle unless you lift). The lap simulation drives rpm automatically. Grabbing the slider switches to Dyno with a toast. On the dyno, per-lap counters reset every 90 s ("bench lap").
- **Slow motion only for visuals.** At 12,000 rpm the crank turns 200 times a second, so mechanical motion is divided by 50 by default. Sound, telemetry and flows stay real-time, and the UI says so.
- **Qualifying** refills the battery at each lap line, standing in for the out-lap charge.
- **Fuel cell drawn as a translucent bladder** so the fuel level and the Energy Store under it stay readable.
- **The MGU-K is on the camera side** (+Z), so the default view shows the hybrid hardware.
- **Look:** a light "shop manual" theme: drafting paper with a millimetre grid, ink rules, flat panels, and one racing-red accent for the interface. The page is laid out like a drawing sheet: a header with a chapter strip, a control sheet on the left, the lesson drawer on the right, a telemetry strip along the bottom, and a live title block in the drawing area.
- **Colours are for data only:** teal-green = electric deploy, cobalt blue = harvest, orange = fuel, brick = exhaust, slate = intake air, brass = crank → wheels, violet = MGU-H.

## Development log

Tooling: Playwright is installed locally in `tools/` (`npm i -D playwright`, not global). `tools/shot.mjs` takes screenshots with console/page-error capture. `tools/interact.mjs` presses every shortcut, enables sound, drags the slider, hovers and clicks parts, and asserts that there are no errors. The Chromium browser binary is in Playwright's user cache. Tests ran against `python3 -m http.server` on port 8765.

**Round 1 (first full build)**
- The scene rendered, but the camera was far too close and the model was clipped.
- Bloom blew out the exhaust and flows.
- The dock rows overflowed: the rpm label wrapped and the rpm value overlapped the slow-mo buttons.
- Telemetry values wrapped, the kicker wrapped, and the lesson numbers were duplicated.
- Console warnings: the deprecated `THREE.Clock` and the removed `PCFSoftShadowMap`.

Fixes:
- switched to `THREE.Timer` and `PCFShadowMap`
- restructured the dock (modes/rules/drive/icons, then views/rpm/slow-mo)
- widened the SoC column and pulled the camera back
- lowered bloom and exhaust glow, enlarged particle sprites
- dimmed the floor grid
- turned the fuel cell into a translucent bladder with straps

**Round 2 (X-ray, exploded, mobile)**
- X-ray threw a page error every frame. The SoC strip had been swapped to the ghost material, so `.emissive` was undefined. Fixed by marking it `keep`.
- A second error: `Color.addScaledVector` doesn't exist. Fixed with manual RGB math.
- X-ray looked washed out, because additive ghost shells with bright rims and scan lines stacked up. Reduced the ghost alpha and removed the lines. Also lowered the per-cylinder fire light, which was overexposing the pistons.
- Bright horizontal bars in X-ray turned out to be the polished cam shafts blooming. Changed them to dark alloy.
- The battery cells were glowing white; dimmed them.
- A persistent white flare near the fuel cell survived with flows off. Bisection (hiding parts, then tank children, then disabling bloom and AO in turn) showed a tiny extreme HDR value feeding bloom. Fixed with a custom sanitise/clamp pass before bloom, NaN guards in all custom shaders, rougher steel and less clearcoat.
- Exploded labels hid under the side panels. Labels are now clamped to the free centre area, the explode offsets are tighter, and the camera pulls back further.
- Mobile: dock segments overlapped. The cause was a CSS class `.g` shared by the dock groups and the green-text spans in the cards. Renamed the dock class to `.grp` and made the rows scroll. Also pulled the portrait camera back ×1.9.
- The brake discs looked like grey tyres. Made them smaller and drilled (a canvas texture), and toned down their glow.

**Round 3 (lessons, modes, 2025, Chinese, interaction test)**
- Lift-off on the dyno still showed +210 kW deploy. Lifting now harvests (dyno coast).
- Qualifying drained the battery to 3 % on every lap. It now refills at the lap line.
- The turbo, MGU-H, MGU-K and fuel lesson cameras were too close. Moved them out.
- Checked 2025 mode (the MGU-H appears, K is capped at 120 kW, 2 MJ harvest / 4 MJ deploy caps, the violet H flow runs), the 繁中 UI, help, cinematic, hide-UI, slider drag → Dyno, hover → tooltip, and click → lesson. All passed with zero console errors or warnings.

**Round 4 (visual redesign)**
- Reworked the visual design into an original light theme ("shop manual"): paper background with a drafting grid, Barlow / Barlow Condensed / IBM Plex Mono, flat ruled panels, a racing-red accent, and a new layout (header + chapter strip, left control sheet, right lesson drawer with a cover page, bottom telemetry strip, live title block).
- The 3D render was re-tuned for paper: Neutral tone mapping, a screen-space paper texture pre-compensated for the tone mapper, neutral lighting, a lighter shadow, and less bloom. The X-ray shells, combustion gas, fuel volume, energy conduits and packets switched from additive to normal blending so they stay visible on a light background.
- A camera view offset and zoom now centre the model in the free drawing area; part labels are clamped to the same area.
- Fixed a latent bug where the harvested/deployed mini bars never filled.
- Checked desktop (1440×900, 1280×800, 1024×768) and 390×844 mobile, EN and 繁中, 2025/2026, all views, cinematic, help and the interaction script: no console errors or warnings.

**Known weaknesses**
- The model is stylised. There's no chassis or wheels, and part proportions are approximate.
- Visuals were tuned only on Apple M1 (ANGLE Metal). Low-end phones will fall back to lower quality automatically, but this wasn't tested on real devices.
- Audio was verified only as "creates and runs without errors"; nobody listened to it.
- The speed taper and lap strategy are simplified.

## Files

- `index.html`: the whole app (≈170 KB)
- `docs/screenshots/`:
  - `01-overview`
  - `02-exploded`
  - `03-xray-four-stroke`
  - `04-energy-flow`
  - `05-2025-vs-2026`
  - `06-mobile`
  - `07-modes-zh`
  - `08-cinematic`
- `tools/`: local Playwright verification scripts (`shot.mjs`, `interact.mjs`, `clip.mjs` for zoomed crops; set `PORT` to use a port other than 8765). `node_modules` is git-ignored.
- `BRIEF.md`: the project brief.
