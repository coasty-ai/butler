# Modularity and first run

A plan, not a refactor. **PR-1 (§8) has been applied; nothing else in this
document has.** What PR-1 changed is marked where it appears. It names real
files, real exports and real commands as they stand on `feat/memory-voice-natural-speech`
at the time of writing, and it says which of those facts a reviewer should re-check
before starting, because `src/core/runner.ts` and the Swift helpers are being edited
in parallel.

Three questions are answered: what the modules should be, what makes Butler
easy to install and to embed, and which single change to make first.

## 0. What is there today, measured

| Area                    | Lines  | Note                                     |
| ----------------------- | ------ | ---------------------------------------- |
| `src/` (TypeScript/TSX) | 15,476 | no file imports `electron`               |
| `electron/`             | 7,751  | only 4 of 14 files import `electron`     |
| `native/macos/` (Swift) | 4,986  | two helper binaries plus pure rule files |
| `tests/`                | 19,895 | 25 vitest files, 1 Playwright spec       |

Largest files: `electron/main.ts` 2,276 · `src/ui/main.tsx` 2,257 ·
`src/core/runner.ts` 1,835 · `electron/conversation.ts` 1,153 ·
`src/core/policy.ts` 1,075 · `src/providers/http.ts` 997 ·
`electron/messages.ts` 908 · `electron/kokoro/client.ts` 854 ·
`src/voice/turns.ts` 838 · `electron/speech-output.ts` 685 ·
`electron/controller.ts` 538 · `electron/diagnostics.ts` 464.

Two measurements matter more than the rest.

**No file under `src/` imports `electron`.** `grep -rn 'from "electron"' src/` returns
nothing. The run loop, the policy engine, the providers, the voice rules, the memory
layer, the vault and the contribution code are already runtime-neutral. `src/core`
does not even import a `node:` builtin.

**Only four files in `electron/` import `electron`:** `main.ts` (2,276),
`preload.ts` (62), `provider.ts` (74) and `kokoro/client.ts` (854, and only for
`utilityProcess`, which is already injectable through the `KokoroFork` option).
The other ten files — `controller.ts`, `conversation.ts`, `credentials.ts`,
`diagnostics.ts`, `messages.ts`, `speech-output.ts`, `voice.ts`,
`kokoro/{manifest,protocol,worker}.ts` — total 4,485 lines of plain Node that live
in the Electron directory for historical reasons only. That is 58% of `electron/`
misfiled, and it is the cheapest modularity win in the repository.

## 1. What is already a clean boundary

These need no work. They are the seams the rest of the plan builds on.

