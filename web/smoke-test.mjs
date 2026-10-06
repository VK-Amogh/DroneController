// smoke-test.mjs — verifies the arcade control scheme end-to-end.
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--window-size=1280,800'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('CONSOLE: ' + m.text());
});

await page.goto('http://localhost:5173/?autostart', { waitUntil: 'networkidle2' });
await page.waitForSelector('#osd:not(.hidden)', { timeout: 30000 });

const state = () => page.evaluate(() => {
  const p = window.sim.physics;
  return { pos: { ...p.position }, rotY: p.rotation.y, speed: p.speed };
});

// 1) Hover check: idle 4s — the drone must NOT drift upward on its own
await new Promise((r) => setTimeout(r, 4000));
const s0 = await state();
console.log('idle 4s:', JSON.stringify(s0));

// 2) W → forward (-z), fast
await page.keyboard.down('w');
await new Promise((r) => setTimeout(r, 3000));
const s1 = await state();
await page.keyboard.up('w');
console.log('3s W:', JSON.stringify(s1));

// 3) S → backward (+z)
await page.keyboard.down('s');
await new Promise((r) => setTimeout(r, 3000));
const s2 = await state();
await page.keyboard.up('s');
console.log('3s S:', JSON.stringify(s2));

// 4) A → strafe left (-x), D → strafe right (+x)
await page.keyboard.down('a');
await new Promise((r) => setTimeout(r, 2000));
const sA = await state();
await page.keyboard.up('a');
await page.keyboard.down('d');
await new Promise((r) => setTimeout(r, 2000));
const sD = await state();
await page.keyboard.up('d');
console.log('A then D:', JSON.stringify(sA), JSON.stringify(sD));

// 5) ArrowUp climbs, ArrowDown descends
await page.keyboard.down('ArrowUp');
await new Promise((r) => setTimeout(r, 2000));
const sUp = await state();
await page.keyboard.up('ArrowUp');
await page.keyboard.down('ArrowDown');
await new Promise((r) => setTimeout(r, 2000));
const sDn = await state();
await page.keyboard.up('ArrowDown');
console.log('Up then Down:', JSON.stringify(sUp), JSON.stringify(sDn));

// 6) Q/E yaw turns the drone
await page.keyboard.down('e');
await new Promise((r) => setTimeout(r, 1000));
const sYaw = await state();
await page.keyboard.up('e');

await page.screenshot({ path: 'smoke-flying.png' });

const checks = [
  ['hover: no self climb', Math.abs(s0.pos.y - 0.2) < 0.6, `y=${s0.pos.y.toFixed(2)}`],
  ['W forward + fast', s1.pos.z < s0.pos.z - 15 && s1.speed > 12, `z=${s1.pos.z.toFixed(1)} v=${s1.speed.toFixed(1)}`],
  ['S backward', s2.pos.z > s1.pos.z + 5, `z=${s2.pos.z.toFixed(1)}`],
  ['A strafe left', sA.pos.x < s2.pos.x - 5, `x=${sA.pos.x.toFixed(1)}`],
  ['D strafe right', sD.pos.x > sA.pos.x + 2, `x=${sD.pos.x.toFixed(1)}`],
  ['ArrowUp climbs', sUp.pos.y > sD.pos.y + 5, `y=${sUp.pos.y.toFixed(1)}`],
  ['ArrowDown descends', sDn.pos.y < sUp.pos.y - 5, `y=${sDn.pos.y.toFixed(1)}`],
  ['E yaws', sYaw.rotY > 0.5, `rotY=${sYaw.rotY.toFixed(2)}`],
  ['no js errors', errors.length === 0, errors.slice(0, 3).join(' | ')],
];

let ok = true;
for (const [name, pass, info] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  (${info})`);
  if (!pass) ok = false;
}
await browser.close();
process.exit(ok ? 0 : 1);
