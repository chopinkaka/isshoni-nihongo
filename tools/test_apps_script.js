// apps-script/Code.gs 로직 검사(모의 환경). 사용: node tools/test_apps_script.js
const assert = require('assert');
const { load } = require('./apps_script_mock.js');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

// 키를 안 바꾼 채 배포하면 아무것도 못 하게 막는다
{
  const gs = load('CHANGE-ME');
  ok(gs.get({ key: 'CHANGE-ME' }).error === 'key-not-set', '기본 키로는 거절');
  ok(gs.post({ key: 'CHANGE-ME', action: 'progress', date: '2026-10-05', name: '광우' }).error === 'key-not-set', '기본 키 쓰기 거절');
}

const K = 'family-secret-9999';
const gs = load(K);
const P = (o = {}) => Object.assign({ key: K, action: 'progress', date: '2026-10-05', name: '광우', reviewCount: 0, newCount: 5, patternId: 'p01', minutes: 9, totalLearned: 5 }, o);

// 인증
ok(gs.get({}).error === 'forbidden' && gs.get({ key: 'x' }).error === 'forbidden', '키 없이/틀린 키로 읽기 거절');
ok(gs.post(P({ key: 'x' })).error === 'forbidden', '틀린 키로 쓰기 거절');
ok(gs.post('not json').ok === false, '깨진 요청도 JSON 오류로 응답');

// 쓰기/덮어쓰기(중복 방지)
ok(gs.post(P()).ok === true && gs.post(P()).updated === true, '같은 날·같은 이름은 덮어씀');
gs.post(P({ minutes: 12, reviewCount: 3 }));
gs.post(P({ name: '아버지', minutes: 20 }));
gs.post(P({ date: '2026-10-06', reviewCount: 8, newCount: 5, totalLearned: 10 }));
let rows = gs.get({ key: K }).rows;
ok(rows.length === 3, '3줄(광우 10/5·10/6, 아버지 10/5): ' + rows.length);
const r1 = rows.find(r => r.name === '광우' && r.date === '2026-10-05');
ok(r1.minutes === 12 && r1.reviewCount === 3, '덮어쓴 값이 반영');
ok(rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date)), '날짜는 항상 YYYY-MM-DD');
ok(gs.sheets.progress.values[0].join() === 'date,name,reviewCount,newCount,patternId,minutes,totalLearned,updatedAt', '머리글');
ok(gs.sheets.progress.formats.includes('@'), '날짜 열은 글자 서식');

// 범위 조회
ok(gs.get({ key: K, from: '2026-10-06', to: '2026-10-06' }).rows.length === 1, '범위 조회');
ok(gs.get({ key: K, from: '2026-10-07', to: '2026-10-09' }).rows.length === 0, '범위 밖은 비어 있음');

// 입력 검증
ok(gs.post(P({ date: '10/5' })).error === 'bad-request', '날짜 형식 오류');
ok(gs.post(P({ name: '  ' })).error === 'bad-request', '이름 없음');
ok(gs.post(P({ minutes: -5, newCount: 'abc', reviewCount: 1e9 })).ok === true, '이상한 숫자는 0으로 정리');
const odd = gs.get({ key: K }).rows.find(r => r.date === '2026-10-05' && r.name === '광우');
ok(odd.minutes === 0 && odd.newCount === 0 && odd.reviewCount === 0, '숫자 정리 결과');
ok(gs.post(P({ name: 'ㅇ'.repeat(40) })).ok === true && gs.get({ key: K }).rows.some(r => r.name.length === 12), '이름은 12자로 자름');
ok(gs.post({ key: K, action: 'delete' }).error === 'unknown-action', '모르는 동작은 거절');

// 응원
ok(gs.post({ key: K, action: 'cheer', date: '2026-10-06', from: '광우', to: '아버지' }).duplicate === false, '응원 저장');
ok(gs.post({ key: K, action: 'cheer', date: '2026-10-06', from: '광우', to: '아버지' }).duplicate === true, '같은 응원은 한 번만');
ok(gs.post({ key: K, action: 'cheer', date: '2026-10-06', from: '광우', to: '광우' }).error === 'bad-request', '자기 자신에게는 안 됨');
ok(gs.get({ key: K }).cheers.length === 1, '응원 목록');

// 시트가 날짜를 Date 객체로 바꿔 버린 경우도 읽을 수 있어야 한다
{
  const g2 = load(K); g2.post(P());
  g2.sheets.progress.values[1][0] = new Date('2026-10-05T00:00:00Z');
  ok(g2.get({ key: K }).rows[0].date === '2026-10-05', 'Date 객체 날짜도 정규화');
  ok(g2.post(P({ minutes: 7 })).updated === true && g2.sheets.progress.values.length === 2, 'Date 객체여도 같은 날은 덮어씀(중복 없음)');
}
console.log(`OK: apps-script ${n} checks passed`);
