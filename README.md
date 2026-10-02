# 잇쇼니 니홍고 (一緒に日本語)

아버지와 함께하는 일본어 기초 16주 학습 앱 (개인·가족용).

- 학습 자료 출처: 바로일본어 무료 공개 자료 — 왕초보 일본어 단어장 130개, JLPT N5 필수 200단어, 일본여행 필수패턴 32개. 저작권은 바로일본어에 있으며 이 저장소는 가족 학습용입니다. (PDF 원본은 올리지 않음, 검색 색인 제외 `noindex`)
- 데이터: `data/` (검사: `python tools/validate_data.py`)
- 검수: `docs/검수목록.md`
- 개발 가이드: `CLAUDE.md`

## 앱 열기
GitHub Pages: https://chopinkaka.github.io/isshoni-nihongo/
갤럭시는 크롬으로 열고 ⋮ 메뉴 → 「홈 화면에 추가」(또는 「앱 설치」).

## 파일 구성
| 파일 | 역할 |
| --- | --- |
| `index.html` `app.css` `app.js` | 화면·상호작용 (빌드 없음, 정적 파일) |
| `core.js` | 순수 로직: 날짜, SRS, 오늘 분량 계획, 저장 마이그레이션, 가나 퀴즈 |
| `sw.js` `manifest.webmanifest` `icons/` | PWA (오프라인, 홈 화면 설치) |
| `data/*.json` | 단어·패턴·가나·일정 |
| `tools/` | `validate_data.py`(데이터 검사), `test_core.js`(로직 검사), `build_furigana.py`(후리가나 생성) |

## 개발
```bash
python -m http.server 8000      # http://localhost:8000
python tools/validate_data.py   # 데이터 무결성(후리가나 포함)
node tools/test_core.js         # SRS·일정·마이그레이션 로직 검사
```

후리가나는 `data/*.json`의 `jpr`/`exr` 필드(예: `駅[えき]まで`)로 들어 있습니다. 다시 만들려면 `pip install fugashi unidic-lite` 후 `python tools/build_furigana.py`(`--check`는 한글 발음과 대조만).

**체험 모드**: 주소 뒤에 `?date=2026-10-05`를 붙이면 그 날짜로 앱이 동작합니다(예: 1일차 미리 해 보기).
기록은 실제 기록(`isshoni.v1`)이 아니라 `isshoni.v1.test`에 따로 저장되므로 실제 학습 기록에 영향이 없습니다.

## 배포
`main` 브랜치 루트를 GitHub Pages로 서비스합니다(`.nojekyll`). 파일을 추가하면 `sw.js`의 `ASSETS`에 넣고 `VERSION`을 올리세요.
