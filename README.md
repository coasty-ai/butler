# Butler

_Formerly Open Assist. Open source under the MIT license; see the status below before relying on it._

**Press a key. Tell your computer what to do.**

A macOS voice assistant that operates your Mac for you. Hold **Option + Space**, speak, and release. A floating pill shows Listening → Working in your app → Needs approval → Done, then disappears. Hold again to pause and steer the same task. Tap for a text command. Settings and optional local-run review live in the menu bar. To launch directly into hands-free listening with diagnostics, run `npm run debug:local -- --hands-free` (`--no-hands-free` disables it). For hands-free use, select **Say “Hey Butler”** under **Talk to Butler** in Settings and save, or enable it from the menu bar. Say “Hey Butler, open Notes,” or just “Butler, open Notes,” then pause; say the wake phrase again to interrupt. The menu bar can turn off its microphone at any time.

Butler is the consumer product. CoArena is the intelligence/evaluation layer; CoArena Gym is the environment and evaluation product. Contributions connect them only after per-run review and consent.

**Status: development alpha.** Native push-to-talk, optional on-device wake-phrase listening, on-device speech, screen capture/input, correction handling, approval, encrypted local trajectories and opt-in contribution are implemented. Offline checks use synthetic tasks and mocked providers; GPT-5.4 mini has also completed a generated-screen task through the live API and a few real Calculator/Safari tasks through the terminal live harness. Live speech accuracy, arbitrary desktop reliability and shortcut latency still need device testing. See [validation](docs/VALIDATION.md), [implementation status](docs/IMPLEMENTATION.md) and [resources required](docs/RESOURCES.md).

**Measured status (2026-09-20).** On the repository's own market benchmark (35 everyday tasks in email, files, research, business forms, shopping and smart-home fixtures, driven live on a Mac under the owner regime that never asks and allows everything) the current cell model, `gpt-5.4-mini`, passes about 45 to 53% of attempts, and between a quarter and two fifths of its "done" claims are wrong. The mechanics (finding and pressing controls, reading pages, typing, closing stray menus, staying in its own browser) are in good shape; planning and judgment on multi-page work are bounded by the cell model, and the done audit that catches wrong claims is strongest with a stronger auditing model (`--audit-model`, see docs/BENCHMARK.md). Treat it as an experimental agent you watch, not an assistant you trust unattended.

## Download and start (Apple Silicon Mac)

Requirements: a Mac with Apple Silicon (M1 or newer) running macOS 14 Sonoma or later.

