# Comic Studio Starter

[한국어](README.md) · **English**

A skeleton workshop that turns a rough memo into a 4–6 panel comic. This is a **super-sample, not a finished product**: take it, then bend it to your own voice, art style and workflow.
Flow: LLM storyboard planning → hand-edited lettering → 1080×1350 slide export.

> The UI, error messages and planner prompts are in English, and the planner replies in the language of your memo (Korean memos work too). The original Korean UI is kept on the [`ko` branch](https://github.com/bloglluukk-glitch/comic-studio-starter/tree/ko).

## What's inside

| Path | Role |
|---|---|
| `engine/planner.mjs` | Memo → panel plan prompt and JSON schema. The core know-how: *preserve the speaker's voice instead of polishing it away.* |
| `engine/queue.mjs`, `store.mjs` | Job queue, draft autosave, version history |
| `engine/images.mjs`, `image-prompt.mjs` | Per-panel image request prompts (plug in your own image generator) |
| `engine/export.mjs` | One 1080×1350 PNG per panel, plus a ZIP |
| `shared/lettering.mjs` | Speech-bubble auto layout, tails, text sizing |
| `client/` | React editing UI (bundled with esbuild) |
| `tests/` | 29 tests via `node --test` (some fixtures are intentionally Korean to cover non-English memos) (some fixtures are intentionally Korean to cover non-English memos) |
| `examples/` | Sample memo and sample series profile |

## Run

```bash
npm install
npm test
npm start        # builds, then serves http://127.0.0.1:8769
```

Requires Node 20+. Work is saved to `./projects` (override with `COMIC_DATA_DIR`; port via `COMIC_PORT`).

## AI backend

The sample calls your **local login** of the [OpenAI Codex CLI](https://github.com/openai/codex) (`engine/codex.mjs`). No API key lives in the code or repo. Install and log in to the Codex CLI and it works; without it the UI still opens but AI planning is disabled.
Model names are hard-coded in `engine/planner.mjs` and `engine/images.mjs` — change them to models you have access to. To use another LLM, replace only `runCodexJson` in `engine/codex.mjs`.

## Intentionally left out

- TTS, voice and video pipelines (separate services in the original project)
- Personal characters, art-style references, manuscripts, work logs
- Commercial fonts — the default font is [Pretendard](https://github.com/orioncactus/pretendard) (SIL OFL). To use your own, change the `@font-face ComicLetter` rule in `client/styles.css` and `public/app.css`.
- The `127.0.0.1:8768` link in `client/main.jsx` is a placeholder for the author's local video tool. Delete it if you don't need it.

## License

MIT for the code. Font: Pretendard — see `public/fonts/LICENSE-Pretendard.txt` (SIL OFL 1.1).