| Seam                | Where                                                                                                                                                                                              | Implementations                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Controller`        | `src/core/schema.ts:408` — `surface`, `capture`, `execute`, `stop`, `resume`, optional `restore`/`revalidate`                                                                                      | `NativeController` (`electron/controller.ts:366`), `TutorialController` (`src/core/tutorial.ts:14`)                                                   |
| `Provider`          | `src/core/schema.ts:392` — one method, `next(observation, signal)`                                                                                                                                 | `HttpProvider` (`src/providers/http.ts:764`), `TutorialProvider` (`src/core/tutorial.ts:82`), the trace-wrapping proxy in `scripts/live-task.mjs:230` |
| `Recorder`          | `src/core/schema.ts:467` — `begin`, `append`, `frame`, `save`                                                                                                                                      | `Vault` (`src/storage/vault.ts:37`), plus `nullRecorder()` (`src/core/recorder.ts`, PR-1; see §2h)                                                    |
| Helper protocol     | newline-delimited JSON on private stdin/stdout, request id + allow-listed method; `HelperProcess` (`electron/controller.ts:73`) with restart backoff and a SIGUSR1 stop latch                      | `coarena-controller`, `coarena-voice`, `coarena-messages`                                                                                             |
| `MemoryAccess`      | `src/core/memory.ts` (PR-1; was `src/memory/types.ts`), built by `createMemoryAccess(store, index, options)` (`src/memory/access.ts:70`) — `recall(task)`, `learn(input)`, never throws into a run | `MemoryStore` + the native `index` method                                                                                                             |
| Messages channel    | `MessagesChannel` (`electron/messages.ts`) with `onSnapshot(s)` and its own helper                                                                                                                 | one                                                                                                                                                   |
| Pure voice policy   | `planVoiceTurn` (`src/voice/turns.ts:749`), `utteranceCompleteness`, `speakableText`/`speakableApproval`, `idlePill`/`PillState`                                                                   | consumed by `electron/main.ts` and `electron/conversation.ts`                                                                                         |
| Transport injection | `HttpProvider(settings, key, fetch, diagnostics)` takes `fetch`; `desktopTransport()` (`electron/provider.ts:8`) supplies the Chromium one                                                         | Node `fetch` in the harnesses, Chromium session in the app                                                                                            |

`docs/DEVELOPMENT.md` already documents two of these as extension points
("Add a provider", "Add an OS backend"). The interfaces are real; what is missing
is a place to import them from and a build that keeps them honest.

## 2. What is tangled

**a. `electron/main.ts` owns eleven things.** By line range:

| Lines              | Responsibility                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 106–113            | single-instance lock (a module side effect, executed on import) and the userData override                                                                                  |
| 114–158            | 24 module-level mutable variables: `window`, `tray`, `voice`, `pill`, `runner`, `native`, `vault`, `memory`, `master`, `settings`, `credentials`, `uploads`, `snapshot`, … |
| 161–257            | natural-voice (Kokoro) lifecycle, download, status projection                                                                                                              |
| 258–333            | construction of speech output, messages channel and conversation                                                                                                           |
| 334–346            | `saveConfig()` — AES-GCM seal of `{settings, credentials, uploads}` into `config.enc`                                                                                      |
| 347–450            | native helper ownership, restart handling, auto-resume after manual input                                                                                                  |
| 451–528            | memory access, debounced flush, Spotlight index prewarm                                                                                                                    |
| 529–600, 1289–1369 | the pill state machine (`setPill`, `renderPill`, `pillSummary`, `approvalPill`)                                                                                            |
| 601–683            | tray menu and settings window                                                                                                                                              |
| 684–1081           | voice helper ownership and event routing (`receiveVoice` alone is 168 lines)                                                                                               |
| 1082–1288          | turn planning and execution (`command`, `planRun`, `executePlan`)                                                                                                          |
| 1397–1899          | `dispatch()`: one `switch` with 34 cases, ~500 lines, the entire IPC surface                                                                                               |
| 1900–2276          | renderer reload budget, page loading, launch-argument parsing, app bootstrap                                                                                               |

The cost is visible in the test suite: `tests/desktop-provider.test.ts` mocks
`electron`'s `app` with `requestSingleInstanceLock: () => false` purely so that
importing `electron/main` to reach one pure function (`shouldPrewarmIndex`,
`electron/main.ts:479`) does not start an application.

**b. The IPC surface is stringly typed in one direction.** `Bridge`
(`src/ui/api.ts:150`) is a good typed contract, but `electron/preload.ts` collapses
it to `ipcRenderer.invoke("coarena", method, args)` and `dispatch` re-expands it
with a `switch` and ad-hoc `zod` parsing per case. Adding a method means editing
three files with no compiler link between them.

**c. `src/core` depends on `src/memory`.** _Fixed by PR-1: the labels now live at
`src/core/labels.ts` and the contract types at `src/core/memory.ts`, so nothing
under `src/core` imports outside it. The paragraph below describes the state
before that._ `src/core/runner.ts:23` imports
`../memory/types` (types only) and `src/core/runner.ts:34` imports
`../memory/labels` (values: `labelMatches`, `normalizeLabel`, `normalizeRole`,
`utf16Prefix`). `src/memory/types.ts:1` imports back from `../core/schema`, and
`src/memory/store.ts:12` imports `../storage/vault`, which imports `../core/schema`.
That is a directory-level cycle: core → memory → core. It is the single thing that
makes `@butler-agent/core` impossible as written.

**d. `src/providers` depends on `src/memory`.** _Fixed by PR-1: the table is now
`src/providers/playbooks.ts`._ `src/providers/http.ts:10` imports
`playbookLines` from `../memory/playbooks`. `playbooks.ts` has no imports at all —
it is a static table the provider serializes as `context.playbook`. It is filed
under memory because the design note lives in `docs/MEMORY.md`, not because of a
dependency.

**e. 4,485 lines of Node-only code sit in `electron/`** (§0). `scripts/live-task.mjs`,
`scripts/bench.mjs` and `scripts/native-input-smoke.mjs` all reach into
`electron/controller.ts` from outside Electron. That import reads like a mistake and
is not one.

**f. `src/ui/main.tsx` is 2,257 lines** holding the settings window, the pill
overlay, the run history, the contribution review and the browser-preview branch,
switched by `isPill`/`isSettings` module constants.

**g. "Core" policy is macOS-specific.** `src/core/policy.ts` contains 29 literal
`com.apple.*` bundle identifiers and 43 `AX*` role references (Spotlight matching,
Dock redirection, Calculator keypad rules, the protected floor, document-app text
areas). The `Controller` interface is portable; `evaluate` and `surfacePolicy` are
not. A second OS backend needs a seam here, and that seam is safety code.

**h. `Recorder` is hand-rolled three times.** _Fixed by PR-1: `nullRecorder()`
(`src/core/recorder.ts`) is the single copy; the three call sites keep only the
run/frame bookkeeping that is theirs._ `scripts/live-task.mjs:77–99`,
`scripts/bench.mjs` and `tests/core.test.ts:534` each define the same
begin/save/frame/append stub. Any embedder writes a fourth.

## 3. Boundary map

Eleven modules. "Move" means a file relocation with no logic change unless stated.

### 3.1 `core` — the run loop and policy (pure, no Electron, no `node:`)

**Path** `src/core/` (unchanged).
**Owns** the action schema and `validateAction`; `Settings` and `defaultSettings`;
the `Controller`, `Provider`, `Recorder` interfaces; `Run`, `JournalEvent`, `Frame`,
`Surface`, `Snapshot`, `Observation`; the policy engine (`surfacePolicy`,
`evaluate`); the `Runner` state machine; error taxonomy; `scanText`/`redactSecrets`;
`shouldAutoResume`; the tutorial fixtures; the `DiagnosticSink` type.

**Moved in (PR-1, done)**

- `src/memory/labels.ts` → `src/core/labels.ts` (70 lines, zero imports). Fixes (c).
  The single-source-of-truth rule in `docs/DEVELOPMENT.md` ("change matching rules
  only there") survives the move; update the path in that sentence.
- the _contract_ half of `src/memory/types.ts` → `src/core/memory.ts`:
  `SystemIndex`, `PlanStep`, `ReplayPlan`, `Recall`, `TrajectoryStep`, `LearnInput`,
  `MemoryAccess`. The _storage_ half (`Episode`, `Preference`, `Skill`, `SkillStep`,
  `AppUsage`, `MemoryData`) stays in `src/memory/types.ts`. `MemoryContext` is
  already in `src/core/schema.ts`, so this follows the existing precedent.

**Moves out (later, PR-8)** `src/core/runner.ts`, at 1,835 lines and still growing
(automatic re-aim landed while this was being written), is the state machine _and_
the replay executor _and_ the re-aim recovery path _and_ the stall/loop detectors.
Split into
`src/core/runner.ts` (state machine), `src/core/replay.ts` (plan step → proposal,
control resolution by role/label, `completeWhen` checks) and `src/core/progress.ts`
(`progressProbe`, `sameProbe`, `actionSignature`, `repetitionPeriod`, the three
warning strings). Not now: another agent is in this file, and the replay path is
covered by 48 tests in `tests/runner-memory.test.ts` that would all need re-pointing.

**Exports (`src/core/index.ts` barrel, added by PR-1)** `Runner`, `terminal`, `validateAction`,
`actionSchema`, `settingsSchema`, `defaultSettings`, `evaluate`, `surfacePolicy`,
`scanText`, `redactSecrets`, `TutorialController`, `TutorialProvider`,
`nullRecorder`, all interfaces and types above, plus the label helpers.

**Depends on** `zod`. Nothing else.

### 3.2 `os` — OS control adapters

**Path** `src/os/` (new) — `src/os/helper-process.ts`, `src/os/macos/controller.ts`,
`src/os/macos/index.ts`.
**Moves** `electron/controller.ts` splits: `HelperProcess` + `budgetDelay` +
`nativeTimeout` → `src/os/helper-process.ts` (shared by the voice and messages
helpers, which import it today from `electron/controller`); `NativeController` →
`src/os/macos/controller.ts`. The Swift sources stay at `native/macos/` and the
binaries at `native/bin/`; `scripts/build-native.mjs` is unchanged.
**Owns** the helper process lifecycle (spawn, newline-JSON framing, per-method
timeouts, 500 ms–2 s restart backoff capped at five per minute, SIGUSR1 stop latch,
parent-death exit), and the macOS `Controller` implementation.
**Exports** `NativeController`, `HelperProcess`, `nativeTimeout`, `budgetDelay`,
`HelperHooks`.
**Depends on** `core` (types + `cleanScreenContext`), `node:child_process`,
`node:readline`.
**A second OS** implements `Controller` under `src/os/windows/` or `src/os/linux/`
against the contract in `docs/DEVELOPMENT.md#add-an-os-backend`. It will hit §2g:
`policy.ts` needs a platform profile before a non-macOS backend is safe. Budget that
separately (PR-7), and do not let a Windows adapter ship against macOS policy
constants.

### 3.3 `providers` — model adapters

**Path** `src/providers/` (unchanged).
**Moved in (PR-1, done)** `src/memory/playbooks.ts` → `src/providers/playbooks.ts`.
Fixes (d). `docs/MEMORY.md` and `docs/DEVELOPMENT.md` name the new path.
**Owns** `buildRequest`, `parseResponse`, `parseUsage`, `memoryForModel`,
`singleJsonObject`, the retry/`retryAfter` rules, `providerDefaults`,
`selectProvider`, `credentialScope`, and the static playbook table.
**Stays in the app** `electron/provider.ts` — `desktopTransport()` is a _transport_
(Chromium in-memory session, DIRECT-route fallback to Node TLS), not a provider.
`createDesktopProvider` is a two-line composition. Keep it in `electron/`.
**Depends on** `core`. After the playbooks move, nothing else.

### 3.4 `voice` — speech in and speech out

Split in two, and the existing split is already right except for where the files sit.

**`src/voice/` (pure, unchanged path)** phrase inventory, `planVoiceTurn` and the
turn-taking rules, `utteranceCompleteness`, `speakableText`/`speakableApproval`/
`speakableSummary`, `voiceIntent`, `PillState`/`idlePill`, and the Kokoro G2P,
tokenizer, normalizer and audio helpers (pure DSP, 1,657 lines, tested by
`tests/kokoro-g2p.test.ts` without a model).

