const {
  app,
  BrowserWindow,
  screen,
  ipcMain,
  globalShortcut,
  systemPreferences,
  session,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const { uIOhook, UiohookKey } = require('uiohook-napi');

// --- load .env (same key/model as the cadgod project) -----------------
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnv();

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CADGOD_MODEL || 'claude-opus-4-8';

// The window is a FIXED-SIZE transparent canvas: the bar sits at the bottom
// and the output panel grows upward inside it with CSS (no OS window
// resizing — that's what caused the snapping). Empty transparent space
// click-forwards to whatever app is underneath.
const WIN_WIDTH = 560;
const BAR_HEIGHT = 42;
const GAP = 6;
const PANEL_MAX = 420;
const WIN_HEIGHT = PANEL_MAX + GAP + BAR_HEIGHT;

let win;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const x = Math.round((width - WIN_WIDTH) / 2);
  // Place so the BAR (bottom of the window) sits around 1/3 down the screen.
  const y = Math.max(20, Math.round(height * 0.30) - (PANEL_MAX + GAP));

  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Float above everything — Chrome, fullscreen apps, all spaces.
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');

  // Re-assert on every focus change: macOS silently drops always-on-top
  // level for accessory-policy apps in a few situations (space switches,
  // another app also requesting a high window level), so we nail it back
  // down whenever the window (de)activates instead of trusting the initial call.
  win.on('blur', () => win.setAlwaysOnTop(true, 'screen-saver', 1));
  win.on('show', () => win.setAlwaysOnTop(true, 'screen-saver', 1));

  // Start click-through; the renderer toggles this off when the cursor is
  // over an island (bar/panel) and back on over transparent space.
  win.setIgnoreMouseEvents(true, { forward: true });

  // Exclude the overlay from screen captures so Claude never sees (or reads)
  // its own chat panel in screenshots.
  win.setContentProtection(true);
}

// --- full-screen glow-trail window (never captures clicks or screenshots) --
let trailWin;

function createTrailWindow() {
  const bounds = screen.getPrimaryDisplay().bounds;
  trailWin = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  trailWin.setIgnoreMouseEvents(true);
  trailWin.setAlwaysOnTop(true, 'screen-saver', 2);
  trailWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  trailWin.setContentProtection(true); // invisible to screenshots
  trailWin.loadFile('trail.html');
}

ipcMain.on('set-ignore-mouse', (_event, ignore) => {
  if (!win) return;
  // While the agent is driving the cursor the whole overlay must stay
  // click-through, or nut.js clicks land on our own bar instead of the app
  // underneath.
  if (agentActive && !ignore) return;
  win.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on('quit-app', () => {
  app.quit();
});

ipcMain.on('generate-start', (event, prompt) => {
  const sender = event.sender;

  if (!API_KEY) {
    sender.send('generate-error', 'No ANTHROPIC_API_KEY found in .env');
    return;
  }

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 400,
    system:
      'Answer as briefly as possible — a few words to a couple sentences. No preamble, no filler, no restating the question. Use markdown (#, **bold**) only when it genuinely helps.',
    stream: true,
    messages: [{ role: 'user', content: prompt }],
  });

  const req = https.request(
    {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    },
    (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (!payload) continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === 'content_block_delta' && evt.delta?.text) {
              sender.send('generate-chunk', evt.delta.text);
            } else if (evt.type === 'error') {
              sender.send('generate-error', evt.error?.message || 'API error');
            }
          } catch {
            // ignore partial/non-JSON SSE lines
          }
        }
      });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          sender.send('generate-error', `HTTP ${res.statusCode}`);
        }
        sender.send('generate-end');
      });
    }
  );

  req.on('error', (err) => {
    sender.send('generate-error', err.message);
  });

  req.write(body);
  req.end();
});

// ======================= Halo: voice-driven cursor agent =================
const { runAgent } = require('./agent');
const { transcribe, tts } = require('./voice');
const { captureScreen, screenshotDims } = require('./screen');

let agentActive = false;

// Each run gets its own abort flag + Anthropic AbortController, and a
// generation number. Barge-in supersedes the in-flight run rather than
// mutating shared state (which would race a new run against an old one's
// straggling awaits) — stale runs are silenced by the generation check,
// and their network calls are actually cancelled via the controller.
let runGeneration = 0;
let currentAbort = null;
let currentController = null;
let audioPending = false; // TTS handed to the renderer but not finished playing

