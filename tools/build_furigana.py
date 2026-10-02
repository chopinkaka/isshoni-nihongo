"""후리가나 생성: data/*.json의 일본어 문장에 `jpr`(예: 駅[えき]までいくらですか？)를 채운다.

사용:  python tools/build_furigana.py            # 생성/갱신 (data/*.json 수정)
       python tools/build_furigana.py --check    # 수정 없이 한글 발음(kr)과 대조만

필요: pip install fugashi unidic-lite   (개발할 때만. 앱은 완성된 JSON만 읽는다)
읽기 결정 순서: ① tools/furigana_overrides.json 규칙(날짜·개수·합성어) → ② fugashi(unidic) 형태소 분석.
검증: 읽기를 한글로 옮겨 원문 PDF의 한글 발음(kr)과 뼈대(자음군+모음)를 비교하고, 어긋나는 문장을 출력한다.
`jp`는 건드리지 않는다(음성 읽기·검색은 jp 기준). 후리가나가 필요 없는 문장(한자 없음)에는 jpr을 만들지 않는다.
"""
import json, pathlib, re, sys

D = pathlib.Path(__file__).resolve().parent.parent / 'data'
OVR = pathlib.Path(__file__).resolve().parent / 'furigana_overrides.json'
KANJI = '一-鿿々〻'
RK = re.compile(f'[{KANJI}]')
HAS_RUBY = re.compile(f'[{KANJI}]+\\[[^\\]]+\\]')

def hira(s):
    return ''.join(chr(ord(c) - 0x60) if 0x30A1 <= ord(c) <= 0x30F6 else c for c in s)

def to_ruby(surface, reading):
    """surface(한자+오쿠리가나)와 reading(히라가나 전체)을 맞춰 한자 덩어리에만 [읽기]를 붙인다."""
    runs = re.findall(f'[{KANJI}]+|[^{KANJI}]+', surface)
    pat = '^' + ''.join('(.+?)' if RK.match(r) else re.escape(hira(r)) for r in runs) + '$'
    m = re.match(pat, reading)
    if not m:
        return None
    out, gi = '', 1
    for r in runs:
        if RK.match(r):
            out += f'{r}[{m.group(gi)}]'; gi += 1
        else:
            out += r
    return out

def load_rules():
    return [(re.compile(r['re']), r['reading']) for r in json.loads(OVR.read_text(encoding='utf-8'))['rules']]

def make_ruby(text, tagger, rules, warn):
    """text 전체의 jpr 문자열. 한자가 없으면 None."""
    if not RK.search(text):
        return None
    # ① 규칙으로 고정된 구간
    spans = []   # (start, end, reading)
    def free(a, b): return all(b <= s or a >= e for s, e, _ in spans)
    for rx, reading in rules:
        for m in rx.finditer(text):
            a, b = m.span('text') if 'text' in rx.groupindex else m.span()
            if a < b and free(a, b) and RK.search(text[a:b]):
                spans.append((a, b, reading))
    # ② 나머지는 형태소 분석
    pos = 0
    for w in tagger(text):
        i = text.find(w.surface, pos)
        if i < 0: continue
        pos = i + len(w.surface)
        if not RK.search(w.surface): continue
        a, b = i, i + len(w.surface)
        if any(not (b <= s or a >= e) for s, e, _ in spans): continue
        kana = w.feature.kana
        if not kana:
            warn(f'읽기 없음: {w.surface} in {text}'); continue
        spans.append((a, b, hira(kana)))
    spans.sort()
    out, last = '', 0
    for a, b, reading in spans:
        out += text[last:a]
        seg = text[a:b]
        r = to_ruby(seg, reading)
        if r is None:
            warn(f'정렬 실패(통째로 표기): {seg} / {reading} in {text}')
            r = f'{seg}[{reading}]'
        out += r; last = b
    out += text[last:]
    return out

def strip_ruby(s):
    return re.sub(r'\[[^\]]*\]', '', s)

def ruby_to_kana(s):
    """jpr → 전체 히라가나(한자는 읽기로 치환)"""
    return re.sub(f'[{KANJI}]+\\[([^\\]]+)\\]', r'\1', s)