**Moves in** `electron/conversation.ts` (1,153 lines) → `src/voice/conversation.ts`.
It imports `electron` not at all; its only non-`src` imports are _types_ from
`./speech-output` and `./voice`. It decides what to say and when — `momentKey`,
`gateOf`, the answer/approval/continuation windows, deduplication — which is voice
policy, not shell code. `electron/messages.ts` imports `momentKey` from it so that
speech and text agree on what counts as one moment; that import survives the move.

**`src/voice/runtime/` (new)** the I/O half: `electron/voice.ts` → the helper
client; `electron/speech-output.ts` → engine selection and speaking;
`electron/kokoro/{client,worker,manifest,protocol}.ts` → the utility-process voice.
`kokoro/client.ts` keeps its `KokoroFork` injection point so the default
`utilityProcess.fork` stays an Electron detail supplied by the app.

**Depends on** `core`, `os/helper-process`.

### 3.5 `memory` and skills

**Path** `src/memory/` (unchanged), minus `labels.ts`, `playbooks.ts` and the
contract types.
**Owns** the encrypted store (`memory.enc`, AAD `memory`, caps, decay, atomic
debounced writes), BM25 retrieval, built-in intents, skill learning/matching, and
`createMemoryAccess`.
**Depends on** `core` (schema + labels + the `MemoryAccess` contract) and `storage`
(`seal`/`unseal`). Becomes a leaf that the loop consumes through one interface, so
an embedder can pass `undefined` or their own `MemoryAccess`.

### 3.6 `channels` — the ways a task can start

Four exist; only one is a module today.

| Channel      | Today                                                                                       | Target                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Pill overlay | `src/ui/main.tsx` (`Pill`) + `renderPill`/`setPill` in `electron/main.ts:529–600,1289–1369` | `src/ui/pill/` for the view; the pill _projection_ (`Snapshot` → `PillState`) moves to `src/channels/pill.ts`, pure and testable |
| Voice        | `receiveVoice`/`command`/`executePlan` in `electron/main.ts:684–1288`                       | `src/channels/voice.ts` driving the `Session` façade; the decision half is already pure in `planVoiceTurn`                       |
| iMessage     | `electron/messages.ts` — already a channel object                                           | `src/channels/messages/` unchanged in behaviour                                                                                  |
| CLI          | `scripts/live-task.mjs`, `scripts/bench.mjs`, `scripts/debug-local.mjs`                     | `src/channels/cli/` or left as scripts; they only need `core` + `os` barrels                                                     |

**The missing piece is a façade.** Every channel needs the same five verbs —
`submit(text, source)`, `stop()`, `pause()/resume()`, `confirm(yes)`,
`subscribe(fn)` — and today each reaches into `electron/main.ts` module state to get
them. Introduce `src/app/session.ts`:

```
class Session {
  constructor(deps: {controller, provider, recorder, settings, memory?, diagnostics?})
  submit(text: string, source: "ptt" | "wake" | "followup" | "text"): Promise<void>
  stop(reason?): void; pause(msg?): void; resume(): Promise<void>
  confirm(yes: boolean): void
  updateSettings(next: Settings): void
  subscribe(fn: (s: Snapshot) => void): () => void
  readonly snapshot: Snapshot
}
```

`VoiceSource` already exists (`src/voice/turns.ts:673`). `Session` owns the `Runner`,
the `Snapshot` fan-out and `ensureIdle`; `electron/main.ts` keeps windows, tray, IPC,
config encryption, launch arguments and packaging. This is the change that actually
shrinks `main.ts`, and it is also the riskiest, because voice hold/resume, auto-resume
after manual input and the messages channel all read the same mutable state today.

### 3.7 `storage` and consent

**Path** `src/storage/`, `src/contribution/`, `services/ingest/` (unchanged).
**Owns** `Vault` (AES-256-GCM per-run journal, hash-chained events, content-addressed
frames, truncated-tail recovery), `seal`/`unseal`/`digest`, bundle preparation,
consent shape, the upload/resume/commit/withdraw client, and the loopback ingest
reference service.
**One port to add** the master key is wrapped by Electron's `safeStorage`
(`electron/main.ts:2013–2027`). Name it:

```
interface MasterKeyStore { load(): Buffer }   // src/storage/key-store.ts
```

with `electron/safe-storage-key.ts` for the app and a file-backed implementation for
headless use. `scripts/live-task.mjs` and `scripts/bench.mjs` already write a random
key beside a scratch store; that becomes one shared implementation instead of two.

### 3.8 `eval` — gym and bench

**Path** `src/gym/` (unchanged) plus `scripts/{bench,analyze-runs,live-task}.mjs`.
**Owns** the seeded task/grader, the workflow exporter, the 12-task automation
catalogue, the deterministic graders (which read only `controller.surface()`,
`controller.capture()` and the run journal — never screenshots), the report and the
diagnostics analyzer.
**Depends on** `core`, `os`, `providers`, and `contribution` for the exporter.
Nothing depends on it, so it is the natural first consumer of the barrels: if
`scripts/bench.mjs` can import `@butler-agent/core` and `@butler-agent/macos` and
nothing else, the boundary is real.

### 3.9 `app` — what stays Electron

`electron/main.ts`, `electron/preload.ts`, `electron/provider.ts`,
`electron/credentials.ts`, `electron/diagnostics.ts`, `src/ui/`. Windows, tray,
global shortcut, IPC, `safeStorage`, `config.enc`, launch arguments, second-instance
handling, renderer reload budget, `electron-builder` configuration.

## 4. Dependency diagram

Today (`→` = imports; `⇄` = cycle). This is the state **before** PR-1, which
removed the `src/core ⇄ src/memory` cycle and the `src/providers → src/memory`
arrow by moving `labels.ts`, the memory contract types and `playbooks.ts`:

```
                 electron/main.ts (2276)
        ┌────────────┬───────┴────────┬───────────────┐
        ▼            ▼                ▼               ▼
  electron/        electron/       electron/      electron/
  controller.ts    voice.ts        messages.ts    conversation.ts
  speech-output.ts kokoro/*        credentials.ts diagnostics.ts
        │            │                │               │
        └────────────┴───────┬────────┴───────────────┘
                             ▼
      src/voice ──► src/core/schema ◄── src/storage/vault ◄── src/memory/store
                         ▲   ⇅                                      │
      src/providers ─────┘   ⇅  src/core/runner ⇄ src/memory/{types,labels}
             └──────────────────────────► src/memory/playbooks
      src/ui ──► src/core, src/memory/types, src/providers/catalog, src/voice/router
      src/gym ──► src/core, src/contribution
```

Target (acyclic, layered; every arrow points down):

