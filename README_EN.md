# MVMaker — AI Music Video Generator

English | [简体中文](README.md)

Feed it a song, get a music video. A desktop app (Electron) that runs the whole pipeline locally, with the AI stages served through an Agnes OpenAI-compatible gateway.

Audio slicing → MERT emotion analysis → storyboard outline → text-to-image → image-to-video → ffmpeg composition

<p align="center">
  <img src="https://img.shields.io/badge/version-1.1.45-blue" alt="version">
  <img src="https://img.shields.io/badge/platform-Windows%20x64-lightgrey" alt="platform">
</p>

## Download

Latest installer (205 MB, NSIS one-click, per-user install — no admin required):

**[Releases · v1.1.45](https://github.com/ddddddeyrueuad/mvmaker/releases/latest)**

ffmpeg and the backend runtime are bundled in the installer — nothing else to set up.

## Configuration

You need your own **Agnes API key** (OpenAI-compatible gateway). Pick either:

1. **In the app** (recommended) — type it into the "API Key" field after launch; this takes precedence over the config file
2. **Config file** — copy the template and fill it in

```bash
cp server/.env.example server/.env
```

```ini
AGNES_API_KEY=your-key-here
```

> `server/.env` is excluded by `.gitignore`, so it will never be committed by accident.

**MERT emotion analysis** is an optional local module. Without it the pipeline just skips that stage — nothing else breaks. Enabling it means installing torch / transformers / librosa yourself and downloading the model; point `MERT_MODEL_PATH` at it.

## Running from source

```bash
# 1. Install dependencies
npm install
npm --prefix server install
npm --prefix client install

# 2. Configure (see above)
cp server/.env.example server/.env

# 3. Offline regression suite (no external services needed)
npm run verify

# 4. Development (two terminals)
npm --prefix server run dev      # backend :3001 (node --watch, auto-restart)
npm --prefix client run dev      # frontend :5173 (proxies /api and /files to :3001)

# 5. Package (put ffmpeg into resources/ffmpeg/ first)
npx electron-builder --win --publish never
# output lands in release/
```

## Architecture

```
client/          React18 + Vite, five-step wizard
  src/steps/     Step1 Upload → Step2 Storyboard → Step3 Images → Step4 Videos → Step5 Compose
server/          Express backend
  src/services/  agnesHttp / llm / mert / t2i / i2v / compose
                 storyboard / styles / camera / mapping
  src/utils/     ffmpeg wrapper, output directories
electron/        main process, self-extracting server runtime
```

Every AI call in the generation pipeline is funnelled through `server/src/services/`:

| Service | Responsibility |
|---|---|
| `llm.js` | Agnes chat client, prompt building, Chinese prompt completion (with self-healing retries) |
| `mert.js` | Local emotion / energy / brightness / tempo analysis → visual mapping |
| `t2i.js` | Text-to-image, including content-policy sanitisation and retries |
| `i2v.js` | Image-to-video, two-stage async polling |
| `compose.js` | ffmpeg composition |
| `storyboard.js` | Chunked outline generation (CHUNK=10), shot prompts, character/scene quotas, continuity locking, JSON self-healing chain |
| `styles.js` | Style library and cross-style isolation |
| `camera.js` / `mapping.js` | Camera-move and shot-size decisions |

## Regression tests

`npm run verify` chains every offline check. No API key required:

| Command | Covers |
|---|---|
| `verify:json` | JSON truncation repair and parse self-healing |
| `verify:story` | Story outline arrangement, scene-variety checks |
| `verify:chunk` | Chunked outline generation |
| `verify:content` | Storyboard content-quality validation |
| `verify:quote` | Unescaped-quote repair and echo-degradation detection |
| `verify:zh` | Chinese prompt completion |
| `verify:style` | Cross-style isolation (picking A must never surface B/C/D) |
| `verify:selfheal` | End-to-end self-healing (mocked Agnes + mocked MERT) |

CI config lives in `.github/workflows/verify.yml`, running on Ubuntu and macOS.

## Implementation notes

- **Chunked outlines** — generated 10 beats at a time, which avoids the empty-output degradation that reasoning models hit on large single responses
- **JSON self-healing chain** — truncation repair → unescaped-quote escaping → echo-loop short-circuit; multi-round differentiated regeneration (low temperature + JSON constraint / high temperature + plain text) breaks the echo cycle
- **Two-stage i2v** — after submitting you get a `task_id` (`task_xxx`, short) to poll `GET /v1/videos/{task_id}` with (no rate limit on queries). The completion response carries **only a `video_id`, no download URL**, so you then query `GET /agnesapi?video_id=` with the `video_id` (`video_xxx`, long base64) to get the mp4 URL (that endpoint is rate-limited at 429, so it's queried exactly once, on completion)
- **Style isolation** — once a style is chosen, other styles' signature tokens are stripped so they can't bleed in
- **Character quotas** — protagonist / two-hander / empty-scene ratios are allocated per segment (empty scenes only land where there's an actual landscape signal)
- **Continuity locking** — character description, wardrobe, and a protagonist-lock line carry across every shot

## Disclaimer

This is a personal project, shared for learning and reference. It ships without an open-source licence — all rights reserved by default. You are responsible for obtaining your own API key and complying with your provider's terms, and for the copyright and compliance of anything you generate.
