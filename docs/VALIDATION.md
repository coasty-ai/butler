# Validation record

Validated September 16, 2026 on an Apple Silicon Mac. This is a development alpha with implemented native paths; automated synthetic success is not a claim of live agent reliability.

The table and follow-ups below the next section are the earlier September 16 baseline; their test counts are superseded by the current change set.

## Current change set: automatic re-aim after a screen change (September 17, 2026)

Scope: one automatic re-aim for a model-proposed pointer action whose input was refused with `STATE_CHANGED`, in `src/core/runner.ts` only (no native, policy or provider change); the `ActionReaimed` journal event and its `ACTION_REAIMED` classification in `src/gym/bench/analyze.ts`. The rule and its limits are in [DEVELOPMENT.md](DEVELOPMENT.md) ("Automatic re-aim").

Measured before the change with `node scripts/analyze-runs.mjs` over this Mac's own diagnostics (38 runs, 18,497 events; window 2026-09-16T08:39:49Z .. 2026-09-17T19:10:49Z):

| Measurement | Value |
|---|---|
| Runs with a screen-change rejection | 16 of 38 |
| Screen-change rejections | 115 (57 `SCREEN_CHANGED` seen by the runner, 58 `SCREEN_CHANGED_NATIVE`) |
| Applications | Chrome 29/30, Spotlight 9, VS Code 6, Spotify 6 |
| Proposed action behind the 57 runner-side rejections | click 29, hotkey 16, key 10, type_text 2 |
| Median model call / capture / execute | 2052 ms / 504 ms / 492 ms (about 3.0 s from screenshot to input) |

The 29 rejected clicks are the ones this change can recover without a model call; keyboard rejections are deliberately out of scope, and a click with no identified control or with several matching ones still costs a model call. The saving per recovered step is one model call plus the capture that follows it (about 2.5 s of the roughly 3 s round trip). How often a fresh frame really yields exactly one matching control on a live animating page is not established by this record: `ACTION_REAIMED` exists so the next analyzer run over live diagnostics can measure it.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Pass |
| `npx vitest run` | 26 files, 1,134 passed, 1 skipped (13 new re-aim cases in `tests/runner-resilience.test.ts`) |
| `npm run build:native` | Pass |
| `npm run test:native-safety` | 1,093 PASS, 0 FAIL (no native code was touched) |
| `npx prettier` on the changed TypeScript | Pass |

New regression cases: a rejected click re-aimed at the moved control with no new model call and one counted action; fallback to the model when the control is gone, when two controls match, when the only match is disabled, when the fresh frame is another application, when the target was never identified and when the re-aim capture fails; `drag` and `type_text` never re-aimed; a replayed plan step never re-aimed (it still abandons the plan); at most one re-aim per proposed action; an approved (`CONFIRM`) step asked for approval again instead of reusing consent; and a re-aim dropped when the user pauses while it captures.

## Current change set: memory, spoken replies and forgiving turn-taking (September 17, 2026)

Scope: local memory, system index, learned skills and `open_file` ([MEMORY.md](MEMORY.md)); spoken replies with the Mac voice, the free on-device Kokoro voice and the opt-in OpenAI voice; patience-based endpoints, segment accumulation, follow-up windows, fragment clarification and continuation amendment ([VOICE_PRODUCT.md](VOICE_PRODUCT.md)). Two independent reviews (memory: 25 confirmed findings; voice: 14 confirmed findings) were fixed and re-verified with tests that fail when each fix is reverted.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Pass |
| `npx vitest run` | 21 files, 1008 passed, 1 skipped (real Kokoro data test runs only with `KOKORO_DATA_DIR`) |
| `npm run test:native-safety` | 947 PASS, 0 FAIL |
| `npm run build` | Pass |
| `npm run test:e2e` | 3 passed |
| `npm run test:desktop` | Passed, 21 checks (one earlier run timed out waiting for Settings under heavy CPU load from a parallel benchmark; it passed on retry) |
| `npm run package:mac` (unsigned) | Pass; 347 MB app, ONNX Runtime darwin-arm64 binaries unpacked from asar |
| Native index on this Mac | 58 apps, 8 folders, 20 recent files; 0.2–0.5 s warm after token and cache fixes |
| Live built-in intent (“Open Calculator”) | Opened Calculator with no model call; both live runs then paused for a real hardware mouse movement (takeover worked as designed) |
| Kokoro (onnxruntime-node, fp32, M2) | 332 MB verified download in 16 s; about 1.3 s cold to first audio; about 0.5 s per short sentence warm; about 700 MB worker memory; 0 word errors in a Whisper round trip during the spike |