function haloSend(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// --- cursor trail control --------------------------------------------------
// Polls the real cursor and streams points to the trail window. In 'user'
// mode we also record the path so the traced gesture can be drawn onto the
// screenshot Claude sees.
let trailTimer = null;
let trailHideTimer = null; // pending fade-then-hide; cancelled if a new trail starts
let userPath = [];

function startTrail(mode) {
  if (!trailWin || trailWin.isDestroyed()) return;
  if (mode === 'user') userPath = [];
  // A new trail cancels any pending hide from the previous one, so the window
  // can't disappear out from under an AI run that starts right after a
  // recording ends.
  if (trailHideTimer) { clearTimeout(trailHideTimer); trailHideTimer = null; }
  // Drop any stale points before we show, so nothing from the last session
  // flashes on the first frame.
  trailWin.webContents.send('trail-clear');
  trailWin.webContents.send('trail-mode', mode);
  trailWin.showInactive();
  // Re-assert level + workspace visibility every time: the AI trail has to sit
  // above both our own overlay and whatever app the cursor is driving —
  // including an app that's in its own native-fullscreen Space, which the
  // once-at-creation flag doesn't reliably cover.
  trailWin.setAlwaysOnTop(true, 'screen-saver', 2);
  trailWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (trailTimer) clearInterval(trailTimer);
  trailTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    if (mode === 'user') {
      userPath.push({ x: p.x, y: p.y });
      if (userPath.length > 4000) userPath.shift();
    }
    trailWin.webContents.send('trail-point', p.x, p.y);
  }, 16);
}

function stopTrail() {
  if (trailTimer) clearInterval(trailTimer);
  trailTimer = null;
  // Let the glow fade out before hiding the window. Tracked in trailHideTimer
  // so a new startTrail can cancel it deterministically (not via a !trailTimer
  // race).
  if (trailHideTimer) clearTimeout(trailHideTimer);
  trailHideTimer = setTimeout(() => {
    trailHideTimer = null;
    if (!trailTimer && trailWin && !trailWin.isDestroyed()) {
      trailWin.hide();
      trailWin.webContents.send('trail-clear');
    }
  }, 1500);
}

// --- AI screen annotations (draw_* tools) ----------------------------------
// Shapes arrive in screenshot pixel space; scale them to logical screen points
// (same mapping as toScreenCoords — the screenshot covers the full display
// from (0,0), so a single scale factor is enough for positions AND sizes).
function execDraw(name, input) {
  if (!trailWin || trailWin.isDestroyed()) return 'FAILED: drawing window unavailable';
  if (name === 'clear_drawings') {
    trailWin.webContents.send('draw-clear');
    return 'cleared';
  }
  const d = screenshotDims();
  if (!d) return 'FAILED: no screenshot taken yet';
  const k = d.displayW / d.imgW;
  const s = { color: input.color || 'blue' };
  if (name === 'draw_ellipse') {
    Object.assign(s, { type: 'ellipse', cx: input.cx * k, cy: input.cy * k, rx: input.rx * k, ry: input.ry * k });
  } else if (name === 'draw_rect') {
    Object.assign(s, { type: 'rect', x: input.x * k, y: input.y * k, w: input.width * k, h: input.height * k });
  } else if (name === 'draw_line' || name === 'draw_arrow') {
    Object.assign(s, { type: name.slice(5), x1: input.x1 * k, y1: input.y1 * k, x2: input.x2 * k, y2: input.y2 * k });
  } else {
    return `FAILED: unknown drawing tool ${name}`;
  }
  for (const v of Object.values(s)) {
    if (typeof v === 'number' && !Number.isFinite(v)) return 'FAILED: bad coordinates';
  }
  // startTrail('ai') already showed the window, but re-assert in case a
  // pending hide fired between runs.
  if (!trailWin.isVisible()) {
    trailWin.showInactive();
    trailWin.setAlwaysOnTop(true, 'screen-saver', 2);
  }
  trailWin.webContents.send('draw-shape', s);
  return `drew ${s.type} (${s.color})`;
}

