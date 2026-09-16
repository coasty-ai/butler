# Open Assist

**Press a key. Tell your computer what to do.**

A macOS voice assistant built from the supplied 39-page strategy PDF and the subsequent Open Assist MVP specification. Hold **Option + Space**, speak, and release. A floating pill shows Listening → Working in your app → Needs approval → Done, then disappears. Hold again to pause and steer the same task. Tap for a text command. Settings and optional local-run review live in the menu bar. To launch directly into hands-free listening with diagnostics, run `npm run debug:local -- --hands-free` (`--no-hands-free` disables it). For hands-free use, select **Say “Hey Assist”** under **Talk to Open Assist** in Settings and save, or enable it from the menu bar. Say “Hey Assist, open Notes,” then pause; say the wake phrase again to interrupt. The menu bar can turn off its microphone at any time.

Open Assist is the consumer product. CoArena is the intelligence/evaluation layer; CoArena Gym is the environment and evaluation product. Contributions connect them only after per-run review and consent.

**Status: development alpha.** Native push-to-talk, optional on-device wake-phrase listening, on-device speech, screen capture/input, correction handling, approval, encrypted local trajectories and opt-in contribution are implemented. Offline checks use synthetic tasks and mocked providers; GPT-5.4 mini has also completed a generated-screen task through the live API. Live speech accuracy, arbitrary desktop reliability and shortcut latency still need device testing. See [validation](docs/VALIDATION.md), [implementation status](docs/IMPLEMENTATION.md) and [resources required](docs/RESOURCES.md).

## Run

The local Apple Silicon development package is `release/mac-arm64/Open Assist.app` (about 316 MB). Open it in Finder; first launch shows the small settings window. Start with **Try the safe tutorial**, then enable permissions and configure a model for real tasks. This package is unsigned/not notarized and has been tested locally, not distributed as a public release.

Requirements: **Node 22.12+ (Node 24 recommended)**, npm, macOS 14+, Xcode Command Line Tools (`xcode-select --install`).

```sh
npm ci
npm run dev
```

The app builds its two Swift helpers on first launch. Choose **Try the safe tutorial** for a deterministic, no-key run. It operates a simulated task board using the actual run loop and local journal. It does not record audio, capture your desktop or call a model.

For real tasks, open Settings once, configure a vision-capable model, and grant Screen Recording, Accessibility, Microphone and Speech Recognition (and Input Monitoring if macOS requests it). Restart if macOS requests it. On-device speech support depends on the installed language; there is no cloud transcription fallback. Text commands remain available. The selected display and bounded window/selection context supply automatic context to the model.

Known text fields and recognized preparation/navigation controls can proceed automatically. Sending, publishing, paying and deleting require approval. Unidentified targets trigger up to three recovery attempts, then pause for manual help instead of requesting approval for blind input. Passwords and protected surfaces require manual takeover. These deterministic rules still need live/adversarial validation; arbitrary desktop UI is not perfectly classified.

- **Local:** install Ollama, download a vision model, and use `http://127.0.0.1:11434`. The default `qwen3-vl:8b` is editable; it is not automatically downloaded. Cloud model identifiers are rejected.
- **BYOM:** choose OpenAI, Anthropic, Google or an OpenAI-compatible endpoint. Enter your own API key, model ID, and current input/output token prices for estimated cost accounting. Requests go directly to that provider.
- **Stop:** `Escape`, `Control + Option + Escape`, the stop control, or hold and say “stop.” Native Escape handling is independent of the renderer/model call during real runs.
- **Talk / steer:** hold `Option + Space`; release to execute. The controller stops immediately on key-down. Say “Wait,” “Stop,” “Use Chrome, not Safari,” or another correction.
- **Type:** tap `Option + Space`, or use `Command + Shift + Space`.
- **Approve:** click once, or hold the shortcut and say “yes” to the current approval. In hands-free mode, say “Hey Assist, yes.” Spoken approval is still bound to the pending action and a finalized recognition confidence check.
- **Take over:** move the mouse, click, scroll or type to pause the agent. Hold and say “continue” when ready. The app records the takeover event, not your intervening keystrokes.

The adapters use a single custom GUI-action tool over vision-capable provider APIs. They do not yet translate each vendor's specialized built-in computer-use tools; use a model supporting image input and function calling (or Ollama JSON output).

### Use your local `.env` keys

