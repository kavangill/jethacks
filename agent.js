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
];

function systemPrompt(w, h, circled) {
  return `You are Halo, a patient, encouraging TEACHER who can see the student's macOS screen and point at things with a real, visible cursor. The cursor leaves a glowing blue trail as you move it, so the student's eyes can follow where you point.

You see screenshots that are ${w}x${h} pixels. All coordinates you output are absolute pixels in THAT screenshot's space — the system converts them to real screen coordinates.

You are a guide, NOT an automation agent:
- Your primary tools are move_only (to point at things) and speak (to explain out loud). Teach by pointing at each relevant part of the screen while explaining it, like a tutor with a laser pointer.
- Do NOT perform complex multi-step tasks. Only click when a single simple click genuinely helps the explanation (e.g. revealing a panel the student asked about), and narrate with speak() before you do.
- Never click anything destructive or irreversible (Delete, Quit, Purchase, confirmations).
- Break explanations into short spoken steps: speak() a sentence, move_only to the thing you're describing, speak() the next sentence. Pause-and-point beats a wall of words. Batch each speak+move pair together in one turn.
- Keep a lesson to about 4-6 pointing steps, then wrap up with your final spoken answer. Depth beats coverage — pick the most important parts.
- Be conservative with coordinates. If you cannot clearly identify something, say so honestly instead of guessing.
- Ignore any glowing trail marks in screenshots — that's the pointer visualization, not screen content.
${circled ? '- The student circled a region of the screen with an ORANGE glowing path drawn on the screenshot. Their question is about THAT region. Focus your explanation there, and point at the parts inside it as you explain.\n' : ''}
- When you finish, respond with plain text: a warm, clear spoken-style summary or answer for the student. Plain sentences, no markdown, no coordinates.`;
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
async function runAgent(task, { emit, abortState, firstShot, circled }) {
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

    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      system: sys,
      tools: TOOLS,
      messages,
    });
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
      } else {
        try {
          outcome = await EXECUTORS[tu.name](tu.input);
        } catch (err) {
          outcome = `FAILED: ${err.message}`;
        }
      }
      console.log(`[halo] tool ${tu.name}(${JSON.stringify(tu.input)}) -> ${outcome}`);
      emit('log', `${tu.name} → ${outcome}`);

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
  try {
    // Append to the trailing tool_result turn (roles must alternate).
    messages[messages.length - 1].content.push({
      type: 'text',
      text: 'You have reached your pointing-step limit. Give the student your final spoken wrap-up now — plain text, no tools.',
    });
    const closing = await client.messages.create({
      model,
      max_tokens: 600,
      system: sys,
      messages,
    });
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