```
  ┌───────────────────────────────────────────────────────────────┐
  │ app        electron/{main,preload,provider,credentials,        │
  │            diagnostics}.ts · src/ui/{settings,pill,review}     │
  └───────────────┬───────────────────────────────────────────────┘
                  ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ channels   src/channels/{pill,voice,messages,cli}              │
  │ session    src/app/session.ts                                  │
  └───────┬──────────┬──────────┬──────────┬─────────┬────────────┘
          ▼          ▼          ▼          ▼         ▼
      ┌───────┐  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
      │  os   │  │providers│ │ voice  │ │ memory │ │ storage  │
      │macos/ │  │ +play   │ │ +conv  │ │ +skills│ │ +consent │
      │helper │  │ books   │ │ runtime│ │        │ │          │
      └───┬───┘  └────┬────┘ └───┬────┘ └───┬────┘ └────┬─────┘
          └───────────┴──────────┴──────────┴───────────┘
                             ▼
      ┌───────────────────────────────────────────────────────────┐
      │ core   schema · policy · runner · replay · progress ·      │
      │        errors · sanitize · labels · memory contract ·      │
      │        tutorial · recorder (zod only)                      │
      └───────────────────────────────────────────────────────────┘

  eval (src/gym, scripts/bench.mjs, scripts/live-task.mjs)
      ──► core, os, providers, contribution     [nothing depends on eval]
```

Rules a lint test can enforce (see PR-1): `core` imports nothing from the repository
outside `src/core`; no file under `src/` imports `"electron"`; `providers` does not
import `memory`; `os` does not import `providers`, `voice` or `memory`.
`tests/boundaries.test.ts` enforces the first three today (and, for `core`, also
`node:*`); the `os` rule lands with PR-3, when that directory exists.

## 5. Packages: what to split, what not to, honestly

### What a workspace would cost

Today the whole build is: `tsc --noEmit` once over `src`, `electron`, `services`,
`tests`; `vite build` for the renderer; one `esbuild` call bundling
`electron/{main,preload,kokoro/worker}.ts` to CJS with `electron` and
`onnxruntime-node` external; `electron-builder` with an explicit `files` list
naming `dist-electron/main.cjs`, `preload.cjs` and `kokoro/worker.cjs` and three
`extraResources` binaries. One `vitest run` covers 25 files. `npm ci && npm run dev`
is the entire contributor loop, and `package.json` is `"private": true` with no
version discipline at all.

A six-package workspace adds, concretely:

- **Build ordering.** Either every package keeps `"main": "src/index.ts"` (works
  inside the workspace, useless to an external consumer) or each gets its own
  emit step, and `esbuild` must then resolve built output rather than sources.
  The current single `esbuild` invocation becomes six `tsc -b` project references
  plus the bundle.
- **Six versions to bump per change.** A fix that touches `core` and `providers`
  becomes two version bumps, a changeset, and a lockfile churn — for a repository
  that currently ships by running `npm run package:mac:release`.
- **A new failure mode with teeth.** `@butler-agent/providers` at a version different
  from `@butler-agent/core` can silently change the cached system instruction in
  `buildRequest`. Prompt-cache stability is a _cost_ property here (Anthropic cache
  writes bill at 1.25×, reads at 0.1×); a version skew between the schema and the
  request builder is a real bill, not a style problem.
- **Test topology.** `tests/` currently imports across every boundary freely
  (21 files import `../src/core/schema`). Packages force either a test package that
  depends on all six, or per-package test suites — a 19,895-line reorganisation.

### What it would buy

An external embedder can `npm i @butler-agent/core @butler-agent/macos`. A second OS
adapter physically cannot import Electron. Contributors see the boundary in
`package.json` instead of in a document.

### Verdict

| Candidate                 | Recommendation                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@butler-agent/core`      | **Publish, eventually.** Only after §3.1 removes the cycle. It is the one piece with a plausible external consumer (someone running the loop against their own controller). zod is its only dependency.      |
| `@butler-agent/macos`     | **Publish with core, or not at all.** Useless without core; versions must move together. Ships a Swift build step, so an external consumer needs Xcode CLT — say so in its README or ship prebuilt binaries. |
| `@butler-agent/providers` | **Keep in-app.** Must not version-skew from `core` (prompt cache). If ever split, pin an exact peer dependency.                                                                                              |
| `@butler-agent/voice`     | **Keep in-app.** No independent consumer. Its pure half is already importable as `src/voice`.                                                                                                                |
| `@butler-agent/memory`    | **Keep in-app.** Consumed through `MemoryAccess`, which lives in core; an embedder can supply their own.                                                                                                     |
| `@butler-agent/channels`  | **Keep in-app.** Channels are product decisions, not a library.                                                                                                                                              |

**Do the directory and dependency split now; do the package split when a second
consumer exists.** The discipline a workspace buys can be had for one test file:
`tests/boundaries.test.ts` reads every `from "…"` specifier under `src/` and asserts
the arrow directions in §4. That is ~40 lines, zero build change, and it fails in CI
the moment someone re-introduces the cycle. It landed with PR-1.

## 6. First run, end to end

> **Implemented**, except step 0. The `setup` view lives in `src/ui/main.tsx`
> (`SetupView`); its shared contract — `SetupStatus`, `PrivacyPane`,
> `privacyPanes`, `privacySettingsRoot`, `privacyPanePaths`, `setupPermissions`,
> `firstTask`, `localModelSizes`, `usableOllamaModels`, `permissionsReady`,
> `resumeSetupAt`, `providerKeyMessage` — is in `src/ui/api.ts`, and the six
> dispatch cases are in `electron/main.ts`. `tests/setup.test.ts` covers the
> pure parts; `scripts/desktop-smoke.mjs` asserts that the view opens on a first
> launch, the `setupStatus` field set, the local probe, the key check, and that
> the overlay reaches none of it. What changed against the text below:
>
> - **`completeSetup()`** joins the five listed methods, and `SetupStatus` has
>   one extra field, `complete`. It is backed by `settings.setupComplete`
>   (`src/core/schema.ts`, `.default(false)`), which is what makes setup
>   resumable: quitting to apply a Screen Recording grant comes back to it. A
>   stored config written before the flag existed is treated as already set up,
>   so an update never pushes an existing install back through setup.
> - **`screenNeedsRelaunch`** is detected as _"the OS preflight says granted,
>   but this process was launched under the old decision"_. `capture` cannot be
>   the probe: the native helper starts latched (`stopped = true` in
>   `Controller.swift`) and a setup screen must not install the event tap.
>   Instead main records `systemPreferences.getMediaAccessStatus("screen")` at
>   launch and every `screen: false` it sees afterwards, so a revoke-and-regrant
>   while running is caught too.
> - **The download size** lives in `src/ui/api.ts` as `localModelSizes`, keyed
>   by model id, rather than in `src/providers/catalog.ts`, which was out of
>   scope for this change. `tests/setup.test.ts` pins the key to
>   `providerDefaults.ollama.model`, so it still cannot drift.
> - **The model-id inconsistency is already resolved**:
>   `providerDefaults.ollama.model`, `defaultSettings.model` and the README all
>   say `qwen3-vl:8b`, and a test holds them together.
> - **`showSettings` re-sends its section on `did-finish-load`**, because the
>   first-run push happens during startup and could otherwise reach the window
>   before the renderer had subscribed.
> - **Step 0 (Gatekeeper) is not addressed here**: it is packaging, not UI. The
>   README still carries the words; `FIRST-OPEN.txt` in the DMG is still open.
>
> `AppInfo.voice.kokoro` was not touched, as §9 requires.

Today: download a DMG, defeat Gatekeeper, open Settings, press two buttons that
trigger four OS prompts, type a model id and an endpoint, optionally paste a key,
and guess whether it worked. The permission rows show a binary Allowed/Enable with
no explanation of what is missing, no deep link to the right pane, and no signal
that Screen Recording needs a relaunch.

Proposal: a `setup` view, entered on first launch and reachable from the tray.
`electron/main.ts:678` already pushes an arbitrary section string over the `view`
channel and `src/ui/main.tsx:145` sets it as state, so a new view costs no plumbing.

### New bridge methods

Add to `Bridge` (`src/ui/api.ts:150`), `electron/preload.ts` and `dispatch`:

```ts
setupStatus(): Promise<SetupStatus>;
openPrivacyPane(pane: PrivacyPane): Promise<void>;
relaunch(): Promise<void>;
detectOllama(): Promise<{ running: boolean; models: string[] }>;
checkProviderKey(settings: Settings, key?: string): Promise<{ ok: boolean; message: string }>;
```

```ts
export type PrivacyPane =
  | "screen"
  | "accessibility"
  | "microphone"
  | "speech"
  | "input"
  | "automation"
  | "fullDisk";

