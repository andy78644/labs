# Two-Mode Wings: 2026 F1 active aero

Part 2 of the F1 2026 series, after [Inside the 50/50 Engine](../f1-2026-power-unit/). It is a single-file interactive lab about the 2026 active aerodynamics rules. You can switch a procedurally built open-wheel car between **Corner Mode** and **Straight Mode**, watch the airflow change, run a lap that switches modes by itself, follow another car through its wake, and compare it all with 2025 DRS.

![overview](docs/screenshots/01-overview.png)

## Run it

```bash
cd labs/f1-2026-active-aero
python3 -m http.server 8000
# open http://localhost:8000/
```

Everything is in `index.html` and there is no build step. Three.js 0.186.1 loads from jsDelivr through an import map (the same version as part 1). The fonts are Saira and JetBrains Mono from Google Fonts, so the first load needs a network connection. There are no asset files: the car, textures, airflow and sound are all generated in code.

## Features

**3D scene**
- A generic 2026-style open-wheel car built from code with no real team shapes or liveries. It is painted in unbranded primer grey with a generic "26" number panel. It has:
  - a lofted monocoque, nose and engine cover, and sidepods with a coke-bottle taper
  - a halo, a driver helmet, and wishbone plus push-rod suspension
  - lathe-turned tyres with wheel covers
  - a partly flat floor with fences, and a diffuser with strakes
  - the 2026 wheel-wake boards
  - a front wing with a fixed main plane and **two active flaps**
  - a rear wing with a main plane, endplates, a single pylon and **two active flaps**
- **Smooth flap motion.** Front flaps hinge at their leading edge and flatten. Rear flaps hinge at their trailing edge, so the leading edge lifts away from the main plane. A move takes about 0.4 s. The moving flaps have red trailing edges.
- **2025 ⇄ 2026 morph.** The body stretches to a 3.6 m wheelbase and 2.0 m width. The beam wing and the front wheel arches return and the wake boards disappear. In 2025 only the top rear flap moves (DRS), and the front flaps stay fixed.
- **Airflow.** 1,400 streak particles (700 on touch devices) move through a velocity field I built by hand:
  - potential-flow doublets around the body and wheels
  - for each wing, a bound vortex, an upwash sheet and tip vortices
  - faster flow under the floor, and lift out of the diffuser
  - a noisy, velocity-deficit wake whose strength grows with downforce

  Colour shows pressure from Bernoulli (Cp = 1 − (v/U)²): **blue = low pressure / fast**, grey = free stream, **red = high pressure**, and **violet = turbulent wake**. In Corner Mode the rear wing throws a tall, swirling violet wake. In Straight Mode the streaks stay flat and the wake shrinks.
- **X-ray** shows the flap actuators: a gold unit in the nose and one in the rear-wing pylon head, with links that follow the flaps as they move.
- **Exploded view** with labelled parts and leader lines.
- **Rolling road.** The Tunnel scene has a wind-tunnel belt. Lap and Chase use an asphalt track with kerbs that scrolls at the simulated speed while the wheels turn.

**Simulation (illustrative)**
- Forces use F = ½ρ·C·A·v² with made-up ClA/CdA values for each setup (Corner, Straight, Partial, and 2025 Corner/DRS). From these the model gets:
  - downforce, drag and L/D
  - steady-state top speed, by bisecting power against drag and rolling resistance
  - cornering speed on a 120 m radius
- Each bar has a white tick that marks the 2025 Corner-setup value.
- The **lap** uses the same test circuit as part 1:
  - grip-limited corner speeds and a braking envelope for each aero setup
  - activation zones on straights longer than about 3 s, marked 60 m after the corner exit
  - **Auto**: Straight Mode in a zone, and Corner Mode again as soon as the car brakes
  - a simplified 2026 MGU-K: 350 kW tapering above 290 km/h, harvest under braking, a 4 MJ battery window, and deployment that eases off as the battery runs low
  - S1–S3 sector timing in purple, green and yellow, as in part 1
  - a track map that shows the zones
  - a speed trace with a **mode timeline** strip under it (white = Straight, red = Corner), plus the previous lap as a ghost line
