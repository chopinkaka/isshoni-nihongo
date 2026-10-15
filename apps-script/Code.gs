/**
 * 잇쇼니 니홍고 — 진도 공유 서버 (Google Apps Script 웹 앱)
 *
 * 구글 시트에 붙은 스크립트로 배포한다. 설치 방법은 docs/2차-설치.md.
 *   POST {key, action:'progress', date, name, reviewCount, newCount, patternId, minutes, totalLearned} → 같은 날짜+이름은 덮어씀(중복 없음)
 *   POST {key, action:'cheer', date, from, to}                                                          → 응원 (같은 날·같은 사람은 한 번만)
 *   GET  ?key=…&from=YYYY-MM-DD&to=YYYY-MM-DD                                                           → 두 사람의 기록과 응원 목록
 *
 * 앱 코드는 공개 저장소에 있으므로 이 키(FAMILY_KEY)와 웹 앱 주소는 코드에 넣지 않고,
 * 앱의 「가족 코드」로만 전달한다. 키를 모르면 읽기·쓰기 모두 거절된다.
 */
const FAMILY_KEY = 'CHANGE-ME';   // ← 길고 아무도 모를 문자열로 바꾸세요 (예: 12자 이상). 바꾸고 다시 배포!

const PROGRESS_SHEET = 'progress';
const CHEER_SHEET = 'cheers';
const PROGRESS_HEAD = ['date', 'name', 'reviewCount', 'newCount', 'patternId', 'minutes', 'totalLearned', 'updatedAt'];
const CHEER_HEAD = ['date', 'from', 'to', 'createdAt'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function doPost(e) {
  return respond_(function () {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkKey_(body.key);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);              // 두 사람이 동시에 저장해도 서로 덮어쓰지 않게
    try {
      if (body.action === 'progress') return saveProgress_(body);
      if (body.action === 'cheer') return saveCheer_(body);
      throw new Error('unknown-action');
    } finally {
      lock.releaseLock();
    }
  });
}

function doGet(e) {
  return respond_(function () {
    const p = (e && e.parameter) || {};
    checkKey_(p.key);
    const from = p.from || '0000-00-00', to = p.to || '9999-99-99';
    return {
      ok: true,
      rows: readRows_(PROGRESS_SHEET, PROGRESS_HEAD).filter(function (r) { return r.date >= from && r.date <= to; }),
      cheers: readRows_(CHEER_SHEET, CHEER_HEAD).filter(function (r) { return r.date >= from && r.date <= to; }),
    };
  });
}

/* ---------- 내부 ---------- */
function respond_(fn) {
  let out;
  try { out = fn(); } catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function checkKey_(key) {
  if (FAMILY_KEY === 'CHANGE-ME') throw new Error('key-not-set');       // 키를 안 바꾸고 배포한 경우
  if (!key || key !== FAMILY_KEY) throw new Error('forbidden');
}

function sheet_(name, head) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(head);
    sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@');     // 날짜 열을 글자로(시트가 날짜로 바꾸지 않게)
  }
  return sh;
}

function dateText_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v);
}

function readRows_(name, head) {
  const values = sheet_(name, head).getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = {};
    head.forEach(function (h, c) { row[h] = h === 'date' ? dateText_(values[i][c]) : values[i][c]; });
    if (row.date && DATE_RE.test(row.date)) out.push(row);
  }
  return out;
}

const int_ = function (v) { const n = Math.round(Number(v)); return isFinite(n) && n >= 0 && n <= 99999 ? n : 0; };
const text_ = function (v, max) { return String(v == null ? '' : v).trim().slice(0, max); };

function saveProgress_(b) {
  const date = text_(b.date, 10), name = text_(b.name, 12);
  if (!DATE_RE.test(date) || !name) throw new Error('bad-request');
  const row = [date, name, int_(b.reviewCount), int_(b.newCount), text_(b.patternId, 40), int_(b.minutes), int_(b.totalLearned), new Date().toISOString()];
  const sh = sheet_(PROGRESS_SHEET, PROGRESS_HEAD);
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (dateText_(values[i][0]) === date && String(values[i][1]) === name) {
      sh.getRange(i + 1, 1, 1, PROGRESS_HEAD.length).setValues([row]);
      return { ok: true, updated: true };
    }
  }
  sh.appendRow(row);
  return { ok: true, updated: false };
}

function saveCheer_(b) {
  const date = text_(b.date, 10), from = text_(b.from, 12), to = text_(b.to, 12);
  if (!DATE_RE.test(date) || !from || !to || from === to) throw new Error('bad-request');
  const sh = sheet_(CHEER_SHEET, CHEER_HEAD);
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (dateText_(values[i][0]) === date && String(values[i][1]) === from && String(values[i][2]) === to) return { ok: true, duplicate: true };
  }
  sh.appendRow([date, from, to, new Date().toISOString()]);
  return { ok: true, duplicate: false };
}
