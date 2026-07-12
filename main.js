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

const WIN_WIDTH = 560;
const BAR_HEIGHT = 42;
const GAP = 6;
const PANEL_MAX = 420;
const WIN_HEIGHT = PANEL_MAX + GAP + BAR_HEIGHT;

let win;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const x = Math.round((width - WIN_WIDTH) / 2);
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

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');

  // macOS keeps dropping always-on-top, reassert on focus changes
  win.on('blur', () => win.setAlwaysOnTop(true, 'screen-saver', 1));
  win.on('show', () => win.setAlwaysOnTop(true, 'screen-saver', 1));

  win.setIgnoreMouseEvents(true, { forward: true });
  win.setContentProtection(true); // hide overlay from screenshots
}

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
  trailWin.setContentProtection(true);
  trailWin.setBounds(bounds); // re-assert, macOS clamps below menu bar on creation
  trailWin.loadFile('trail.html');
}

function trailOrigin() {
  if (!trailWin || trailWin.isDestroyed()) return { x: 0, y: 0 };
  const b = trailWin.getBounds();
  return { x: b.x, y: b.y };
}

ipcMain.on('set-ignore-mouse', (_event, ignore) => {
  if (!win) return;
  if (agentActive && !ignore) return; // keep click-through while agent drives cursor
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
          } catch {}
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

const { runAgent } = require('./agent');
const { transcribe, tts } = require('./voice');
const { captureScreen, screenshotDims } = require('./screen');

let agentActive = false;

// barge-in bumps this so stale runs/emits get ignored instead of racing
let runGeneration = 0;
let currentAbort = null;
let currentController = null;
let audioPending = false;

let clipSeq = 0;
const clipStartWaiters = new Map();

let lastLesson = null; // { task, answer }

function lessonContext() {
  if (!lastLesson) return '';
  if (lastLesson.answer) {
    return `Context: the student's previous question was "${lastLesson.task}" and you finished answering: "${lastLesson.answer}". If this new request is a follow-up, build on that; otherwise start fresh.`;
  }
  return `Context: you were interrupted mid-explanation of "${lastLesson.task}". The student's new request below may adjust or redirect that explanation — follow the new request.`;
}

function haloSend(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

let trailTimer = null;
let trailHideTimer = null;
let userPath = [];

function startTrail(mode) {
  if (!trailWin || trailWin.isDestroyed()) return;
  if (mode === 'user') userPath = [];
  if (trailHideTimer) { clearTimeout(trailHideTimer); trailHideTimer = null; }
  shapesDrawn = 0;
  trailWin.webContents.send('trail-clear');
  trailWin.webContents.send('trail-mode', mode);
  trailWin.setBounds(screen.getPrimaryDisplay().bounds);
  trailWin.showInactive();
  trailWin.setAlwaysOnTop(true, 'screen-saver', 2);
  trailWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const o = trailOrigin();
  if (trailTimer) clearInterval(trailTimer);
  trailTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    if (mode === 'user') {
      userPath.push({ x: p.x, y: p.y });
      if (userPath.length > 4000) userPath.shift();
    }
    trailWin.webContents.send('trail-point', p.x - o.x, p.y - o.y);
  }, 16);
}

function stopTrail() {
  if (trailTimer) clearInterval(trailTimer);
  trailTimer = null;
  if (trailHideTimer) clearTimeout(trailHideTimer);
  trailHideTimer = setTimeout(() => {
    trailHideTimer = null;
    if (!trailTimer && trailWin && !trailWin.isDestroyed()) {
      trailWin.hide();
      shapesDrawn = 0;
      trailWin.webContents.send('trail-clear');
    }
  }, 1500);
}

let shapesDrawn = 0;

function execDraw(name, input) {
  if (!trailWin || trailWin.isDestroyed()) return 'FAILED: drawing window unavailable';
  if (name === 'clear_drawings') {
    shapesDrawn = 0;
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
  } else if (name === 'draw_text') {
    const text = String(input.text || '').slice(0, 60).trim();
    if (!text) return 'FAILED: empty text';
    Object.assign(s, { type: 'text', x: input.x * k, y: input.y * k, size: (input.size || 34) * k, text });
  } else {
    return `FAILED: unknown drawing tool ${name}`;
  }
  for (const v of Object.values(s)) {
    if (typeof v === 'number' && !Number.isFinite(v)) return 'FAILED: bad coordinates';
  }
  const o = trailOrigin();
  for (const f of ['cx', 'x', 'x1', 'x2']) if (s[f] != null) s[f] -= o.x;
  for (const f of ['cy', 'y', 'y1', 'y2']) if (s[f] != null) s[f] -= o.y;
  if (!trailWin.isVisible()) {
    trailWin.showInactive();
    trailWin.setAlwaysOnTop(true, 'screen-saver', 2);
  }
  shapesDrawn++;
  trailWin.webContents.send('draw-shape', s);
  return `drew ${s.type} (${s.color})`;
}

