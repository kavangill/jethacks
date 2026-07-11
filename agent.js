const Anthropic = require('@anthropic-ai/sdk');
const { captureScreen } = require('./screen');
const actions = require('./actions');

const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS || '22', 10);
const API_TIMEOUT_MS = parseInt(process.env.HALO_API_TIMEOUT || '20000', 10);

const TOOLS = [
  {
    name: 'move_and_click',
    description:
      'Move the real cursor to (x, y) in SCREENSHOT pixel coordinates and click. Use for buttons, menus, links.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'double'] },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'move_only',
    description: 'Move the cursor to (x, y) without clicking — to hover or point.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'drag',
    description: 'Press at (from_x, from_y), drag to (to_x, to_y), release.',
    input_schema: {
      type: 'object',
      properties: {
        from_x: { type: 'number' },
        from_y: { type: 'number' },
        to_x: { type: 'number' },
        to_y: { type: 'number' },
      },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
    },
  },
  {
    name: 'type_text',
    description: 'Type text at the current focus. Click the target field first.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a key or combo, e.g. "Enter", "Escape", "Cmd+S".',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the surface under the cursor.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: '1-50, default 3' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'take_screenshot',
    description:
      'Take a fresh screenshot to verify the result of your last action — including checking that your drawings landed exactly on their targets.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'speak',
    description:
      'Say a short narration out loud mid-task ("opening the effects panel now"). Does not end the task.',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  // --- drawing: glowing annotations rendered on a transparent overlay ------
  {
    name: 'draw_ellipse',
    description:
      'Draw a glowing ellipse outline on the screen. Circle the thing you are talking about, or sketch circles for diagrams. Center (cx, cy) with radii rx/ry, in screenshot pixels.',
    input_schema: {
      type: 'object',
      properties: {
        cx: { type: 'number' },
        cy: { type: 'number' },
        rx: { type: 'number' },
        ry: { type: 'number' },
        color: { type: 'string', enum: ['red', 'blue', 'yellow'] },
      },
      required: ['cx', 'cy', 'rx', 'ry'],
    },
  },
  {
    name: 'draw_rect',
    description:
      'Draw a glowing rectangle outline — box a screen region, or sketch diagram shapes (e.g. the squares on each side of a right triangle).',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'left edge' },
        y: { type: 'number', description: 'top edge' },
        width: { type: 'number' },
        height: { type: 'number' },
        color: { type: 'string', enum: ['red', 'blue', 'yellow'] },
      },
      required: ['x', 'y', 'width', 'height'],
    },
  },
  {
    name: 'draw_line',
    description: 'Draw a glowing straight line from (x1, y1) to (x2, y2) — diagram edges, connections, underlines.',
    input_schema: {
      type: 'object',
      properties: {
        x1: { type: 'number' },
        y1: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        color: { type: 'string', enum: ['red', 'blue', 'yellow'] },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
  },
  {
    name: 'draw_arrow',
    description: 'Draw a glowing arrow from (x1, y1) pointing at (x2, y2) — point at something or show direction/flow.',
    input_schema: {
      type: 'object',
      properties: {
        x1: { type: 'number' },
        y1: { type: 'number' },
        x2: { type: 'number', description: 'arrowhead x' },
        y2: { type: 'number', description: 'arrowhead y' },
        color: { type: 'string', enum: ['red', 'blue', 'yellow'] },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
  },
  {
    name: 'draw_text',
    description:
      'Write short glowing marker text on the screen — label diagram parts ("a", "b²", "90°", "I₁"). (x, y) is the CENTER of the text. A few characters only; put full formulas on the board instead.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        text: { type: 'string' },
        size: { type: 'number', description: 'text height in screenshot px, default 34' },
        color: { type: 'string', enum: ['red', 'blue', 'yellow'] },
      },
      required: ['x', 'y', 'text'],
    },
  },
  {
    name: 'clear_drawings',
    description: 'Erase all your drawings. Use before starting a new diagram or when old highlights would clutter the screen.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'board_write',
    description:
      'Append one line to the formula board shown under your status bar. Math lines are LaTeX (no surrounding $), rendered beautifully: "a^2 + b^2 = c^2", "\\Sigma I_{in} = \\Sigma I_{out}", "c = \\sqrt{25} = 5". Write every formula you mention and every calculation step AS you do it. Set highlight for the key formula, and plain: true for non-math text (titles, notes).',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        highlight: { type: 'boolean' },
        plain: { type: 'boolean', description: 'render as plain text, not LaTeX' },
      },
      required: ['text'],
    },
  },
];