export interface SetupStatus {
  supported: boolean; // macOS 14+
  screen: boolean; // CGPreflightScreenCaptureAccess
  screenNeedsRelaunch: boolean; // granted this session, capture still failing
  accessibility: boolean; // AXIsProcessTrusted
  microphone: boolean;
  speech: boolean;
  onDevice: boolean; // an on-device model exists for `locale`
  locale: string;
  shortcut: boolean; // the voice helper owns Option-Space
  model: { kind: "none" | "ollama" | "cloud"; ready: boolean; detail: string };
  kokoro: KokoroUiStatus;
}
```

`screen`, `accessibility` and `supported` come from the existing native
`permissions` method (`native/macos/Controller.swift:1343`); the voice fields come
from the voice helper's `permissions`. **Do not add fields to `AppInfo.voice.kokoro`:**
`scripts/desktop-smoke.mjs:222` deep-equals that object's key list and will fail.
`setupStatus` is a separate method for exactly that reason.

Pane URLs for `openPrivacyPane` (macOS 14/15; verify on the target release and fall
back to `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension`
plus the written path when `openExternal` rejects):

```
screen        x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture
accessibility x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility
microphone    x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone
speech        x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition
input         x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent
automation    x-apple.systempreferences:com.apple.preference.security?Privacy_Automation
fullDisk      x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles
```

The only such link in the app today is
`x-apple.systempreferences:com.apple.Accessibility-Settings.extension` at
`electron/main.ts:1769` (Spoken Content voices). Keep that one; it points elsewhere.

Poll `setupStatus()` every 2 s while the setup view is visible and on window focus,
and stop polling when the view is left. OS permission state changes outside the app,
so a static snapshot is wrong within seconds.

### Step 0 — Gatekeeper (before the app can run)

This cannot be solved in the UI: the alpha is ad-hoc signed and not notarized, so
the first open is blocked. Either notarize (the real fix, and it removes a step that
loses users) or keep the README instruction. If not notarizing, ship a
`FIRST-OPEN.txt` inside the DMG next to the app with the same words the README uses,
because the user reads the DMG, not GitHub.

> **macOS blocked this app.** This build is signed but not yet notarized by Apple.
> Open **System Settings → Privacy & Security**, scroll to the message about
> Butler, and click **Open Anyway**. You only do this once.

### Step 1 — Welcome

Keep the existing landing copy in `src/ui/main.tsx:262–292` ("Tell your computer
what to do", the ⌥Space demo, the sample command). Add one button below it.

> **Set up Butler** — About two minutes. You can stop after any step.
>
> _or_ **Try the safe tutorial first** — Simulated workspace. No permissions, no
> model, no microphone.

### Step 2 — Permissions

> ## Four permissions
>
> Butler needs these to see your screen and use the keyboard and mouse. macOS
> asks for each one; you grant it in System Settings. Nothing is captured until you
> start a task, and moving the mouse pauses it.

Four rows, each with a live state chip, a one-line reason and a button that opens
the exact pane.

> **Screen Recording** — So it can see the screen it is working on.
> `Not granted` → **Open Screen Recording**
> `Granted, restart needed` → macOS applies this only after a restart. → **Quit and reopen**
> `Granted` → ✓
>
> **Accessibility** — So it can click and type, and stop the moment you touch the mouse.
> `Not granted` → **Open Accessibility**
>
> **Microphone** — So it can hear you while you hold ⌥Space.
> `Not granted` → **Open Microphone**
>
> **Speech Recognition** — So it can turn what you said into text on this Mac.
> There is no cloud transcription.
> `Not granted` → **Open Speech Recognition**

Conditional lines:

> _(when `onDevice` is false)_ This Mac has no on-device speech model for
> **{locale}**. Butler will not transcribe. Typed commands still work: tap
> ⌥Space instead of holding it.
>
> _(when `supported` is false)_ Desktop control needs macOS 14 or later. The safe
> tutorial still runs.
>
> _(footer)_ Rechecked every couple of seconds and whenever this window comes
> forward. **Skip for now** — you can grant these later in Settings.

`screenNeedsRelaunch` is the detail worth getting right: macOS grants Screen
Recording but the running process keeps the old decision, so a checklist that says
"Allowed" is lying. Detect it as _granted in the OS preflight but capture still
failing_, and show the **Quit and reopen** button that calls
`app.relaunch(); app.quit()`.

### Step 3 — Model

> ## Choose a model
>
> Butler sends a screenshot of your screen and your task to one model you
> choose. It has no server of its own in between.

Two cards, the local one first.

> ### On this Mac — free, nothing leaves the Mac
>
> _(Ollama not reachable)_ Ollama is not running. Download it from **ollama.com**,
> open it once, then come back to this screen.
> _(reachable, model missing)_ Ollama is running at `127.0.0.1:11434`.
> `qwen3-vl:8b` is not installed yet. Run this in Terminal:
>
> ```
> ollama pull qwen3-vl:8b
> ```
>
> **Copy** — about 6 GB to download; it stays on this Mac.
> On a Mac with 16 GB of memory, `ollama pull qwen3-vl:2b` (about 2 GB) is faster
> and less accurate.
> _(installed)_ ✓ `qwen3-vl:8b` is installed. **Use it**
>
> ### Your own API key
>
> Requests go straight to the provider you choose. Choose OpenAI, Anthropic, Google,
> or an OpenAI-compatible endpoint. The model must accept images and function calls.
>
> [provider ▾] [model id] [API key] **Check key**
>
> _(ok)_ ✓ The key works. The prices below are used only for the local cost
> estimate — edit them if the provider changes them.
> _(401/403)_ The provider rejected this key.
> _(Gemini `API_KEY_SERVICE_BLOCKED`)_ This Google key is restricted. Allow
> `generativelanguage.googleapis.com` in the key's API restrictions, then check again.
> _(network)_ Could not reach {host}. Check your connection or proxy.

Implementation notes for this step:

- Detect Ollama by calling `GET {endpoint}/api/tags` through `desktopTransport()`
  with a 2 s timeout, **after** passing the candidate settings through
  `validateProviderEndpoint` (`src/core/privacy.ts:3`). Do not write a second,
  weaker network rule: `PRIVATE_LOCAL` permits literal loopback only, rejects
  credentials/query/fragment, and rejects cloud-looking model ids.
- Filter the returned tag list to models the loop can actually use; today
  `providerDefaults.ollama.model` is `qwen3-vl:2b` (`src/providers/catalog.ts:10`)
  while `defaultSettings.model` is `qwen3-vl:8b` (`src/core/schema.ts:218`) and the
  README says `8b`. Pick one before writing this copy — a first-run screen that
  names a different model from the default is the worst place for that
  inconsistency to surface.
- The download size is the one fact in this flow that goes stale. Keep it beside
  the model id in `src/providers/catalog.ts` so it changes when the default does,
  and after a successful pull confirm it from the local tag list rather than the
  hard-coded estimate.
- `checkProviderKey` should do one minimal request and map the failure through the
  existing `providerProblems` (`src/providers/http.ts:23`) and `networkFailure`
  (`src/providers/network.ts:53`) vocabularies. Never echo the response body.

### Step 4 — Spoken replies (optional)

> ## Spoken replies
>
> Butler answers out loud when you talk to it. The built-in Mac voice works
> now. A free natural voice runs entirely on this Mac after a one-time download.
>
> **Natural voice — 332 MB.** Apple Silicon only. No account, no network use after
> the download. **Download**
> _(downloading)_ 142 MB of 332 MB · **Cancel**
> _(done)_ ✓ Installed. **Hear it**
> _(`checksum_mismatch` / `size_mismatch`)_ The download did not match its
> checksum. Try again; nothing was installed.
> _(`disk_full`)_ Not enough free space for 332 MB.
> _(`supported: false`)_ This Mac keeps the built-in voice; the natural voice needs
> Apple Silicon.
>
> **Skip** — you can turn this on later in Settings → Voice replies.

332 MB is exact: the six pinned files in `KOKORO_FILES`
(`electron/kokoro/manifest.ts`) total 332,071,387 bytes. Progress comes from the
existing `subscribeKokoro` stream; no new plumbing.

### Step 5 — First task

Implemented with **Run it for me** calling `command()`, the same path a typed
command takes, so nothing is auto-approved and the run lands in history like any
other.

The proof step. Use a task that already has a deterministic grader in
`src/gym/bench/catalogue.ts` (`calculator-multiply`), so the same instruction is
exercised by `npm run bench`.

> ## Try it
>
> Hold **⌥ Space** and say:
>
> > Open Calculator and multiply 128 by 46
>
> Release when you finish talking. Watch the pill: **Listening → Working →
> Done**. Press **Escape** to stop at any time, or move the mouse to pause.
>
> **Run it for me** _(starts the same task typed, for anyone who would rather not
> talk yet)_
>
> _(after it settles)_ Done. That run is in your history — open it to see every
> step it took.
>
> _(if permissions are incomplete)_ Permissions are still missing, so this would
> not work yet. **Try the safe tutorial** instead — a simulated board, no
> permissions and no model.

### Step 6 — Done

> You are set up. Hold **⌥ Space** anywhere to talk, tap it to type.
> **⌃ ⌥ Escape** stops everything.
> Everything else — hands-free listening, text updates, what it learns — is in the
> menu bar.

## 7. The embedder API

### The smallest public surface

Five things, all of which exist:

1. **A controller** — `Controller` (`src/core/schema.ts:408`). Ready-made:
   `NativeController`, `TutorialController`.
2. **A provider** — `Provider` (`src/core/schema.ts:392`), one method. Ready-made:
   `HttpProvider` with an injected `fetch`.
3. **A recorder** — `Recorder` (`src/core/schema.ts:467`), four methods.
4. **A runner** — `new Runner(controller, provider, recorder, settings, emit, recentTasks?, memory?)`;
   then `start`, `stop`, `pause`, `resume`, `confirm`, `revise`, `amendTask`,
   `updateSettings`, plus `settled` and `snapshot`.
5. **Events** — the `emit: (s: Snapshot) => void` constructor argument. `Snapshot`
   carries `run` (status, actions, usage, summary), `frame`, `events`, `pending`
   (the approval question) and `message`.

### What is missing today

- **No entry point.** _Fixed by PR-1: `src/core/index.ts`._ An embedder imports `../src/core/runner`,
  `../electron/controller`, `../src/providers/http` — three deep paths, one of them
  through a directory named `electron` that contains no Electron.
- **`emit` is a constructor argument, not a subscription.** One consumer only; a
  second listener means wrapping the callback by hand.
- **`Recorder` has no null implementation.** _Fixed by PR-1: `nullRecorder()` in
  `src/core/recorder.ts`._ `scripts/live-task.mjs:77`,
  `scripts/bench.mjs` and `tests/core.test.ts:534` each write the same stub.
- **No `AsyncIterable` or typed event names.** `emit` fires on every state change
  with the whole snapshot; that is workable but undocumented.

Three small additions fix all of it: `src/core/index.ts`, `src/os/macos/index.ts`,
and `nullRecorder()` in `src/core/recorder.ts`. PR-1 added the first and the third;
`src/os/macos/index.ts` waits for PR-3.

### A working example, today

This compiles against the real exports. Verified with TypeScript 7.0.2 and the
repository's own `tsconfig.json` compiler options (`strict`, `moduleResolution:
"Bundler"`, `allowImportingTsExtensions`), `tsc --noEmit` exit 0. Run it with
`node --import tsx`, after `npm run build:native`.

```ts
import { randomUUID } from "node:crypto";
import { NativeController } from "./electron/controller";
import { Runner, terminal } from "./src/core/runner";
import { selectProvider } from "./src/providers/catalog";
import { HttpProvider } from "./src/providers/http";
import {
  defaultSettings,
  settingsSchema,
  type JournalEvent,
  type Recorder,
  type Snapshot,
} from "./src/core/schema";