Not measured yet (need the microphone, speakers and a person): spoken-reply start latency on device, false activations in follow-up windows, echo with Bluetooth output, cut-off rate for disfluent speech at each patience level, and push-to-talk success for very short answers.

## Current change set: open_app, grounded controls and recoverable run loop (September 16, 2026)

Scope: launch-only `open_app` with native resolution and denial (`LaunchSafety.swift`); grounded `context.controls` including browser web-area controls; Safari page-host detection for protected domains; tolerant single-object extraction from model text; Calculator, search-result-page and heading policy; Dock clicks redirected to `open_app`; executed-target step history, loop and app-switch detection, refusal/outage/native-error recovery, active-time budget and live settings updates; helper auto-restart and parent-death exit; voice stop/pause from final transcripts only; the opt-in live harness.

| Check | Result | Notes |
|---|---|---|
| `npm test` | 492 tests passed (11 files) | Final diff, including the post-review fixes below |
| Native Swift checks | 190 passed | Frame, wake-policy and launch-safety checks; final diff |
| `npm run test:e2e` | 3 passed | Final diff |
| `npm run test:desktop` | 18 checks passed | Final diff (development Electron with isolated storage) |
| `npm run test:native-input` | 24 checks passed before the review-fix round; not re-run on the final diff | Later runs failed only at the Spotlight step: with the unbundled fixture frontmost, macOS did not open Spotlight for a synthetic Command-Space at all (the same helper opened it from VS Code in 0.4–1 s, and the pre-change packaged helper could not reach the step because a 0.46 px pointer echo triggered the old false takeover). The step now records an explicit skip after one bounded retry. The final run was not executed because the user may have been using the Mac |
| `npm run build`, `npm run build:native`, TypeScript, Prettier | Passed | Final diff |

Live desktop runs used `npm run test:live` from a terminal on this Mac (source native helper, not the packaged app), GPT-5.4 mini unless noted. Reports: `output/qa/live-task-*.json`.

| Task | Result | Detail |
|---|---|---|
| Calculator: 128 × 46 (four earlier runs) | Failed | Three runs hit their action budgets (25, 16 and 16 actions; $0.121, $0.090, $0.059), with repeated retargets or loop warnings. One run reported completion in 13 actions/45 s/$0.047 but stated 51888, a **wrong result**. The models treated their own entered digit as leftover state and cleared it |
| Calculator: 128 × 46, `claude-sonnet-5` | Failed | Same clearing behaviour; action budget at 16 actions, $0.184 |
| Calculator: 128 × 46, after executed-target step memory | Completed | Correct 5888 in 5 actions, 22 s, $0.020; one transient provider outage recovered without a pause |
| Safari web search for San Francisco weather | Completed | 3 actions, 32 s, $0.013, no approvals |
| Safari + Calculator: San Francisco temperature °F → °C (earlier attempts) | Failed | One run hit its 25-action budget ($0.143) after three declined approvals (the results-page unit toggle needed approval) and loop warnings; another stopped at takeover after five unidentified targets ($0.040). Also observed: a Dock mis-click launched Freeform, heading clicks returned `RETRY`, and web controls were not grounded |
| Safari + Calculator: °F → °C (after fixes) | Completed | 63 °F = 17.2 °C, correct; 19 actions, 102 s, $0.10, no pauses. Fixes: search-result-host buttons, `AXHeading` content clicks, Dock → `open_app`, web-area control grounding and the app-switch warning |