Put `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and/or `GEMINI_API_KEY` in the repository's `.env` (see `.env.example`). With the current app built, import the keys and select the inexpensive OpenAI preset:

```sh
npm run start:local -- --provider openai
```

This selects `gpt-5.4-mini` and its estimated token rates. `--provider google` selects `gemini-3.5-flash-lite`; `--provider anthropic` selects `claude-sonnet-5`. These are editable starting points, not a guarantee of task success. The command without `--provider` imports keys while preserving the current model and privacy mode. Run it again after rotating a key.

The main process imports only known API-key variables and saves them in the encrypted local store, bound to their provider and endpoint. Keys are never loaded into Vite, returned to the renderer, or included in the app package. After import, double-click the app normally; `.env` is no longer needed to launch it. Screen context goes directly to the selected provider; microphone audio stays local.

If Gemini returns `API_KEY_SERVICE_BLOCKED`, the Google Cloud key's API restrictions must allow the Generative Language API (`generativelanguage.googleapis.com`). Enabling model access/billing is separate from importing a key.

For a live debugging session, quit the running app, then use `npm run debug:local` with the current Mac package built. It runs the same Mac app with streaming local diagnostics in the terminal. `npm run logs:live` follows the same stream from another terminal. Logs are in `.data/diagnostics/current.jsonl`, with three rotated files (5 MB each). They include task state, action types/coordinates, native/provider timings, retries, token usage and redacted errors; they omit task/transcript text, typed text, screenshots and keys. Full task trajectories remain in the existing encrypted local history. There is no web dashboard or diagnostics upload. Quit this debug launch and open the app normally to disable the stream. Source changes require a rebuild/restart; active tasks are not hot-reloaded.

A browser preview is also available:

```sh
npm run dev:ui
```

Open `http://127.0.0.1:5173`. It is labeled as a preview, runs the tutorial in memory, and has no desktop control, credential storage or contribution uploads.

## Verify and build

```sh
npm test
npm run build:native
npm run build
npx playwright install chromium
npm run test:e2e
npm start
```

`npm run test:desktop` checks the actual Electron shell with a synthetic run and isolated encrypted storage. `CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac` produces a local `.app` directory without using your release signing identity. Release signing/notarization and signed updates are not configured. Both native helpers must match the target architecture.

`npm run test:provider -- openai` is an optional **paid API** check using your `.env` key and generated screenshots in an isolated, offline browser. It exercises visual targeting, text entry and completion verification, with a six-step limit and a $0.05 estimated budget checked before each request. It never captures your desktop or sends OS input. Results go to `output/qa/provider-smoke-openai.json`. `anthropic` and `google` can be checked the same way; failures are recorded and return a nonzero exit code.

## Optional contribution service

The assistant works without this service. This loopback reference service stores encrypted quarantine bundles, enforces explicit consent, verifies chunk and final checksums, supports resumable uploads and deletes contributions using a possession token. It expires contributions after seven days on startup/hourly sweeps.

```sh
# Generate and securely retain a 32-byte key. Changing it loses access to stored data.
export INGEST_ENCRYPTION_KEY="$(openssl rand -hex 32)"
npm run ingest
```

Set the contribution endpoint to `http://127.0.0.1:4319` in desktop Settings. Finish a tutorial, review its contribution, remove frames/actions if desired, tick the consent checkbox and contribute. A successful upload requires a manifest checksum receipt. Use **Withdraw** to delete the server copy, then optionally delete the local run.

Native screenshots are **excluded** from uploads in this alpha. Text detectors redact common identifiers and secrets; the UI does not call the result anonymous. The service is a local development reference, not a public collector. See [deployment resources](docs/RESOURCES.md) before deploying it.

## Gym starter

```sh
npm run gym -- seed 42 .data/gym
npm run gym -- grade .data/gym
```

Seeding writes a deterministic initial board, task instructions and an empty trajectory. Grading checks the expected board and unchanged distractor, and rejects an empty or non-GUI trace. A fresh seed intentionally fails grading until solved. The SDK is a task-authoring starting point, not a VM orchestrator or tamper-proof evaluator. Workflow export is available for acknowledged trajectory contributions; it uses the exact approved bundle and requires analyst review.

## Repository

- `src/core`: action schema, privacy boundary, policy, run state machine, tutorial and text sanitizer.
- `src/providers`: OpenAI Responses, Anthropic Messages, Gemini, compatible and Ollama adapters.
- `electron`, `native/macos`: menu-bar shell, floating pill, IPC boundary, native speech/capture/input and emergency stop.
- `src/voice`: terse command classification and pill state. Completed corrections extend the active task. Audio and the stream of partial transcripts are not stored; a command recovered from an empty final recognition is stored only as the submitted command.
- `src/storage`: AES-256-GCM history and hash-chained event records. The master key is wrapped by Electron's OS secure storage.
- `src/contribution`, `services/ingest`: review bundles, consent, upload/resume/commit/deletion and encrypted quarantine.
- `src/gym`: workflow candidate exporter, seeded task and state grader.
- `src/ui`: desktop UI and an explicitly separate in-memory browser preview.

See [voice product contract](docs/VOICE_PRODUCT.md), [visual design](docs/DESIGN.md), [architecture](docs/ARCHITECTURE.md), [developer guide](docs/DEVELOPMENT.md), [privacy](PRIVACY.md), [security](SECURITY.md) and [threat model](docs/THREAT_MODEL.md).