// Draw the student's gesture path onto a screenshot (composited in the trail
// window's canvas — the main process has no canvas API).
function annotateShot(shot, points) {
  return new Promise((resolve) => {
    const dims = screenshotDims();
    if (!dims || points.length < 2 || !trailWin || trailWin.isDestroyed()) {
      return resolve(shot);
    }
    const scaled = points.map((p) => ({
      x: Math.round((p.x * dims.imgW) / dims.displayW),
      y: Math.round((p.y * dims.imgH) / dims.displayH),
    }));
    let done = false;
    ipcMain.once('annotate-done', (_e, b64) => {
      if (done) return;
      done = true;
      resolve({ base64: b64, width: shot.width, height: shot.height });
    });
    trailWin.webContents.send('annotate', shot.base64, scaled);
    setTimeout(() => {
      if (!done) { done = true; resolve(shot); }
    }, 3000);
  });
}

// --- loading layout ---------------------------------------------------------
// While the agent works, the overlay snaps to the top-centre of the screen
// (just under the camera notch) collapsed to the bare textbox with a spinner,
// then snaps back to wherever the user had it and shows the output.
let savedBounds = null; // where the window was before the loading snap

function enterLoadingLayout() {
  if (!win || win.isDestroyed() || savedBounds) return; // already snapped
  savedBounds = win.getBounds();
  const wa = screen.getPrimaryDisplay().workArea; // excludes menu bar / notch
  const x = Math.round(wa.x + (wa.width - WIN_WIDTH) / 2);
  const y = wa.y + 6;
  haloSend('halo-loading', true);
  // resizable:false blocks programmatic setBounds resizes on some platforms —
  // lift it for the two snaps.
  win.setResizable(true);
  win.setBounds({ x, y, width: WIN_WIDTH, height: BAR_HEIGHT }, true);
  win.setResizable(false);
}

function exitLoadingLayout() {
  if (!win || win.isDestroyed() || !savedBounds) return;
  win.setResizable(true);
  win.setBounds(savedBounds, true);
  win.setResizable(false);
  savedBounds = null;
  haloSend('halo-loading', false);
}

// --- hold-to-talk listening mode --------------------------------------------
// Hold ⌥ Option (or the mic button): mic on + amber gesture trail → speak and
// optionally circle something → release → transcribe + annotated screenshot
// → teacher explains. Starting a recording always supersedes whatever the
// agent is currently doing (barge-in): output is cut and generation bumped
// so the interrupted run can never re-surface stale audio or status.
let listening = false;

function cancelCurrentRun() {
  runGeneration++; // any in-flight run's emits/finally are now stale
  if (currentController) currentController.abort();
  if (currentAbort) currentAbort.aborted = true;
  audioPending = false; // the queue is about to be wiped; no done event will come
  haloSend('halo-audio-stop');
}

function startListening() {
  if (listening) return;
  cancelCurrentRun(); // barge-in: cuts off any current speech/thinking
  exitLoadingLayout(); // if we interrupted a run mid-snap, put the bar back home
  listening = true;
  startTrail('user');
  haloSend('halo-status', 'recording');
  haloSend('halo-listen-start');
}

function stopListening() {
  if (!listening) return;
  listening = false;
  stopTrail();
  haloSend('halo-status', 'transcribing');
  haloSend('halo-listen-stop'); // renderer stops the recorder → halo-teach
}

// Escape / mic-click-while-busy: stop everything and return to idle,
// discarding (not processing) any recording in progress.
function cancelEverything(reason) {
  cancelCurrentRun();
  if (listening) {
    listening = false;
    haloSend('halo-listen-cancel'); // renderer discards the recorder's audio
  }
  // Always stop the trail — aborting an AI run has listening === false, and
  // runHaloTask's finally skips its own stopTrail once the run is stale, so
  // without this the polling interval keeps drawing a live trail on an idle
  // screen.
  stopTrail();
  exitLoadingLayout();
  agentActive = false;
  haloSend('halo-log', `aborted (${reason})`);
  haloSend('halo-status', 'idle');
}

