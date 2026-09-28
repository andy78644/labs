# labs

A collection of small interactive experiments: browser games, explorable explainers and whatever else is fun to build. Everything runs as a static page with no build step, and every model, texture and sound is generated in code at load time.

Most of these were built by Claude Code agents with Claude Opus 5.5. Each project folder keeps the brief the agents were given, and a README that logs how the agents worked.

| | Project | What it is | How it was built |
|---|---|---|---|
| <a href="https://andy78644.com/labs/neon-runner/"><img src="neon-runner/docs/screenshots/02-gameplay.png" width="320" alt="Neon Runner gameplay"></a> | **[Neon Runner](neon-runner/)**<br>[▶ Play](https://andy78644.com/labs/neon-runner/) | A synthwave 3D endless runner. Switch lanes, jump and slide past three kinds of obstacles, collect coins and power-ups. | An orchestrating agent wrote an architecture contract (module interfaces, event bus, shared config and stubs) first. Four sub-agents then built the world, player, hazards/FX and game/UI in parallel, each owning its own files. ~45 min, ~4,750 lines. |
| <a href="https://andy78644.com/labs/f1-2026-power-unit/"><img src="f1-2026-power-unit/docs/screenshots/01-overview.png" width="320" alt="F1 2026 power unit lab"></a> | **[Inside the 2026 F1 Power Unit](f1-2026-power-unit/)**<br>[▶ Open](https://andy78644.com/labs/f1-2026-power-unit/) | An explorable explainer for the 2026 F1 power unit: spin the V6, cut it open, explode it, follow the energy between engine, MGU-K and battery, and compare it with 2025. | A single long agent run. It researched the FIA 2026 regulations first, then built the page in a screenshot-and-fix loop with Playwright. |

## Run locally

```bash
git clone https://github.com/andy78644/labs.git
cd labs
python3 -m http.server 8080
```

Then open http://localhost:8080/neon-runner/ or http://localhost:8080/f1-2026-power-unit/.

Three.js is loaded from jsDelivr, so you need an internet connection.

## Notes

- Each project folder has its own `README.md` with controls, features and the agent workflow log, plus the original `BRIEF.md`.
- Nothing here has been tested on a wide range of real devices yet. Frame rate and audio were checked in headless browsers only.