function annotateShapes(shot) {
  return new Promise((resolve) => {
    if (!shapesDrawn || !trailWin || trailWin.isDestroyed()) return resolve(shot);
    const d = screenshotDims();
    if (!d) return resolve(shot);
    const o = trailOrigin();
    let done = false;
    const onDone = (_e, b64) => {
      if (done) return;
      done = true;
      resolve({ base64: b64, width: shot.width, height: shot.height });
    };
    ipcMain.once('annotate-shapes-done', onDone);
    trailWin.webContents.send('annotate-shapes', shot.base64, {
      k: d.imgW / d.displayW,
      ox: o.x,
      oy: o.y,
    });
    setTimeout(() => {
      if (!done) {
        done = true;
        ipcMain.removeListener('annotate-shapes-done', onDone);
        resolve(shot);
      }
    }, 3000);
  });
}

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
    const onDone = (_e, b64) => {
      if (done) return;
      done = true;
      resolve({ base64: b64, width: shot.width, height: shot.height });
    };
    ipcMain.once('annotate-done', onDone);
    trailWin.webContents.send('annotate', shot.base64, scaled);
    setTimeout(() => {
      if (!done) {
        done = true;
        ipcMain.removeListener('annotate-done', onDone);
        resolve(shot);
      }
    }, 3000);
  });
}

const BOARD_MAX = 360;
let savedBounds = null;

