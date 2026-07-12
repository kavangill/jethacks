<p align="center">
  <a href="https://git.io/typing-svg">
    <img src="https://readme-typing-svg.demolab.com?font=Rajdhani&weight=700&size=40&pause=1000&color=ff0000&center=true&vCenter=true&width=1000&lines=Presenting:+Halo;A+Context-Aware+system;Teaching+you+a+variety+of+concepts;By+drawing+on+your+screen!." alt="JECHACKS 2026" />
  </a>
</p>

<p align="center">
  <a href="https://git.io/typing-svg">
    <img src="https://readme-typing-svg.demolab.com?font=Rajdhani&weight=700&size=40&pause=2500&color=ff0000&center=true&vCenter=true&width=1000&lines=Created+by:;Abhiram+Vadali;Kevin+Renjith;Kavan+Gill;" alt="JECHACKS 2026" />
  </a>
</p>

A lightweight Electron utility that uses less than 10% of system resources (M1 Macbook Pro) \
It draws on your screen, providing on-screen tutorials & help, no matter the scenario.

**Please Note:** On macOS, Screen Recording + Accessibility permissions are required for full functionality.

## Features
- Voice or text input (hold-to-talk or prompt box)
- Screen capture used as context for the AI
- Streaming model output rendered live in a compact panel
- Synchronized Text to Speech and on-screen neon drawings
- Optional real cursor automation for demos
- Small formula board that renders LaTeX with an onboard compiler

## How it works (high level)
1. The renderer records audio or accepts text and sends it to the main process.
2. main.js captures a scaled screenshot and calls the agent loop (agent.js).
3. agent.js sends the screenshot + user prompt to Anthropic, receives interleaved tool commands and text, and interprets them.
4. Drawing commands are rendered by the trail overlay (trail.html). Action commands are executed via nut-js (actions.js).
5. Text to Speech clips are delivered to the renderer for playback so speech and drawings remain synchronized.

# File Descriptions

- `index.html` -> Main overlay HTML: the prompt bar, mic button, panel, formula board, and links to renderer scripts and KaTeX.  
- `trail.html` -> Full-screen transparent canvas for glowing cursor trails and on-screen annotation rendering driven by IPC.  
- `main.js` -> Electron main process: creates overlay & trail windows, manages permissions/global hooks, coordinates runs, and mediates IPC.  
- `preload.js` -> Secure IPC bridge exposing a small overlay API (haloVoice, haloTask, haloTeach, setIgnoreMouse, etc.) to the renderer.  
- `renderer.js` -> Front-end logic: streaming markdown rendering, audio recording, Text to Speech playback queue, UI state, and panel/board updates.  
- `agent.js` -> AI agent loop: builds screenshot+prompt messages for Anthropic, interprets interleaved tool_use responses, and sequences tools and narration.  
- `actions.js` -> Mouse/keyboard executor using nut-js: move, click, drag, type, press combos, and scroll with demo-friendly timings.  
- `screen.js` -> Screenshot and coordinate utilities: capture via desktopCapturer or screencapture CLI and map image pixels to logical screen coordinates.  
- `voice.js` -> Speech to Text and Text to Speech functions used by main.js and the agent.  
- `test-cursor.js` -> Small cursor and calibration helpers for verifying trail, coordinate mapping, and grid tests.

## How to Use
- Install npm & Node.js
- Run the install script that corresponds to your Operating System (.zsh for Mac OS X, .bat for Windows)

- One could ask Halo to explain anything, using the screen as a canvas, like so:
    - Press and hold the Option Key (⌥) to talk to Halo, asking it any question
        - __For Example:__ Explain the Pythagorean Theorem
    - It would then draw a right triangle on the screen, and explain the theorem
    - One can interrupt Halo at any time as well 

## CRITICAL DISCLAIMER
- The API key is provided for ***testing purposes only*** 

## Credits
- Project created by:
    - Abhiram Vadali
    - Kavan Gill
    - Kevin Renjith