const settings = settingsSchema.parse(
  selectProvider(defaultSettings, "openai"),
);
const provider = new HttpProvider(
  settings,
  process.env.OPENAI_API_KEY ?? "",
  fetch,
);
let runner: Runner;
const controller = new NativeController("native/bin/coarena-controller", () =>
  runner.stop("Emergency stop."),
);
const recorder: Recorder = {
  begin: () => {},
  save: () => {},
  frame: () => {},
  append: (run_id, type, data = {}): JournalEvent => ({
    event_id: randomUUID(),
    run_id,
    sequence_number: 0,
    monotonic_timestamp: performance.now(),
    wall_clock_timestamp: new Date().toISOString(),
    schema_version: 1,
    type,
    data,
  }),
};
runner = new Runner(controller, provider, recorder, settings, (s: Snapshot) => {
  console.log(s.run?.status, s.message, s.pending?.reason ?? "");
  if (s.pending) runner.confirm(false); // decline every approval
  if (s.run && terminal(s.run.status)) controller.close();
});
await controller.configure(settings);
await runner.start("Open Calculator and multiply 128 by 46");
```

Twenty-two lines, and eleven of them are the `Recorder` stub that every consumer
writes. This drives the real desktop and costs real money; it is the same wiring
`scripts/live-task.mjs` uses.

### The same example after PR-1 and PR-3

```ts
import {
  Runner,
  nullRecorder,
  defaultSettings,
  settingsSchema,
  terminal,
  type Snapshot,
} from "@butler-agent/core"; // or "./src/core"
import { HttpProvider, selectProvider } from "@butler-agent/core/providers";
import { NativeController } from "@butler-agent/macos"; // or "./src/os/macos"

