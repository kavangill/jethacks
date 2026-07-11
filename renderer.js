const promptInput = document.getElementById('prompt');
const panel = document.getElementById('panel');
const scroll = document.getElementById('scroll');
const content = document.getElementById('content');
const kill = document.getElementById('kill');

const PANEL_MAX = 420;
const PANEL_PAD = 12; // #scroll vertical padding

// ---------------------------------------------------------------- markdown
// Line-based renderer mirroring cadgod's renderMarkdown: #/##/### headings,
// - bullets (→ •), **bold**, `code`, --- rules, _muted_ placeholders, and
// ▸/● leading markers recolored as accents.
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(line) {
  let html = escapeHtml(line);
  // **bold** — text between ** pairs (same split-on-** approach as cadgod)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  // `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  return html;
}

function renderMarkdown(md) {
  const out = [];
  for (const raw of md.split('\n')) {
    let line = raw;
    const trimmed = line.trim();

    if (trimmed === '---' || trimmed === '***') {
      out.push('<div class="hr"></div>');
      continue;
    }

    let cls = 'line';
    if (line.startsWith('### ')) { line = line.slice(4); cls = 'h3'; }
    else if (line.startsWith('## ')) { line = line.slice(3); cls = 'h2'; }
    else if (line.startsWith('# ')) { line = line.slice(2); cls = 'h1'; }
    else if (line.startsWith('- ') || line.startsWith('* ')) {
      line = '   •  ' + line.slice(2);
    } else if (trimmed.startsWith('_')) {
      cls = 'line muted';
    }

    // Leading ▸/● marker glyphs get the accent color.
    let prefix = '';
    if (line.startsWith('▸ ') || line.startsWith('● ')) {
      prefix = `<span class="marker">${line.slice(0, 2)}</span>`;
      line = line.slice(2);
    }

    out.push(`<div class="${cls}">${prefix}${renderInline(line)}</div>`);
  }
  return out.join('');
}

// ---------------------------------------------------------------- panel
// The OS window never resizes (that's what snapped) — the panel's height
// animates with CSS inside the fixed transparent window, growing upward
// since the bar is pinned to the bottom.
let history = ''; // rendered HTML of past turns
let currentMd = ''; // streaming markdown of the active turn

function redraw() {
  content.innerHTML = history + renderMarkdown(currentMd);
  const wanted = Math.min(content.scrollHeight + PANEL_PAD + 2, PANEL_MAX);
  panel.style.height = wanted + 'px';
  panel.classList.add('open');
  scroll.scrollTop = scroll.scrollHeight;
}

function hidePanel() {
  panel.classList.remove('open');
  panel.style.height = '0px';
  history = '';
  currentMd = '';
  content.innerHTML = '';
}

let generating = false;

function startGenerate(prompt) {
  generating = true;
  history += `<div class="line prompt">❯ ${escapeHtml(prompt)}</div>`;
  currentMd = '';
  promptInput.disabled = true;
  redraw();
  window.overlay.generate(prompt);
}

window.overlay.onChunk((text) => {
  currentMd += text;
  redraw();
});

window.overlay.onEnd(() => {
  history += renderMarkdown(currentMd);
  currentMd = '';
  generating = false;
  promptInput.disabled = false;
  promptInput.value = '';
  promptInput.focus();
});

window.overlay.onError((msg) => {
  history += renderMarkdown(currentMd) + `<div class="line error">✗ ${escapeHtml(msg)}</div>`;
  currentMd = '';
  generating = false;
  redraw();
  promptInput.disabled = false;
  promptInput.focus();
});

// ---------------------------------------------------------------- input
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !generating) {
    const value = promptInput.value.trim();
    if (!value) return;
    // "/do <task>" runs the Halo cursor agent from text (mic-less fallback).
    if (value.startsWith('/do ')) {
      promptInput.value = '';
      window.overlay.haloTask(value.slice(4).trim());
      return;
    }
    startGenerate(value);
  } else if (e.key === 'Escape' && !generating) {
    hidePanel();
    promptInput.value = '';
  }
});