# ---------- 한글 발음(kr) 대조용 ----------
KMAP = {}
_base = {
 'あ': '아', 'い': '이', 'う': '우', 'え': '에', 'お': '오', 'か': '카', 'き': '키', 'く': '쿠', 'け': '케', 'こ': '코',
 'さ': '사', 'し': '시', 'す': '스', 'せ': '세', 'そ': '소', 'た': '타', 'ち': '치', 'つ': '츠', 'て': '테', 'と': '토',
 'な': '나', 'に': '니', 'ぬ': '누', 'ね': '네', 'の': '노', 'は': '하', 'ひ': '히', 'ふ': '후', 'へ': '헤', 'ほ': '호',
 'ま': '마', 'み': '미', 'む': '무', 'め': '메', 'も': '모', 'や': '야', 'ゆ': '유', 'よ': '요',
 'ら': '라', 'り': '리', 'る': '루', 'れ': '레', 'ろ': '로', 'わ': '와', 'を': '오',
 'が': '가', 'ぎ': '기', 'ぐ': '구', 'げ': '게', 'ご': '고', 'ざ': '자', 'じ': '지', 'ず': '즈', 'ぜ': '제', 'ぞ': '조',
 'だ': '다', 'ぢ': '지', 'づ': '즈', 'で': '데', 'ど': '도', 'ば': '바', 'び': '비', 'ぶ': '부', 'べ': '베', 'ぼ': '보',
 'ぱ': '파', 'ぴ': '피', 'ぷ': '푸', 'ぺ': '페', 'ぽ': '포',
}
KMAP.update(_base)
_yoon = {'き': 'ㅋ', 'し': 'ㅅ', 'ち': 'ㅊ', 'に': 'ㄴ', 'ひ': 'ㅎ', 'み': 'ㅁ', 'り': 'ㄹ', 'ぎ': 'ㄱ', 'じ': 'ㅈ', 'び': 'ㅂ', 'ぴ': 'ㅍ'}
CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'
def _syl(cho, jung): return chr(0xAC00 + (CHO.index(cho) * 21 + JUNG.index(jung)) * 28)
YOON = {}
for k, c in _yoon.items():
    for sm, v in (('ゃ', 'ㅑ'), ('ゅ', 'ㅠ'), ('ょ', 'ㅛ')):
        YOON[k + sm] = _syl(c, v)