function enterLoadingLayout() {
  if (!win || win.isDestroyed() || savedBounds) return;
  savedBounds = win.getBounds();
  const wa = screen.getPrimaryDisplay().workArea;
  const x = Math.round(wa.x + (wa.width - WIN_WIDTH) / 2);
  const y = wa.y + 6;
  haloSend('halo-loading', true);
  win.setResizable(true);
  win.setBounds({ x, y, width: WIN_WIDTH, height: BAR_HEIGHT + 6 + BOARD_MAX }, true);
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

let listening = false;

function cancelCurrentRun() {
  runGeneration++;
  if (currentController) currentController.abort();
  if (currentAbort) currentAbort.aborted = true;
  audioPending = false;
  for (const resolve of clipStartWaiters.values()) resolve();
  clipStartWaiters.clear();
  haloSend('halo-audio-stop');
}

function startListening() {
  if (listening) return;
  cancelCurrentRun();
  agentActive = false;
  exitLoadingLayout();
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
  haloSend('halo-listen-stop');
}

function cancelEverything(reason) {
  cancelCurrentRun();
  if (listening) {
    listening = false;
    haloSend('halo-listen-cancel');
  }
  stopTrail();
  exitLoadingLayout();
  agentActive = false;
  haloSend('halo-log', `aborted (${reason})`);
  haloSend('halo-status', 'idle');
}

function toSpokenText(text) {
  return text.replace(/\*\*?|__|`|^#+\s*|^\s*[-•]\s*/gm, '');
}

async function speakOut(text, myAbort, myGen) {
  try {
    const mp3 = await tts(toSpokenText(text));
    if (myAbort.aborted || myGen !== runGeneration) return;
    audioPending = true;
    haloSend('halo-audio', { id: ++clipSeq, b64: mp3.toString('base64') });
  } catch (err) {
    if (myAbort.aborted || myGen !== runGeneration) return;
    console.error('[halo] TTS failed:', err.message);
    haloSend('halo-log', `TTS failed: ${err.message}`);
  }
}

ipcMain.on('halo-audio-playing', (_e, id) => {
  const resolve = clipStartWaiters.get(id);
  if (resolve) {
    resolve();
    clipStartWaiters.delete(id);
  }
});

async function runHaloTask(task, opts = {}) {
  const myAbort = { aborted: false };
  const myController = new AbortController();
  require('node:events').setMaxListeners(64, myController.signal);
  const myGen = ++runGeneration;
  currentAbort = myAbort;
  currentController = myController;
  agentActive = true;
  win.setIgnoreMouseEvents(true, { forward: true });
  enterLoadingLayout();
  startTrail('ai');

  const context = lessonContext();
  lastLesson = { task, answer: null };

  const stale = () => myGen !== runGeneration;

  const emit = (event, data) => {
    if (stale()) return;
    if (event === 'status') haloSend('halo-status', data);
    else if (event === 'log') haloSend('halo-log', data);
    else if (event === 'shot') haloSend('halo-shot', data);
    else if (event === 'thinking') haloSend('halo-thinking', data);
    else if (event === 'board') haloSend('halo-board', data);
  };

  const speakAndWait = async (text) => {
    if (myAbort.aborted || stale()) return 'skipped (cancelled)';
    let mp3;
    try {
      mp3 = await tts(toSpokenText(text));
    } catch (err) {
      console.error('[halo] TTS failed:', err.message);
      haloSend('halo-log', `TTS failed: ${err.message}`);
      return `FAILED to speak: ${err.message}`;
    }
    if (myAbort.aborted || stale()) return 'skipped (cancelled)';
    audioPending = true;
    const id = ++clipSeq;
    const started = new Promise((resolve) => clipStartWaiters.set(id, resolve));
    haloSend('halo-audio', { id, b64: mp3.toString('base64') });
    await Promise.race([started, new Promise((r) => setTimeout(r, 30000))]);
    clipStartWaiters.delete(id);
    return 'spoken';
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
      annotate: annotateShapes,
      speak: speakAndWait,
      context,
    });
    if (myAbort.aborted || stale()) return;
    console.log(`[halo] final: ${finalText}`);
    lastLesson = { task, answer: String(finalText).slice(0, 400) };
    haloSend('halo-log', `✓ ${finalText}`);
    haloSend('halo-status', 'speaking');
    await speakOut(finalText, myAbort, myGen);
  } catch (err) {
    if (stale()) return;
    console.error('[halo] agent error:', err);
    haloSend('halo-error', err.message);
    await speakOut('Sorry, something went wrong with that.', myAbort, myGen);
  } finally {
    if (!stale()) {
      agentActive = false;
      if (!listening && !audioPending) {
        stopTrail();
        exitLoadingLayout();
        haloSend('halo-status', 'idle');
      }
    }
  }
}

ipcMain.on('halo-audio-done', () => {
  audioPending = false;
  if (!agentActive && !listening) {
    stopTrail();
    exitLoadingLayout();
    haloSend('halo-status', 'idle');
  }
});

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
    runHaloTask(task);
    return { task };
  } catch (err) {
    exitLoadingLayout();
    haloSend('halo-status', 'idle');
    return { error: err.message };
  }
});

ipcMain.handle('halo-task', async (_event, task) => {
  haloSend('halo-transcript', task);
  runHaloTask(task);
  return { task };
});

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
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });
  if (process.platform === 'darwin') app.dock.hide(); // needed for always-on-top over fullscreen spaces
  createWindow();
  createTrailWindow();

  const escOk = globalShortcut.register('Escape', () => cancelEverything('Escape'));
  console.log(escOk ? '[halo] Escape kill switch armed' : '[halo] FAILED to register Escape');

  // uiohook for real key hold/release, globalShortcut has no key-up event
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

  if (process.env.HALO_TEST_TASK) {
    setTimeout(() => runHaloTask(process.env.HALO_TEST_TASK), 1500);
  }

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

  // HALO_TEST_GRID=/path/out.png npm start — calibration check
  if (process.env.HALO_TEST_GRID) {
    setTimeout(async () => {
      const { nativeImage } = require('electron');
      const { execFile } = require('node:child_process');
      trailWin.setContentProtection(false); // must be visible to the capture
      trailWin.webContents.send('trail-bg', '#000'); // opaque: kill wallpaper noise
      const shot = await captureScreen(); // establishes dims
      startTrail('ai');
      console.log(`[grid] trailWin bounds: ${JSON.stringify(trailWin.getBounds())}`);
      const rx = Math.round(shot.width * 0.15), ry = Math.round(shot.height * 0.15);
      const rw = Math.round(shot.width * 0.7), rh = Math.round(shot.height * 0.7);
      execDraw('draw_rect', { x: rx, y: ry, width: rw, height: rh, color: 'red' });
      setTimeout(() => {
        const out = process.env.HALO_TEST_GRID;
        execFile('screencapture', ['-x', '-D', '1', out], () => {
          const img = nativeImage.createFromPath(out);
          const { width: W, height: H } = img.getSize();
          const d = screenshotDims();
          const s = W / d.displayW; // capture px per logical px (retina = 2)
          const k = d.displayW / d.imgW; // logical px per image px
          const exp = { L: rx * k * s, T: ry * k * s, R: (rx + rw) * k * s, B: (ry + rh) * k * s };
          const bmp = img.toBitmap(); // BGRA
          const yStart = Math.round((trailWin.getBounds().y + 4) * s); // skip menu-bar band
          let minX = W, minY = H, maxX = -1, maxY = -1;
          for (let y = yStart; y < H; y += 2) {
            for (let x = 0; x < W; x += 2) {
              const i = (y * W + x) * 4;
              if (bmp[i + 2] > 190 && bmp[i + 1] < 110 && bmp[i] < 110) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          const f = (n) => Math.round(n);
          console.log(`[grid] expected L:${f(exp.L)} T:${f(exp.T)} R:${f(exp.R)} B:${f(exp.B)}`);
          console.log(`[grid] measured L:${minX} T:${minY} R:${maxX} B:${maxY}`);
          console.log(`[grid] deltas   L:${f(minX - exp.L)} T:${f(minY - exp.T)} R:${f(maxX - exp.R)} B:${f(maxY - exp.B)} (capture px; stroke≈±10 ok)`);
          app.quit();
        });
      }, 1500);
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