1. **Download** the latest `Butler-<version>-arm64.dmg` from [Releases](https://github.com/coasty-ai/butler/releases). The only release at the time of publishing (v0.1.0-alpha.1, 17 September 2026) predates the rename and most of this history; until the next tagged build, build from source as described below.
2. **Install:** open the DMG and drag **Butler** into **Applications**.
3. **First launch:** this alpha is signed ad hoc but not notarized by Apple, so macOS blocks the first open. Open it once, then go to **System Settings → Privacy & Security**, scroll down to the message about Butler and click **Open Anyway**. Alternatively, run this once in Terminal:
   ```sh
   xattr -dr com.apple.quarantine "/Applications/Butler.app"
   ```
4. **Set up:** on the first launch the setup view opens and walks through permissions, a model, the optional natural voice and a first task. Every step is skippable and nothing is a dead end: it reopens from the menu bar (**Set up Butler…**) and from Settings. Prefer to look around first? Click **Try the safe tutorial first**; it runs on a simulated board and needs no permissions or keys.
5. **Grant permissions** from the checklist: Screen Recording, Accessibility, Microphone and Speech Recognition. Each row explains what it is for and opens the exact System Settings pane, and the list rechecks itself every couple of seconds. **After granting Screen Recording, quit and reopen the app** — macOS applies it only to a process started after the grant, so the checklist says “Granted, restart needed” instead of showing a tick.
6. **Choose a model** in the setup step or in Settings:
   - **Private local (free):** install [Ollama](https://ollama.com), run `ollama pull qwen3-vl:8b` (about 6 GB; `qwen3-vl:2b` is smaller but much weaker at finding controls), and keep the default endpoint. Setup looks for a running Ollama on the loopback address and says whether that model is installed.
   - **Bring your own key:** choose OpenAI, Anthropic or Google and paste your API key. **Check key** verifies it with one small request that never touches your screen, then saves it encrypted. Requests go directly to that provider.
7. **Talk to it:** hold **Option + Space**, say what you want (“open Notes and write a shopping list”), and release. Tap the shortcut to type instead. For hands-free use, choose **Say “Hey Butler”** in Settings.
8. **Optional natural voice:** in the setup step, or in **Settings → Voice replies**, choose **Natural voice (free, on-device)** and click **Download** (332 MB, runs entirely on your Mac). Make sure your Mac's volume is up to hear replies.

Stop anytime with **Escape** or by saying “stop”. Moving your mouse pauses the agent; it continues on its own when you let go.

Updating: download the new DMG and replace the app. Because each alpha build is signed ad hoc, macOS may ask you to grant the permissions again after an update. Your settings, history and learned memory are kept.

## Build from source

Requirements: **Node 22.12+ (Node 24 recommended)**, npm, macOS 14+, Xcode Command Line Tools (`xcode-select --install`).

```sh
git clone https://github.com/coasty-ai/butler.git
cd butler
npm ci
npm run dev
```

To produce the downloadable DMG and ZIP (ad-hoc signed, in `release-dist/`), run `npm run package:mac:release`. `npm run package:mac` builds an unpacked app in `release/mac-arm64/` for local testing.

The app builds its two Swift helpers on first launch. Choose **Try the safe tutorial** for a deterministic, no-key run. It operates a simulated task board using the actual run loop and local journal. It does not record audio, capture your desktop or call a model.

For real tasks, open Settings once, configure a vision-capable model, and grant Screen Recording, Accessibility, Microphone and Speech Recognition (and Input Monitoring if macOS requests it). Restart if macOS requests it. On-device speech support depends on the installed language; there is no cloud transcription fallback. Text commands remain available. The selected display and bounded window/selection context supply automatic context to the model.

Known text fields, recognized navigation and controls with a benign label (Close, Search, Play, …) can proceed automatically. Sending, publishing, paying, deleting and other labelled controls require approval. Unidentified targets trigger up to three recovery attempts, then pause for manual help instead of requesting approval for blind input. To open or switch apps the model uses a launch-only `open_app` action limited to installed apps in the standard application folders; installers, terminals, script apps and protected apps are refused. Passwords and protected surfaces require manual takeover.

Butler learns locally. It knows your installed apps, standard folders and recently used files from Spotlight metadata, remembers your corrections and past tasks, and turns procedures that succeed repeatedly into skills that replay without model calls. Every replayed step still goes through the same safety checks. Memory is encrypted on this Mac; turn it off or forget everything in **Settings → Learning**. See [docs/MEMORY.md](docs/MEMORY.md). These deterministic rules still need live/adversarial validation; arbitrary desktop UI is not perfectly classified.

- **Local:** install Ollama, download a vision model, and use `http://127.0.0.1:11434`. The default `qwen3-vl:8b` is editable; it is not automatically downloaded. Cloud model identifiers are rejected.
- **BYOM:** choose OpenAI, Anthropic, Google or an OpenAI-compatible endpoint. Enter your own API key, model ID, and current input/output token prices for estimated cost accounting. Requests go directly to that provider.
- **Stop:** `Escape`, `Control + Option + Escape`, the stop control, or hold and say “stop.” Native Escape handling is independent of the renderer/model call during real runs.
- **Talk / steer:** hold `Option + Space`; release to execute. The controller stops and a working run pauses immediately on key-down; if nothing usable is recognized, the run stays paused. Say “Wait,” “Stop,” “Use Chrome, not Safari,” or another correction.
- **Type:** tap `Option + Space`, or use `Command + Shift + Space`.
- **Approve:** click once, or hold the shortcut and say “yes” to the current approval. In hands-free mode, say “Hey Butler, yes,” or just “yes” while it is listening for your reply. Spoken approval is still bound to the pending action and a finalized recognition confidence check.
- **Hear replies:** it answers out loud when you talk to it: questions, approvals and results. Pause to think; it waits longer when your sentence sounds unfinished. Choose the voice, speed and patience in **Settings → Voice replies / Listening**. See [docs/VOICE_PRODUCT.md](docs/VOICE_PRODUCT.md).
- **Take over:** move the mouse, click, scroll or type to pause the agent. Hold and say “continue” when ready. The app records the takeover event, not your intervening keystrokes.
- **Text yourself updates:** optional, off by default. Butler can text one number — yours — when a task starts, needs you or finishes, and read short replies from that number: `status`, `stop`, `pause`, `continue`, or `do <task>`. Approvals never happen by text. Turn it on under **Settings → Text updates**, where the two macOS permissions (Automation for Messages, Full Disk Access to read replies) are explained. See [docs/MESSAGING.md](docs/MESSAGING.md).
- **Hand code to a coding agent:** “ask Claude Code to fix the failing test in open-assist”, “have Codex add a dark mode”. Butler types the task into the CLI in that folder (a tmux session you can attach to, or the CLI's print mode without tmux), tells you what it is doing when you ask, relays every question it asks and reads its summary on request. Only your own “tell it yes” or “tell it no” answers a permission prompt. See [docs/CODING_AGENTS.md](docs/CODING_AGENTS.md).

The adapters use a single custom GUI-action tool over vision-capable provider APIs. They do not yet translate each vendor's specialized built-in computer-use tools; use a model supporting image input and function calling (or Ollama JSON output).

### Use your local `.env` keys

Put `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and/or `GEMINI_API_KEY` in the repository's `.env` (see `.env.example`). With the current app built, import the keys and select the inexpensive OpenAI preset:

```sh
npm run start:local -- --provider openai
```

This selects `gpt-5.4-mini` and its estimated token rates. `--provider google` selects `gemini-3.5-flash-lite`; `--provider anthropic` selects `claude-sonnet-5`. These are editable starting points, not a guarantee of task success. The command without `--provider` imports keys while preserving the current model and privacy mode. Run it again after rotating a key. An `OPENROUTER_API_KEY` in the same file is imported into its own slot for the optional "Decide with Jev" setting; importing it never turns that setting on (tick it in Settings, or add `--decide-with-jev` to a debug launch).

`PHONE_NO` is imported the same way, as the number for optional text updates. It is saved in the encrypted config and nothing is texted until you turn the feature on in **Settings → Text updates**; use a number or iMessage address that is not signed in to Messages on this Mac, so your own texts can be told apart from Butler's.

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

`npm run test:live -- --provider openai "Open Calculator"` is an optional **paid, real desktop** run: it drives this Mac with the source native helper under cost/action/time caps, declines approvals and stops at any pause. `--trace-dir` saves screenshots and per-step traces; keep that directory outside the repository. See the [developer guide](docs/DEVELOPMENT.md#live-task-harness).

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

- `src/core`: action schema, privacy boundary, policy, run state machine, control-label rules, the memory contract, tutorial and text sanitizer. `src/core/index.ts` is the entry point for embedding the loop in another app, and it imports nothing from the rest of `src/` (see [modularity](docs/MODULARITY.md)).
- `scripts/live-task.mjs`: opt-in paid live desktop harness.
- `src/providers`: OpenAI Responses, Anthropic Messages, Gemini, compatible and Ollama adapters.
- `electron`, `native/macos`: menu-bar shell, floating pill, IPC boundary, native speech/capture/input and emergency stop.
- `src/voice`: terse command classification and pill state. Completed corrections extend the active task. Audio and the stream of partial transcripts are not stored; a command recovered from an empty final recognition is stored only as the submitted command.
- `src/storage`: AES-256-GCM history and hash-chained event records. The master key is wrapped by Electron's OS secure storage.
- `src/contribution`, `services/ingest`: review bundles, consent, upload/resume/commit/deletion and encrypted quarantine.
- `src/gym`: workflow candidate exporter, seeded task and state grader.
- `src/ui`: desktop UI and an explicitly separate in-memory browser preview.

See [voice product contract](docs/VOICE_PRODUCT.md), [visual design](docs/DESIGN.md), [architecture](docs/ARCHITECTURE.md), [developer guide](docs/DEVELOPMENT.md), [privacy](PRIVACY.md), [security](SECURITY.md) and [threat model](docs/THREAT_MODEL.md).