- In **2025 mode** the lap opens DRS only in the two longest zones, and only with "Within 1 s" switched on. Forcing Straight Mode on for the whole lap costs grip in the corners, and the lap time shows it.
- **Chase**: a second car sits 5–60 m ahead (a slider sets the gap). Its wake takes downforce from the follower (illustrative: ~16 % at 10 m for 2026, ~25 % for 2025) and gives it a tow (less drag). **Overtake** (+0.5 MJ, 350 kW held to 337 km/h) makes the follower close in, pull out and pass. The car ahead then resets.
- Telemetry shows:
  - speed, gear, a mode badge (C / S / D / P), and front and rear flap position gauges
  - forces, speed limits, battery SoC and MGU-K power
  - status chips: activation zone, DRS zone, braking, deploy/harvest, Overtake, dirty air and tow

**Lessons.** There are seven chapters, with the same 01–07 chapter strip and timing-tower cover as part 1. Each chapter moves the camera to its parts, makes them pulse with a lime rim, labels them and sets up the scene. English and Traditional Chinese are both included.
1. Downforce: an upside-down wing, with a pressure key
2. The price: drag, with Corner/Straight buttons
3. 2026: two modes, both wings (X-ray view with the actuators)
4. Not the old DRS: a 2025-vs-2026 table and a rules switch
5. Smaller, lighter, less floor: a dimensions table and the 2025/2026 morph
6. Dirty air and the chase, with an Overtake button
7. Aero + electric: the energy to hold 300 km/h for 1 km in each setup, with a link to part 1

**Other**
- Cinematic camera (V) with the broadcast lower-third captions from part 1.
- Hide UI (/) and help (H or ?).
- Sound (M): wind noise that follows speed × drag, and a servo whirr when the flaps move.
- Mobile layout: telemetry as a row of chips, lessons as a single sheet with 1–7 buttons, and a sideways-scrolling control dock.

**Keys:** 1–7 lessons · C/S/A Corner/Straight/Auto · Y rules year · T/L/K Tunnel/Lap/Chase · F airflow · E explode · X X-ray · O Overtake · G within 1 s · ↑↓ tunnel speed · [ ] gap · M sound · V cinematic · / hide UI · I language · H/? help · Esc back.

**URL parameters** (used for testing): `card=3&instant`, `aero=corner|straight|auto`, `era=2025`, `scene=studio|lap|chase`, `xray`, `explode`, `flow=0`, `chasing`, `v=250`, `gap=15`, `lang=zh`, `warm=N` (pre-simulate N seconds), `cam=x,y,z,tx,ty,tz`, `lowq`, `noao`. `window.AA` exposes the state and setters for automated tests.

## 2026 rule facts used, and sources

| Item | Used in the lab | Source / note |
|---|---|---|
| Mode names | **Straight Mode** (flaps open, low drag) and **Corner Mode** (flaps in their normal high-downforce position). The early press names were "X-mode" and "Z-mode". | Motorsport.com (FIA/F1 terminology); Motor Sport Magazine; formula1.com |
| What moves | The front wing's two-element flap and the rear wing flaps. Both wings move, unlike DRS. | formula1.com aero explainer; The Race (partial mode: "both front and rear flaps move") |
| Who switches, and when | The FIA marks **activation zones** on the straights. The driver switches to Straight Mode inside them. Braking or lifting sends the car back to Corner Mode automatically. Every car can use it, with no 1 s rule. | Silverstone (F1 101); formula1.com. **Sources differ on the details.** Motor Sport Magazine calls the alternation automatic, and F1's early explainer said "straights longer than three seconds". The lab uses "armed in zones, automatic return on braking". |
| Partial mode | Race control can allow front flaps only, for wet or unsafe conditions. The model has the coefficients and a P badge for it, but nothing in the UI switches it on. | The Race; Silverstone |
| Actuation time | About 0.4 s | **Approx.**: this figure only appears in secondary summaries of the technical regulations. I could not check it in the regulation text. |
| Dimensions | Wheelbase 3.4 m (−200 mm); width 1.9 m (−100 mm); floor −150 mm; tyres −25 mm front / −30 mm rear | formula1.com aero explainer |
| Mass | ≈768 kg (2025: 800 kg) | formula1.com. Some later sources say 770 kg, so it is marked approximate. |
| Downforce and drag | FIA target about −30 % downforce and about −55 % drag. Later figures quote about 15–30 % and about 40 %. The model's Straight-vs-2025 drag is about −39 %. | formula1.com; Motorsport.com |
| Other aero | Beam wing removed; front wheel arches removed; in-washing wheel-wake control boards; flatter floor and lower-powered diffuser | formula1.com |
| DRS (2011–2025) | Rear flap only, lifting at most 85 mm; within 1 s at the detection point; DRS zones only; closes on braking; ≈10–12 km/h gain | Wikipedia (Drag reduction system), citing the FIA |
| Overtake | Within 1 s of the car ahead at a detection point; +0.5 MJ; replaces DRS as the overtaking aid | Motor Sport Magazine; formula1.com beginner's guide; Motorsport.com |
| Power split | About half electric (350 kW MGU-K) | formula1.com; see part 1 for the power-unit sources |