def decompose(ch):
    n = ord(ch) - 0xAC00
    if not 0 <= n < 11172: return None
    return CHO[n // 588], JUNG[(n % 588) // 28]

# 조사 は/わ는 한글로 '와'라 적히므로 하/와를 같은 것으로 본다. 쥬/주, 쇼/소처럼 한국어 표기가 흔들리는 요음 모음도 합친다.
CCLASS = {'ㄱ': 'K', 'ㅋ': 'K', 'ㄲ': 'K', 'ㄷ': 'T', 'ㅌ': 'T', 'ㄸ': 'T', 'ㅂ': 'P', 'ㅍ': 'P', 'ㅃ': 'P',
          'ㅈ': 'C', 'ㅊ': 'C', 'ㅉ': 'C', 'ㅅ': 'S', 'ㅆ': 'S', 'ㄴ': 'N', 'ㄹ': 'R', 'ㅁ': 'M', 'ㅎ': 'H', 'ㅇ': ''}
VCLASS = {'ㅐ': 'ㅔ', 'ㅓ': 'ㅗ', 'ㅕ': 'ㅗ', 'ㅛ': 'ㅗ', 'ㅒ': 'ㅔ', 'ㅖ': 'ㅔ', 'ㅑ': 'ㅏ', 'ㅠ': 'ㅜ', 'ㅡ': 'ㅜ'}

def skeleton(syllables):
    """[(초성,중성)] → 장음 연장 모음(우/이/오/아 단독 음절)을 앞 음절에 합쳐 뼈대 문자열로."""
    out = []
    for c, v in syllables:
        if (c, v) == ('ㅇ', 'ㅘ'): c, v = 'ㅎ', 'ㅏ'          # 와 → は/わ
        c = CCLASS[c]; v = VCLASS.get(v, v)
        if c == '' and out and out[-1][1] in ('ㅗ', 'ㅜ', 'ㅡ', 'ㅛ', 'ㅠ') and v in ('ㅜ', 'ㅗ'): continue
        if c == '' and out and out[-1][1] in ('ㅔ', 'ㅣ') and v in ('ㅣ', 'ㅔ'): continue
        if c == '' and out and out[-1][1] == v == 'ㅏ': continue
        out.append((c, v))
    return ''.join(c + v for c, v in out)

def kana_skeleton(kana):
    kana = hira(kana)
    syl, i = [], 0
    while i < len(kana):
        ch = kana[i]
        two = kana[i:i + 2]
        if two in YOON: syl.append(decompose(YOON[two])); i += 2; continue
        if ch == 'わ': syl.append(('ㅎ', 'ㅏ'))
        elif ch in KMAP: syl.append(decompose(KMAP[ch]))
        i += 1
    return skeleton(syl)

def kr_skeleton(kr):
    syl = [decompose(c) for c in kr if decompose(c)]
    return skeleton(syl)

# ---------- 데이터 순회 ----------
# 한글 표기 방식 차이일 뿐 읽기는 맞는 경우(외래어 フォ·チェ·フェ, 받침으로 쓴 く(학생), 조사 へ=에)
BENIGN = ['カフェ', 'フォーク', 'チェック', '学生', '駅へ']

def targets(P, W):
    """(레코드, 원문 키, jpr 키, kr 값) 목록"""
    out = []
    for p in P['patterns']:
        out.append((p, 'jp', 'jpr', p['kr']))
        for e in p['examples']: out.append((e, 'jp', 'jpr', e['kr']))
        for q in p['quiz']: out.append((q, 'jp', 'jpr', q['kr']))
    for r in P['roleplays']:
        for l in r['lines']: out.append((l, 'jp', 'jpr', l['kr']))
    for w in W['words']:
        if w.get('ex'): out.append((w, 'ex', 'exr', w.get('exKr', '')))
    return out

def insert_after(d, after, key, value):
    items = list(d.items()); d.clear()
    for k, v in items:
        if k == key: continue
        d[k] = v
        if k == after: d[key] = value

def word_ruby(w):
    """단어 표제어: 읽기가 하나뿐인 한자 단어만(・로 구분된 복수 읽기, 〜/～ 자리표시는 건너뜀)."""
    if not RK.search(w['jp']) or '・' in w['kana'] or re.search('[〜～~]', w['jp']):
        return None
    if '/' in w['jp']:      # 右/左 ↔ みぎ / ひだり 처럼 짝이 맞으면 각각 붙인다
        js, ks = w['jp'].split('/'), [k.strip() for k in w['kana'].split('/')]
        parts = [to_ruby(j, hira(k)) if RK.search(j) else j for j, k in zip(js, ks)]
        return '/'.join(parts) if len(js) == len(ks) and all(parts) else None
    return to_ruby(w['jp'], hira(w['kana']))

def main(check_only):
    import fugashi
    tagger = fugashi.Tagger()
    rules = load_rules()
    P = json.loads((D / 'patterns.json').read_text(encoding='utf-8'))
    W = json.loads((D / 'words.json').read_text(encoding='utf-8'))
    warns = []
    n = 0
    mism = []
    for rec, src, dst, kr in targets(P, W):
        ruby = make_ruby(rec[src], tagger, rules, warns.append)
        if ruby is None:
            rec.pop(dst, None); continue
        assert strip_ruby(ruby) == rec[src], (rec[src], ruby)
        n += 1
        # 영문·숫자 / 검사기가 못 보는 표기 차이가 있는 문장은 한글 대조만 건너뛴다(후리가나는 그대로 기록)
        if not (re.search('[A-Za-z0-9０-９]', rec[src]) or any(k in rec[src] for k in BENIGN)):
            a, b = kana_skeleton(ruby_to_kana(ruby)), kr_skeleton(kr)
            if a != b: mism.append((rec[src], ruby, kr, a, b))
        if not check_only: insert_after(rec, src, dst, ruby)
    nw = 0
    for w in W['words']:
        r = word_ruby(w)
        if r:
            nw += 1
            if not check_only: insert_after(w, 'jp', 'jpr', r)
        elif not check_only:
            w.pop('jpr', None)
    print(f'문장 {n}개 · 단어 표제어 {nw}개에 후리가나')
    for w in warns: print('경고:', w)
    print(f'한글 발음과 뼈대가 다른 문장 {len(mism)}개')
    for jp, ruby, kr, a, b in mism: print(f'  {ruby}\n    kr={kr}\n    kana={a} kr={b}')
    if not check_only:
        for name, obj in (('patterns', P), ('words', W)):
            (D / f'{name}.json').write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding='utf-8')
    return len(mism)

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main('--check' in sys.argv)
