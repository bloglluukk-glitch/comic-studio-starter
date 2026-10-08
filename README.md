# Comic Studio Starter

**한국어** · [English](README.en.md)

메모 한 줄을 4~6컷 만화로 바꾸는 **작업실의 뼈대**입니다. 완성품이 아니라 — 가져가서 자기 말투·그림체·워크플로에 맞게 고쳐 쓰세요.
A starter skeleton for turning a rough memo into a short comic: LLM storyboard planning → hand-edited lettering → 1080×1350 slide export. Fork it, bend it.

## 들어 있는 것 / What's inside

| 폴더 | 역할 |
|---|---|
| `engine/planner.mjs` | 메모 → 컷 구성 프롬프트와 JSON 스키마 (이 프로젝트의 핵심 노하우: *목소리를 다듬어 없애지 말고 보존하라*) |
| `engine/queue.mjs`, `store.mjs` | 작업 큐, 초안 자동저장·버전 기록 |
| `engine/images.mjs`, `image-prompt.mjs` | 컷별 그림 요청 프롬프트 조립 (그림 생성기는 직접 연결) |
| `engine/export.mjs` | 컷마다 1080×1350 PNG + ZIP 내보내기 |
| `shared/lettering.mjs` | 말풍선 자동 배치·꼬리·글자 크기 조절 |
| `client/` | React 편집 화면 (esbuild로 번들) |
| `tests/` | `node --test` 29개 |
| `examples/` | 샘플 메모, 샘플 시리즈 설정 |

## 실행 / Run

```bash
npm install
npm test
npm start        # 빌드 후 http://127.0.0.1:8769
```

Node 20+ 필요. 작업물은 `./projects`에 저장됩니다 (`COMIC_DATA_DIR`로 변경, 포트는 `COMIC_PORT`).

## AI 연결 / AI backend

이 샘플은 [OpenAI Codex CLI](https://github.com/openai/codex)의 **로컬 로그인**을 호출합니다 (`engine/codex.mjs`). API 키를 코드나 저장소에 넣지 않습니다. Codex CLI를 설치·로그인하면 동작하고, 없으면 화면은 열리지만 AI 구성은 비활성입니다.
모델 이름은 `engine/planner.mjs`, `engine/images.mjs`에 하드코딩돼 있으니 쓰는 모델로 바꾸세요. 다른 LLM을 쓰고 싶다면 `engine/codex.mjs`의 `runCodexJson` 하나만 교체하면 됩니다.

## 일부러 뺀 것 / Intentionally left out

- TTS·음성·영상 파이프라인 (원 프로젝트에선 별도 서비스)
- 개인 캐릭터·그림체 레퍼런스, 원고, 작업 기록
- 상용 폰트 — 기본 글꼴은 OFL의 [Pretendard](https://github.com/orioncactus/pretendard)입니다. 자기 글꼴을 쓰려면 `client/styles.css`/`public/app.css`의 `@font-face ComicLetter`만 바꾸세요.
- `client/main.jsx`의 `127.0.0.1:8768` 링크는 원작자의 로컬 영상 도구용 자리표시자입니다. 필요 없으면 지우세요.

## 라이선스

MIT (코드). 글꼴: Pretendard — `public/fonts/LICENSE-Pretendard.txt` (SIL OFL 1.1).
