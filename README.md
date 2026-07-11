# CADGOD — CAD Inspection Copilot (MVP)

A desktop AI CAD reviewer for macOS. Attaches to a CAD window (Fusion 360,
Onshape-in-browser, SolidWorks), navigates the model with simulated cursor
control, captures screenshots from multiple angles, builds a knowledge graph of
the design, and produces a senior-mechanical-engineer style design review with
evidence and confidence scores.

Built with C++20 + Make only — no cmake/Homebrew/Qt required. The UI shell is a
native AppKit floating overlay (Cursor-style dark panel); the core is
UI-agnostic so a Qt front-end can be swapped in later.

## Setup

```sh
cp .env.example .env      # put your ANTHROPIC_API_KEY in .env (git-ignored)
make all                  # builds build/cadgod, build/cadgod-overlay, tests
make test                 # run the unit test suite
```

macOS permissions needed for real inspections (System Settings → Privacy & Security):
- **Screen Recording** — for window titles + screenshots
- **Accessibility** — for cursor control (orbit/zoom)

## Usage

```sh
./build/cadgod-overlay               # the app: Cursor-style floating window
./build/cadgod smoke                 # verify the API key with one tiny call
./build/cadgod windows               # list windows (CAD/browser flagged)
./build/cadgod inspect --prompt "3d printed gearbox"   # CLI inspection
./build/cadgod inspect --window-id N # manual window selection
./build/cadgod inspect --dry-run     # pipeline check offline ([DRY RUN]-tagged)
```

In the overlay: type a description of your model in the bottom input and press
Inspect. The system immediately takes a screenshot of the attached window
(auto-detected, or pick one from the dropdown — ◆ CAD app, ◇ browser), verifies
with vision that a real CAD viewport is visible, and only then runs the
multi-view inspection loop. Screenshots appear in the chat log with notes on
what vision picked up; the left panel shows state-machine progress. If no CAD
viewport is confirmed, the run aborts with an error — it never proceeds on
assumed data.

Reports are written to `inspection_out/report.md` alongside the captured
screenshots.

### Onshape in Chrome

Chrome tab titles are only visible with Screen Recording permission. Without a
title match, cadgod attaches to the largest browser window (or falls back to a
full-screen screenshot) and lets the vision verification pass confirm the CAD
viewport. Orbit uses Onshape's right-drag convention automatically.

## Architecture

Five agents orchestrated in a loop (`src/core/orchestrator.cpp`):

| Agent | Role | LLM? |
|---|---|---|
| Planner | picks next view, decides when inspection is complete | no (deterministic) |
| Camera | orbits/zooms the CAD viewport via CGEvent, captures via `screencapture` | no |
| Vision | extracts facts only (parts, holes, fasteners, relationships) | yes, image input |
| Research | engineering references (fits, fastener access, gear mesh, …) | no (offline library) |
| Engineering | final review: issues, confidence, questions, recommendations | yes, adaptive thinking |

State machine (`src/core/session.cpp`): attach → capture initial screenshot →
**vision verifies a CAD viewport is actually visible (hard abort if not)** →
model-type onboarding (asks the user via popup when unknown) → loop { plan →
orbit → capture → dedup → vision extract → knowledge graph } with a minimum of
3 views → research → engineering review → report.

Anti-hallucination rules: vision may only report visible objects (uncertain →
"unclassified"), non-CAD frames yield zero objects, and engineering may only
discuss knowledge-graph objects. A run with no visually confirmed components
refuses to produce a report.

### Cost & token controls
- Identical screenshots are hashed and **never sent twice**
- Vision receives a **text summary of known objects** instead of prior images
- Planner is deterministic — **no LLM call per navigation step**
- Exactly **one** research pass (offline) and **one** engineering call per inspection
- Structured outputs (`output_config.format` JSON schema) — no retry-on-bad-JSON loops
- Tunable via `.env`: `CADGOD_MAX_STEPS`, `CADGOD_CONFIDENCE_THRESHOLD`, `CADGOD_MODEL`

### Layout
```
src/core/      json, env, knowledge graph, screenshot store, Claude client, agents, orchestrator
src/platform/  window detection / capture / cursor control (interfaces + macOS impl)
src/app/       CLI (main.cpp), overlay (overlay_app.mm), shared wiring (app_common)
tests/         self-contained test suite (make test)
```

The Claude integration is raw HTTPS against `POST /v1/messages` (libcurl) with
an injectable transport, so tests run fully offline. Default model:
`claude-opus-4-8`.

## Scope

This is the **CAD Inspection Copilot MVP** only — read-only inspection and
review. CAD editing, firmware debugging, ROS, and simulation are future
expansions; the platform/agent interfaces are designed so those can be added
without reworking the core.
