// Step-2 proof from the build order: if this moves the real cursor,
// the hardest dependency (nut.js + Accessibility permission) works.
const { mouse, straightTo, Point } = require('@nut-tree-fork/nut-js');

(async () => {
  const before = await mouse.getPosition();
  console.log('cursor before:', before);
  mouse.config.mouseSpeed = 1500;
  await mouse.move(straightTo(new Point(500, 500)));
  const after = await mouse.getPosition();
  console.log('cursor after :', after);
  const moved = Math.abs(after.x - 500) < 5 && Math.abs(after.y - 500) < 5;
  console.log(moved ? 'CURSOR MOVED ✅' : 'CURSOR DID NOT MOVE ❌ — grant Accessibility permission');
  process.exit(moved ? 0 : 1);
})();
