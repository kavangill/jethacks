const promptInput = document.getElementById('prompt');
const panel = document.getElementById('panel');
const scroll = document.getElementById('scroll');
const content = document.getElementById('content');
const kill = document.getElementById('kill');

const PANEL_MAX = 420;
const PANEL_PAD = 12; // #scroll vertical padding

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(line) {
  let html = escapeHtml(line);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
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

    let prefix = '';
    if (line.startsWith('▸ ') || line.startsWith('● ')) {
      prefix = `<span class="marker">${line.slice(0, 2)}</span>`;
      line = line.slice(2);
    }

    out.push(`<div class="${cls}">${prefix}${renderInline(line)}</div>`);
  }
  return out.join('');
}

let history = '';
let currentMd = '';

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

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !generating) {
    const value = promptInput.value.trim();
    if (!value) return;
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

const mic = document.getElementById('mic');

let recorder = null;
let recChunks = [];
let haloBusy = false;
let cancelNext = false;
let currentStatus = 'idle';

const BUSY_STATES = ['thinking', 'acting', 'transcribing', 'speaking'];

function setMicState(state) {
  currentStatus = state;
  mic.className = state === 'idle' ? '' : state;
}

function haloLine(html) {
  history += html;
  redraw();
}

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
      if (cancelNext) { cancelNext = false; setMicState('idle'); return; }
      if (blob.size < 2000) { setMicState('idle'); return; }
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

mic.addEventListener('click', () => {
  if (BUSY_STATES.includes(currentStatus)) window.overlay.haloAbort();
});

const spin = document.getElementById('spin');
spin.addEventListener('click', () => window.overlay.haloAbort());
const board = document.getElementById('board');
const boardContent = document.getElementById('board-content');
window.overlay.onHaloLoading((on) => {
  document.body.classList.toggle('loading', on);
  if (on) {
    boardContent.innerHTML = '';
    board.classList.remove('has');
  } else {
    redraw();
  }
});

function mathHtml(text, displayMode) {
  if (typeof katex === 'undefined') return escapeHtml(text);
  try {
    return katex.renderToString(text, { throwOnError: false, displayMode });
  } catch {
    return escapeHtml(text);
  }
}

window.overlay.onHaloBoard(({ text, highlight, plain }) => {
  const div = document.createElement('div');
  div.className = 'bline' + (highlight ? ' hl' : '') + (plain ? ' plain' : '');
  if (plain) div.textContent = text;
  else div.innerHTML = mathHtml(text, true);
  boardContent.appendChild(div);
  board.classList.add('has');
  board.scrollTop = board.scrollHeight;
  const echo = plain ? escapeHtml(text) : mathHtml(text, false);
  haloLine(`<div class="line bmath${highlight ? ' hl' : ''}">${echo}</div>`);
});

window.overlay.onHaloListenStart(() => {
  haloBusy = false;
  cancelNext = false;
  startRecording('teach');
});
window.overlay.onHaloListenStop(() => stopRecording());

window.overlay.onHaloListenCancel(() => {
  cancelNext = true;
  stopRecording();
});

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

window.overlay.onHaloShot((b64) => {
  haloLine(`<img class="shot" src="data:image/png;base64,${b64}" />`);
  setTimeout(redraw, 150);
});

window.overlay.onHaloThinking((text) => {
  haloLine(`<div class="line thinking">${escapeHtml(text)}</div>`);
});

const audioQueue = [];
let playing = false;
let currentAudioEl = null;
function playNext() {
  if (playing) return;
  if (audioQueue.length === 0) {
    window.overlay.haloAudioDone();
    return;
  }
  const clip = audioQueue.shift();
  playing = true;
  window.overlay.haloAudioPlaying(clip.id);
  currentAudioEl = new Audio('data:audio/mpeg;base64,' + clip.b64);
  currentAudioEl.onended = currentAudioEl.onerror = () => { playing = false; currentAudioEl = null; playNext(); };
  currentAudioEl.play().catch(() => { playing = false; currentAudioEl = null; playNext(); });
}
window.overlay.onHaloAudio((clip) => {
  audioQueue.push(clip);
  playNext();
});

window.overlay.onHaloAudioStop(() => {
  audioQueue.length = 0;
  playing = false;
  if (currentAudioEl) {
    currentAudioEl.onended = currentAudioEl.onerror = null;
    currentAudioEl.pause();
    currentAudioEl.src = '';
    currentAudioEl = null;
  }
});

let ignoring = true;
window.addEventListener('mousemove', (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const overIsland = !!(el && el.closest('.island'));
  if (overIsland === ignoring) {
    ignoring = !overIsland;
    window.overlay.setIgnoreMouse(ignoring);
  }
});