const DRAW_TOOLS = new Set(['draw_ellipse', 'draw_rect', 'draw_line', 'draw_arrow', 'draw_text', 'clear_drawings']);

function systemPrompt(w, h, circled) {
  return `You are Halo, a friendly teacher who can see the student's macOS screen. You point with a real glowing cursor and DRAW glowing shapes right on their screen.

Screenshots are ${w}x${h} pixels. All coordinates you output are absolute pixels in THAT screenshot's space.

VOICE — everything you speak() is read aloud:
- Short and simple. One idea per speak(), one or two plain sentences, words a five-year-old gets.
- Never lecture. Say a little, point or draw at it, then say the next little bit.
- Speech and drawing are synchronized: in each turn, put the speak() FIRST and then the drawings it narrates — those drawings appear on screen exactly as that sentence is spoken. Never draw things a sentence hasn't reached yet.

DRAWING — your best teaching tool, use it constantly:
- Draw at almost every step. A sketch beats a sentence.
- draw_ellipse to circle the exact thing you're talking about. draw_arrow to point or connect. draw_rect and draw_line to sketch real diagrams (e.g. a square on each side of a right triangle for the Pythagorean theorem).
- draw_text to LABEL what you draw — sides ("a", "b", "c"), values ("3", "5V"), angles ("90°"). A diagram without labels is half a diagram.
- Colors: red = the main thing, blue = supporting parts, yellow = extra emphasis or labels.
- AIM PRECISELY. When circling a real on-screen element, read its exact pixel position from the screenshot: center the ellipse on the element's center, and size rx/ry to half the element's width/height plus a small margin so the circle hugs it. An arrow's TIP must touch the target.
- Your drawings appear in the screenshots you take afterwards. When a mark must be exact (circling a button, a value, a plot feature), take_screenshot to verify it landed; if it's off, clear_drawings and redraw before moving on.
- clear_drawings before each new diagram or topic so the screen stays clean.
- The moving cursor's glowing trail is NOT screen content — ignore it.

BOARD — a math panel the student sees under your status bar, rendered as real typeset math:
- The moment you mention a formula, board_write it in LaTeX (highlight: true for the key one). Titles or plain notes get plain: true.
- Show every calculation step-by-step as you speak it: "a^2 + b^2 = c^2" → "3^2 + 4^2 = 9 + 16 = 25" → "c = \\sqrt{25} = 5". One short line per write.

RULES:
- Batch each step in one turn: a speak() plus ALL the drawing/board writes that go with it.
- 4-7 short steps, then finish with your final answer. The final answer is READ ALOUD to the student: one or two short plain sentences ONLY — no lists, no bullets, no emoji, no markdown, no coordinates.
- You MAY operate simple teaching tools when it genuinely helps the lesson: type an equation into a graphing calculator like Desmos (move_and_click its expression entry, type_text e.g. "y=x^2", press Enter), switch a visible tab, or scroll. A few deliberate steps, narrated as you go, verified with take_screenshot.
- NEVER touch anything destructive or stateful: no deleting, quitting, purchasing, sending, submitting forms, or entering personal data.
- If you can't clearly identify something, say so honestly instead of guessing.
${circled ? '- The student circled part of the screen with an ORANGE path drawn on the screenshot. Their question is about THAT region — focus there.\n' : ''}`;
}

function imageBlock(shot) {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: shot.base64 },
  };
}

const EXECUTORS = {
  move_and_click: (i) => actions.moveAndClick(i.x, i.y, i.button || 'left'),
  move_only: (i) => actions.moveOnly(i.x, i.y),
  drag: (i) => actions.drag(i.from_x, i.from_y, i.to_x, i.to_y),
  type_text: (i) => actions.typeText(i.text),
  press_key: (i) => actions.pressKey(i.key),
  scroll: (i) => actions.scroll(i.direction, i.amount),
  take_screenshot: async () => 'fresh screenshot attached',
};