Post-review fixes to the last changes (a final safety review of grounding, search-result and Calculator policy): search-result-host buttons are routine only when the target is inside the browser's page with the same host (browser chrome, other apps' panels and embedded account/consent frames on other hosts need approval); Calculator keypad rules apply only to named keypad keys with no sheet or dialog open; the Safari page-host search skips hostless web areas and browser chrome; over-long titles and labels are truncated instead of dropping the whole context; executed-step history never names an editable field by its value; embedded JSON is accepted only when fenced or bare, never from surrounding prose or next to a truncated second object.

Open limitations:

- Mini-model planning is still the main limit on multi-app tasks: successful runs needed several recoveries and failed attempts outnumbered successes.
- Spotlight on this Mac intermittently ignores the first synthetic Command-Space; the native smoke retries once.
- The packaged app in `release/mac-arm64` was **not rebuilt** for this change set; the installed instance runs the earlier build.
- Live voice/microphone paths (push-to-talk, wake phrase, spoken stop/pause/approval, voice hold) were not exercised.
- Gemini remains untested for these tasks.
- Grounded controls and search-result-host rules were validated only on the tasks above, not on arbitrary sites or apps. The post-review fixes were verified by unit tests; the live tasks ran before them.
- Capture takes about 850 ms on a busy web page with grounding (about 500 ms before), from stable sampling plus the time-capped web walk.
- The built-in search-result-host rule still trusts localized, non-consequential-looking buttons inside those result pages (for example a consent button).

## Earlier baseline

| Check | Result | What it establishes |
|---|---|---|
| `npm test` | 142 tests passed across nine files | Schema bounds, private routing, policy, budgets/cancellation, correction invalidation, manual takeover, scoped approval, context sanitization, provider fixtures, encrypted storage, safe env import, endpoint-bound credentials, changed-screen recovery, approval revalidation, consent/upload/withdrawal and seeded task grading; plus transient connection recovery, bounded retries, secret redaction, permanent errors, cancellation during retry delay, partial-body failure and a shared request deadline. Diagnostic checks verify key/content exclusion, rotation/permissions, event deduplication, UUID preservation and non-interference; desktop transport checks cover TLS-record fallback, proxy preservation and certificate failure |
| `npm run build:native` | Passed | Both Swift helpers compile against AppKit/ScreenCaptureKit/Speech/AVFoundation on this Mac |
| `npm run build` | Passed | TypeScript checks and production renderer/main/preload bundles |
| `npm run test:e2e` | Three tests passed | Minimal preview, tutorial pill, pause/correction/stop, consent/exclusions/cancel/delete, settings, bundled Space Grotesk and responsive layout |
| Desktop integration | Passed | Real Electron shell and OS secure storage, synthetic run, real loopback contribution HTTP, exact-approved export, prohibited pill IPC, restart recovery, withdrawal and deletion |
| Packaged desktop integration | Passed | The packaged `.app` launches/restarts and passes the same checks, plus same-run correction/completion, native text-pill expansion, encrypted three-provider env import, key retention across provider switching, no key reuse for custom endpoints, and no credential values in renderer info |
| Packaged diagnostic stream | Passed | Real tutorial action/completion events reach the rotating JSONL log; saved fixture API keys and task text are absent. Native requests, voice status and permission checks are observable without capturing additional data |
| Live OpenAI API fixture | Passed | `gpt-5.4-mini` completed a generated project-name form and verified the resulting screen in five calls; 16.503 s total, 8,717 input / 365 output tokens, estimated $0.00818. Uses our actual adapter and action schema; only isolated browser input, no OS input or personal screenshots |
| Packaged provider transport | Connection passed; task fixture failed | Production provider factory loaded in the packaged Electron main runtime received six valid OpenAI responses, including after a 15-second idle gap; each response took 0.9–2.51 s. The model repeatedly clicked and did not finish the generated form within six calls. Estimated $0.00816. Evidence: `output/qa/provider-smoke-desktop-openai.json`; this establishes connectivity, not task success |
| Local configured package | Passed | Real `.env` keys imported into the user's encrypted store; OpenAI selected. No key values found in renderer info, ciphertext config, or packaged app contents. `.env` remains Git-ignored and mode 0600 |
| Native pixel/input/wake policy | 56 checks passed | Caret/clock/rendering variation and verified control animation are tolerated; changed targets/layout/geometry are rejected. Wake checks cover anchored phrase matching, ignored ambient approvals/commands, silence endpointing, empty-command expiry, hard duration limits and standby recycling |
| Native input | Seventeen checks passed | Real clicks and typing succeed in a temporary AppKit window with clock/caret animation. Stationary pointer notifications are ignored while actual cursor movement stops input. Command-A and Command-Shift-K reach the fixture; Spotlight opens without false takeover, owns the observed input context, and Escape dismisses it. Changed focus, moved/relabelled buttons, edited long field values and a second window reject stale input. No API calls or saved screenshots; evidence: `output/qa/native-input-smoke.json` |
| Mac arm64 directory package | Produced | `release/mac-arm64/Open Assist.app`, about 316 MB, with both native helpers, local font and custom icon; no Developer ID identity used and no notarization/publication |
| Dependency audit | Zero reported vulnerabilities | At validation time; not a security certification |