Links:
- Formula 1, "Explained: 2026 aerodynamic regulations — X-mode and Z-mode": https://www.formula1.com/en/latest/article/explained-2026-aerodynamic-regulations-fia-x-mode-z-mode-.26c1CtOzCmN3GfLMywrgb2
- Formula 1, "The beginner's guide to the 2026 regulations": https://www.formula1.com/en/latest/article/the-beginners-guide-to-the-2026-regulations.6j0tS0hrHG2T01tpmK6XYz
- Motorsport.com, "FIA unveils the new F1 terminology you need to know for the 2026 season": https://www.motorsport.com/f1/news/f1-and-fia-unveil-new-renders-and-terminology-for-2026/10785237/
- Motor Sport Magazine, "Explained: the new mode names for active aero and energy boost": https://www.motorsportmagazine.com/articles/single-seaters/f1/explained-the-new-mode-names-for-active-aero-and-energy-boost-for-f1-2026/
- Silverstone, "Active aerodynamics explained": https://www.silverstone.co.uk/news/active-aero-explained-f101-beginners-guide-f1s-aerodynamics-2026
- The Race, "Why F1 has added new 'partial' aero mode to 2026 rules": https://www.the-race.com/formula-1/f1-2026-partial-aero-mode-explained/
- Wikipedia, "Drag reduction system": https://en.wikipedia.org/wiki/Drag_reduction_system

**The physics is illustrative, not a team or CFD model.** The ClA/CdA values, grip, the wake-loss curve, the tow, the energy strategy and the whole airflow field are invented. They were chosen so the proportions look sensible: top speeds of about 330–365 km/h, downforce above the car's weight at corner speed, and 2026 losing less in dirty air than 2025. The UI says "illustrative" wherever it shows numbers.

## Design decisions (made without asking)

- **Same series look as part 1.** The CSS design system is reused directly:
  - carbon-fibre backdrop, chamfered and slanted panels
  - Saira in condensed italic plus JetBrains Mono
  - red, white and black, with lime for live data and purple/green/yellow for sectors
  - kerb stripes, the chapter strip, left dock, right lesson panel with a timing tower, bottom telemetry and info bug

  The renderer is shared too: tone mapping, the code-built studio environment, GTAO, bloom with an HDR sanitise pass, and adaptive quality. The header links back to part 1.
- **New data colours:** blue for low pressure and downforce, red for high pressure, orange for drag, violet for the wake. Corner Mode is red and Straight Mode is white on every badge, button and timeline.
- **The highlight is a lime fresnel rim.** An early version tinted the material, which turned the black tyres and carbon olive. The rim now reuses the X-ray shell.
- **Tunnel "Auto"** switches between the two modes every 3.5 s, so the flap animation plays without any input.
- **The car stays still and the road moves.** This keeps the airflow readable. The lap and chase scenes still run the real simulation.