const settings = settingsSchema.parse(
  selectProvider(defaultSettings, "openai"),
);
const provider = new HttpProvider(
  settings,
  process.env.OPENAI_API_KEY ?? "",
  fetch,
);
let runner: Runner;
const controller = new NativeController("native/bin/coarena-controller", () =>
  runner.stop("Emergency stop."),
);
runner = new Runner(
  controller,
  provider,
  nullRecorder(),
  settings,
  (s: Snapshot) => {
    console.log(s.run?.status, s.message);
    if (s.pending) runner.confirm(false);
    if (s.run && terminal(s.run.status)) controller.close();
  },
);
await controller.configure(settings);
await runner.start("Open Calculator and multiply 128 by 46");
```

Thirteen lines. Nothing new is invented: `nullRecorder()` is the stub above, and the
two barrels are re-exports. Note what an embedder still cannot do without the
`Session` façade (§3.6): route voice, drive the pill, or accept texted commands.
Those are product surfaces, and keeping them out of the embedder API is correct.

## 8. Ranked plan

Ranked by value per unit of risk. Effort is one engineer, including tests and
review, on a repository they already know.

| #   | Change                                                                           | Effort        | Risk                                                                                      | What it buys                                                                                                      |
| --- | -------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | **Acyclic core + entry points + `nullRecorder`** (§3.1, §3.3) — **done**         | 1 d           | very low — imports only                                                                   | Removes the one structural defect; makes every later step legal; halves the embedder example                      |
| 2   | **First-run setup view** (§6)                                                    | 3 d           | low–medium — new view, 5 IPC methods, e2e copy                                            | The user-visible half of the request                                                                              |
| 3   | **Move the ten non-Electron files out of `electron/`** (§3.2, §3.4)              | 2 d           | low, large diff                                                                           | `electron/` becomes only Electron; harnesses stop importing through it; a second OS adapter has somewhere to live |
| 4   | **`tests/boundaries.test.ts`** import-direction guard — **done** (landed with 1) | 0.5 d         | none                                                                                      | Keeps 1 and 3 from decaying; cheapest possible substitute for a workspace                                         |
| 5   | **`Session` façade** (§3.6), `electron/main.ts` → ~800 lines                     | 4 d           | medium–high — voice hold/resume, auto-resume and the messages channel share mutable state | The change that actually makes `main.ts` reviewable                                                               |
| 6   | **Split `dispatch()` into typed handler modules**                                | 2 d           | medium — 34 cases, each with its own validation                                           | Adding an IPC method stops being a three-file edit                                                                |
| 7   | **Split `src/ui/main.tsx`** into settings / pill / review / setup                | 3 d           | medium — e2e asserts DOM and copy                                                         | Two people can work on the UI                                                                                     |
| 8   | **Split `runner.ts`** into runner / replay / progress                            | 3 d           | high — 48 replay tests, and it is being edited now                                        | Reviewability of the loop; do it _after_ the in-flight work lands                                                 |
| 9   | **Platform profile seam in `policy.ts`** (§2g)                                   | 5 d           | high — safety code, 29 bundle ids, 43 AX roles                                            | Prerequisite for any non-macOS backend. Do not start it before a second backend is actually being written         |
| 10  | **npm workspace packages**                                                       | 5 d + ongoing | medium, permanent tax                                                                     | Only when an external consumer exists (§5)                                                                        |

### The first change, specified

**PR-1 — "Acyclic core, public entry points, one recorder." Landed.** No behaviour
change; `git diff --stat` is almost entirely import lines. The specification below
is what was done, with one deviation noted in step 2. `src/memory/types.ts` keeps
only the storage shapes and imports `RunStatus` from `src/core/schema`; every
consumer of a contract type imports it from `src/core/memory` directly, the way
`MemoryContext` has always been imported from `src/core/schema` — no re-export
shim, for the same reason step 1 does not leave one.

**Files**

1. `git mv src/memory/labels.ts src/core/labels.ts` (70 lines, zero imports).
   Update the three importers: `src/core/runner.ts:34` (`"../memory/labels"` →
   `"./labels"`), `src/memory/learn.ts:7` and `src/memory/skills.ts:2`
   (`"./labels"` → `"../core/labels"`), plus the prose comment at
   `src/core/runner.ts:301`. The loop now has two independent consumers of these
   rules — skill replay and `Runner.reaim` (automatic re-aim after
   `STATE_CHANGED`) — which is exactly why they belong in `core`. Do **not** leave a re-export shim: two paths
   to the same symbols would make the
   "change matching rules only there" rule in `docs/DEVELOPMENT.md` ambiguous, and
   that rule is load-bearing (a label-matching mismatch silently stops learned
   skills from replaying).
2. New `src/core/memory.ts` — move the contract types out of `src/memory/types.ts`:
   `SystemIndex`, `PlanStep`, `ReplayPlan`, `Recall`, `TrajectoryStep`, `LearnInput`,
   `MemoryAccess`. Leave `Episode`, `Preference`, `Skill`, `SkillStep`, `AppUsage`,
   `MemoryData` in `src/memory/types.ts`. Update importers: `src/core/runner.ts:23`,
   `src/ui/api.ts`, `electron/main.ts`, `src/memory/{access,learn,skills,store,retrieve,intents}.ts`,
   and `tests/{memory,runner-memory,runner-amend,native-process,desktop-provider}.test.ts`.
3. `git mv src/memory/playbooks.ts src/providers/playbooks.ts`. Update
   `src/providers/http.ts:10`, the comment at `src/providers/http.ts:226`,
   `tests/playbooks.test.ts:10`, `tests/providers.test.ts:22`, and the two doc
   references (`docs/MEMORY.md:58`, `docs/DEVELOPMENT.md:74`).
4. New `src/core/recorder.ts` exporting `nullRecorder(): Recorder` — the stub from
   `scripts/live-task.mjs:77–99`, verbatim. Replace the copies in
   `scripts/live-task.mjs`, `scripts/bench.mjs` and `tests/core.test.ts:534`.
5. New `src/core/index.ts` — re-exports only, no logic:
   `Runner`, `terminal`, `MANUAL_PAUSE_MESSAGE`, `TARGET_HANDOFF_MESSAGE`;
   `actionSchema`, `validateAction`, `settingsSchema`, `defaultSettings`,
   `supportedKeys`, `normalizePixelCoordinates`, `sameGeometry`, `mapPoint`;
   `evaluate`, `surfacePolicy`, `isInstallerName`, `INSTALLER_PATTERN`;
   `scanText`, `sanitizeText`, `redactSecrets`; `validateProviderEndpoint`;
   `shouldAutoResume`; `TutorialController`, `TutorialProvider`; `nullRecorder`;
   `normalizeLabel`, `normalizeRole`, `labelMatches`, `utf16Prefix`,
   `CONTROL_LABEL_LIMIT`, `REPLAYABLE_ROLES`; every error class from
   `src/core/errors.ts`; and the types `Action`, `Settings`, `Controller`,
   `Provider`, `Recorder`, `Snapshot`, `Run`, `JournalEvent`, `Frame`, `Surface`,
   `Geometry`, `ScreenContext`, `Observation`, `Usage`, `ProviderResult`,
   `ExecutionResult`, `RunStatus`, `PrivacyMode`, `ProviderKind`, `MemoryContext`,
   `MemoryAccess`, `Recall`, `ReplayPlan`, `PlanStep`, `TrajectoryStep`,
   `LearnInput`, `SystemIndex`, and `NativeActionCode` (needed to read
   `NativeActionError.code`).

**Tests**

- New `tests/boundaries.test.ts` (~40 lines): walk `src/` with `node:fs`, collect
  every `from "…"` specifier, assert (i) no file under `src/core` imports from
  `src/memory`, `src/providers`, `src/voice`, `src/storage`, `src/ui`, `src/gym`,
  `src/contribution` or `electron`; (ii) no file under `src/` imports `"electron"`;
  (iii) no file under `src/providers` imports from `src/memory`. This test is the
  deliverable that keeps PR-1 from being undone.
- Every existing suite passes unchanged apart from import paths. Pay attention to
  `tests/playbooks.test.ts` (12 tests) and `tests/providers.test.ts` (40), which
  assert the exact serialized `context.playbook` content.

**Acceptance**

```
npx tsc --noEmit          # exit 0 today; must stay 0
npm test                  # 25 files
npm run test:desktop      # real Electron + Keychain + ingest, synthetic data only
npm run build             # tsc + vite + esbuild
```

**Coordination.** `src/core/runner.ts` is being edited by another agent right now.
PR-1 needs exactly two lines of it (23 and 34). Land their change first, or hand
them the two-line edit; do not rebase a file-move over an in-flight rewrite of the
same file.

## 9. What must not break

Checked against the current tree; each item names the thing that would catch a
regression.

- **`npx tsc --noEmit`** — exit 0 at the time of writing. It covers `src`,
  `electron`, `services`, `tests` and the two config files.
- **`npm test`** — 25 vitest files, 19,771 lines. The suites most sensitive to the
  moves above: `tests/memory.test.ts` (59 tests), `tests/runner-memory.test.ts`
  (48), `tests/providers.test.ts` (40), `tests/policy-routine.test.ts` (39).
- **`npm run test:desktop`** (`scripts/desktop-smoke.mjs`) — launches real Electron
  with isolated storage and a local ingest server. It asserts the `info` payload
  field by field: `settings.memory === true`, `settings.model === "gpt-5.4-mini"`
  after import, `credentialScopes.length === 3`, `handsFree === false`, that no API
  key appears anywhere in the IPC JSON, and — importantly — the **exact key set** of
  `info.voice.kokoro`. Add new first-run state as a separate method, not as fields
  on that object.
- **`npm run test:e2e`** (`tests/e2e/app.spec.ts`) — asserts the landing heading
  _"Press a key. Tell your computer what to do."_, `nav` count 0, that the
  Space Grotesk font loaded, the tutorial pill text ("Working", then "Done."), the
  review/cancel/delete flow, and that **no request leaves `127.0.0.1:5173`**. A
  setup view that becomes the default first screen breaks the first assertion, and
  a live Ollama probe from the _preview_ build would break the last one — the
  browser preview must keep returning `desktop: false` and must not detect anything.
- **Native safety checks** — `npm run test:native-safety` and
  `npm run test:native-input` (Swift: `FrameSafetyTests`, `LaunchSafetyTests`,
  `FileSafetyTests`, `WakePolicyTests`, `TurnPolicyTests`, `MessageSafetyTests`,
  `InputIdleTests`, `RegressionWindow`). Untouched by any TypeScript move, but the
  **mirrored rules** must stay mirrored: `INSTALLER_PATTERN` and the protected floor
  in `src/core/policy.ts` mirror `native/macos/LaunchSafety.swift`;
  `CONTROL_LABEL_LIMIT = 80` mirrors the native grounded-control cut; index and
  `open_file` exclusions live once in `FileSafety.swift`. A module move must not
  duplicate any of these.
- **Packaging** — `npm run package:mac` / `package:mac:release`. `package.json`
  `build.files` names `dist-electron/main.cjs`, `dist-electron/preload.cjs` and
  `dist-electron/kokoro/worker.cjs` explicitly, and `extraResources` names
  `native/bin/coarena-{controller,voice,messages}`. `scripts/build-electron.mjs`
  bundles exactly those three entry points with `electron` and `onnxruntime-node`
  external. Moves **inside** `src/` are invisible to all of this; moving an **entry
  point** out of `electron/` (PR-3) requires editing `scripts/build-electron.mjs`
  and `scripts/dev.mjs` together.
- **Prompt-cache stability** — the system instruction built in `buildRequest`
  (`src/providers/http.ts:215`) is the cached prefix. Per-app playbook lines go in
  the per-request JSON as `context.playbook`, never in the instruction; Anthropic
  requests mark the tools and system prefix `cache_control: ephemeral` and bill
  writes at 1.25× / reads at 0.1×. Moving `playbooks.ts` must not reorder or
  reformat anything serialized. Add a test that snapshots the system instruction
  string so a future move proves it byte for byte.
- **Encrypted store format** — four on-disk shapes, none of which any step here
  touches, and all of which a package split could break silently:
  `vault-key` (master key wrapped by Electron `safeStorage`), `config.enc`
  (AAD `"config"`, holding `{settings, credentials, uploads}`), `memory.enc`
  (AAD `"memory"`), and the per-run journal (per-event GCM with run id, sequence
  number and previous ciphertext hash as associated data; content-addressed frame
  ciphertext). The AAD strings, file names and the field names of `Run`,
  `JournalEvent` and `Frame` are a storage format, not an implementation detail —
  `Vault.events()` parses what a previous version wrote.
- **`Settings` compatibility** — `settingsSchema` is `.strict()` and
  `electron/main.ts` parses a stored `config.enc` through it at startup. Adding a
  field needs a `.default()`; removing or renaming one bricks existing installs.

## 10. Risks

- **The in-flight edits.** `src/core/runner.ts` and the Swift helpers are being
  changed while this is written. Every line number here should be re-checked; the
  PR-1 scope deliberately needs only two lines of `runner.ts` for that reason.
- **Shims are worse than moves.** Leaving `src/memory/labels.ts` as a re-export
  gives two import paths for the label rules and quietly weakens the
  single-source-of-truth rule that keeps learning and replay agreeing. Move, update
  importers, delete.
- **Version skew is a cost bug.** If `providers` ever ships separately from `core`,
  a mismatch can change the cached system instruction and start billing full-price
  input tokens on every step. Pin exactly, or do not split.
- **Deep-link URLs are undocumented.** The `x-apple.systempreferences:` pane
  identifiers in §6 are not API. Every button must degrade to the Privacy & Security
  root plus the written path, and the copy must still make sense when the deep link
  does nothing.
- **A permission checklist that lies is worse than none.** Screen Recording is
  granted in the OS before the running process can use it. If
  `screenNeedsRelaunch` is not implemented, the checklist will show four green ticks
  on a build that cannot capture the screen, and the first task will fail with no
  explanation.
- **The Ollama probe is a second network policy.** Route it through
  `validateProviderEndpoint`, not a raw `fetch`, or `PRIVATE_LOCAL` now has two
  definitions of "local".
- **The model-id inconsistency is user-facing.** `defaultSettings.model` is
  `qwen3-vl:8b`, `providerDefaults.ollama.model` is `qwen3-vl:2b`, the README says
  `8b`. Resolve it before the first-run copy is written, not after.
- **`Session` will be harder than it looks.** Voice hold, auto-resume after manual
  input, the messages channel and the pill all read `electron/main.ts` module state
  in the same tick. Extracting it is a behaviour-preserving refactor with no
  end-to-end test that covers the interleavings; budget the 4 days as 4 days of
  reading, not typing.
- **Splitting `policy.ts` is safety work.** 29 bundle identifiers and 43 AX roles
  are not configuration; they are the difference between a routine click and an
  approval. Do not generalise them for a hypothetical second OS.
