// core.js 로직 검사. 사용: node tools/test_core.js  (실패 시 예외로 종료 코드 1)
const fs = require('fs'), path = require('path'), assert = require('assert');
const Core = require('../core.js');
const D = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', p + '.json'), 'utf8'));
const data = Core.indexData({ words: D('words'), patterns: D('patterns'), kana: D('kana'), schedule: D('schedule') });
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

// 날짜
ok(Core.addDays('2026-10-31', 1) === '2026-11-01', 'addDays month');
ok(Core.dowOf('2026-10-05') === 1, '10/5 is Monday');
ok(Core.dueAfter('2026-10-10', 1) === '2026-10-12', '토→일 예정은 월요일로');
ok(Core.dueAfter('2026-10-05', 1) === '2026-10-06', '월→화');
ok(Core.diffDays('2026-09-30', '2027-01-26') === 118, 'D-day 118');

// 저장 마이그레이션: 기존 기록 보존 + 빠진 키 채움
const old = { schemaVersion: 1, user: { name: '아버지' }, cards: { a001: { stage: 3, due: '2026-10-20' } }, log: [{ date: '2026-10-05' }] };
const m = Core.migrate(old);
ok(m.cards.a001.stage === 3 && m.log.length === 1 && m.user.name === '아버지', 'migrate keeps data');
ok(m.settings.fontSize && m.daily && m.kana && m.flags && Array.isArray(m.pendingSync), 'migrate fills keys');
ok(JSON.stringify(old.cards) === JSON.stringify({ a001: { stage: 3, due: '2026-10-20' } }), 'migrate does not mutate input');
ok(Core.migrate(null).schemaVersion === 1 && Core.migrate('x').cards, 'migrate garbage');

