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
    startGenerate(value);
  } else if (e.key === 'Escape' && !generating) {
    hidePanel();
    promptInput.value = '';
  }
});

kill.addEventListener('click', () => window.overlay.quit());

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
