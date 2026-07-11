const Anthropic = require('@anthropic-ai/sdk');
const { captureScreen } = require('./screen');
const actions = require('./actions');

const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS || '16', 10);
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
    description: 'Take a fresh screenshot to verify the result of your last action.',
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
    name: 'clear_drawings',
    description: 'Erase all your drawings. Use before starting a new diagram or when old highlights would clutter the screen.',
    input_schema: { type: 'object', properties: {} },
  },
];

const DRAW_TOOLS = new Set(['draw_ellipse', 'draw_rect', 'draw_line', 'draw_arrow', 'clear_drawings']);

function systemPrompt(w, h, circled) {
  return `You are Halo, a friendly teacher who can see the student's macOS screen. You point with a real glowing cursor and DRAW glowing shapes right on their screen.

Screenshots are ${w}x${h} pixels. All coordinates you output are absolute pixels in THAT screenshot's space.

VOICE — everything you speak() is read aloud:
- Short and simple. One idea per speak(), one or two plain sentences, words a five-year-old gets.
- Never lecture. Say a little, point or draw at it, then say the next little bit.

DRAWING — your best teaching tool:
- draw_ellipse to circle the exact thing you're talking about. draw_arrow to point or connect. draw_rect and draw_line to sketch real diagrams (e.g. a square on each side of a right triangle for the Pythagorean theorem).
- Colors: red = the main thing, blue = supporting parts, yellow = extra emphasis or labels.
- Be accurate: match each shape to the element's true position and size in the screenshot. A circle around a button should hug it, not float nearby.
- clear_drawings before each new diagram or topic so the screen stays clean.
- Your drawings and cursor trail are visible to the student but NEVER appear in your screenshots — don't look for them there; trust they landed where you asked.

RULES:
- Batch each step in one turn: a speak() plus the pointing/drawing that goes with it.
- 3-5 short steps max, then finish with your final answer: one or two plain spoken sentences. No markdown, no coordinates.
- Only click when one simple click truly helps, never anything destructive, and say so first.
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
//   'speak'   -> mid-task narration text (caller TTSes it)
// abortState.aborted (set by the Escape kill switch) stops before each step.
async function runAgent(task, { emit, abortState, signal, firstShot, circled, draw }) {
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
        { type: 'text', text: `Student's question (spoken aloud): ${task}` },
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
        emit('speak', tu.input.message);
        outcome = 'spoken';
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

      // speak/draw don't change what Claude can see (drawings are excluded
      // from captures), so a fresh screenshot after them is wasted tokens —
      // only re-capture after tools that actually touch the screen.
      if (tu.name === 'speak' || DRAW_TOOLS.has(tu.name)) {
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: [{ type: 'text', text: outcome }],
        });
        continue;
      }

      shot = await captureScreen();
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
