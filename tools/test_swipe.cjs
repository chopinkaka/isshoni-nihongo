/* 실제 모바일 터치로 카드 되돌아보기·채점 보호·세로 스크롤을 검사한다.
   실행: node tools/test_swipe.cjs (playwright와 Chromium/Edge 필요) */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Core = require('../core.js');
const root = path.resolve(__dirname, '..');
const { chromium } = require(require.resolve('playwright', { paths: [root, process.env.NODE_PATH || '',
  'C:/Users/USER-1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'] }));
const data = Core.indexData(Object.fromEntries(['words', 'patterns', 'kana', 'schedule'].map(n => [n, JSON.parse(fs.readFileSync(path.join(root, 'data', n + '.json'), 'utf8'))])));
const server = http.createServer((req, res) => {
  const p = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (p !== root && !p.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  const file = p === root ? path.join(root, 'index.html') : p;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  const types = { '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html' };
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
let browser;
let checks = 0;
function equal(actual, expected, label) { assert.deepEqual(actual, expected, label); checks++; }
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bundled = chromium.executablePath();
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(bundled) ? bundled : edge });
  async function open(date, seed) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const state = seed || Core.defaultState();
    state.user = { name: '검사', role: 'dad' };
    state.settings.autoSpeak = false; state.settings.voiceSkip = true;
    await context.addInitScript(s => localStorage.setItem('isshoni.v1.test', JSON.stringify(s)), state);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/?date=${date}#/today`);
    await page.locator('[data-act=start]').click();
    await page.locator('.session-card').waitFor();
    const cdp = await context.newCDPSession(page);
    const snapshot = () => page.evaluate(() => localStorage.getItem('isshoni.v1.test'));
    const progress = () => page.locator('[role=progressbar]').getAttribute('aria-valuenow');
    const title = () => page.locator('.session-card .bigjp').first().textContent();
    async function swipe(dx, dy = 0, selector = '.session-card .bigjp') {
      const box = await page.locator(selector).first().boundingBox();
      const x = dx < 0 ? 285 : 95, y = Math.min(box.y + box.height / 2, 550);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 6, y: y + dy * i / 6 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(450);
    }
    return { page, context, snapshot, progress, title, swipe, errors };
  }
  const a = await open('2026-10-05');
  const ids = data.dayByDate['2026-10-05'].newWords;
  equal(await a.title(), data.wordsById[ids[0]].jp, 'first word');
  equal(await a.page.locator('[data-act=session-prev]').isDisabled(), true, 'first card cannot go back');
  const first = await a.snapshot();
  await a.swipe(150);
  equal(await a.snapshot(), first, 'right swipe at start leaves records untouched');
  await a.swipe(-160);
  equal(await a.title(), data.wordsById[ids[1]].jp, 'left swipe advances new word');
  await a.page.locator('[data-act=learned]').click();
  equal(await a.title(), data.wordsById[ids[2]].jp, 'next button still advances');
  const saved = await a.snapshot(), pct = await a.progress();
  await a.swipe(160);
  equal(await a.title(), data.wordsById[ids[1]].jp, 'right swipe shows previous word');
  equal(await a.page.locator('.history-note').count(), 1, 'history notice');
  equal(await a.page.locator('[data-act=learned], [data-act=grade]').count(), 0, 'history has no grading or completion buttons');
  equal(await a.snapshot(), saved, 'history does not change saved records');
  equal(await a.progress(), pct, 'history keeps actual progress');
  await a.page.locator('[data-act=session-prev]').click();
  equal(await a.title(), data.wordsById[ids[0]].jp, 'previous button browses farther back');
  await a.page.locator('[data-act=session-next]').click();
  await a.swipe(-160);
  equal(await a.title(), data.wordsById[ids[2]].jp, 'forward swipe returns to current word');
  equal(await a.snapshot(), saved, 'return does not introduce an unseen word');
  await a.swipe(-15, -130);
  equal(await a.title(), data.wordsById[ids[2]].jp, 'vertical swipe does not advance');
  await a.swipe(-25);
  equal(await a.title(), data.wordsById[ids[2]].jp, 'short drag does not advance');
  await a.page.locator('[data-act=session-prev]').click();
  await a.page.locator('[data-act=session-current]').click();
  equal(await a.title(), data.wordsById[ids[2]].jp, 'return-to-current button');
  // 새 단어 떠올리기까지 이동한 뒤 채점 없이 스와이프로 건너뛰지 못하는지 확인.
  while (await a.page.locator('[data-act=learned]').count()) await a.page.locator('[data-act=learned]').click();
  const beforeQuiz = await a.snapshot();
  await a.swipe(-160);
  equal(await a.page.locator('[data-act=reveal]').count(), 1, 'recall requires explicit answer reveal');
  equal(await a.snapshot(), beforeQuiz, 'swipe cannot grade recall');
  await a.page.locator('[data-act=reveal]').click();
  await a.page.locator('[data-act=grade][data-g=know]').click();
  const graded = await a.snapshot();
  await a.swipe(160);
  equal(await a.title(), data.wordsById[ids[0]].jp, 'completed recall can be reread');
  equal(await a.page.locator('[data-act=grade]').count(), 0, 'completed recall cannot be graded twice');
  equal(await a.snapshot(), graded, 'rereading preserves SRS stage and due date');
  await a.page.locator('[data-act=session-current]').click();
  equal(await a.page.locator('[data-act=reveal]').count(), 1, 'current unrevealed recall stays unrevealed');
  // 첫날을 끝까지 완료하고 학습 수·패턴 퀴즈·로그가 기존대로 남는지 확인.
  let guard = 0;
  while (new URL(a.page.url()).hash === '#/session' && guard++ < 80) {
    const b = a.page.locator('[data-act=reveal], [data-act=learned], [data-act=next], [data-act=grade][data-g=know]').first();
    await b.click();
    await a.page.waitForTimeout(80);
  }
  const done = JSON.parse(await a.snapshot());
  equal(done.log.length, 1, 'one daily log');
  equal(done.log[0].newCount, 5, 'five new words');
  equal(Object.keys(done.cards).filter(Core.isQuizId).length, 3, 'three pattern quiz cards');
  equal(a.errors, [], 'no browser errors');
  await a.context.close();
  // 기한이 된 복습 카드를 되돌아봐도 복습 횟수나 SRS가 달라지지 않아야 한다.
  const seed = Core.defaultState();
  seed.cards.a001 = { stage: 1, due: '2026-10-06', intro: '2026-10-05', lapse: 0 };
  const b = await open('2026-10-06', seed);
  await b.page.locator('[data-act=reveal]').click();
  await b.page.locator('[data-act=grade][data-g=no]').click();
  const reviewed = await b.snapshot();
  await b.swipe(160);
  equal(await b.snapshot(), reviewed, 'history does not reset or regrade failed review');
  equal(JSON.parse(reviewed).daily['2026-10-06'].reviewCount, 1, 'review count exactly once');
  await b.page.locator('[data-act=session-current]').click();
  await b.page.evaluate(() => { document.documentElement.className = 'fs-xlarge'; });
  equal(await b.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'largest font fits mobile screen');
  equal(b.errors, [], 'no review browser errors');
  await b.context.close();
  console.log(`OK: ${checks} mobile swipe checks passed`);
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  server.close();
});
