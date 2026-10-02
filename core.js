/* 잇쇼니 니홍고 — 순수 로직(날짜·SRS·오늘 분량 계획·저장 마이그레이션·가나 퀴즈).
   화면(DOM)에 의존하지 않으므로 node로 검사할 수 있다: node tools/test_core.js */
const Core = (() => {
  'use strict';
  const STORAGE_KEY = 'isshoni.v1';
  const SCHEMA_VERSION = 1;
  const INTERVALS = [1, 3, 7, 14, 30];      // SRS 5단계 간격(일)
  const REVIEW_CAP = 40;                    // 하루 복습 카드 상한(약 8분)
  const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];

  /* ---------- 날짜 (모두 로컬 날짜 'YYYY-MM-DD') ---------- */
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
  const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);   // b - a
  const dowOf = s => parse(s).getDay();
  /** 복습 예정일: 일요일은 휴식이므로 월요일로 미룬다. */
  const dueAfter = (today, days) => { const d = addDays(today, days); return dowOf(d) === 0 ? addDays(d, 1) : d; };

  /* ---------- 난수 (날짜 시드 → 같은 날엔 같은 결과) ---------- */
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function shuffle(arr, rng = Math.random) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  /* ---------- 저장 구조 ---------- */
  function defaultSettings() {
    return { fontSize: 'large', krMode: 'show', speed: 'normal', autoSpeak: true, kanaWarmup: false, showReview: true, furigana: true };
  }
  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      user: { name: '', role: '', createdAt: null },
      settings: defaultSettings(),
      cards: {},          // id → {stage, due, intro, lapse, last, lastGrade}
      flags: {},          // id → true  (사용자가 직접 '헷갈려요' 표시한 단어)
      log: [],            // 하루 한 줄 {date,name,reviewCount,newCount,patternId,minutes,totalLearned}
      pendingSync: [],    // 2차(Apps Script)에서 사용
      daily: {},          // date → {finished, ms, reviewCount, newTarget, patternDone, roleplayDone, extraSeen, kanaDone}
      kana: { stats: {}, quizzes: [], passed: false },
      custom: { words: {}, patterns: {}, seq: 0 },   // 내가 추가한 단어(u1…)·패턴(up1…)
    };
  }
  /** 역할별 기본 설정. */
  function presetFor(role) {
    const base = defaultSettings();
    if (role === 'kwangwoo') return { ...base, fontSize: 'normal', krMode: 'auto', kanaWarmup: true };
    if (role === 'dad') return { ...base, fontSize: 'large', krMode: 'show', kanaWarmup: false };
    return base;
  }
  /** 저장된 값을 현재 구조로 맞춘다. 데이터는 절대 지우지 않고 빠진 키만 채운다. */
  function migrate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultState();
    const s = JSON.parse(JSON.stringify(raw));
    const def = defaultState();
    // (버전이 올라갈 때 여기에 `if ((s.schemaVersion||1) < 2) {...}` 식으로 단계별 변환을 추가한다)
    for (const k of Object.keys(def)) if (s[k] === undefined || s[k] === null) s[k] = def[k];
    s.settings = Object.assign(defaultSettings(), s.settings);
    s.user = Object.assign(def.user, s.user);
    s.kana = Object.assign(def.kana, s.kana);
    s.custom = Object.assign(def.custom, s.custom);
    s.custom.words = s.custom.words || {}; s.custom.patterns = s.custom.patterns || {};
    if (typeof s.schemaVersion !== 'number') s.schemaVersion = SCHEMA_VERSION;
    return s;
  }

  /* ---------- SRS ---------- */
  function introduce(state, id, today) {
    if (!state.cards[id]) state.cards[id] = { stage: 1, due: dueAfter(today, 1), intro: today, lapse: 0 };
    return state.cards[id];
  }
  /** g: 'know' | 'fuzzy' | 'no'. 반환: {isReview} — 오늘 처음 만든 카드가 아니면 복습으로 센다. */
  function grade(state, id, g, today) {
    const existed = !!state.cards[id];
    const c = introduce(state, id, today);
    const wasDue = existed && c.due <= today;
    const isReview = existed && c.intro !== today;
    if (g === 'know') {
      if (wasDue) { c.stage = Math.min(5, c.stage + 1); c.due = dueAfter(today, INTERVALS[c.stage - 1]); }
    } else if (g === 'fuzzy') {
      const nd = dueAfter(today, INTERVALS[c.stage - 1]);
      c.due = wasDue ? nd : (c.due < nd ? c.due : nd);
      c.lapse = (c.lapse || 0) + 1;
    } else {
      c.stage = 1; c.due = dueAfter(today, 1); c.lapse = (c.lapse || 0) + 1;
    }
    c.last = today; c.lastGrade = g;
    return { isReview };
  }

  /* ---------- 데이터 색인 ---------- */
  function indexData(raw) {
    const wordsById = {}; raw.words.words.forEach(w => { wordsById[w.id] = w; });
    const patternsById = {}; raw.patterns.patterns.forEach(p => { patternsById[p.id] = p; });
    const rolesById = {}; raw.patterns.roleplays.forEach(r => { rolesById[r.id] = r; });
    const dayByDate = {}; raw.schedule.days.forEach(d => { dayByDate[d.date] = d; });
    const studyWords = raw.words.words.filter(w => w.seq).sort((a, b) => a.seq - b.seq);
    return { ...raw, wordsById, patternsById, rolesById, dayByDate, studyWords };
  }
  const isQuizId = id => /^p\d\dq\d$/.test(id);
  const quizPid = id => id.slice(0, 3);
  const quizIds = p => p.quiz.map((_, i) => `${p.id}q${i + 1}`);
  function quizOf(data, qid) { const p = data.patternsById[quizPid(qid)]; return p && p.quiz[Number(qid.slice(4)) - 1] ? { p, q: p.quiz[Number(qid.slice(4)) - 1] } : null; }

  function dayInfo(data, date) {
    if (data.dayByDate[date]) return data.dayByDate[date];
    const days = data.schedule.days;
    if (date < days[0].date) return { date, week: 0, dow: DOW_KO[dowOf(date)], type: 'pre' };
    const last = days[days.length - 1];
    return { date, week: last.week + 1, dow: DOW_KO[dowOf(date)], type: dowOf(date) === 0 ? 'rest' : 'review', phase: '여행 실전' };
  }

  /* ---------- 오늘 분량 계획 ---------- */
  /** 복습량에 따라 오늘 새 단어 수를 줄인다(20분 유지). */
  function newWordTarget(base, dueCount) {
    if (dueCount <= 40) return base;
    if (dueCount <= 48) return base - 1;
    if (dueCount <= 56) return base - 2;
    if (dueCount <= 64) return base - 3;
    return Math.max(1, base - 4);
  }
  function rallyQuizIds(data, date, perPattern = 1) {
    const rng = mulberry32(hashStr('rally' + date));
    const out = [];
    data.patterns.patterns.forEach(p => { out.push(...shuffle(quizIds(p), rng).slice(0, perPattern)); });
    return shuffle(out, rng);
  }
  function randomQuizIds(data, date, n) {
    const rng = mulberry32(hashStr('mix' + date));
    const all = []; data.patterns.patterns.forEach(p => all.push(...quizIds(p)));
    return shuffle(all, rng).slice(0, n);
  }

  function buildPlan(data, state, date) {
    const day = dayInfo(data, date);
    const daily = state.daily[date] || {};
    const plan = {
      date, day, type: day.type, week: day.week,
      review: [], reviewDueTotal: 0, newIds: [], newTarget: 0, newIntroducedToday: 0, backlogNew: 0,
      extra: [], pattern: null, roleplay: null, finished: !!daily.finished,
    };
    const studyLike = day.type === 'study' || day.type === 'saturday' || day.type === 'review';
    const optionalRest = day.type === 'rest';
    if (!studyLike && !optionalRest) return plan;

    // 패턴 단계
    let patternQuizIds = [];
    if (day.type === 'study' && day.pattern && !daily.patternDone) {
      const pt = day.pattern;
      if (pt.mode === 'new') {
        const p = data.patternsById[pt.id];
        plan.pattern = { mode: 'new', pids: [pt.id], quizIds: quizIds(p), examples: true };
      } else if (pt.mode === 'review') {
        const ids = pt.ids.flatMap(pid => quizIds(data.patternsById[pid]));
        plan.pattern = { mode: 'review', pids: pt.ids.slice(), quizIds: ids, examples: false };
      } else if (pt.mode === 'rally') {
        plan.pattern = { mode: 'rally', pids: pt.ids.slice(), quizIds: rallyQuizIds(data, date), examples: false };
      }
    } else if (day.type === 'review' && !daily.patternDone) {
      plan.pattern = { mode: 'rally', pids: [], quizIds: randomQuizIds(data, date, day.phase === '여행 실전' ? 6 : 8), examples: false };
    }
    if (plan.pattern) patternQuizIds = plan.pattern.quizIds;
    const skip = new Set(patternQuizIds);

    // 복습 단계: 기한이 된 카드(패턴 단계에서 다루는 퀴즈는 제외). 오래 밀린 것·자주 틀린 것 먼저.
    const due = Object.entries(state.cards)
      .filter(([id, c]) => c.due <= date && !skip.has(id) && (isQuizId(id) ? !!quizOf(data, id) : (!!data.wordsById[id] || !!(state.custom && state.custom.words[id]))))
      .sort((a, b) => (a[1].due < b[1].due ? -1 : a[1].due > b[1].due ? 1 : (b[1].lapse || 0) - (a[1].lapse || 0) || (a[0] < b[0] ? -1 : 1)))
      .map(([id]) => id);
    plan.reviewDueTotal = due.length;
    const cap = optionalRest ? 20 : REVIEW_CAP;
    plan.review = due.slice(0, cap);

    // 새 단어: 진도일은 그날 분량(복습이 많으면 줄임). 못 배운 단어는 앞에서부터 다시 나오고,
    // 토요일·복습기간에 여유가 있으면 밀린 단어를 따라잡는다(12/18까지 275개를 마치기 위함).
    if (studyLike) {
      const scheduled = [];
      data.schedule.days.forEach(d => { if (d.type === 'study' && d.date <= date) scheduled.push(...d.newWords); });
      const pending = scheduled.filter(id => !state.cards[id]);
      const base = data.schedule.rules.newWordsPerDay || 5;
      plan.newIntroducedToday = Object.entries(state.cards).filter(([id, c]) => c.intro === date && data.wordsById[id]).length;
      let target;
      if (daily.newTarget != null) target = daily.newTarget;
      else if (day.type === 'study') target = newWordTarget(base, due.length);
      else if (day.type === 'saturday') target = due.length <= 30 ? 3 : 0;
      else target = newWordTarget(base, due.length);
      plan.newTarget = target;
      const remain = Math.max(0, target - plan.newIntroducedToday);
      plan.newIds = pending.slice(0, remain);
      // 밀린 새 단어: 오늘 배울 목록에 들지 않은, 이미 지난 날짜 분량
      const earlier = new Set(); data.schedule.days.forEach(d => { if (d.type === 'study' && d.date < date) d.newWords.forEach(id => earlier.add(id)); });
      plan.backlogNew = pending.filter(id => earlier.has(id) && !plan.newIds.includes(id)).length;
      if (day.type === 'study') plan.extra = (day.extraReview || []).filter(id => !(daily.extraSeen || []).includes(id));
    }
    if ((day.type === 'saturday' || (day.type === 'review' && day.phase === '여행 실전')) && !daily.roleplayDone) {
      if (day.roleplay) plan.roleplay = day.roleplay;
      else if (day.type === 'review') {
        const rng = mulberry32(hashStr('role' + date));
        plan.roleplay = data.patterns.roleplays[Math.floor(rng() * data.patterns.roleplays.length)].id;
      }
    }
    return plan;
  }
  /** 남은 일이 있는가 */
  function planRemaining(plan) {
    return plan.review.length + plan.newIds.length + plan.extra.length + (plan.pattern ? 1 : 0) + (plan.roleplay ? 1 : 0);
  }

  /* ---------- 진도 요약 ---------- */
  const isWordId = (data, id) => !!data.wordsById[id];
  function totalLearned(data, state) { return Object.keys(state.cards).filter(id => isWordId(data, id)).length; }
  function dayDone(state, d) { const x = state.daily[d]; return !!(x && (x.finished || x.kanaDone)); }
  function computeStreak(data, state, today) {
    const first = data.schedule.days[0].date;
    let d = today, n = 0;
    if (!dayDone(state, d)) d = addDays(d, -1);
    while (d >= first) {
      if (dayInfo(data, d).type === 'rest') { d = addDays(d, -1); continue; }
      if (dayDone(state, d)) { n++; d = addDays(d, -1); } else break;
    }
    return n;
  }
  /** 이번 주(월~일) 상태: done / today / missed / future / rest / off */
  function weekStrip(data, state, today) {
    const dw = dowOf(today); const monday = addDays(today, -((dw + 6) % 7));
    const first = data.schedule.days[0].date;
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(monday, i); const info = dayInfo(data, d);
      let st;
      if (info.type === 'rest') st = 'rest';
      else if (d < first) st = 'off';
      else if (dayDone(state, d)) st = 'done';
      else if (d === today) st = 'today';
      else if (d > today) st = 'future';
      else st = 'missed';
      if (d === today && st === 'done') st = 'donetoday';
      return { date: d, dow: DOW_KO[dowOf(d)], state: st };
    });
  }

  /* ---------- 후리가나 ---------- */
  const KANJI = '\u4e00-\u9fff\u3005\u303b';
  const hira = str => str.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const hasKanji = str => new RegExp(`[${KANJI}]`).test(str || '');
  const escRe = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** 한자+오쿠리가나 표기(jp)와 읽기(kana)로 `漢字[かんじ]` 표기를 만든다. 정렬이 안 되면 통째로 붙인다. 한자가 없거나 읽기가 없으면 null. */
  function autoRuby(jp, kana) {
    kana = hira((kana || '').trim());
    if (!hasKanji(jp) || !kana) return null;
    const runs = jp.match(new RegExp(`[${KANJI}]+|[^${KANJI}]+`, 'g')) || [];
    const pat = '^' + runs.map(r => (hasKanji(r) ? '(.+?)' : escRe(hira(r)))).join('') + '$';
    const m = kana.match(new RegExp(pat));
    if (!m) return `${jp}[${kana}]`;
    let gi = 1;
    return runs.map(r => (hasKanji(r) ? `${r}[${m[gi++]}]` : r)).join('');
  }
  const stripRuby = str => String(str || '').replace(/\[[^\]]*\]/g, '');
  /** 후리가나 → 히라가나 전체 읽기 (검색용): 駅[えき]まで → えきまで */
  const readingOf = (jp, jpr) => (jpr ? jpr.replace(new RegExp(`[${KANJI}]+\\[([^\\]]+)\\]`, 'g'), '$1') : (jp || ''));

  /** 앱이 이미 아는 한자 단어의 읽기 사전(패턴·예문의 후리가나 + 한자만으로 된 단어 표제어). 사용자가 읽기를 안 적은 한자에 자동으로 붙인다. */
  function buildLexicon(data) {
    const cnt = {}, heads = new Set();
    const add = (k, r, w) => { cnt[k] = cnt[k] || {}; cnt[k][r] = (cnt[k][r] || 0) + w; };
    const scan = str => {
      if (!str) return;
      const re = new RegExp(`([${KANJI}]+)\\[([^\\]]+)\\]`, 'g'); let m;
      while ((m = re.exec(str))) add(m[1], m[2], 1);
    };
    data.patterns.patterns.forEach(p => { scan(p.jpr); p.examples.forEach(e => scan(e.jpr)); p.quiz.forEach(q => scan(q.jpr)); });
    data.patterns.roleplays.forEach(r => r.lines.forEach(l => scan(l.jpr)));
    const kanjiOnly = new RegExp(`^[${KANJI}]+$`);
    data.words.words.forEach(w => {
      scan(w.exr);
      if (kanjiOnly.test(w.jp) && w.kana && !/[・/\s]/.test(w.kana)) { add(w.jp, hira(w.kana), 5); heads.add(w.jp); }
    });
    const lex = new Map();
    Object.entries(cnt).forEach(([k, rs]) => {
      if (k.length === 1 && !heads.has(k)) return;      // 한 글자는 문맥에 따라 읽기가 달라서 표제어일 때만
      lex.set(k, Object.entries(rs).sort((a, b) => b[1] - a[1])[0][0]);
    });
    return lex;
  }
  /** 읽기를 모르는 문장에 사전으로 아는 한자만 후리가나를 붙인다. 붙은 게 없으면 null. 한 글자 단어는 다른 한자와 붙어 있지 않을 때만. */
  function lexRuby(text, lex) {
    const isK = ch => hasKanji(ch);
    let out = '', i = 0, any = false;
    while (i < text.length) {
      if (!isK(text[i])) { out += text[i++]; continue; }
      let j = i; while (j < text.length && isK(text[j])) j++;
      let k = i;
      while (k < j) {
        let hit = null;
        for (let e = j; e > k; e--) {
          const key = text.slice(k, e);
          if (lex.has(key) && (key.length > 1 || (k === i && e === j))) { hit = [key, e]; break; }
        }
        if (hit) { out += `${hit[0]}[${lex.get(hit[0])}]`; k = hit[1]; any = true; } else { out += text[k++]; }
      }
      i = j;
    }
    return any ? out : null;
  }

  /* ---------- 가나 퀴즈 ---------- */
  /** pool: 문제 후보 [{k,kr,ro,type}]. 헷갈리는 짝의 읽기를 보기에 우선 넣는다. */
  function kanaOptions(target, pool, confusions, rng = Math.random, n = 4) {
    const opts = [target.kr];
    const partners = [];
    (confusions || []).forEach(g => { if (g.includes(target.k)) g.forEach(ch => { if (ch !== target.k) partners.push(ch); }); });
    const byK = {}; pool.forEach(x => { byK[x.k] = x; });
    shuffle(partners, rng).forEach(ch => { const x = byK[ch]; if (x && !opts.includes(x.kr) && opts.length < n) opts.push(x.kr); });
    shuffle(pool, rng).forEach(x => { if (opts.length < n && !opts.includes(x.kr)) opts.push(x.kr); });
    return shuffle(opts, rng);
  }
  /** 틀린 적이 많은 글자를 더 자주 뽑는 무작위 출제(중복 없음). */
  function pickKana(pool, stats, count, rng = Math.random) {
    const items = pool.map(x => {
      const s = (stats && stats[x.k]) || { ok: 0, ng: 0 };
      return { x, w: 1 + 3 * (s.ng / (s.ok + s.ng + 1)) };
    });
    const out = [];
    while (out.length < count && items.length) {
      const total = items.reduce((a, b) => a + b.w, 0);
      let r = rng() * total, i = 0;
      while (i < items.length - 1 && r >= items[i].w) { r -= items[i].w; i++; }
      out.push(items.splice(i, 1)[0].x);
    }
    return out;
  }

  return {
    STORAGE_KEY, SCHEMA_VERSION, INTERVALS, REVIEW_CAP, DOW_KO,
    fmt, parse, addDays, diffDays, dowOf, dueAfter, hashStr, mulberry32, shuffle,
    defaultSettings, defaultState, presetFor, migrate,
    introduce, grade,
    indexData, isQuizId, quizPid, quizIds, quizOf, dayInfo,
    newWordTarget, buildPlan, planRemaining, totalLearned, computeStreak, weekStrip, dayDone,
    kanaOptions, pickKana, autoRuby, hasKanji, stripRuby, hira, readingOf, buildLexicon, lexRuby,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Core;