// runAgent drives the loop. emit(event, data) surfaces progress to the UI:
//   'status'  -> 'thinking' | 'acting'
//   'log'     -> console-style line for the panel
//   'board'   -> formula board line
// speak(text) TTSes narration and resolves when the clip STARTS playing, so
// each turn's drawings appear in sync with their sentence.
// context is a short summary of the previous exchange (follow-ups/interrupts).
// abortState.aborted (set by the Escape kill switch) stops before each step.
async function runAgent(task, { emit, abortState, signal, firstShot, circled, draw, annotate, speak, context }) {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: API_TIMEOUT_MS,
    maxRetries: 1,
  });
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

  emit('status', 'thinking');
  let shot = firstShot || (await captureScreen());
  emit('shot', shot.base64);
  const sys = systemPrompt(shot.width, shot.height, circled);

  const messages = [
    {
      role: 'user',
      content: [
        imageBlock(shot),
        {
          type: 'text',
          text:
            (context ? `${context}\n\n` : '') +
            `Student's question (spoken aloud): ${task}`,
        },
      ],
    },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (abortState.aborted) return null;

    let response;
    try {
      response = await client.messages.create(
        { model, max_tokens: 2000, system: sys, tools: TOOLS, messages },
        { signal }
      );
    } catch (err) {
      if (abortState.aborted || signal?.aborted) return null; // barge-in cancelled the request
      throw err;
    }
    if (abortState.aborted) return null; // superseded while the request was in flight
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');

    // Surface Claude's interleaved reasoning text in the chat log (the final
    // no-tools text is reported separately as the answer, not as thinking).
    if (toolUses.length > 0) {
      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) emit('thinking', block.text.trim());
      }
    }

    if (toolUses.length === 0) {
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();
      return text || 'Done.';
    }

    emit('status', 'acting');
    const results = [];
    for (const tu of toolUses) {
      if (abortState.aborted) return null;

      let outcome;
      if (tu.name === 'speak') {
        // Blocks until this clip starts playing, so the drawings that follow
        // in this batch land on screen with the sentence, not ahead of it.
        outcome = speak ? await speak(tu.input.message) : 'spoken';
      } else if (tu.name === 'board_write') {
        emit('board', {
          text: String(tu.input.text || ''),
          highlight: !!tu.input.highlight,
          plain: !!tu.input.plain,
        });
        outcome = 'written on board';
      } else if (DRAW_TOOLS.has(tu.name)) {
        try {
          outcome = draw ? await draw(tu.name, tu.input) : 'FAILED: drawing unavailable';
        } catch (err) {
          outcome = `FAILED: ${err.message}`;
        }
      } else {
        try {
          outcome = await EXECUTORS[tu.name](tu.input);
        } catch (err) {
          outcome = `FAILED: ${err.message}`;
        }
      }
      console.log(`[halo] tool ${tu.name}(${JSON.stringify(tu.input)}) -> ${outcome}`);
      emit('log', `${tu.name} → ${outcome}`);

      // speak/draw/board don't change what Claude can see (drawings are
      // excluded from captures), so a fresh screenshot after them is wasted
      // tokens — only re-capture after tools that actually touch the screen.
      if (tu.name === 'speak' || tu.name === 'board_write' || DRAW_TOOLS.has(tu.name)) {
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: [{ type: 'text', text: outcome }],
        });
        continue;
      }

      shot = await captureScreen();
      // Composite the AI's own drawings onto the shot (they're excluded from
      // raw captures) so it can verify placement and fix a missed circle.
      if (annotate) shot = await annotate(shot);
      emit('shot', shot.base64);
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: [{ type: 'text', text: outcome }, imageBlock(shot)],
      });
    }
    messages.push({ role: 'user', content: results });
    emit('status', 'thinking');
  }

  // Step cap reached mid-lesson: ask for a closing summary with tools
  // disabled so the student gets a graceful wrap-up instead of a cutoff.
  if (abortState.aborted) return null;
  try {
    // Append to the trailing tool_result turn (roles must alternate).
    messages[messages.length - 1].content.push({
      type: 'text',
      text: 'You have reached your pointing-step limit. Give the student your final spoken wrap-up now — plain text, no tools.',
    });
    const closing = await client.messages.create(
      { model, max_tokens: 600, system: sys, messages },
      { signal }
    );
    if (abortState.aborted) return null;
    const text = closing.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    if (text) return text;
  } catch {
    // fall through to the generic wrap below
  }
  return "That's the guided tour for now — ask me a follow-up if you'd like to go deeper.";
}

module.exports = { runAgent };