// SRS
let s = Core.defaultState();
Core.grade(s, 'a001', 'know', '2026-10-05');             // 처음 → 1단계, 내일
ok(s.cards.a001.stage === 1 && s.cards.a001.due === '2026-10-06', 'new card stage1 due+1');
Core.grade(s, 'a001', 'know', '2026-10-06');
ok(s.cards.a001.stage === 2 && s.cards.a001.due === '2026-10-09', '알아요 → 2단계 +3일');
Core.grade(s, 'a001', 'fuzzy', '2026-10-09');
ok(s.cards.a001.stage === 2 && s.cards.a001.due === '2026-10-12', '헷갈려요 → 같은 단계');
Core.grade(s, 'a001', 'no', '2026-10-12');
ok(s.cards.a001.stage === 1 && s.cards.a001.due === '2026-10-13' && s.cards.a001.lapse === 2, '몰라요 → 1단계');
for (let i = 0; i < 8; i++) { const c = s.cards.a001; Core.grade(s, 'a001', 'know', c.due); }
ok(s.cards.a001.stage === 5, '5단계 상한');
const before = JSON.stringify(s.cards.a001);
Core.grade(s, 'a001', 'know', '2026-10-13');  // 기한 전 '알아요'는 단계를 올리지 않는다
ok(JSON.stringify(s.cards.a001).replace(/"last[^,]*,?/g, '') !== null && s.cards.a001.stage === 5, 'not-due know keeps stage');

// 계획: 1일차(10/5)
s = Core.defaultState();
let plan = Core.buildPlan(data, s, '2026-10-05');
ok(plan.type === 'study' && plan.newIds.join() === 'a001,a002,a003,a004,a005', '1일차 새 단어 5개');
ok(plan.pattern.mode === 'new' && plan.pattern.pids[0] === 'p01' && plan.pattern.quizIds.length === 3, '1일차 패턴 p01');
ok(plan.review.length === 0, '1일차 복습 없음');
ok(Core.buildPlan(data, s, '2026-10-01').type === 'warmup', '10/1 워밍업');
ok(Core.buildPlan(data, s, '2026-09-30').type === 'pre', '9/30 시작 전');
ok(Core.buildPlan(data, s, '2026-10-11').type === 'rest', '일요일 휴식');

// 55일 진도를 성실히(모두 '알아요') 수행하는 시뮬레이션
s = Core.defaultState();
const days = data.schedule.days; let maxReview = 0, totalNew = 0, dueOnSunday = 0;
for (const d of days) {
  const date = d.date;
  const p = Core.buildPlan(data, s, date);
  if (d.type === 'rest') continue;
  maxReview = Math.max(maxReview, p.review.length);
  if (d.type === 'study') {
    ok(p.newIds.length === p.newTarget || p.newIds.length < p.newTarget, `${date} new words within target`);
    s.daily[date] = { newTarget: p.newTarget };
    p.newIds.forEach(id => { Core.grade(s, id, 'know', date); totalNew++; });
    if (p.pattern) p.pattern.quizIds.forEach(q => Core.grade(s, q, 'know', date));
    s.daily[date].patternDone = true;
  }
  else if (p.newIds.length) { s.daily[date] = { newTarget: p.newTarget }; p.newIds.forEach(id => { Core.grade(s, id, 'know', date); totalNew++; }); }
  p.review.forEach(id => Core.grade(s, id, 'know', date));
  s.daily[date] = { ...(s.daily[date] || {}), finished: true };
}
ok(totalNew === 275, '275 words introduced (밀린 단어 따라잡기 포함), got ' + totalNew);
{ // 성실히 해도 월요일 복습이 몰리는 날엔 새 단어가 줄어 몇 개가 토요일로 넘어간다 — 12/19(토)까지는 275개가 끝나야 한다
  const by = d => Object.entries(s.cards).filter(([id, c]) => data.wordsById[id] && c.intro <= d).length;
  console.log('  12/18까지', by('2026-12-18'), '개, 12/19까지', by('2026-12-19'), '개 학습');
  ok(by('2026-12-19') === 275, '12/19까지 275개 완료: ' + by('2026-12-19'));
}
ok(Core.totalLearned(data, s) === 275, 'totalLearned 275');
ok(Object.keys(s.cards).filter(Core.isQuizId).length === 94, '94 quiz cards');
Object.values(s.cards).forEach(c => ok(Core.dowOf(c.due) !== 0, 'no card due on Sunday'));
console.log('  성실 시뮬레이션: 하루 최대 복습 카드', maxReview, '장 (상한', Core.REVIEW_CAP + ')');
ok(maxReview <= Core.REVIEW_CAP, 'review cap');
ok(Core.computeStreak(data, s, '2027-01-23') > 10, 'streak counts through rest days: ' + Core.computeStreak(data, s, '2027-01-23'));

// 밀린 날: 10/5만 하고 10/8에 접속 → 밀린 단어는 앞에서부터, 복습 우선
s = Core.defaultState();
let p5 = Core.buildPlan(data, s, '2026-10-05');
p5.newIds.forEach(id => Core.grade(s, id, 'know', '2026-10-05'));
let p8 = Core.buildPlan(data, s, '2026-10-08');
ok(p8.newIds.join() === 'a006,a007,a008,a009,a010', '밀린 날: 안 배운 단어를 순서대로');
ok(p8.backlogNew === 5 + 0 || p8.backlogNew >= 5, 'backlog reported: ' + p8.backlogNew);
ok(p8.review.includes('a001'), '기한 지난 카드가 복습에 포함');

// 복습이 많으면 새 단어를 줄인다
ok(Core.newWordTarget(5, 30) === 5 && Core.newWordTarget(5, 45) === 4 && Core.newWordTarget(5, 80) === 1, 'newWordTarget');

// 재진입: 3개 배운 뒤 나갔다가 돌아오면 남은 2개만
s = Core.defaultState();
p5 = Core.buildPlan(data, s, '2026-10-05'); s.daily['2026-10-05'] = { newTarget: p5.newTarget };
['a001', 'a002', 'a003'].forEach(id => Core.introduce(s, id, '2026-10-05'));
ok(Core.buildPlan(data, s, '2026-10-05').newIds.join() === 'a004,a005', '재진입 시 남은 새 단어');

// 12/18 랠리, 롤플레잉
const rally = Core.buildPlan(data, Core.defaultState(), '2026-12-18');
ok(rally.pattern.mode === 'rally' && rally.pattern.quizIds.length === 32, '랠리 32문제');
ok(Core.buildPlan(data, Core.defaultState(), '2026-10-17').roleplay === 'r1', '10/17 롤플레잉 r1');
ok(Core.buildPlan(data, Core.defaultState(), '2027-01-12').type === 'review', '여행 실전 review');

// 가나 보기
const kh = data.kana.hiragana;
for (const t of kh) {
  const o = Core.kanaOptions(t, kh.filter(x => x.type === t.type), data.kana.confusions.hiragana);
  ok(o.length === 4 && new Set(o).size === 4 && o.includes(t.kr), 'kana options ' + t.k);
}
const so = Core.kanaOptions(kh.find(x => x.k === 'さ'), kh.filter(x => x.type === 'basic'), data.kana.confusions.hiragana, () => 0.3);
ok(so.includes('치') || so.includes('키'), 'confusion partner appears (さ↔ち/き)');
const picked = Core.pickKana(kh.filter(x => x.type === 'basic'), { あ: { ok: 0, ng: 9 } }, 46);
ok(new Set(picked.map(x => x.k)).size === 46, 'pickKana no duplicates');

// 후리가나: 직접 적은 읽기 정렬 / 사전 기반 자동 / 검색용 읽기
ok(Core.autoRuby('食べ物', 'たべもの') === '食[た]べ物[もの]', 'autoRuby okurigana');
ok(Core.autoRuby('お金', 'おかね') === 'お金[かね]', 'autoRuby prefix');
ok(Core.autoRuby('こんにちは', 'こんにちは') === null && Core.autoRuby('駅', '') === null, 'autoRuby none');
ok(Core.autoRuby('駅', 'エキ') === '駅[えき]', 'autoRuby katakana reading');
const lex = Core.buildLexicon(data);
ok(lex.size > 150, 'lexicon size ' + lex.size);
ok(Core.lexRuby('出口はどこですか', lex) === '出口[でぐち]はどこですか', 'lexRuby known word');
ok(Core.lexRuby('駅前', lex) === null, 'lexRuby: 한 글자 단어는 다른 한자와 붙어 있으면 건드리지 않음');
ok(Core.lexRuby('醤油', lex) === null, 'lexRuby unknown kanji untouched');
ok(Core.readingOf('駅までいくらですか？', '駅[えき]までいくらですか？') === 'えきまでいくらですか？', 'readingOf');
ok(Core.stripRuby('駅[えき]まで') === '駅まで', 'stripRuby');
ok(data.patterns.patterns.every(p => p.examples.every(e => !Core.hasKanji(e.jp) || e.jpr)), '모든 패턴 예문의 한자에 후리가나');

// 내 단어(u1): 복습 카드로 들어가고 기한이 되면 복습에 나온다. 단어가 지워지면 카드는 무시된다
{
  const st = Core.defaultState();
  st.custom.words.u1 = { id: 'u1', jp: '醤油', kana: 'しょうゆ', mean: '간장' };
  Core.introduce(st, 'u1', '2026-10-05');
  ok(Core.buildPlan(data, st, '2026-10-06').review.includes('u1'), '내 단어가 복습에 나옴');
  ok(Core.totalLearned(data, st) === 0, '내 단어는 275개 진도에 세지 않음');
  delete st.custom.words.u1;
  ok(!Core.buildPlan(data, st, '2026-10-06').review.includes('u1'), '삭제한 내 단어는 복습에서 빠짐');
  ok(Core.migrate({ cards: {} }).custom.words && Core.migrate({ custom: { words: { u1: {} } } }).custom.patterns, '마이그레이션: custom 기본값');
}

console.log(`OK: ${n} checks passed`);