## Development log

Tooling: Playwright is installed locally in `tools/` (`npm i`, not global; `node_modules` is git-ignored). `tools/shot.mjs` takes screenshots and records console and page errors. `tools/interact.mjs <dir>` uses Playwright's real keyboard to press every shortcut. It also drags the speed slider, hovers and clicks a part, clicks the gap slider, runs an Overtake in Chase and prints the resulting state. `tools/clip.mjs` takes zoomed crops. Set `PORT` to choose the server port (8791 was used here).

The page was built in small steps. Each step was one or two short edits: CSS and markup, helpers and physics, the renderer (copied from part 1), the car in three chunks, the airflow, the lap sim, the copy, the lessons, the labels and setters, the camera and sound, the input, the telemetry, and finally the loop.

**Round 1 (first render)**
- The body looked dark brown and the lighting seemed to come from the wrong side. The loft generator's winding order was inverted, so the car showed its back faces. Flipped the triangle and cap winding.
- The Scene buttons overflowed the dock row, the airflow key labels overlapped, and the kerb cut through the middle of the view. Moved Scene to its own row, shortened the key, and moved the kerbs to ±6.6–7.5 m.
- The default camera was too close; pulled it back.

**Round 2 (airflow)**
- A white-hot band of streaks climbed over the whole car. The front-wing upwash term fed itself: the band's trajectory rose, and particles caught in it kept rising. It now decays within about 0.7 m (front) or about 3 m (rear).
- Additive lines were blowing out to white under bloom. Lowered the line intensity and darkened the free-stream grey so that red and blue stand out.
- Corner and Straight looked too alike. Made the wake strength ∝ (ClA/3.3)^1.6 and raised the rear-wing upwash. Raised the particle count to 1,400 with 16-point trails. The corner wake is now a tall violet swirl and the straight wake is flat.

**Round 3 (lessons, chase, 2025, mobile)**
- Several lesson cameras were cropped (X-ray, 2025 rear view, chase). Reframed them. The chase camera now depends on the gap.
- Mobile: the "Part 1" link overlapped the title, so it is hidden on phones. Opening a lesson hid the car behind the lesson sheet, because the view offset was pushing the image the wrong way. The car now sits between the chips and the sheet.
- Interaction test: hovering the flaps returned an empty id, because flap and wheel meshes sit inside unnamed pivot groups. Picking now walks up to the owning part. Clicking a part opens the lesson that explains it: flaps → lesson 3, beam wing → lesson 4.
- During a pass the tow went to −40 % (the gap went negative), and the battery went flat every lap. Wake and tow now use an effective gap that ignores the car ahead once you are alongside, and deployment eases off below 1.2 MJ.
- The pass was too fast to see; closing speed is now 5 m/s.

**Final check:** 1440×900, 1024×768 and 390×844 (mobile), EN and 繁中, both rule sets, all three scenes, all views, every lesson, cinematic, help, hide-UI and `tools/interact.mjs`. There were 0 console errors or warnings.

**Known weaknesses**
- The airflow is a hand-built field, not CFD. It shows the right trends (stagnation, suction under the wings and floor, upwash, tip vortices, wake), but local detail is invented.
- The car is stylised. It has no bargeboard detail, and the proportions are approximate.
- The lap strategy is simple: no lift-and-coast, no super-clipping, and no partial mode on the circuit.
- Everything was tuned on Apple M1 (ANGLE Metal) and in headless Chromium only. Nobody has listened to the audio.
- Some CSS rules copied from part 1 are unused (shift lights, firing strip).

## Files

- `index.html`: the whole app (about 173 KB, about 2,240 lines)
- `docs/screenshots/`:
  - `01-overview`
  - `02-straight-mode`
  - `03-corner-mode`
  - `04-airflow-wake`
  - `05-chase-overtake`
  - `06-2025-vs-2026`
  - `07-exploded`
  - `08-mobile`
  - `09-xray-actuators`
  - `10-zh-1024`
- `tools/`: Playwright verification scripts
- `BRIEF.md`: the project brief