async function speakOut(text, myAbort, myGen) {
  try {
    // The model occasionally slips markdown into spoken text despite the
    // prompt — strip it so ElevenLabs never reads asterisks aloud.
    const spoken = text.replace(/\*\*?|__|`|^#+\s*/gm, '');
    const mp3 = await tts(spoken);
    if (myAbort.aborted || myGen !== runGeneration) return; // superseded
    audioPending = true; // cleared by halo-audio-done when playback drains
    haloSend('halo-audio', mp3.toString('base64'));
  } catch (err) {
    if (myAbort.aborted || myGen !== runGeneration) return;
    console.error('[halo] TTS failed:', err.message);
    haloSend('halo-log', `TTS failed: ${err.message}`);
  }
}

async function runHaloTask(task, opts = {}) {
  const myAbort = { aborted: false };
  const myController = new AbortController();
  // The SDK adds one abort listener per request on this shared signal; a
  // multi-step lesson easily passes Node's default cap of 10.
  require('node:events').setMaxListeners(64, myController.signal);
  const myGen = ++runGeneration;
  currentAbort = myAbort;
  currentController = myController;
  agentActive = true;
  win.setIgnoreMouseEvents(true, { forward: true });
  enterLoadingLayout(); // snap the bar top-centre while we work
  startTrail('ai'); // blue glow so the student can follow the pointer

  const stale = () => myGen !== runGeneration;

  const emit = (event, data) => {
    if (stale()) return;
    if (event === 'status') haloSend('halo-status', data);
    else if (event === 'log') haloSend('halo-log', data);
    else if (event === 'speak') speakOut(data, myAbort, myGen);
    else if (event === 'shot') haloSend('halo-shot', data);
    else if (event === 'thinking') haloSend('halo-thinking', data);
  };

  try {
    haloSend('halo-status', 'thinking');
    const finalText = await runAgent(task, {
      emit,
      abortState: myAbort,
      signal: myController.signal,
      firstShot: opts.firstShot,
      circled: opts.circled,
      draw: execDraw,
    });
    if (myAbort.aborted || stale()) return;
    console.log(`[halo] final: ${finalText}`);
    exitLoadingLayout(); // snap back home and reveal the output panel
    haloSend('halo-log', `✓ ${finalText}`);
    haloSend('halo-status', 'speaking');
    await speakOut(finalText, myAbort, myGen);
  } catch (err) {
    if (stale()) return;
    console.error('[halo] agent error:', err);
    exitLoadingLayout();
    haloSend('halo-error', err.message);
    await speakOut('Sorry, something went wrong with that.', myAbort, myGen);
  } finally {
    if (!stale()) {
      agentActive = false;
      exitLoadingLayout(); // no-op if already restored above
      // A barge-in may already have started a new recording (listening
      // true) that owns the trail/status now — don't clobber it.
      if (!listening) {
        // If the final answer is still being spoken, leave the trail window
        // (and any drawings) up and the status on 'speaking' — the renderer
        // reports halo-audio-done when playback drains, and we tidy up there.
        if (!audioPending) {
          stopTrail();
          haloSend('halo-status', 'idle');
        }
      }
    }
  }
}

// Playback queue drained in the renderer — now it's safe to fade the trail,
// clear drawings, and go idle (unless a new run/recording already took over).
ipcMain.on('halo-audio-done', () => {
  audioPending = false;
  if (!agentActive && !listening) {
    stopTrail();
    haloSend('halo-status', 'idle');
  }
});

// Teach path: hold-to-talk recording. The renderer sends the audio here
// after release; the gesture path is already in userPath.
ipcMain.handle('halo-teach', async (_event, audioArrayBuffer, mimeType) => {
  try {
    haloSend('halo-status', 'transcribing');
    enterLoadingLayout();
    const task = await transcribe(Buffer.from(audioArrayBuffer), mimeType);
    if (!task) {
      exitLoadingLayout();
      haloSend('halo-status', 'idle');
      return { error: 'Heard nothing — try again.' };
    }
    haloSend('halo-transcript', task);
    const shot = await captureScreen();
    const circled = userPath.length > 20;
    const firstShot = circled ? await annotateShot(shot, userPath) : shot;
    runHaloTask(task, { firstShot, circled });
    return { task };
  } catch (err) {
    exitLoadingLayout();
    haloSend('halo-status', 'idle');
    return { error: err.message };
  }
});

// Voice path: renderer records webm while the mic button is held, sends it
// here on release; we transcribe then hand the text to the agent.
ipcMain.handle('halo-voice', async (_event, audioArrayBuffer, mimeType) => {
  try {
    haloSend('halo-status', 'transcribing');
    enterLoadingLayout();
    const task = await transcribe(Buffer.from(audioArrayBuffer), mimeType);
    if (!task) {
      exitLoadingLayout();
      haloSend('halo-status', 'idle');
      return { error: 'Heard nothing — try again.' };
    }
    haloSend('halo-transcript', task);
    runHaloTask(task); // fire and forget; progress streams over IPC
    return { task };
  } catch (err) {
    exitLoadingLayout();
    haloSend('halo-status', 'idle');
    return { error: err.message };
  }
});

// Text path for testing/demo fallback: "/do <task>" in the prompt box.
ipcMain.handle('halo-task', async (_event, task) => {
  haloSend('halo-transcript', task);
  runHaloTask(task);
  return { task };
});

// Mic-click-while-busy (renderer detects the busy state) and any other
// explicit cancel request from the UI.
ipcMain.on('halo-abort', () => {
  cancelEverything('user');
});

function checkPermissions() {
  const accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  const screenAccess = systemPreferences.getMediaAccessStatus('screen');
  if (!accessibility || screenAccess !== 'granted') {
    console.error(`
==================================================================
HALO CANNOT CONTROL YOUR CURSOR.
  Accessibility:    ${accessibility ? 'OK' : 'MISSING'}
  Screen Recording: ${screenAccess}
Grant permissions, then FULLY QUIT and relaunch:
  System Settings → Privacy & Security → Accessibility → add your terminal/Electron app
  System Settings → Privacy & Security → Screen Recording → same
==================================================================`);
  } else {
    console.log('[halo] permissions OK (accessibility + screen recording)');
  }
}

app.whenReady().then(() => {
  checkPermissions();
  systemPreferences.askForMediaAccess('microphone').catch(() => {});
  // getUserMedia from the overlay renderer needs an explicit grant.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });
  // Accessory activation policy (no Dock icon / Cmd-Tab entry) — this is
  // what lets an always-on-top window actually float over OTHER apps'
  // native fullscreen Spaces (e.g. a fullscreened Chrome window). Without
  // it macOS confines the window to the regular desktop Space no matter
  // what level/collection-behavior it's given.
  if (process.platform === 'darwin') app.dock.hide();
  createWindow();
  createTrailWindow();

  // Escape is a persistent global kill switch — registered once, not tied
  // to any single run, so it cancels a recording-in-progress even before
  // the agent has started.
  const escOk = globalShortcut.register('Escape', () => cancelEverything('Escape'));
  console.log(escOk ? '[halo] Escape kill switch armed' : '[halo] FAILED to register Escape');

  // Hold the ⌥ Option key to talk. Electron's globalShortcut has no key-up
  // event, so real hold/release detection needs an OS-level hook (uiohook-napi)
  // that reports raw keydown/keyup. A lone modifier avoids the ⌘Space Spotlight
  // clash the old chord fought. optDown also swallows the key-repeat keydowns
  // macOS fires while the key is held so we only start recording once.
  let optDown = false;
  const isOpt = (e) => e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight;

  uIOhook.on('keydown', (e) => {
    if (!isOpt(e) || optDown) return;
    optDown = true;
    startListening();
  });
  uIOhook.on('keyup', (e) => {
    if (!isOpt(e) || !optDown) return;
    optDown = false;
    stopListening();
  });
  try {
    uIOhook.start();
    console.log('[halo] hold ⌥ Option to talk (uiohook active)');
  } catch (err) {
    console.error(`[halo] uiohook failed to start (${err.message}) — hold-to-talk hotkey disabled; use the mic button instead.`);
  }

  // Headless-ish test hook: HALO_TEST_TASK="hover the Apple menu" npm start
  if (process.env.HALO_TEST_TASK) {
    setTimeout(() => runHaloTask(process.env.HALO_TEST_TASK), 1500);
  }

  // Simulates the space-circle-speak flow without a mic: draws a synthetic
  // circle in the middle of the screen and asks HALO_TEST_TEACH about it.
  if (process.env.HALO_TEST_TEACH) {
    setTimeout(async () => {
      const { width, height } = screen.getPrimaryDisplay().size;
      userPath = [];
      for (let a = 0; a <= Math.PI * 2 + 0.1; a += 0.05) {
        userPath.push({
          x: width / 2 + 220 * Math.cos(a),
          y: height / 2 + 150 * Math.sin(a),
        });
      }
      const task = process.env.HALO_TEST_TEACH;
      haloSend('halo-transcript', task);
      const shot = await captureScreen();
      const firstShot = await annotateShot(shot, userPath);
      if (process.env.HALO_DEBUG === '1') {
        require('node:fs').writeFileSync('/tmp/halo_annotated.png', Buffer.from(firstShot.base64, 'base64'));
      }
      runHaloTask(task, { firstShot, circled: true });
    }, 2500);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  uIOhook.stop();
});
