// apps-script/Code.gs 를 Google 없이 실행해 보는 모의 환경(Node vm + 메모리 시트).
// 사용: const { load } = require('./apps_script_mock.js'); const gs = load('내키'); gs.get({...}); gs.post({...});
// 또 `node tools/apps_script_mock.js [포트]`로 실행하면 앱을 붙여 시험할 수 있는 로컬 서버(CORS 허용)가 뜬다.
const fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');

function makeSheet(name) {
  const sh = { name, values: [], formats: [] };
  sh.getLastRow = () => sh.values.length;
  sh.getMaxRows = () => Math.max(1000, sh.values.length);
  sh.appendRow = row => { sh.values.push(row.slice()); };
  sh.getDataRange = () => ({ getValues: () => sh.values.map(r => r.slice()) });
  sh.getRange = (r, c, nr, nc) => ({
    setValues: vals => { vals.forEach((v, i) => { sh.values[r - 1 + i] = v.slice(); }); },
    setNumberFormat: f => { sh.formats.push(f); },
  });
  return sh;
}

function load(familyKey) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8')
    .replace("const FAMILY_KEY = 'CHANGE-ME';", `const FAMILY_KEY = ${JSON.stringify(familyKey)};`);
  const sheets = {};
  const sandbox = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = makeSheet(n)) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; }, getContent() { return this.text; } }) },
    Utilities: { formatDate: (d, tz, f) => d.toISOString().slice(0, 10) },
    Session: { getScriptTimeZone: () => 'Asia/Seoul' },
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__doGet = doGet; this.__doPost = doPost;', sandbox);
  return {
    sheets,
    get: params => JSON.parse(sandbox.__doGet({ parameter: params }).getContent()),
    post: body => JSON.parse(sandbox.__doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).getContent()),
  };
}
module.exports = { load };

if (require.main === module) {
  const key = process.env.FAMILY_KEY || 'test-key-1234';
  const gs = load(key), port = Number(process.argv[2]) || 8799;
  http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Content-Type': 'application/json; charset=utf-8' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET') { res.writeHead(200, cors); return res.end(JSON.stringify(gs.get(Object.fromEntries(u.searchParams)))); }
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => { res.writeHead(200, cors); res.end(JSON.stringify(gs.post(body))); });
  }).listen(port, '127.0.0.1', () => console.log(`apps-script mock on http://127.0.0.1:${port}/  key=${key}`));
}
