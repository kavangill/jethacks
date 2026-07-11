const { desktopCapturer, screen: escreen, nativeImage } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const path = require('node:path');
const execFileAsync = promisify(execFile);

// Claude sees the (possibly downscaled) screenshot; nut.js wants logical
// screen points. toScreenCoords maps image-space -> screen-space and clamps
// to the display so a hallucinated coordinate can't click a random corner.
const MAX_WIDTH = 1280;

let dims = null; // { displayW, displayH, imgW, imgH } — set on every capture

async function captureViaDesktopCapturer(targetW, targetH, primary) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetW, height: targetH },
  });
  const source =
    sources.find((s) => s.display_id === String(primary.id)) || sources[0];
  if (!source) throw new Error('No screen source');
  const image = source.thumbnail;
  if (image.isEmpty()) throw new Error('Blank screenshot');
  return image;
}

// Fallback: the screencapture CLI is TCC-attributed to the *responsible*
// process (the terminal that launched us), which often has Screen Recording
// permission even when the Electron app itself was denied.
async function captureViaScreencaptureCLI(targetW) {
  const tmp = path.join(os.tmpdir(), `halo-shot-${Date.now()}.png`);
  await execFileAsync('screencapture', ['-x', '-D', '1', tmp]);
  const image = nativeImage.createFromPath(tmp);
  require('node:fs').unlink(tmp, () => {});
  if (image.isEmpty()) throw new Error('screencapture produced a blank image');
  return image.resize({ width: targetW });
}

async function captureScreen() {
  const primary = escreen.getPrimaryDisplay();
  const { width: displayW, height: displayH } = primary.size; // logical points
  const targetW = Math.min(displayW, MAX_WIDTH);
  const targetH = Math.round(displayH * (targetW / displayW));

  let image;
  try {
    image = await captureViaDesktopCapturer(targetW, targetH, primary);
  } catch (err) {
    if (process.env.HALO_DEBUG === '1') {
      console.log(`[halo] desktopCapturer failed (${err.message}); trying screencapture CLI`);
    }
    image = await captureViaScreencaptureCLI(targetW);
  }

  const { width: imgW, height: imgH } = image.getSize();
  if (imgW === 0 || imgH === 0) {
    throw new Error('Blank screenshot — grant Screen Recording permission and fully relaunch.');
  }
  dims = { displayW, displayH, imgW, imgH };

  return { base64: image.toPNG().toString('base64'), width: imgW, height: imgH };
}

function toScreenCoords(x, y) {
  if (!dims) throw new Error('toScreenCoords called before first capture');
  const { displayW, displayH, imgW, imgH } = dims;
  const sx = Math.round((x * displayW) / imgW);
  const sy = Math.round((y * displayH) / imgH);
  const cx = Math.max(0, Math.min(displayW - 1, sx));
  const cy = Math.max(0, Math.min(displayH - 1, sy));
  if (process.env.HALO_DEBUG === '1') {
    console.log(`[halo] toScreenCoords image(${x},${y}) -> screen(${cx},${cy})`);
  }
  return { x: cx, y: cy };
}

function screenshotDims() {
  return dims;
}

module.exports = { captureScreen, toScreenCoords, screenshotDims };
