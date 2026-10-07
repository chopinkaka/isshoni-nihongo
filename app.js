/* 잇쇼니 니홍고 — 화면/상호작용. 로직은 core.js, 데이터는 data/*.json */
(() => {
  'use strict';
  const C = Core;
  const APP_VERSION = 'MVP 0.1';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const jp = t => `<span lang="ja">${esc(t)}</span>`;
  const RUBY_RE = /([一-鿿々〻]+)\[([^\]]+)\]/g;
  /** 일본어 표시. ruby(`駅[えき]まで`)가 있고 설정이 켜져 있으면 한자 위에 후리가나를 얹는다. */
  const rb = (text, ruby) => {
    if (!ruby || state.settings.furigana === false) return jp(text);
    return `<span lang="ja">${esc(ruby).replace(RUBY_RE, '<ruby>$1<rt>$2</rt></ruby>')}</span>`;
  };
  const STAGE_DAYS = C.INTERVALS;

  /* ================= 환경: 체험 모드(?date=YYYY-MM-DD) ================= */
  const params = new URLSearchParams(location.search);
  const OVERRIDE = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : null;
  const KEY = OVERRIDE ? C.STORAGE_KEY + '.test' : C.STORAGE_KEY;   // 체험 모드는 실제 기록과 완전히 분리
  const today = () => OVERRIDE || C.fmt(new Date());
  const md = s => { const d = C.parse(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const mdKo = s => { const d = C.parse(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${C.DOW_KO[d.getDay()]})`; };
  const greetName = () => (state.user.role === 'dad' ? state.user.name : state.user.name + '님');
  const dLabel = n => n > 0 ? `D-${n}` : n === 0 ? 'D-day' : `D+${-n}`;

  /* ================= 저장 ================= */
  let state = C.defaultState();
  let storageOk = true;
  function load() {
    let raw = null, parsed = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { storageOk = false; }
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (e) {
        try { localStorage.setItem(KEY + '.corrupt', raw); } catch (e2) { /* 무시 */ }   // 깨진 기록도 지우지 않고 보관
      }
    }
    if (parsed && (parsed.schemaVersion || 1) < C.SCHEMA_VERSION) {
      try { localStorage.setItem(`${KEY}.backup-v${parsed.schemaVersion || 1}`, raw); } catch (e) { /* 무시 */ }
    }
    state = C.migrate(parsed);
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { storageOk = false; toast('저장에 실패했어요. 기록 내보내기로 백업해 주세요.'); }
  }
  const daily = date => (state.daily[date] = state.daily[date] || {});

  /* ================= 데이터 ================= */
  let DATA = null;
  let LEX = new Map();
  async function loadData() {
    const names = ['words', 'patterns', 'kana', 'schedule'];
    const res = await Promise.all(names.map(n => fetch(`data/${n}.json`).then(r => { if (!r.ok) throw new Error(`${n}.json ${r.status}`); return r.json(); })));
    const raw = {}; names.forEach((n, i) => { raw[n] = res[i]; });
    DATA = C.indexData(raw);
    LEX = C.buildLexicon(DATA);
  }
  const rubyFor = (jpText, kana) => C.autoRuby(jpText, kana) || C.lexRuby(jpText, LEX);
  const customWord = id => {
    const c = state.custom.words[id]; if (!c) return null;
    return { id, jp: c.jp, kana: c.kana || c.jp, jpr: rubyFor(c.jp, c.kana), kr: '', mean: c.mean, cat: '내 단어', note: c.note || '', custom: true };
  };
  const customPattern = id => {
    const c = state.custom.patterns[id]; if (!c) return null;
    const examples = c.examples.map(e => ({ jp: e.jp, jpr: rubyFor(e.jp, e.kana), mean: e.mean, kr: '', kana: e.kana || '' }));
    return { id, custom: true, no: '내', part: 0, jp: c.jp, jpr: rubyFor(c.jp, c.kana), kr: '', mean: c.mean, kana: c.kana || '', examples, quiz: examples.map(e => ({ q: e.mean, jp: e.jp, jpr: e.jpr, kr: '' })) };
  };
  const W = id => DATA.wordsById[id] || customWord(id);
  const PAT = id => DATA.patternsById[id] || customPattern(id);
  const allWords = () => DATA.studyWords.concat(Object.keys(state.custom.words).map(customWord).filter(Boolean));
  const allPatterns = () => DATA.patterns.patterns.concat(Object.keys(state.custom.patterns).map(customPattern).filter(Boolean));
  const exCard = w => (w.ex ? w : (w.n5 && W(w.n5) && W(w.n5).ex ? W(w.n5) : (w.dupOf ? w : null)));
  const partName = no => (DATA.patterns.parts.find(p => p.no === no) || {}).name || '';

  /* ================= 음성 (Web Speech API) ================= */
  const Speech = (() => {
    const supported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    let voice = null, voices = 0;
    function pick() {
      if (!supported) return;
      const list = speechSynthesis.getVoices() || [];
      voices = list.length;
      const ja = list.filter(v => /^ja([-_]|$)/i.test(v.lang));
      voice = ja.find(v => v.localService) || ja[0] || null;
    }
    if (supported) { pick(); speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', pick); }
    const clean = t => String(t).replace(/[〜～~]/g, ' ').replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim();
    const rate = () => ({ slow: 0.65, normal: 0.85, fast: 1.05 }[state.settings.speed] || 0.85);
    function say(texts) {
      if (!supported) return false;
      const list = (Array.isArray(texts) ? texts : [texts]).map(clean).filter(Boolean);
      if (!list.length) return false;
      try {
        speechSynthesis.cancel();
        setTimeout(() => list.forEach(t => {
          const u = new SpeechSynthesisUtterance(t);
          u.lang = 'ja-JP'; u.rate = rate();
          if (voice) u.voice = voice;
          speechSynthesis.speak(u);
        }), 40);
      } catch (e) { return false; }
      return true;
    }
    return {
      supported, say, pick,
      status: () => (!supported ? 'unsupported' : voice ? 'ok' : (voices === 0 ? 'unknown' : 'none')),
      voiceName: () => (voice ? voice.name : ''),
    };
  })();
  const wordSay = w => String(w.kana || w.jp).split('・')[0];
  let voiceWarned = false;
  function speakOrWarn(texts) {
    if (!Speech.say(texts)) toast('이 브라우저는 음성을 지원하지 않아요. 크롬으로 열어 주세요.');
    else if (Speech.status() === 'none' && !state.settings.voiceOk && !voiceWarned) {
      voiceWarned = true;      // 카드마다 뜨면 방해되므로 접속당 한 번만
      toast('일본어 음성이 없을 수 있어요 → 설정 > 일본어 음성 확인');
    }
  }

  /* ================= 공통 UI ================= */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast'); if (!el) return;
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }
  const krVisible = () => {
    const m = state.settings.krMode;
    if (m === 'show') return true;
    if (m === 'hide') return false;
    return C.dayInfo(DATA, today()).week < 3;      // 자동: 3주차부터 숨김
  };
  const revBadge = on => (on && state.settings.showReview ? '<span class="badge-rev" title="Claude가 채운 내용이라 검수 중이에요">검수 중</span>' : '');
  const speakBtn = (t, cls = '') => `<button class="say ${cls}" data-say="${esc(t)}" aria-label="소리 듣기">🔊</button>`;
  const empty = msg => `<div class="empty">${msg}</div>`;

  function applySettings() {
    const html = document.documentElement;
    html.classList.remove('fs-normal', 'fs-large', 'fs-xlarge');
    html.classList.add('fs-' + (state.settings.fontSize || 'large'));
  }

  /* ================= 라우터 ================= */
  let lastRoute = '';
  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
  function render(opts = {}) {
    const app = $('#app'); if (!app) return;
    if (!DATA) return;
    const parts = (location.hash.replace(/^#\/?/, '') || 'today').split('/').filter(Boolean).map(decodeURIComponent);
    const route = parts[0] || 'today';
    if (!state.user.role && route !== 'welcome' && route !== 'voice') { location.replace('#/welcome'); return; }
    let html = '', tab = route, hideTabs = false;
    switch (route) {
      case 'welcome': html = viewWelcome(); hideTabs = true; break;
      case 'voice': html = viewVoice(parts[1] === 'first'); hideTabs = parts[1] === 'first'; tab = 'settings'; break;
      case 'today': html = viewToday(); break;
      case 'session': if (!SESS) { location.replace('#/today'); return; } html = viewSession(); hideTabs = true; tab = 'today'; break;
      case 'done': html = viewDone(); hideTabs = true; tab = 'today'; break;
      case 'words':
        html = parts[1] === 'new' ? viewWordForm() : parts[1] === 'edit' ? viewWordForm(parts[2]) : parts[1] ? viewWordDetail(parts[1]) : viewWords(); hideTabs = parts[1] === 'new' || parts[1] === 'edit'; break;
      case 'patterns':
        html = parts[1] === 'new' ? viewPatternForm() : parts[1] === 'edit' ? viewPatternForm(parts[2]) : parts[1] ? viewPatternDetail(parts[1]) : viewPatterns(); hideTabs = parts[1] === 'new' || parts[1] === 'edit'; break;
      case 'practice': startPractice(parts[1]); return;
      case 'roleplay': startRoleplayPractice(parts[1]); return;
      case 'kana': html = parts[1] === 'quiz' ? viewKanaQuiz() : viewKana(); hideTabs = parts[1] === 'quiz'; break;
      case 'settings': html = viewSettings(); break;
      default: location.replace('#/today'); return;
    }
    app.innerHTML = html;
    renderTabs(tab, hideTabs);
    const key = location.hash;
    if (!opts.keepScroll && key !== lastRoute) window.scrollTo(0, 0);
    lastRoute = key;
    afterRender(route);
  }
  function renderTabs(active, hide) {
    const nav = $('#tabs'); if (!nav) return;
    nav.hidden = hide;
    document.body.classList.toggle('no-tabs', hide);
    const tabs = [['today', '📅', '오늘'], ['words', '📖', '단어장'], ['patterns', '💬', '패턴']];
    if (state.settings.kanaWarmup) tabs.push(['kana', 'あ', '가나']);
    tabs.push(['settings', '⚙️', '설정']);
    nav.innerHTML = tabs.map(([r, ic, lb]) => `<a href="#/${r}" class="${r === active ? 'on' : ''}" ${r === active ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${lb}</a>`).join('');
  }
  function afterRender(route) {
    if (route === 'session' && SESS && SESS.pendingSpeak) {
      SESS.pendingSpeak = false;
      if (state.settings.autoSpeak) speakItem(SESS.items[SESS.i]);
    }
    if (route === 'kana' && KQ && KQ.pendingSpeak) { KQ.pendingSpeak = false; Speech.say(KQ.items[KQ.i].t.k); }
  }

  /* ================= 첫 실행 ================= */
  function viewWelcome() {
    return `<main class="page center">
      <div class="logo">${jp('一緒に日本語')}</div>
      <h1>잇쇼니 니홍고</h1>
      <p class="muted">아버지와 함께하는 일본어 기초 16주</p>
      <div class="card">
        <h2>누가 쓰나요?</h2>
        <button class="btn lg block" data-act="role" data-role="kwangwoo">광우</button>
        <button class="btn lg block" data-act="role" data-role="dad">아버지</button>
        <form class="other" data-act="role-other">
          <label for="otherName" class="muted">다른 분 이름</label>
          <div class="row"><input id="otherName" maxlength="12" placeholder="이름" autocomplete="off"><button class="btn sec" type="submit">시작</button></div>
        </form>
      </div>
      <p class="tiny muted">로그인은 없어요. 학습 기록은 이 폰에만 저장됩니다.</p>
    </main>`;
  }

  /* ================= 음성 확인/안내 ================= */
  function viewVoice(first) {
    const st = Speech.status();
    const stTxt = { ok: `일본어 음성을 찾았어요 (${esc(Speech.voiceName())})`, none: '일본어 음성 목록에서 찾지 못했어요. 그래도 소리가 나는지 아래에서 직접 확인해 보세요.', unknown: '음성 목록을 아직 불러오는 중이에요. 잠시 뒤 「다시 확인」을 눌러 보세요.', unsupported: '이 브라우저는 음성 읽기를 지원하지 않아요. 크롬으로 열어 주세요.' }[st];
    return `<main class="page">
      <h1>일본어 음성 확인</h1>
      <div class="card">
        <p class="status ${st === 'ok' ? 'good' : 'warn'}">${stTxt}</p>
        <button class="btn lg block" data-say="こんにちは。いっしょに にほんごを べんきょうしましょう。">🔊 소리 테스트</button>
        <p class="muted">「こんにちは…」 하고 일본어로 들리나요? (미디어 볼륨도 확인해 주세요)</p>
        <div class="row2">
          <button class="btn good-btn" data-act="voice-ok" data-first="${first ? 1 : 0}">들렸어요</button>
          <button class="btn sec" data-act="voice-no">안 들려요</button>
        </div>
        <button class="btn ghost block" data-act="voice-recheck">다시 확인</button>
      </div>
      <div class="card" id="voiceGuide" ${state.settings.voiceOk || st === 'ok' ? 'hidden' : ''}>
        <h2>소리가 안 나거나 일본어가 아닌 소리일 때</h2>
        <ol class="steps">
          <li>폰 <b>설정</b>에서 <b>텍스트 음성 변환</b>(TTS)을 찾아요. 기종에 따라 「일반」이나 「접근성」 안에 있고 이름이 조금 다를 수 있어요.</li>
          <li>사용하는 엔진이 <b>Google 텍스트 음성 변환</b>인지 확인하고, 톱니바퀴(⚙) 설정에서 <b>일본어</b> 음성 데이터를 설치해요.</li>
          <li>크롬을 완전히 닫았다가 다시 열고 이 화면에서 <b>다시 확인</b>을 눌러요.</li>
        </ol>
        <p class="muted">음성 없이도 글자·뜻으로 공부할 수 있어요. 나중에 설정 &gt; 일본어 음성 확인에서 다시 볼 수 있어요.</p>
        <button class="btn sec block" data-act="voice-skip" data-first="${first ? 1 : 0}">그래도 계속하기</button>
      </div>
    </main>`;
  }

  /* ================= 오늘 ================= */
  function patternLabel(plan) {
    const p = plan.pattern; if (!p) return '';
    if (p.mode === 'new') { const x = DATA.patternsById[p.pids[0]]; return `새 패턴 ${x.no}. ${x.jp}`; }
    if (p.mode === 'review') return '지난 패턴 다시 말하기: ' + p.pids.map(id => DATA.patternsById[id].jp).join(' · ');
    return p.pids.length === 32 ? `패턴 랠리 (${p.quizIds.length}문제)` : `패턴 퀴즈 ${p.quizIds.length}문제`;
  }
  function estMinutes(plan) {
    const m = plan.review.length * 0.2 + plan.newIds.length * 1.2 + plan.extra.length * 0.3 + (plan.pattern ? (plan.pattern.mode === 'new' ? 6 : 4) : 0) + (plan.extraPattern ? 6 : 0) + (plan.roleplay ? 3 : 0);
    return Math.max(1, Math.round(m));
  }
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (location.hash.startsWith('#/today') || !location.hash) render({ keepScroll: true }); });
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function viewToday() {
    const date = today(), plan = C.buildPlan(DATA, state, date), day = plan.day;
    const sch = DATA.schedule;
    const toTrip = C.diffDays(date, sch.trip), toFirst = C.diffDays(date, sch.firstReadDone), toStart = C.diffDays(date, sch.start);
    const dd = daily(date);
    let body = '';
    const started = !!(dd.started || plan.newIntroducedToday);
    const remaining = C.planRemaining(plan);
    // 남은 일이 없는데 시작했다면 완료 처리
    if (['study', 'saturday', 'review'].includes(plan.type) && started && !plan.finished && remaining === 0) { finishDay(date); plan.finished = true; }

    const kanaBtn = (state.settings.kanaWarmup && (day.kanaWarmup || plan.type === 'warmup' || plan.type === 'pre'))
      ? `<a class="btn sec block" href="#/kana">あ 가나 워밍업 ${plan.type === 'study' ? '(선택 · 5분)' : ''}</a>` : '';
    if (plan.type === 'pre') {
      body = `<div class="card"><h2>본 진도 시작 전이에요</h2>
        <p>가나 워밍업은 <b>${md(DATA.schedule.days[0].date)}(${DATA.schedule.days[0].dow})</b>부터, 본 진도는 <b>${md(sch.start)}(월)</b>부터예요.</p>
        <p class="muted">지금은 앱을 홈 화면에 설치하고 소리를 확인해 두면 돼요.</p>
        <a class="btn sec block" href="#/voice">🔊 일본어 음성 확인</a>${kanaBtn}</div>`;
    } else if (plan.type === 'warmup') {
      body = `<div class="card"><h2>오늘은 가나 워밍업</h2>
        <p>본 진도(단어·패턴)는 <b>${md(sch.start)}(월)</b>부터 시작해요.</p>
        ${state.settings.kanaWarmup ? kanaBtn : '<p class="muted">가나가 헷갈리는 분은 설정에서 「가나 워밍업」을 켜면 표와 퀴즈가 나와요.</p>'}</div>`;
    } else if (plan.type === 'rest') {
      body = `<div class="card"><h2>오늘은 쉬는 날 🌿</h2><p class="muted">일요일에 돌아올 복습 카드는 월요일로 넘어가요.</p>
        ${plan.review.length ? `<button class="btn sec block" data-act="start">가볍게 복습하기 (선택 · ${plan.review.length}장)</button>` : ''}</div>`;
    } else {
      const rows = [];
      if (plan.review.length || plan.reviewDueTotal) rows.push(['🔁', `복습 ${plan.review.length}장`, plan.reviewDueTotal > plan.review.length ? `나머지 ${plan.reviewDueTotal - plan.review.length}장은 다음 날` : '오늘 돌아온 카드']);
      else rows.push(['🔁', '복습 없음', '오늘 돌아올 카드가 없어요']);
      if (plan.type === 'study') {
        const nn = plan.newIds.length;
        const sub = [plan.newCarry ? `지난 분량 ${plan.newCarry}개 포함` : (plan.newTarget < 5 && nn ? '복습이 많아 오늘은 줄였어요' : '소리 듣고 따라 말하기'),
          plan.backlogNew ? `아직 밀린 ${plan.backlogNew}개는 며칠에 나눠서` : ''].filter(Boolean).join(' · ');
        rows.push(['🆕', nn ? `새 단어 ${nn}개` : '새 단어 완료', sub]);
        if (plan.extra.length) rows.push(['📝', `N5 예문 ${plan.extra.length}장`, '이미 배운 단어의 예문']);
      } else if (plan.newIds.length) {
        rows.push(['🆕', `밀린 새 단어 ${plan.newIds.length}개`, '여유가 있어서 따라잡기']);
      }
      if (plan.extraPattern) { const x = DATA.patternsById[plan.extraPattern.pids[0]]; rows.push(['↩️', `놓친 패턴 ${x.no}. ${x.jp}`, '예문 듣고 따라 말하기 → 퀴즈']); }
      if (plan.pattern) rows.push(['💬', patternLabel(plan), plan.pattern.mode === 'new' ? '예문 듣고 따라 말하기 → 퀴즈' : '한국어를 보고 일본어로 말하기']);
      else if (day.pattern && plan.type === 'study') rows.push(['💬', '패턴 완료', '']);
      if (plan.roleplay) rows.push(['🎭', `롤플레잉 · ${partName(DATA.rolesById[plan.roleplay].part)}`, '가게·역에서 주고받는 말']);
      const title = { study: '오늘의 진도', saturday: '토요일 · 주간 복습', review: `${esc(day.phase || '복습')} 기간` }[plan.type];
      const kanaNote = '';
      if (plan.finished) {
        body = `<div class="card done"><h2>${title} · 완료 ✓</h2>
          <p>오늘 ${dd.reviewCount || 0}장 복습, 새 단어 ${plan.newIntroducedToday}개. 수고했어요!</p>
          ${remaining ? `<button class="btn sec block" data-act="start">${plan.review.length ? `복습 ${plan.review.length}장 더 하기` : '이어서 하기'}</button>` : ''}
          ${kanaBtn}</div>`;
      } else if (!rows.length || remaining === 0) {
        body = `<div class="card"><h2>${title}</h2><p class="muted">오늘은 할 분량이 없어요.</p>${kanaBtn}</div>`;
      } else {
        body = `<div class="card plan"><h2>${title} <span class="min">약 ${estMinutes(plan)}분</span></h2>
          <ul class="plan-list">${rows.map(r => `<li><span class="ic" aria-hidden="true">${r[0]}</span><div><b>${esc(r[1])}</b>${r[2] ? `<small>${esc(r[2])}</small>` : ''}</div></li>`).join('')}</ul>
          <button class="btn lg block primary" data-act="start">${started ? '이어서 하기' : '학습 시작'} ▶</button>
          ${(plan.newCarry || plan.extraPattern) && !started ? '<button class="btn ghost block" data-act="only-today">부담되면 오늘 것만 하기</button>' : ''}
          ${plan.onlyToday && plan.backlogNew ? '<button class="btn ghost block" data-act="with-backlog">밀린 것도 함께 하기</button>' : ''}${kanaBtn}${kanaNote}</div>`;
      }
    }

    // 진도 요약
    const total = C.totalLearned(DATA, state), streak = C.computeStreak(DATA, state, date), strip = C.weekStrip(DATA, state, date);
    const dotTxt = { done: '✓', donetoday: '✓', today: '●', missed: '·', future: '', rest: '휴', off: '' };
    const summary = `<div class="card"><h2>내 진도</h2>
      <div class="stats"><div><b>${streak}</b><small>연속 일</small></div><div><b>${total}<span class="of">/275</span></b><small>배운 단어</small></div><div><b>${Object.keys(state.cards).filter(C.isQuizId).length}<span class="of">/94</span></b><small>패턴 퀴즈</small></div></div>
      <div class="week" aria-label="이번 주">${strip.map(s => `<div class="wd ${s.state}"><small>${s.dow}</small><i>${dotTxt[s.state]}</i></div>`).join('')}</div>
      <p class="tiny muted">함께 보기(두 사람의 진도)는 2차 업데이트에서 열려요.</p></div>`;

    // 설치 안내
    let install = '';
    if (!isStandalone() && !state.settings.installTipHidden && !OVERRIDE) {
      install = `<div class="card tip"><b>홈 화면에 추가하기</b>
        <p>${deferredInstall ? '아래 버튼을 눌러 앱처럼 설치하세요.' : '크롬 오른쪽 위 ⋮ 메뉴 → <b>홈 화면에 추가</b>(또는 「앱 설치」)를 누르세요.'}</p>
        <div class="row2">${deferredInstall ? '<button class="btn sec" data-act="install">앱 설치</button>' : ''}<button class="btn ghost" data-act="hide-install">숨기기</button></div></div>`;
    }
    const banner = OVERRIDE ? `<div class="banner">🧪 체험 모드 · 날짜 ${OVERRIDE} · 기록은 실제 기록과 분리돼요 <a href="${location.pathname}">체험 끝내기</a></div>` : '';
    const storageWarn = storageOk ? '' : '<div class="banner warn">이 브라우저에서는 기록을 저장할 수 없어요 (사생활 보호 모드?)</div>';
    const voiceWarn = (Speech.status() === 'none' && !state.settings.voiceOk && !state.settings.voiceSkip) ? '<a class="banner warn" href="#/voice">🔊 일본어 음성을 못 찾았어요 → 확인하러 가기</a>' : '';

    const dchips = [`<div class="dchip trip"><small>마쓰야마 출국까지</small><b>${dLabel(toTrip)}</b></div>`];
    if (toStart > 0) dchips.push(`<div class="dchip"><small>본 진도 시작까지</small><b>${dLabel(toStart)}</b></div>`);
    else if (toFirst >= 0) dchips.push(`<div class="dchip"><small>1회독 완료(${md(sch.firstReadDone)})까지</small><b>${dLabel(toFirst)}</b></div>`);
    else dchips.push(`<div class="dchip"><small>1회독 완료</small><b>끝 ✓</b></div>`);

    return `<main class="page">
      ${banner}${storageWarn}${voiceWarn}
      <header class="hello"><div><h1>${esc(greetName())}, 안녕하세요</h1><p class="muted">${mdKo(date)}${day.week ? ` · ${day.week}주차` : ''}</p></div></header>
      <div class="dchips">${dchips.join('')}</div>
      ${body}${summary}${install}
    </main>`;
  }

  /* ================= 세션 ================= */
  let SESS = null;
  function newSession(kind, items, extra = {}) {
    SESS = Object.assign({ kind, items, i: 0, ui: {}, date: today(), tick: Date.now(), pendingSpeak: true, done: false }, extra);
  }
  function tickTime() {
    if (!SESS) return;
    const now = Date.now(); const gap = Math.min(now - SESS.tick, 90000); SESS.tick = now;
    daily(SESS.date).ms = (daily(SESS.date).ms || 0) + gap;
  }
  function itemsFromPlan(plan) {
    const items = [];
    plan.review.forEach(id => items.push(C.isQuizId(id) ? { kind: 'quiz', qid: id, step: '복습', sub: '패턴 복습' } : { kind: 'review', id, step: '복습', sub: '단어' }));
    plan.extra.forEach(id => items.push({ kind: 'extra', id, step: 'N5 예문', sub: '' }));
    plan.newIds.forEach(id => items.push({ kind: 'learn', id, step: '새 단어', sub: '익히기' }));
    plan.newIds.forEach(id => items.push({ kind: 'recall', id, step: '새 단어', sub: '떠올리기' }));
    if (plan.extraPattern) items.push(...patternItems(plan.extraPattern).map(x => { delete x.endsPattern; x.sub = x.kind === 'pattern' ? '놓친 패턴' : '놓친 패턴 · ' + x.sub; return x; }));
    if (plan.pattern) items.push(...patternItems(plan.pattern));
    if (plan.roleplay) items.push({ kind: 'roleplay', rid: plan.roleplay, step: '롤플레잉', sub: '', endsRoleplay: true });
    return items;
  }
  function patternItems(pt) {
    const items = [];
    if (pt.examples) {
      const p = DATA.patternsById[pt.pids[0]];
      items.push({ kind: 'pattern', pid: p.id, step: '패턴', sub: '오늘의 패턴' });
      p.examples.forEach((_, idx) => items.push({ kind: 'example', pid: p.id, idx, step: '패턴', sub: '듣고 따라 말하기' }));
    }
    const sub = pt.mode === 'new' ? '퀴즈' : pt.mode === 'review' ? '지난 패턴 다시 말하기' : '패턴 랠리';
    pt.quizIds.forEach(qid => items.push({ kind: 'quiz', qid, step: '패턴', sub, fromPattern: true }));
    if (items.length) items[items.length - 1].endsPattern = true;
    return items;
  }
  function startToday() {
    const date = today(), plan = C.buildPlan(DATA, state, date);
    const dd = daily(date);
    if (dd.newTarget == null && plan.type !== 'rest' && plan.type !== 'pre' && plan.type !== 'warmup') dd.newTarget = plan.newTarget;
    dd.started = true; save();
    const items = itemsFromPlan(plan);
    if (!items.length) { toast('오늘 할 분량이 없어요'); return; }
    newSession('today', items, { plan });
    go('#/session');
  }
  function startPractice(pid) {
    const p = PAT(pid); if (!p) { location.replace('#/patterns'); return; }
    let items;
    if (p.custom) {      // 내 패턴: SRS 없이 따라 말하기 → 퀴즈(뜻 → 일본어)
      items = [{ kind: 'pattern', pid, step: '패턴', sub: '오늘의 패턴' }]
        .concat(p.examples.map((_, idx) => ({ kind: 'example', pid, idx, step: '패턴', sub: '듣고 따라 말하기' })))
        .concat(C.shuffle(p.quiz.map((_, idx) => idx)).map(idx => ({ kind: 'cquiz', pid, idx, step: '패턴', sub: '퀴즈' })));
    } else {
      items = patternItems({ mode: 'new', pids: [pid], quizIds: C.quizIds(p), examples: true }).map(x => { delete x.endsPattern; return x; });
    }
    newSession('practice', items, { returnTo: `#/patterns/${pid}`, quizzesOnlyAdvance: true });
    location.replace('#/session');
  }
  function startRoleplayPractice(rid) {
    if (!DATA.rolesById[rid]) { location.replace('#/patterns'); return; }
    newSession('practice', [{ kind: 'roleplay', rid, step: '롤플레잉', sub: '', endsRoleplay: true }], { returnTo: '#/patterns' });
    location.replace('#/session');
  }
  function groupLabel(s) {
    const it = s.items[s.i]; let a = s.i, b = s.i;
    const same = x => x && x.step === it.step && x.sub === it.sub;
    while (same(s.items[a - 1])) a--; while (same(s.items[b + 1])) b++;
    const name = it.sub && it.sub !== it.step ? `${it.step} · ${it.sub}` : it.step;
    return b > a ? `${name}  ${s.i - a + 1}/${b - a + 1}` : name;
  }
  function viewSession() {
    const s = SESS, it = s.items[s.i];
    if (!it) return '<main class="page"><p>끝났어요.</p></main>';
    const pct = Math.round((s.i / s.items.length) * 100);
    const top = `<div class="sess-top"><button class="btn ghost sm" data-act="exit">✕ 그만하기</button><div class="prog" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div></div>
      <div class="step">${esc(groupLabel(s))}${it.again ? ' · 한 번 더' : ''}</div>`;
    return `<main class="page sess">${top}${itemView(it, s)}</main>`;
  }
  const gradeBar = labels => `<div class="gradebar"><button class="g g-no" data-act="grade" data-g="no">${labels[0]}<small>내일 다시</small></button><button class="g g-fz" data-act="grade" data-g="fuzzy">${labels[1]}<small>같은 단계</small></button><button class="g g-ok" data-act="grade" data-g="know">${labels[2]}<small>다음 단계</small></button></div>`;
  const KR_LINE = (kr, ui) => (kr ? (krVisible() || ui.kr ? `<div class="kr">${esc(kr)}</div>` : '<button class="btn ghost sm" data-act="show-kr">한글 발음 보기</button>') : '');

  function wordBody(w, ui, o = {}) {
    const base = w.dupOf ? W(w.dupOf) : w;
    const ex = o.noEx ? null : exCard(base.dupOf ? base : w);
    const exSrc = w.dupOf ? w : ex;
    const parts = [];
    parts.push(`<div class="cat">${esc(base.cat)}</div>`);
    parts.push(`<div class="bigjp">${rb(base.jp, base.jpr)}</div>`);
    if (base.jpr && state.settings.furigana !== false) {       // 후리가나가 이미 읽기를 보여주므로 읽기 줄은 생략(검수 표시만 유지)
      if (base.kanaBy === 'claude') parts.push(`<div>${revBadge(true)}</div>`);
    } else if (base.kana && base.kana !== base.jp) parts.push(`<div class="kana">${jp(base.kana)} ${revBadge(base.kanaBy === 'claude')}</div>`);
    parts.push(KR_LINE(base.kr, ui));
    parts.push(`<div class="mean">${esc(base.mean)}</div>`);
    if (exSrc && exSrc.ex) {
      parts.push(`<div class="ex"><div class="jpline">${rb(exSrc.ex, exSrc.exr)} ${speakBtn(exSrc.ex, 'sm')}</div>${krVisible() || ui.kr ? `<div class="kr">${esc(exSrc.exKr || '')}</div>` : ''}<div class="mean sm">${esc(exSrc.exMean || '')}</div></div>`);
    }
    const note = (exSrc && exSrc.note) || base.note;
    if (note) parts.push(`<div class="note">💡 ${esc(note)}</div>`);
    return parts.join('');
  }
  function itemView(it, s) {
    const ui = s.ui;
    switch (it.kind) {
      case 'review': case 'recall': {
        const w = W(it.id), c = state.cards[it.id];
        const front = `<div class="cat">${it.kind === 'review' ? `복습 · ${c ? c.stage : 1}단계` : '방금 배운 단어'}</div><div class="bigjp">${rb(w.jp, w.jpr)}</div>${speakBtn(wordSay(w))}`;
        if (!ui.reveal) return `<div class="card q">${front}<p class="muted">뜻을 떠올려 보세요</p><button class="btn lg block primary" data-act="reveal">정답 보기</button></div>`;
        return `<div class="card q">${wordBody(w, ui)}${speakBtn(wordSay(w))}</div>${gradeBar(['몰라요', '헷갈려요', '알아요'])}`;
      }
      case 'learn': {
        const w = W(it.id);
        return `<div class="card q">${wordBody(w, ui)}${speakBtn(wordSay(w))}<p class="muted">소리를 듣고 3번 따라 말해 보세요</p><button class="btn lg block primary" data-act="learned">다음 ▶</button></div>`;
      }
      case 'extra': {
        const dup = W(it.id), base = W(dup.dupOf);
        return `<div class="card q"><div class="cat">이미 배운 단어의 예문</div>${wordBody(dup, ui)}<button class="btn lg block primary" data-act="extra-next">확인했어요 ▶</button></div>`;
      }
      case 'pattern': {
        const p = PAT(it.pid);
        return `<div class="card q"><div class="cat">${p.custom ? '내 패턴' : `PART ${p.part} · ${esc(partName(p.part))} · 패턴 ${p.no}`}</div><div class="bigjp">${rb(p.jp, p.jpr)}</div>${speakBtn(p.jp)}${KR_LINE(p.kr, ui)}<div class="mean">${esc(p.mean)}</div><p class="muted">이 틀에 단어만 바꿔 넣어요. 예문을 들어 볼까요?</p><button class="btn lg block primary" data-act="next">예문 듣기 ▶</button></div>`;
      }
      case 'example': {
        const p = PAT(it.pid), e = p.examples[it.idx];
        return `<div class="card q"><div class="patline">${rb(p.jp, p.jpr)}</div><div class="bigjp jp-s">${rb(e.jp, e.jpr)}</div>${speakBtn(e.jp)}${e.kana && !p.custom ? '' : (e.kana ? `<div class="kana">${jp(e.kana)}</div>` : '')}${KR_LINE(e.kr, ui)}<div class="mean">${esc(e.mean)}</div><p class="muted">듣고 그대로 따라 말해 보세요</p><button class="btn lg block primary" data-act="next">따라 말했어요 ▶</button></div>`;
      }
      case 'quiz': case 'cquiz': {
        const { p, q } = it.kind === 'cquiz' ? { p: PAT(it.pid), q: PAT(it.pid).quiz[it.idx] } : C.quizOf(DATA, it.qid);
        const head = `<div class="patline">${rb(p.jp, p.jpr)}</div><div class="quizq">${esc(q.q)}</div>`;
        if (!ui.reveal) return `<div class="card q">${head}<p class="muted">일본어로 소리 내어 말한 뒤 정답을 확인하세요</p><button class="btn lg block primary" data-act="reveal">정답 보기</button></div>`;
        return `<div class="card q">${head}<div class="bigjp jp-s">${rb(q.jp, q.jpr)}</div>${speakBtn(q.jp)} ${revBadge(q.by === 'claude')}${KR_LINE(q.kr, ui)}<p class="muted">내가 한 말과 비교해 스스로 채점해요</p></div>${gradeBar(['틀렸어요', '헷갈려요', '맞았어요'])}`;
      }
      case 'roleplay': return roleplayView(it, s);
      default: return '';
    }
  }
  function roleplayView(it, s) {
    const r = DATA.rolesById[it.rid], ui = s.ui;
    if (ui.line == null) { ui.line = 0; ui.reveal = false; }
    const done = r.lines.slice(0, ui.line).map(l => `<div class="rl ${l.who}"><b>${l.who === 'me' ? '나' : '점원'}</b> ${rb(l.jp, l.jpr)}<small>${esc(l.mean)}</small></div>`).join('');
    const l = r.lines[ui.line];
    let cur = '';
    if (l) {
      const who = l.who === 'me';
      cur = `<div class="rl cur ${l.who}">${l.cue ? `<div class="cue">(${esc(l.cue)})</div>` : ''}<b>${who ? '나' : '점원'}</b>
        ${who && !ui.reveal ? `<div class="quizq">${esc(l.mean)}</div><p class="muted">일본어로 말해 보세요</p><button class="btn lg block primary" data-act="rp-reveal">정답 보기</button>`
          : `<div class="bigjp jp-s">${rb(l.jp, l.jpr)}</div>${speakBtn(l.jp)}${KR_LINE(l.kr, ui)}<div class="mean">${esc(l.mean)}</div><button class="btn lg block primary" data-act="rp-next">${ui.line === r.lines.length - 1 ? '마치기 ✓' : '다음 ▶'}</button>`}</div>`;
    }
    return `<div class="card q"><div class="cat">롤플레잉 · PART ${r.part} ${esc(partName(r.part))}</div><div class="rl-list">${done}</div>${cur}</div>`;
  }
  function speakItem(it) {
    if (!it) return;
    const ui = SESS.ui;
    switch (it.kind) {
      case 'review': case 'recall': speakOrWarn(wordSay(W(it.id))); break;
      case 'learn': { const w = W(it.id); const ex = exCard(w); speakOrWarn([wordSay(w)].concat(ex && ex.ex ? [ex.ex] : [])); break; }
      case 'extra': speakOrWarn(W(it.id).ex); break;
      case 'pattern': speakOrWarn(PAT(it.pid).jp); break;
      case 'example': speakOrWarn(PAT(it.pid).examples[it.idx].jp); break;
      case 'roleplay': { const l = DATA.rolesById[it.rid].lines[ui.line || 0]; if (l && l.who === 'staff') speakOrWarn(l.jp); break; }
      default: break;
    }
  }
  function advance(requeue) {
    const s = SESS, it = s.items[s.i];
    tickTime();
    // 항목 완료 표시(재개 시 반복 방지)
    const dd = daily(s.date);
    if (s.kind === 'today') {
      if (it.kind === 'extra') { dd.extraSeen = (dd.extraSeen || []).concat(it.id); }
      if (it.endsPattern) dd.patternDone = true;
      if (it.endsRoleplay) dd.roleplayDone = true;
    }
    if (requeue && !it.again) {
      const copy = Object.assign({}, it, { again: true });
      s.items.splice(Math.min(s.i + 4, s.items.length), 0, copy);
    }
    save();
    s.i++; s.ui = {}; s.pendingSpeak = true;
    if (s.i >= s.items.length) { finishSession(); return; }
    render();
  }
  function gradeItem(g) {
    const s = SESS, it = s.items[s.i];
    const id = it.qid || it.id;
    tickTime();
    if (!it.again && it.kind !== 'cquiz') {
      const r = C.grade(state, id, g, s.date);
      if (r.isReview && s.kind === 'today') daily(s.date).reviewCount = (daily(s.date).reviewCount || 0) + 1;
    }
    advance(g === 'no');
  }
  function finishSession() {
    const s = SESS; s.done = true;
    if (s.kind === 'today') { finishDay(s.date); go('#/done'); }
    else { toast('연습 끝! 수고했어요'); SESS = null; go(s.returnTo || '#/today'); }
  }
  function finishDay(date) {
    const dd = daily(date), day = C.dayInfo(DATA, date);
    dd.finished = true;
    let patternId = '';
    if (day.pattern) patternId = day.pattern.mode === 'new' ? day.pattern.id : day.pattern.mode === 'review' ? day.pattern.ids.join('+') : 'rally';
    const entry = {
      date, name: state.user.name,
      reviewCount: dd.reviewCount || 0,
      newCount: Object.entries(state.cards).filter(([id, c]) => c.intro === date && DATA.wordsById[id]).length,
      patternId, minutes: Math.max(1, Math.round((dd.ms || 0) / 60000)),
      totalLearned: C.totalLearned(DATA, state),
    };
    const i = state.log.findIndex(x => x.date === date);
    if (i >= 0) state.log[i] = entry; else state.log.push(entry);     // 같은 날짜는 덮어써서 중복 기록 방지
    save();
  }
  function viewDone() {
    const date = today(), e = state.log.find(x => x.date === date);
    if (!e) return '<main class="page"><p>오늘 기록이 없어요.</p><a class="btn" href="#/today">오늘 화면으로</a></main>';
    const streak = C.computeStreak(DATA, state, date);
    const msgs = ['오늘도 한 걸음!', '꾸준함이 최고예요 👏', '잘했어요! 내일 또 만나요', '아버지와 함께라서 더 든든해요'];
    return `<main class="page center"><div class="confetti" aria-hidden="true">🎉</div><h1>오늘 학습 완료!</h1><p class="muted">${msgs[C.hashStr(date) % msgs.length]}</p>
      <div class="card"><div class="stats"><div><b>${e.minutes}</b><small>분</small></div><div><b>${e.reviewCount}</b><small>복습</small></div><div><b>${e.newCount}</b><small>새 단어</small></div></div>
      <p>배운 단어 <b>${e.totalLearned}</b> / 275 · 연속 <b>${streak}</b>일</p></div>
      <p class="tiny muted">카톡으로 보내기 버튼은 2차 업데이트에서 열려요.</p>
      <a class="btn lg block primary" href="#/today">오늘 화면으로</a></main>`;
  }

  /* ================= 단어장 ================= */
  const WB = { q: '', filter: 'all', cat: '' };
  const PB = { q: '' };
  let PREFILL = null;
  const norm = s => C.hira(String(s || '').toLowerCase()).replace(/[\s・〜～~、。？?！!]/g, '');
  const dictUrl = q => 'https://ja.dict.naver.com/#/search?query=' + encodeURIComponent(q);
  const isJa = s => /[぀-ヿ一-鿿]/.test(s);
  const isConfused = id => { const c = state.cards[id]; return !!(state.flags[id] || (c && (c.lastGrade === 'no' || c.lastGrade === 'fuzzy' || (c.lapse || 0) >= 2))); };
  const nCustomWords = () => Object.keys(state.custom.words).length;

  /** 검색어가 들어 있는 패턴 예문(내장+내 패턴). 단어가 단어장에 없어도 예문에서 뜻을 알 수 있게. */
  function exampleHits(qn, limit = 8) {
    const out = [], seen = new Set();
    for (const p of allPatterns()) {
      for (const e of p.examples.concat(p.quiz.map(q => ({ jp: q.jp, jpr: q.jpr, mean: q.q, kr: q.kr })))) {
        if (seen.has(e.jp)) continue;
        if (norm(e.jp + C.readingOf(e.jp, e.jpr) + e.mean + (e.kr || '') + (e.kana || '')).includes(qn)) { seen.add(e.jp); out.push({ p, e }); if (out.length >= limit) return out; }
      }
    }
    return out;
  }
  function lookupBox(q) {
    const t = q.trim();
    return `<div class="card lookup"><p>「<b>${esc(t)}</b>」, 단어장에 없나요?</p>
      <a class="btn sec block" href="${dictUrl(t)}" target="_blank" rel="noopener">📖 네이버 일본어사전에서 찾기 ↗</a>
      <button class="btn block" data-act="word-new" data-q="${esc(t)}">＋ 내 단어장에 추가</button></div>`;
  }
  function wordRows() {
    const qn = norm(WB.q);
    const list = allWords().filter(w => {
      if (WB.filter === 'mine' && !w.custom) return false;
      if (WB.filter === 'learned' && !state.cards[w.id]) return false;
      if (WB.filter === 'confused' && !isConfused(w.id)) return false;
      if (WB.cat && w.cat !== WB.cat) return false;
      if (qn) {
        const ex = exCard(w);
        if (!norm([w.jp, w.kana, w.kr, w.mean, w.note, ex && ex.ex, ex && C.readingOf(ex.ex, ex.exr), ex && ex.exMean].join(' ')).includes(qn)) return false;
      }
      return true;
    });
    let html = '';
    if (!list.length) {
      html = empty(qn ? '단어장에서 찾지 못했어요.' : WB.filter === 'confused' ? '헷갈린 단어가 아직 없어요. 복습에서 「헷갈려요」「몰라요」를 고르면 여기에 모여요.' : WB.filter === 'mine' ? '아직 추가한 단어가 없어요. 궁금한 단어를 직접 추가해 보세요.' : '단어가 없어요.');
    } else {
      html = `<ul class="wlist">${list.map(w => {
        const c = state.cards[w.id];
        const st = isConfused(w.id) ? '<i class="dot amber" title="헷갈림"></i>' : c ? '<i class="dot green" title="배움"></i>' : '<i class="dot" title="아직"></i>';
        const sub = [w.kana !== w.jp ? jp(w.kana) : '', krVisible() && w.kr ? esc(w.kr) : ''].filter(Boolean).join(' · ');
        return `<li><a href="#/words/${w.id}" class="wrow ${c ? '' : 'todo'}">${st}<span class="w1">${jp(w.jp)}</span><span class="w2">${esc(w.mean)}${w.custom ? ' <span class="badge-mine">내 단어</span>' : ''}<small>${sub}</small></span>${state.flags[w.id] ? '<span class="star">★</span>' : ''}</a></li>`;
      }).join('')}</ul><p class="tiny muted center">${list.length}개</p>`;
    }
    if (qn) {
      const hits = exampleHits(qn);
      if (hits.length) {
        html += `<h2>예문에서 찾기</h2><ul class="exlist">${hits.map(({ p, e }) => `<li>${speakBtn(e.jp, 'sm')}<div><a class="plink" href="#/patterns/${p.id}">${rb(e.jp, e.jpr)}</a><small>${esc(e.mean)}</small></div></li>`).join('')}</ul>`;
      }
      html += lookupBox(WB.q);
    }
    return html;
  }
  function viewWords() {
    const cats = [...new Set(DATA.studyWords.map(w => w.cat))];
    const t = DATA.words.tips;
    const tips = `<details class="card tips"><summary>📌 학습 팁 (발음 함정 · 패턴 공식 · 암기 루틴)</summary>
      <h3>발음 함정</h3><ul>${t.pronunciation.map(x => `<li><b>${esc(x.type)}</b> ${esc(x.text)}</li>`).join('')}</ul>
      <h3>패턴 공식</h3><ul>${t.formulas.map(x => `<li>${jp(x.frame)} → ${esc(x.mean)}</li>`).join('')}</ul>
      <h3>암기 루틴</h3><ol>${t.routine.map(x => `<li>${esc(x)}</li>`).join('')}</ol></details>`;
    const chips = [['all', '전체'], ['learned', '배운 것'], ['confused', '헷갈린 단어'], ['mine', `내 단어 ${nCustomWords()}`]];
    return `<main class="page"><h1>단어장</h1>
      <input id="wq" type="search" placeholder="일본어·뜻·발음·예문 검색" value="${esc(WB.q)}" autocomplete="off">
      <div class="chips">${chips.map(([k, l]) => `<button class="chip ${WB.filter === k ? 'on' : ''}" data-act="wf" data-v="${k}">${l}</button>`).join('')}
        <select id="wcat" aria-label="분류"><option value="">모든 분류</option>${cats.map(c => `<option ${WB.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <button class="btn sec block" data-act="word-new" data-q="">＋ 내 단어 추가</button>
      <div id="wrows">${wordRows()}</div>${tips}</main>`;
  }
  function viewWordDetail(id) {
    const w = W(id); if (!w) return empty('없는 단어예요');
    const c = state.cards[id];
    const status = c ? `<p class="muted">복습 ${c.stage}단계 · 다음 ${md(c.due)} · 헷갈린 횟수 ${c.lapse || 0}</p>` : `<p class="muted">${w.custom ? '복습 카드에 넣지 않았어요' : '아직 배우지 않은 단어예요'}</p>`;
    const mine = w.custom ? `<div class="row2"><a class="btn sec" href="#/words/edit/${id}">고치기</a><button class="btn ghost danger" data-act="word-del" data-id="${id}">삭제</button></div>
      <button class="btn block" data-act="word-srs" data-id="${id}">${c ? '복습에서 빼기' : '복습에 넣기 (내일부터)'}</button>` : '';
    return `<main class="page"><a class="back" href="#/words">← 단어장</a>
      <div class="card q">${wordBody(w, {})}${speakBtn(wordSay(w))}</div>
      ${status}${mine}
      <button class="btn sec block" data-act="flag" data-id="${id}">${state.flags[id] ? '★ 헷갈림 표시 해제' : '☆ 헷갈리는 단어로 표시'}</button>
      <a class="btn ghost block" href="${dictUrl(w.jp)}" target="_blank" rel="noopener">📖 사전에서 더 보기 ↗</a></main>`;
  }
  function viewWordForm(id) {
    const c = id ? state.custom.words[id] : null;
    if (id && !c) return empty('없는 단어예요');
    const pre = c || PREFILL || {};
    PREFILL = null;
    return `<main class="page"><a class="back" href="#/words${id ? '/' + id : ''}">← ${id ? '돌아가기' : '단어장'}</a>
      <h1>${id ? '내 단어 고치기' : '내 단어 추가'}</h1>
      <form class="card" data-form="word" data-id="${id || ''}" autocomplete="off">
        <label class="setlabel" for="f_jp">일본어</label><input id="f_jp" name="jp" required maxlength="40" lang="ja" placeholder="예: 駅" value="${esc(pre.jp || '')}">
        <label class="setlabel" for="f_kana">읽기 (히라가나) <span class="muted tiny">한자가 있으면 적어 주세요 · 비워도 아는 한자는 자동으로 붙어요</span></label><input id="f_kana" name="kana" maxlength="60" lang="ja" placeholder="예: えき" value="${esc(pre.kana || '')}">
        <label class="setlabel" for="f_mean">뜻</label><input id="f_mean" name="mean" required maxlength="60" placeholder="예: 역" value="${esc(pre.mean || '')}">
        <label class="setlabel" for="f_note">메모 (선택)</label><input id="f_note" name="note" maxlength="80" value="${esc(pre.note || '')}">
        <p class="tiny muted">미리보기: <span id="prevRuby" class="prev">${pre.jp ? rb(pre.jp, rubyFor(pre.jp, pre.kana)) : ''}</span></p>
        ${id ? '' : '<label class="chk"><input type="checkbox" name="srs" checked> 복습 카드에 넣기 (내일부터 복습에 나와요)</label>'}
        <button class="btn lg block primary" type="submit">저장</button>
        <a class="btn ghost block" id="f_dict" href="${dictUrl(pre.jp || pre.mean || '')}" target="_blank" rel="noopener">📖 사전에서 찾아보기 ↗</a>
      </form></main>`;
  }
  const KANA_ONLY = /^[ぁ-ゖァ-ヶー・\s]+$/;
  function saveWordForm(form) {
    const f = new FormData(form), id = form.dataset.id;
    const rec = { jp: (f.get('jp') || '').trim(), kana: (f.get('kana') || '').trim(), mean: (f.get('mean') || '').trim(), note: (f.get('note') || '').trim() };
    if (!rec.jp || !rec.mean) { toast('일본어와 뜻을 적어 주세요'); return; }
    if (rec.kana && !KANA_ONLY.test(rec.kana)) { toast('읽기는 히라가나로 적어 주세요'); return; }
    if (!id && DATA.studyWords.some(w => w.jp === rec.jp) && !confirm('이미 단어장에 있는 단어예요. 그래도 추가할까요?')) return;
    let target = id;
    if (id) {
      Object.assign(state.custom.words[id], rec);
    } else {
      target = 'u' + (++state.custom.seq);
      state.custom.words[target] = Object.assign({ id: target, created: today() }, rec);
      if (f.get('srs')) C.introduce(state, target, today());
    }
    save(); toast(id ? '고쳤어요' : '추가했어요');
    go('#/words/' + target);
  }

  /* ================= 패턴 ================= */
  function patternMatches(p, qn) {
    if (!qn) return true;
    return norm([p.jp, C.readingOf(p.jp, p.jpr), p.mean, p.kr, p.kana].concat(p.examples.map(e => e.jp + C.readingOf(e.jp, e.jpr) + e.mean + (e.kana || ''))).join(' ')).includes(qn);
  }
  function patternList() {
    const qn = norm(PB.q);
    const row = p => {
      const tried = p.custom ? false : C.quizIds(p).some(q => state.cards[q]);
      return `<li><a href="#/patterns/${p.id}" class="prow"><span class="pn">${p.custom ? '내' : p.no}</span><span class="pt">${jp(p.jp)}<small>${esc(p.mean)}</small></span>${tried ? '<i class="dot green" title="연습함"></i>' : ''}</a></li>`;
    };
    let html = '', total = 0;
    DATA.patterns.parts.forEach(pt => {
      const list = DATA.patterns.patterns.filter(p => p.part === pt.no && patternMatches(p, qn));
      if (!list.length) return;
      total += list.length;
      html += `<section><h2>PART ${pt.no} · ${esc(pt.name)}</h2><ul class="plist">${list.map(row).join('')}</ul></section>`;
    });
    const mine = Object.keys(state.custom.patterns).map(customPattern).filter(p => p && patternMatches(p, qn));
    total += mine.length;
    if (mine.length || !qn) html += `<section><h2>✏️ 내 패턴</h2>${mine.length ? `<ul class="plist">${mine.map(row).join('')}</ul>` : '<p class="muted tiny">아직 없어요. 여행에서 쓰고 싶은 문장을 직접 추가해 보세요.</p>'}</section>`;
    if (!qn) html += `<section><h2>🎭 롤플레잉</h2><ul class="plist">${DATA.patterns.roleplays.map(r => `<li><a class="prow" href="#/roleplay/${r.id}"><span class="pn">${r.part}</span><span class="pt">PART ${r.part} · ${esc(partName(r.part))}<small>${r.lines.length}줄 주고받기</small></span></a></li>`).join('')}</ul></section>`;
    if (qn && !total) html = empty('찾는 패턴이 없어요.') + lookupBox(PB.q);
    return html;
  }
  function viewPatterns() {
    return `<main class="page"><h1>여행 패턴 32</h1>
      <input id="pq" type="search" placeholder="패턴·예문 검색 (일본어/뜻/발음)" value="${esc(PB.q)}" autocomplete="off">
      <a class="btn sec block" href="#/patterns/new">＋ 내 패턴 추가</a>
      <div id="prows">${patternList()}</div></main>`;
  }
  function viewPatternDetail(pid) {
    const p = PAT(pid); if (!p) return empty('없는 패턴이에요');
    const showKr = krVisible();
    const mine = p.custom ? `<div class="row2"><a class="btn sec" href="#/patterns/edit/${p.id}">고치기</a><button class="btn ghost danger" data-act="pat-del" data-id="${p.id}">삭제</button></div>` : '';
    return `<main class="page"><a class="back" href="#/patterns">← 패턴</a>
      <div class="card q"><div class="cat">${p.custom ? '내 패턴' : `PART ${p.part} · ${esc(partName(p.part))} · 패턴 ${p.no}`}</div><div class="bigjp">${rb(p.jp, p.jpr)}</div>${speakBtn(p.jp)}${p.kr ? `<div class="kr">${esc(p.kr)}</div>` : ''}<div class="mean">${esc(p.mean)}</div></div>
      <a class="btn lg block primary" href="#/practice/${p.id}">이 패턴 연습하기 ▶</a>${mine}
      <h2>예문</h2><ul class="exlist">${p.examples.map(e => `<li>${speakBtn(e.jp, 'sm')}<div>${rb(e.jp, e.jpr)}<small>${esc(e.mean)}${showKr && e.kr ? ' · ' + esc(e.kr) : ''}</small></div></li>`).join('')}</ul>
      <h2>퀴즈</h2><ul class="exlist">${p.quiz.map(q => `<li><div>${esc(q.q)}<details><summary>정답 보기</summary>${rb(q.jp, q.jpr)} ${speakBtn(q.jp, 'sm')} ${revBadge(q.by === 'claude')}<small>${esc(q.kr || '')}</small></details></div></li>`).join('')}</ul></main>`;
  }
  const exRow = (e = {}) => `<div class="exrow"><input name="ex_jp" lang="ja" maxlength="80" placeholder="일본어 예문" value="${esc(e.jp || '')}"><input name="ex_kana" lang="ja" maxlength="120" placeholder="읽기 (히라가나, 선택)" value="${esc(e.kana || '')}"><input name="ex_mean" maxlength="80" placeholder="뜻" value="${esc(e.mean || '')}"><button type="button" class="btn ghost sm" data-act="pat-delrow" aria-label="이 예문 지우기">✕</button></div>`;
  function viewPatternForm(id) {
    const c = id ? state.custom.patterns[id] : null;
    if (id && !c) return empty('없는 패턴이에요');
    const rows = c ? c.examples : [{}, {}, {}];
    return `<main class="page"><a class="back" href="#/patterns${id ? '/' + id : ''}">← ${id ? '돌아가기' : '패턴'}</a>
      <h1>${id ? '내 패턴 고치기' : '내 패턴 추가'}</h1>
      <form class="card" data-form="pattern" data-id="${id || ''}" autocomplete="off">
        <label class="setlabel" for="p_jp">패턴 문장 <span class="muted tiny">단어가 바뀌는 자리는 〜로</span></label><input id="p_jp" name="jp" required maxlength="60" lang="ja" placeholder="예: 〜はどこですか" value="${esc(c ? c.jp : '')}">
        <label class="setlabel" for="p_kana">읽기 (히라가나, 선택)</label><input id="p_kana" name="kana" maxlength="100" lang="ja" value="${esc(c ? c.kana || '' : '')}">
        <label class="setlabel" for="p_mean">뜻</label><input id="p_mean" name="mean" required maxlength="60" placeholder="예: 〜는 어디예요?" value="${esc(c ? c.mean : '')}">
        <div class="setlabel">예문 <span class="muted tiny">일본어와 뜻을 짝으로 적어요. 퀴즈(뜻 → 일본어 말하기)로도 쓰여요</span></div>
        <div id="exrows">${rows.map(exRow).join('')}</div>
        <button type="button" class="btn sec block" data-act="pat-addrow">＋ 예문 줄 추가</button>
        <button class="btn lg block primary" type="submit">저장</button>
      </form></main>`;
  }
  function savePatternForm(form) {
    const f = new FormData(form), id = form.dataset.id;
    const rec = { jp: (f.get('jp') || '').trim(), kana: (f.get('kana') || '').trim(), mean: (f.get('mean') || '').trim(), examples: [] };
    if (!rec.jp || !rec.mean) { toast('패턴 문장과 뜻을 적어 주세요'); return; }
    if (rec.kana && !KANA_ONLY.test(rec.kana)) { toast('읽기는 히라가나로 적어 주세요'); return; }
    const jps = f.getAll('ex_jp'), kanas = f.getAll('ex_kana'), means = f.getAll('ex_mean');
    for (let i = 0; i < jps.length; i++) {
      const e = { jp: jps[i].trim(), kana: (kanas[i] || '').trim(), mean: (means[i] || '').trim() };
      if (!e.jp && !e.mean && !e.kana) continue;
      if (!e.jp || !e.mean) { toast(`${i + 1}번째 예문은 일본어와 뜻을 둘 다 적어 주세요`); return; }
      if (e.kana && !KANA_ONLY.test(e.kana)) { toast(`${i + 1}번째 예문의 읽기는 히라가나로 적어 주세요`); return; }
      rec.examples.push(e);
    }
    if (!rec.examples.length) { toast('예문을 하나 이상 적어 주세요'); return; }
    let pid = id;
    if (id) Object.assign(state.custom.patterns[id], rec);
    else { pid = 'up' + (++state.custom.seq); state.custom.patterns[pid] = Object.assign({ id: pid, created: today() }, rec); }
    save(); toast(id ? '고쳤어요' : '추가했어요'); go('#/patterns/' + pid);
  }

  /* ================= 가나 ================= */
  let KANA_TAB = 'h';
  let KQ = null;
  const kanaAll = () => [].concat(DATA.kana.hiragana.map(x => ({ ...x, script: 'h' })), DATA.kana.katakana.map(x => ({ ...x, script: 'k' })));
  const H2K = ch => String.fromCharCode(ch.charCodeAt(0) + 0x60);
  const BASIC_ROWS = ['あいうえお', 'かきくけこ', 'さしすせそ', 'たちつてと', 'なにぬねの', 'はひふへほ', 'まみむめも', 'や_ゆ_よ', 'らりるれろ', 'わ___を', 'ん____'];
  function viewKana() {
    const list = DATA.kana[KANA_TAB === 'h' ? 'hiragana' : 'katakana'];
    const byK = {}; list.forEach(x => { byK[x.k] = x; });
    const cell = x => x ? `<button class="kcell" data-say="${esc(x.k)}"><span lang="ja">${esc(x.k)}</span><small>${esc(x.kr)}</small></button>` : '<span class="kcell empty"></span>';
    const basic = BASIC_ROWS.map(r => [...r].map(ch => (ch === '_' ? null : byK[KANA_TAB === 'h' ? ch : H2K(ch)]))).map(row => `<div class="krow">${row.map(cell).join('')}</div>`).join('');
    const chunk = (arr, n) => arr.reduce((a, x, i) => { (a[Math.floor(i / n)] = a[Math.floor(i / n)] || []).push(x); return a; }, []);
    const dak = chunk(list.filter(x => x.type === 'dakuten'), 5).map(r => `<div class="krow">${r.map(cell).join('')}</div>`).join('');
    const yoon = chunk(list.filter(x => x.type === 'yoon'), 3).map(r => `<div class="krow y3">${r.map(cell).join('')}</div>`).join('');
    const conf = DATA.kana.confusions[KANA_TAB === 'h' ? 'hiragana' : 'katakana'].map(g => `<span class="pair">${g.map(jp).join(' ↔ ')}</span>`).join('');
    const K = state.kana, last = K.quizzes[K.quizzes.length - 1];
    const weak = Object.entries(K.stats).filter(([, s]) => s.ng > s.ok).map(([k]) => k);
    return `<main class="page"><h1>가나 워밍업</h1>
      <div class="card">${K.passed ? '<p class="status good">✓ 통과 테스트를 통과했어요! 설정에서 워밍업을 꺼도 좋아요.</p>' : `<p class="muted">${esc(DATA.kana.passRule)}</p>`}
        ${last ? `<p class="tiny muted">최근 퀴즈: ${md(last.date)} · ${last.correct}/${last.total}</p>` : ''}
        ${weak.length ? `<p>헷갈리는 글자: ${weak.slice(0, 12).map(jp).join(' ')}</p>` : ''}
        <div class="qgrid">
          <button class="btn sec" data-act="kquiz" data-scope="h-basic">히라가나 20문제</button>
          <button class="btn sec" data-act="kquiz" data-scope="k-basic">가타카나 20문제</button>
          <button class="btn sec" data-act="kquiz" data-scope="voiced">탁음·요음 20문제</button>
          <button class="btn primary" data-act="kquiz" data-scope="pass">통과 테스트 92문제</button></div></div>
      <div class="chips"><button class="chip ${KANA_TAB === 'h' ? 'on' : ''}" data-act="ktab" data-v="h">히라가나</button><button class="chip ${KANA_TAB === 'k' ? 'on' : ''}" data-act="ktab" data-v="k">가타카나</button></div>
      <p class="tiny muted">글자를 누르면 소리가 나요</p>
      <h2>기본 46</h2><div class="kchart">${basic}</div>
      <h2>탁음·반탁음 25</h2><div class="kchart">${dak}</div>
      <h2>요음 33</h2><div class="kchart">${yoon}</div>
      <h2>헷갈리는 짝</h2><div class="pairs">${conf}</div></main>`;
  }
  function startKanaQuiz(scope) {
    const all = kanaAll();
    let pool, count;
    if (scope === 'h-basic') { pool = all.filter(x => x.script === 'h' && x.type === 'basic'); count = 20; }
    else if (scope === 'k-basic') { pool = all.filter(x => x.script === 'k' && x.type === 'basic'); count = 20; }
    else if (scope === 'voiced') { pool = all.filter(x => x.type !== 'basic'); count = 20; }
    else { pool = all.filter(x => x.type === 'basic'); count = pool.length; }
    const conf = [].concat(DATA.kana.confusions.hiragana, DATA.kana.confusions.katakana);
    const picked = C.pickKana(pool, state.kana.stats, count);
    const items = picked.map(t => ({ t, opts: C.kanaOptions(t, all.filter(x => x.script === t.script && x.type === t.type), conf) }));
    KQ = { scope, items, i: 0, correct: 0, wrong: [], answered: null, pendingSpeak: true, done: false };
    go('#/kana/quiz');
  }
  function viewKanaQuiz() {
    if (!KQ) { location.replace('#/kana'); return ''; }
    const label = { 'h-basic': '히라가나', 'k-basic': '가타카나', voiced: '탁음·요음', pass: '통과 테스트' }[KQ.scope];
    if (KQ.done) {
      const pct = Math.round(KQ.correct / KQ.items.length * 100), passed = KQ.scope === 'pass' && pct >= 95;
      return `<main class="page center"><h1>${label} 결과</h1><div class="card"><div class="stats"><div><b>${KQ.correct}/${KQ.items.length}</b><small>정답</small></div><div><b>${pct}%</b><small>정답률</small></div></div>
        ${KQ.scope === 'pass' ? `<p class="status ${passed ? 'good' : 'warn'}">${passed ? '✓ 통과! 가나 워밍업을 마쳐도 좋아요.' : '95% 이상이면 통과예요. 틀린 글자를 다시 봐요.'}</p>` : ''}
        ${KQ.wrong.length ? `<p>틀린 글자</p><div class="wrongs">${[...new Set(KQ.wrong)].map(k => `<button class="kcell sm" data-say="${esc(k)}"><span lang="ja">${esc(k)}</span></button>`).join('')}</div>` : '<p>모두 맞혔어요! 🎉</p>'}</div>
        <button class="btn lg block primary" data-act="kquiz" data-scope="${KQ.scope}">한 번 더</button><a class="btn ghost block" href="#/kana">표로 돌아가기</a></main>`;
    }
    const q = KQ.items[KQ.i], pct = Math.round(KQ.i / KQ.items.length * 100), a = KQ.answered;
    return `<main class="page sess"><div class="sess-top"><a class="btn ghost sm" href="#/kana">✕ 그만하기</a><div class="prog"><i style="width:${pct}%"></i></div></div>
      <div class="step">${label} ${KQ.i + 1}/${KQ.items.length}</div>
      <div class="card q"><div class="kbig">${jp(q.t.k)}</div><button class="say" data-say="${esc(q.t.k)}" aria-label="소리 듣기">🔊</button>
        <p class="muted">어떻게 읽을까요?</p>
        <div class="opts">${q.opts.map(o => `<button class="opt ${a ? (o === q.t.kr ? 'right' : o === a ? 'wrong' : '') : ''}" data-act="kans" data-v="${esc(o)}" ${a ? 'disabled' : ''}>${esc(o)}</button>`).join('')}</div>
        ${a ? `<p class="status ${a === q.t.kr ? 'good' : 'warn'}">${a === q.t.kr ? '정답!' : `정답은 「${esc(q.t.kr)}」 (${esc(q.t.ro)})`}</p>${a === q.t.kr ? '' : '<button class="btn lg block primary" data-act="knext">다음 ▶</button>'}` : ''}</div></main>`;
  }
  function kanaAnswer(v) {
    if (!KQ || KQ.answered) return;
    const q = KQ.items[KQ.i], ok = v === q.t.kr;
    const st = state.kana.stats[q.t.k] = state.kana.stats[q.t.k] || { ok: 0, ng: 0 };
    if (ok) { st.ok++; KQ.correct++; } else { st.ng++; KQ.wrong.push(q.t.k); }
    KQ.answered = v; save(); render({ keepScroll: true });
    if (ok) setTimeout(kanaNext, 650);
  }
  function kanaNext() {
    if (!KQ || !KQ.answered) return;
    KQ.i++; KQ.answered = null; KQ.pendingSpeak = true;
    if (KQ.i >= KQ.items.length) {
      KQ.done = true;
      state.kana.quizzes.push({ date: today(), scope: KQ.scope, total: KQ.items.length, correct: KQ.correct });
      if (KQ.scope === 'pass' && KQ.correct / KQ.items.length >= 0.95) state.kana.passed = true;
      daily(today()).kanaDone = true; save();
    }
    if (location.hash.startsWith('#/kana/quiz')) render();
  }

  /* ================= 설정 ================= */
  function seg(key, opts) {
    return `<div class="seg" role="group">${opts.map(([v, l]) => `<button class="${state.settings[key] === v ? 'on' : ''}" data-act="set" data-key="${key}" data-val="${v}">${l}</button>`).join('')}</div>`;
  }
  function toggle(key, label, desc) {
    return `<div class="setrow"><div><b>${label}</b>${desc ? `<small>${desc}</small>` : ''}</div><button class="switch ${state.settings[key] ? 'on' : ''}" role="switch" aria-checked="${!!state.settings[key]}" data-act="toggle" data-key="${key}" aria-label="${label}"><i></i></button></div>`;
  }
  function viewSettings() {
    const st = Speech.status();
    const vtxt = { ok: `✓ ${esc(Speech.voiceName())}`, none: '목록에서 못 찾음', unknown: '확인 중', unsupported: '지원 안 됨' }[st];
    return `<main class="page"><h1>설정</h1>
      <div class="card"><label class="setlabel" for="uname">이름</label><input id="uname" maxlength="12" value="${esc(state.user.name)}" autocomplete="off"></div>
      <div class="card"><div class="setlabel">글자 크기</div>${seg('fontSize', [['normal', '보통'], ['large', '크게'], ['xlarge', '아주 크게']])}
        <div class="setlabel">한글 발음 표시</div>${seg('krMode', [['show', '항상'], ['auto', '3주차부터 숨김'], ['hide', '숨김']])}
        <div class="setlabel">발음 속도</div>${seg('speed', [['slow', '느리게'], ['normal', '보통'], ['fast', '빠르게']])}
        ${toggle('furigana', '후리가나 표시', '한자 위에 히라가나 읽기를 달아줘요')}
        ${toggle('autoSpeak', '자동으로 소리 재생', '카드가 나오면 바로 읽어 줘요')}
        ${toggle('kanaWarmup', '가나 워밍업', '가나 표·퀴즈 탭을 보여줘요')}
        ${toggle('showReview', '「검수 중」 표시', 'Claude가 채운 내용에 작은 표시')}</div>
      <div class="card"><div class="setrow"><div><b>일본어 음성</b><small>${vtxt}</small></div><a class="btn sec sm" href="#/voice">확인</a></div></div>
      <div class="card"><div class="setlabel">학습 기록 (이 폰에 저장)</div>
        <p class="tiny muted">배운 단어 ${C.totalLearned(DATA, state)}개 · 기록 ${state.log.length}일 · 내 단어 ${nCustomWords()}개 · 내 패턴 ${Object.keys(state.custom.patterns).length}개</p>
        <div class="row2"><button class="btn sec" data-act="export">내보내기</button><label class="btn sec filebtn">가져오기<input type="file" accept="application/json,.json" data-act="import" hidden></label></div>
        <button class="btn ghost block danger" data-act="reset">기록 전체 지우기</button></div>
      <div class="card about"><b>잇쇼니 니홍고 ${APP_VERSION}</b>
        <p class="tiny muted">학습 자료 출처: 바로일본어 무료 공개 자료 (왕초보 일본어 단어장 130개 · JLPT N5 필수 200단어 · 일본여행 필수패턴 32개). 저작권은 바로일본어에 있으며 이 앱은 가족 학습용입니다.</p>
        <p class="tiny muted">「검수 중」: Claude가 채운 요미가나·퀴즈 정답이에요. 이상하면 알려 주세요.</p></div></main>`;
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ================= 이벤트 ================= */
  document.addEventListener('click', e => {
    const say = e.target.closest('[data-say]');
    if (say) { e.preventDefault(); speakOrWarn(say.dataset.say); return; }
    const el = e.target.closest('[data-act]'); if (!el || el.tagName === 'FORM' || el.tagName === 'INPUT') return;
    const act = el.dataset.act;
    const A = {
      role: () => setRole(el.dataset.role),
      start: () => startToday(),
      exit: () => { tickTime(); save(); toast('진행 상황은 저장됐어요'); const back = SESS && SESS.returnTo; if (SESS && SESS.kind !== 'today') SESS = null; go(back || '#/today'); },
      reveal: () => { SESS.ui.reveal = true; tickTime(); render({ keepScroll: true }); const it = SESS.items[SESS.i]; if ((it.kind === 'quiz' || it.kind === 'cquiz') && state.settings.autoSpeak) speakOrWarn(it.kind === 'cquiz' ? PAT(it.pid).quiz[it.idx].jp : C.quizOf(DATA, it.qid).q.jp); },
      'show-kr': () => { SESS.ui.kr = true; render({ keepScroll: true }); },
      grade: () => gradeItem(el.dataset.g),
      learned: () => { const it = SESS.items[SESS.i]; C.introduce(state, it.id, SESS.date); advance(); },
      'extra-next': () => advance(),
      next: () => advance(),
      'rp-reveal': () => { SESS.ui.reveal = true; render({ keepScroll: true }); if (state.settings.autoSpeak) speakOrWarn(DATA.rolesById[SESS.items[SESS.i].rid].lines[SESS.ui.line].jp); },
      'rp-next': () => {
        const s = SESS, r = DATA.rolesById[s.items[s.i].rid];
        if (s.ui.line >= r.lines.length - 1) { advance(); return; }
        s.ui.line++; s.ui.reveal = false; tickTime(); render({ keepScroll: true });
        const l = r.lines[s.ui.line]; if (l.who === 'staff' && state.settings.autoSpeak) speakOrWarn(l.jp);
      },
      install: async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice.catch(() => { }); deferredInstall = null; render({ keepScroll: true }); },
      'hide-install': () => { state.settings.installTipHidden = true; save(); render({ keepScroll: true }); },
      wf: () => { WB.filter = el.dataset.v; render({ keepScroll: true }); },
      'only-today': () => { const dd = daily(today()); dd.onlyToday = true; delete dd.newTarget; save(); render({ keepScroll: true }); },
      'with-backlog': () => { const dd = daily(today()); delete dd.onlyToday; delete dd.newTarget; save(); render({ keepScroll: true }); },
      'word-new': () => { const q = el.dataset.q || ''; PREFILL = q ? (isJa(q) ? { jp: q } : { mean: q }) : null; go('#/words/new'); },
      'word-del': () => {
        const id = el.dataset.id; if (!confirm('이 단어를 삭제할까요? 복습 기록도 함께 지워져요.')) return;
        delete state.custom.words[id]; delete state.cards[id]; delete state.flags[id]; save(); toast('삭제했어요'); go('#/words');
      },
      'word-srs': () => {
        const id = el.dataset.id;
        if (state.cards[id]) delete state.cards[id]; else C.introduce(state, id, today());
        save(); render({ keepScroll: true });
      },
      'pat-del': () => {
        const id = el.dataset.id; if (!confirm('이 패턴을 삭제할까요?')) return;
        delete state.custom.patterns[id]; save(); toast('삭제했어요'); go('#/patterns');
      },
      'pat-addrow': () => {
        const box = $('#exrows'); if (!box) return;
        if (box.children.length >= 12) { toast('예문은 12개까지예요'); return; }
        box.insertAdjacentHTML('beforeend', exRow()); box.lastElementChild.querySelector('input').focus();
      },
      'pat-delrow': () => { const row = el.closest('.exrow'); if (row) row.remove(); },
      flag: () => { const id = el.dataset.id; if (state.flags[id]) delete state.flags[id]; else state.flags[id] = true; save(); render({ keepScroll: true }); },
      ktab: () => { KANA_TAB = el.dataset.v; render({ keepScroll: true }); },
      kquiz: () => startKanaQuiz(el.dataset.scope),
      kans: () => kanaAnswer(el.dataset.v),
      knext: () => kanaNext(),
      set: () => { state.settings[el.dataset.key] = el.dataset.val; save(); applySettings(); render({ keepScroll: true }); },
      toggle: () => { const k = el.dataset.key; state.settings[k] = !state.settings[k]; save(); render({ keepScroll: true }); },
      'voice-ok': () => { state.settings.voiceOk = true; save(); toast('좋아요! 소리 확인 완료'); go(el.dataset.first === '1' ? '#/today' : '#/settings'); },
      'voice-no': () => { state.settings.voiceOk = false; save(); const g = $('#voiceGuide'); if (g) { g.hidden = false; g.scrollIntoView({ behavior: 'smooth' }); } },
      'voice-skip': () => { state.settings.voiceSkip = true; save(); go(el.dataset.first === '1' ? '#/today' : '#/settings'); },
      'voice-recheck': () => { Speech.pick(); render({ keepScroll: true }); toast(Speech.status() === 'ok' ? '일본어 음성을 찾았어요' : '아직 못 찾았어요'); },
      export: () => { download(`isshoni-${state.user.name || 'user'}-${today()}.json`, JSON.stringify(state, null, 2)); toast('파일로 저장했어요'); },
      reset: () => {
        if (!confirm('학습 기록과 내가 추가한 단어·패턴을 모두 지웁니다. 되돌릴 수 없어요.\n먼저 「내보내기」로 백업했나요?')) return;
        if (!confirm('정말 지울까요?')) return;
        try { localStorage.setItem(KEY + '.before-reset', JSON.stringify(state)); } catch (e) { /* 무시 */ }
        state = C.defaultState(); save(); SESS = null; location.hash = '#/welcome'; render();
      },
    };
    if (A[act]) { e.preventDefault(); A[act](); }
  });
  document.addEventListener('submit', e => {
    const wf = e.target.closest('[data-form]');
    if (wf) { e.preventDefault(); if (wf.dataset.form === 'word') saveWordForm(wf); else savePatternForm(wf); return; }
    const f = e.target.closest('[data-act="role-other"]'); if (!f) return;
    e.preventDefault();
    const name = ($('#otherName').value || '').trim();
    if (!name) { toast('이름을 입력해 주세요'); return; }
    setRole('other', name);
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'wq') { WB.q = e.target.value; $('#wrows').innerHTML = wordRows(); }
    if (e.target.id === 'pq') { PB.q = e.target.value; $('#prows').innerHTML = patternList(); }
    if (e.target.form && e.target.form.dataset.form === 'word') {       // 후리가나 미리보기 + 사전 링크
      const f = e.target.form, pv = $('#prevRuby'), jpv = f.jp.value.trim();
      if (pv) pv.innerHTML = jpv ? rb(jpv, rubyFor(jpv, f.kana.value)) : '';
      const d = $('#f_dict'); if (d) d.href = dictUrl(jpv || f.mean.value.trim());
    }
    if (e.target.id === 'uname') { state.user.name = e.target.value.trim().slice(0, 12); save(); }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'wcat') { WB.cat = e.target.value; $('#wrows').innerHTML = wordRows(); }
    if (e.target.matches('input[type=file][data-act="import"]')) importFile(e.target.files[0]);
  });
  function setRole(role, otherName) {
    state.user = { name: role === 'kwangwoo' ? '광우' : role === 'dad' ? '아버지' : otherName, role, createdAt: new Date().toISOString() };
    state.settings = Object.assign(C.presetFor(role), { installTipHidden: false });
    save(); applySettings();
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* 무시 */ }
    go('#/voice/first');
  }
  function importFile(file) {
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const obj = JSON.parse(rd.result);
        if (!obj || typeof obj !== 'object' || !obj.cards) throw new Error('형식이 달라요');
        if (!confirm(`이 파일의 기록으로 바꿉니다.\n(배운 단어 ${Object.keys(obj.cards).length}개 · 지금 기록은 자동 백업돼요)`)) return;
        try { localStorage.setItem(KEY + '.before-import', JSON.stringify(state)); } catch (e) { /* 무시 */ }
        state = C.migrate(obj); save(); applySettings(); toast('가져왔어요'); render();
      } catch (err) { toast('가져오기에 실패했어요: ' + err.message); }
    };
    rd.readAsText(file);
  }

  /* ================= 시작 ================= */
  function showFatal(msg) {
    $('#app').innerHTML = `<main class="page center"><h1>앗, 불러오지 못했어요</h1><p class="muted">${esc(msg)}</p><p>인터넷 연결을 확인하고 다시 시도해 주세요.<br>(처음 한 번은 인터넷이 필요해요)</p><button class="btn lg" onclick="location.reload()">다시 시도</button></main>`;
  }
  async function boot() {
    load(); applySettings();
    window.addEventListener('hashchange', () => { if (location.hash !== '#/session') tickTime(); render(); });
    try { await loadData(); } catch (err) { showFatal(err.message); return; }
    if (!location.hash) location.replace('#/today');
    render();
    if (Speech.supported) {
      // 안드로이드 크롬은 음성 목록이 늦게 채워진다 → 준비되면 화면 갱신
      setTimeout(() => { Speech.pick(); if (/^#\/(today|voice|settings)/.test(location.hash)) render({ keepScroll: true }); }, 1500);
    }
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 오프라인 기능만 빠짐 */ });
    }
  }
  boot();
})();
