"""data/*.json 무결성 검사. 사용: python tools/validate_data.py  (실패 시 AssertionError)"""
import json, pathlib, re
D = pathlib.Path(__file__).resolve().parent.parent / 'data'
W = json.loads((D/'words.json').read_text(encoding='utf-8'))
P = json.loads((D/'patterns.json').read_text(encoding='utf-8'))
K = json.loads((D/'kana.json').read_text(encoding='utf-8'))
S = json.loads((D/'schedule.json').read_text(encoding='utf-8'))
words = W['words']; ids = {w['id'] for w in words}
assert len(words) == 330 and len(ids) == 330, 'word count/ids'
assert sum(w['src'] == 'w130' for w in words) == 130 and sum(w['src'] == 'n5' for w in words) == 200
seqs = sorted(w['seq'] for w in words if 'seq' in w)
assert seqs == list(range(1, 276)), 'seq must be 1..275'
dups = [w for w in words if 'dupOf' in w]
assert len(dups) == 55 and all(d['dupOf'] in ids and 'seq' not in d for d in dups)
for w in words:
    for k in ('id', 'src', 'cat', 'jp', 'kana', 'kr', 'mean'):
        assert w.get(k), (w.get('id'), k)
    assert not re.search(r'[一-鿿]', w['kana']), (w['id'], 'kana has kanji')
pats = P['patterns']
assert len(pats) == 32 and [p['no'] for p in pats] == list(range(1, 33))
assert sum(len(p['examples']) for p in pats) == 189 and sum(len(p['quiz']) for p in pats) == 94
for p in pats:
    for e in p['examples']: assert e['jp'] and e['kr'] and e['mean'], p['id']
    for q in p['quiz']: assert q['q'] and q['jp'] and q['kr'], p['id']
pids = {p['id'] for p in pats}; rids = {r['id'] for r in P['roleplays']}
assert len(P['roleplays']) == 6
assert len(K['hiragana']) == 104 and len(K['katakana']) == 104
days = S['days']; study = [d for d in days if d['type'] == 'study']
assert len(study) == 55 and all(len(d['newWords']) == 5 for d in study)
flat = [i for d in study for i in d['newWords']]
assert len(flat) == 275 and len(set(flat)) == 275 and all(i in ids for i in flat)
assert sum(len(d.get('extraReview', [])) for d in study) == 55
for d in days:
    pt = d.get('pattern')
    if pt: assert all(x in pids for x in ([pt['id']] if 'id' in pt else pt['ids']))
    if d.get('roleplay'): assert d['roleplay'] in rids
news = [d['pattern']['id'] for d in study if d.get('pattern', {}).get('mode') == 'new']
assert news == [f'p{n:02d}' for n in range(1, 33)], 'patterns introduced in order once'
# 후리가나(jpr/exr): 한자가 있는 문장엔 반드시 있고, [읽기]를 지우면 원문과 같고, 읽기는 히라가나뿐
KJ = re.compile(r'[一-鿿々〆]')
def check_ruby(rec, src, dst, where):
    if KJ.search(rec[src]):
        if dst in rec or src == 'jp':
            assert dst in rec, (where, 'missing ' + dst)
    if dst in rec:
        assert re.sub(r'\[[^\]]*\]', '', rec[dst]) == rec[src], (where, dst, 'differs from original')
        assert all(re.fullmatch(r'[ぁ-ゖー・]+', r) for r in re.findall(r'\[([^\]]*)\]', rec[dst])), (where, dst, 'reading must be hiragana')
        assert KJ.search(rec[src]), (where, dst, 'ruby on text without kanji')
nr = 0
for p in pats:
    check_ruby(p, 'jp', 'jpr', p['id'])
    for e in p['examples']: check_ruby(e, 'jp', 'jpr', p['id'])
    for q in p['quiz']: check_ruby(q, 'jp', 'jpr', p['id'])
for r in P['roleplays']:
    for l in r['lines']: check_ruby(l, 'jp', 'jpr', r['id'])
for w in words:
    if w.get('ex'): check_ruby(w, 'ex', 'exr', w['id']); assert (not KJ.search(w['ex'])) or 'exr' in w, (w['id'], 'ex needs exr')
    if 'jpr' in w: check_ruby(w, 'jp', 'jpr', w['id'])
nr = sum('jpr' in x for p in pats for x in [p] + p['examples'] + p['quiz']) + sum('jpr' in l for r in P['roleplays'] for l in r['lines'])
print('OK: words 330 (study 275, dup 55) · patterns 32 (ex 189, quiz 94, roleplay 6) · kana 104×2 · schedule', len(days), 'days · 후리가나 패턴', nr, '문장')