Browser testing used the installed Chromium executable through `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Packaging and desktop testing used Node 24 from the temporary toolchain because the default Node 20 is below the project's supported version. The expected “Invalid IPC sender” log comes from a negative test proving the pill cannot read history.

Current screenshots are in `output/qa/`: `voice-first-desktop.png`, `working-pill.png`, `voice-first-mobile.png`, `voice-settings.png`, `voice-contribution-review.png`, `electron-settings.png` and `electron-command-pill.png`. The mobile screenshot is a responsive browser preview, not a mobile app.

The final package declares macOS 14.0 as its minimum version and uses the generated monochrome `icon.icns`. The latest packaged smoke run's isolated evidence directory was `/var/folders/_n/bvkg4q2s7918hlhyzwx_xg9c0000gn/T/open-assist-desktop-9I0Hmd`.

Desktop integration uses isolated temporary storage, a fresh OS-wrapped encryption key and a local ingest service. It does not use existing personal run history, record microphone audio, call a paid provider, or execute input in other applications.

The separate opt-in provider smoke check calls the live API with generated images only. Its script is `scripts/provider-smoke.mjs`; the OpenAI result is `output/qa/provider-smoke-openai.json`. Anthropic authentication succeeded, but Haiku 4.5 failed to finish within six calls and one Sonnet 5 response mistyped the current frame ID, which the validator rejected. These are failed checks, not validated alternatives. Gemini authentication/model listing returned HTTP 403 `API_KEY_SERVICE_BLOCKED` for the Generative Language API; no Gemini inference success is claimed.

The reported generic provider failure occurred 120 ms after `ModelRequestStarted`, not at the 60-second deadline. The old build discarded the underlying cause, so that exact connection failure could not be identified or reproduced. Read-only checks from the packaged app verified the saved OpenAI endpoint/model/key (HTTP 200); both Node and Chromium also completed generated-image inference. The updated app uses an isolated Chromium network session and bounded retries for recognized transient connection failures, with safe, specific diagnostics and immediate cancellation. Its first packaged task fixture returned invalid coordinates, correctly rejected; the subsequent six-call run had healthy requests but repeated model clicks. Both failures remain recorded. Arbitrary-app reliability is not established.

During the live LaunchServices debug session, the package reported Screen Recording, Accessibility, Microphone and Speech Recognition allowed, and on-device speech and the shortcut available. A spoken command produced a final transcript. Direct executable launch from VS Code had incorrectly attributed Speech Recognition to VS Code and crashed the helper; the debug launcher now uses LaunchServices and a separate log tail. Native click/type behavior is now tested in a disposable AppKit fixture; arbitrary-app task success is still unverified.

## Remaining live checks

- Grant microphone/speech and screen/input permissions to the intended app/helpers; verify denial, revocation and restart behavior. Permission attribution and entitlements need validation in the final signed layout.
- Test actual desktop tasks with the configured model in the packaged app. The live harness results above cover a few Calculator/Safari tasks; arbitrary-app success has not been established.
- Measure local speech finalization, accent/noise behavior, confidence-gated approval and all interruption boundaries, including Escape, held modifiers, manual cursor movement and mid-drag release.
- Measure key-down→pill, key-down→audio-ready, release→first useful action and interrupt→last input. The <100 ms feedback target has not been benchmarked.
- Test Retina/external monitors, moving windows, stale-screen checks, protected surfaces, accessibility coverage and false approvals. Labelled controls outside the benign allow-list currently require approval; unidentified targets retry without input.
- Context is collected with the first observation after release. Invocation-time prefetch, a comprehensive recent-files index and optional spoken TTS are not implemented. Recent documents are bounded references observed during runs, not a filesystem scan.
- Sign/notarize the release, verify helper entitlements, add signed updates and perform security/privacy review before public distribution. Contribution hosting remains a local reference implementation.

Live diagnostics identified `ERR_SSL_BAD_RECORD_MAC_ALERT` in an actual user run and reproduced it with generated images. The final production transport recovered a 3,900,985-byte synthetic PNG request on attempt two after that exact error (HTTP 200, 7.115 s total), then completed a 629,445-byte JPEG request on attempt one (1.343 s). These are connection checks only. Earlier retries sometimes also failed; sustained network reliability is not guaranteed. The original screenshot-size hypothesis alone did not explain the failures. Certificate validation remains enabled; configured system proxies are not bypassed.

Live approval debugging found successful native revalidation followed by a runner `STATE_CHANGED` rejection: Swift had serialized identical geometry in a different property order. The runner now compares keys/values; regression checks cover reordered approvals and changed/missing/additional geometry fields.

Hands-free update: 104 Vitest tests, 31 Swift policy/input checks, three browser flows and the packaged desktop integration passed. The packaged helper reports `handsFree: false` and `wakeListening: false` before explicit opt-in; the UI exposes the new mode and its persistent-microphone disclosure. `output/qa/hands-free-settings.png` was visually inspected. No automated check records microphone audio. Live wake recognition, quiet/loud-room endpointing, repeated interruption/approval, sleep/revocation recovery and battery consumption remain unverified.

Menu discoverability fix: the menu-bar item now has an “Assist” label, and reopening the app with no visible windows reveals Settings. The packaged integration passed checks that reopening reveals Settings while activating a visible pill does not reveal Settings. Tray geometry and Settings-open events are included in local diagnostics.

Explicit hands-free launch: the real user app emitted `wake_status` with `enabled: true` and `listening: true`, then detected multiple wake phrases. Initial trials timed out without command text or failed at final recognition. The native parser now retains command-only speech segments after activation, with three additional policy checks (34 total), and records segment-source/length metadata for diagnosis. End-to-end spoken task completion after this correction remains pending.

Routine navigation update: 124 Vitest tests and the production build passed. Added cases cover exact OS shortcuts, unknown/secure surfaces, shortcut modifiers/order, Spotlight Enter versus message-field Enter, browser-only address focus, text-only selection/deletion, and consequential buttons. These checks validate the policy, not arbitrary-app task success.

Live desktop replay after the September 16 fixes: **Open Notes completed** through the packaged app’s normal command path using GPT-5.4 mini. Spotlight opened, received the app name, and launched Notes with three executed actions and no approval prompts. Native context and a separate read-only foreground check both identified `com.apple.Notes`. Nine observations, 20,803 input / 475 output tokens, estimated $0.01774. The first attempt correctly paused on real mouse movement; the resumed run finished in about 19 seconds. Search-result changes and two invalid pixel-coordinate model actions were rejected before recovery. Evidence: `output/qa/live-open-notes.json`. This verifies the finalized command-to-desktop path; it does not establish fresh speech-recognition accuracy or arbitrary-task reliability. The packaged controller hash matched the helper used by all thirteen native input checks.

Incident follow-up: a subsequent voice task to open Chrome and play a Weeknd song selected “Chrome Remote Desktop Host Uninstaller” above “Google Chrome,” then proposed a click at the Uninstall button. No matching click-execution event was recorded; the approval gate blocked it. This was a failed run, not a successful task. Added real Spotlight selected-cell metadata, exact query/selection gating, a native and runner stop on uninstaller applications, explicit rejection of Uninstall controls, and regression cases for mismatched/missing selections. Ordinary app-launch approvals now require a verified exact result.

The follow-up build passed 132 unit/integration tests, thirteen native fixture checks and packaged desktop integration including a real second-instance Stop. Evidence directory: `/var/folders/_n/bvkg4q2s7918hlhyzwx_xg9c0000gn/T/open-assist-desktop-m0NUpY`. A live “Open Chrome” command correctly recognized an already active Chrome window; a launch attempt from the temporary fixture requested approval and was interrupted by manual input before any action executed. It was cancelled and the fixture closed. No successful Chrome-launch or full YouTube playback claim is made for this follow-up. See `output/qa/spotlight-uninstaller-regression.json`.

Approval interruption diagnosis (`2594b4be-212d-4b80-9d0d-37d1546e38d3`): three confirmations were received but every approved action was rejected by the full-window pixel check. The recorded screen shows a playing Prime Video ad behind Chrome’s focused address bar. Scoped keyboard validation and verified address-bar navigation now cover this case; policy regression tests retain confirmation for message-field Enter, purchases and unknown controls.

The native animated-background regression now passes with real Command-A, Unicode typing and Escape while a large rectangle changes color continuously. Changed focus, field value and selection still reject typing. Seventeen checks passed in `output/qa/native-input-smoke.json`; pure native checks total 46.

Approval-frequency follow-up: the Notes task requested approval for an app-launch click, then an unidentified target in Notes and a later target in Code. Added verified Dock application metadata/launch policy, Notes draft creation and multiline editing, and bounded non-executing targeting recovery. All 139 unit/integration tests and seventeen native input checks passed. A read-only probe through the actual Swift helper classified the Notes Dock icon as ALLOW, Terminal as USER_TAKEOVER, and Trash as RETRY. (Superseded: Dock application clicks now return RETRY with a redirect to `open_app`.) Protected and consequential controls retain their gates. Full task replay results are recorded separately below when available.

The final provider request uses low reasoning for GPT-5.4 mini, with 141 tests passing. Its generated-browser API fixture completed in five calls (16.503 seconds overall; estimated $0.00818). Two preceding real Notes launch attempts with reasoning unset failed on repeated Spotlight name mismatch; neither prompted for approval, and neither completed the note. These are recorded as failures, not task successes.

Final live Notes check: run `9d15720f-89ac-4668-92a3-c39e5d124c39` completed in the rebuilt package using GPT-5.4 mini with low reasoning. It created **Open Assist test** with the supplied body using six executed actions, thirteen frames and **zero approval prompts**. An independent read-only macOS accessibility query confirmed Notes was foreground and the editor contained the expected title and body. The run first paused on physical mouse movement; after resuming, completion took about 62 seconds, including Spotlight name corrections and several rejected changing-screen actions. Estimated inference cost: $0.03569. This is a successful concrete task, not evidence that arbitrary-app reliability or latency is solved. Evidence: `output/qa/live-notes-no-approval.json`. The test note remains visible, and hands-free listening was confirmed enabled afterward.

Voice empty-final follow-up: two actual utterances on September 16 reached 46 and 48 characters after the command endpoint, then received an empty final result and incorrectly displayed “Didn’t catch that.” The callback now retains the latest nonempty hypothesis and emits a separate recovered-command event only for an empty final after release/the silence endpoint. Recovered speech has zero approval confidence, including if a malformed event claims otherwise. Ten added Swift regressions cover the observed sequence, shortened corrections, silence, premature finals and approval distinction; all 56 Swift checks and 142 TypeScript tests passed, as did native and production builds. No microphone recording or cloud STT was used by these checks. A fresh live microphone trial is still needed to validate the installed fix end to end. Evidence: `output/qa/voice-empty-final-regression.json`.

The packaged desktop integration also passed after the voice fix, including isolated storage, corrections, second-instance Stop and native voice status. Both packaged speech-helper bytes and main bundle were checked against the tested build. Desktop evidence directory: `/var/folders/_n/bvkg4q2s7918hlhyzwx_xg9c0000gn/T/open-assist-desktop-aem8Mm`.