kill.addEventListener('click', () => window.overlay.quit());

// ---------------------------------------------------------------- Halo voice
// Hold the mic button → record → release → STT → agent drives the cursor →
// TTS speaks the result. All heavy lifting is in the main process; this side
// only records audio and renders status.
const mic = document.getElementById('mic');

let recorder = null;
let recChunks = [];
let haloBusy = false;

function setMicState(state) {
  mic.className = state === 'idle' ? '' : state;
}

function haloLine(html) {
  history += html;
  redraw();
}

// mode: 'voice' (hold mic button) or 'teach' (Space toggle — main tracks the
// gesture trail and annotates the screenshot with what the student circled).
async function startRecording(mode) {
  if (haloBusy || recorder) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recChunks = [];
    recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recChunks, { type: 'audio/webm' });
      recorder = null;
      if (blob.size < 2000) { setMicState('idle'); return; } // accidental tap
      haloBusy = true;
      setMicState('transcribing');
      const send = mode === 'teach' ? window.overlay.haloTeach : window.overlay.haloVoice;
      const res = await send(await blob.arrayBuffer(), 'audio/webm');
      if (res && res.error) {
        haloBusy = false;
        setMicState('idle');
        haloLine(`<div class="line error">✗ ${escapeHtml(res.error)}</div>`);
      }
    };
    recorder.start();
    setMicState('recording');
  } catch (err) {
    haloLine(`<div class="line error">✗ mic: ${escapeHtml(err.message)}</div>`);
  }
}

function stopRecording() {
  if (recorder && recorder.state === 'recording') recorder.stop();
}

mic.addEventListener('mousedown', () => startRecording('voice'));
mic.addEventListener('mouseup', stopRecording);
mic.addEventListener('mouseleave', stopRecording);

// Space-toggled teaching mode, driven from main's global shortcut.
window.overlay.onHaloListenStart(() => startRecording('teach'));
window.overlay.onHaloListenStop(() => stopRecording());

window.overlay.onHaloTranscript((t) => {
  haloLine(`<div class="line prompt">🎙 ${escapeHtml(t)}</div>`);
});

window.overlay.onHaloStatus((s) => {
  setMicState(s);
  if (s === 'idle') haloBusy = false;
});

window.overlay.onHaloLog((line) => {
  haloLine(`<div class="line muted">${escapeHtml(line)}</div>`);
});

window.overlay.onHaloError((msg) => {
  haloLine(`<div class="line error">✗ ${escapeHtml(msg)}</div>`);
});

// Screenshots the agent takes, shown inline in the chat log.
window.overlay.onHaloShot((b64) => {
  haloLine(`<img class="shot" src="data:image/png;base64,${b64}" />`);
  // Images size in after decode; recompute the panel height once they have.
  setTimeout(redraw, 150);
});

// Claude's interleaved reasoning while it works.
window.overlay.onHaloThinking((text) => {
  haloLine(`<div class="line thinking">${escapeHtml(text)}</div>`);
});

// TTS mp3s from main, played in order.
const audioQueue = [];
let playing = false;
function playNext() {
  if (playing || audioQueue.length === 0) return;
  playing = true;
  const el = new Audio('data:audio/mpeg;base64,' + audioQueue.shift());
  el.onended = el.onerror = () => { playing = false; playNext(); };
  el.play().catch(() => { playing = false; playNext(); });
}
window.overlay.onHaloAudio((b64) => {
  audioQueue.push(b64);
  playNext();
});

// ---------------------------------------------------------------- click-through
// Most of the fixed-size window is empty transparent space; forward mouse
// events to whatever app is underneath unless the cursor is over an island.
let ignoring = true;
window.addEventListener('mousemove', (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const overIsland = !!(el && el.closest('.island'));
  if (overIsland === ignoring) {
    ignoring = !overIsland;
    window.overlay.setIgnoreMouse(ignoring);
  }
});
