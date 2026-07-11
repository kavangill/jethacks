const {
  mouse,
  keyboard,
  straightTo,
  Point,
  Button,
  Key,
} = require('@nut-tree-fork/nut-js');
const { toScreenCoords } = require('./screen');

// Slow enough that the demo audience can watch the cursor travel.
mouse.config.mouseSpeed = 1500;
keyboard.config.autoDelayMs = 15;

const KEY_MAP = {
  cmd: Key.LeftCmd, command: Key.LeftCmd, meta: Key.LeftCmd,
  ctrl: Key.LeftControl, control: Key.LeftControl,
  alt: Key.LeftAlt, option: Key.LeftAlt,
  shift: Key.LeftShift,
  enter: Key.Enter, return: Key.Enter,
  escape: Key.Escape, esc: Key.Escape,
  tab: Key.Tab, space: Key.Space, backspace: Key.Backspace, delete: Key.Delete,
  up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right,
  home: Key.Home, end: Key.End, pageup: Key.PageUp, pagedown: Key.PageDown,
};

function parseCombo(combo) {
  return combo.split('+').map((part) => {
    const p = part.trim().toLowerCase();
    if (KEY_MAP[p]) return KEY_MAP[p];
    if (/^[a-z]$/.test(p)) return Key[p.toUpperCase()];
    if (/^[0-9]$/.test(p)) return Key[`Num${p}`];
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(p)) return Key[p.toUpperCase()];
    throw new Error(`Unknown key: "${part}"`);
  });
}

async function moveAndClick(x, y, button = 'left') {
  const p = toScreenCoords(x, y);
  await mouse.move(straightTo(new Point(p.x, p.y)));
  if (button === 'right') await mouse.click(Button.RIGHT);
  else if (button === 'double') await mouse.doubleClick(Button.LEFT);
  else await mouse.click(Button.LEFT);
  return `clicked ${button} at screen (${p.x}, ${p.y})`;
}

async function moveOnly(x, y) {
  const p = toScreenCoords(x, y);
  await mouse.move(straightTo(new Point(p.x, p.y)));
  return `moved to screen (${p.x}, ${p.y})`;
}

async function drag(fromX, fromY, toX, toY) {
  const from = toScreenCoords(fromX, fromY);
  const to = toScreenCoords(toX, toY);
  await mouse.move(straightTo(new Point(from.x, from.y)));
  await mouse.drag(straightTo(new Point(to.x, to.y)));
  return `dragged (${from.x}, ${from.y}) -> (${to.x}, ${to.y})`;
}

async function typeText(text) {
  await keyboard.type(text);
  return `typed ${text.length} chars`;
}

async function pressKey(combo) {
  const keys = parseCombo(combo);
  await keyboard.pressKey(...keys);
  await keyboard.releaseKey(...keys.slice().reverse());
  return `pressed ${combo}`;
}

async function scroll(direction, amount = 3) {
  const n = Math.max(1, Math.min(50, Math.round(amount)));
  if (direction === 'up') await mouse.scrollUp(n * 100);
  else if (direction === 'down') await mouse.scrollDown(n * 100);
  else if (direction === 'left') await mouse.scrollLeft(n * 100);
  else if (direction === 'right') await mouse.scrollRight(n * 100);
  else throw new Error(`Bad scroll direction: ${direction}`);
  return `scrolled ${direction} ${n}`;
}

module.exports = { moveAndClick, moveOnly, drag, typeText, pressKey, scroll };
