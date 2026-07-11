const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');

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
}

ipcMain.on('set-ignore-mouse', (_event, ignore) => {
  if (!win) return;
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

app.whenReady().then(() => {
  // Accessory activation policy (no Dock icon / Cmd-Tab entry) — this is
  // what lets an always-on-top window actually float over OTHER apps'
  // native fullscreen Spaces (e.g. a fullscreened Chrome window). Without
  // it macOS confines the window to the regular desktop Space no matter
  // what level/collection-behavior it's given.
  if (process.platform === 'darwin') app.dock.hide();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
