# Validation record

## CLI desktop-test preparation (October 3, 2026)

Preparing a desktop task trial reproduced two everyday CLI defects. Saved
connections marked ready on demand were omitted from the connected count, and
stacked polite prefixes such as “Can you please” bypassed local setup and
control routing. The count now includes dormant ready connections, the footer
offers conversational help, and local request normalization accepts repeated
polite prefixes. Compound requests and account approval boundaries retain
their existing checks.

Evaluation `ea23989b-8800-4b3c-981b-b8799095bafe` passed five checks through
three actual CLI processes, including an interactive pseudo-terminal, an
isolated encrypted profile and synthetic MCP servers. Polite Gmail setup
reused the saved fixture connection in 299 ms, and a polite briefing request
saved a two-hour interval in 157 ms. A fresh interactive process displayed
both saved connections and the new conversational footer; “Help” returned
ordinary examples. Settings and encrypted connection access survived restart.
No task runs or GUI actions were created, and no owner account was used.
The isolated profile and project were removed, leaving content-free metrics.

Type checking, touched-file formatting and 84 focused tests passed. These
checks validate CLI behavior, not desktop task completion. The session's
Computer Use controller was unavailable; using Butler's native controller for
the prepared disposable Mac form requires the pending method choice. That
form has not been launched or driven in this trial.

## Conversational setup and saved sessions (October 3, 2026)

The owner's encrypted profile already contained GitHub, Gmail and Slack bot
credentials and seven enabled, consented servers. The UI nevertheless always
greeted a new session with setup instructions, exposed command lists as its
default help and repeated credential questions when reconnecting. This check
read only presence flags and counts; it did not copy account data or secrets.

Plain requests now reuse the existing handlers for voice, listening, briefings,
task controls and model/key setup without a planning call. Typed Yes/No applies
only to a pending task confirmation; voice cannot approve it. Default help and
memory output use ordinary words. Startup loads the same encrypted profile
across sessions and folders and acknowledges saved access. Preferences, task
history and the bounded recent thread retain their existing persistence and
limits; this is not unlimited recall or full app surveillance.

“Connect my apps” selects the nine built-in app/agent integrations, skips healthy
command-pinned connections, reuses saved bot tokens and checks bounded Google
Desktop client downloads. Missing service credentials produce a normal CUA
setup task that stops at account decisions, sign-in, grants and credential
creation. Unfinished setup persists as an inactive, unconsented built-in row,
without selected tools or command approval. Its own paused browser handoff can
be settled for a new verification attempt; unrelated active tasks cannot be
replaced. Google refresh grants cannot migrate to a different client. New
account OAuth binds its callback before opening the browser, retains state/PKCE
checks, and displays a link if launching fails. Hidden prompts keep credential
values out of chat and model context.

Built CLI evaluation `9bbe3768-53cf-49e4-b951-6cfeb2970fde` passed six requests in
six fresh processes with an isolated encrypted profile and marked MCP fixture.
Saved connection reuse passed from the original and a different project folder
in 472 and 315 ms. Briefing scheduling, preference save/recall and disabling
briefings took 182, 207, 188 and 196 ms. The saved preference and recent thread
survived, the profile did not contain the fixture secret in plaintext, and zero
computer task runs were created. This tests the CLI and MCP connection reuse;
it does not authenticate a new real Google or Slack account. The isolated
profile and temporary project were removed; only content-free metrics remain.

Offline tests exercise callback rejection/exchange, safe page opening, client
ambiguity, credential encryption, restart reuse, pending setup handoffs,
uncertain voice, private-local mode and task approval boundaries. Live Google,
Slack and GitHub console preparation was not exercised on the owner's browser.
The workflow still depends on available desktop permissions and each service's
app registration and access requirements. No dependency or native-helper change
was added. The full local suite passed 5,046 tests with two legacy speech-data
skips across 151 files; type checking and touched-file formatting passed.

## CLI summaries, conversation and task control (October 3, 2026)

Inspection of owner runs `854d4494-3f6d-4bd4-8254-f860ec7e0e21`,
`9ff63e9e-138c-431b-ac73-1306ca536157` and
`92136e7d-07ef-47c0-b0f8-0c1878f4e759` found completed tool reads alongside a
later cancelled run with no executed action. Recent provider requests mostly
received HTTP 200. The CLI supplied empty progress and queue fields to the
dialogue model, omitted finished task results, retained only eight short
conversation entries in RAM, and ignored correction and queue plans. Voice
activation could pause a task without resuming it after a reply or an unheard
utterance. These findings do not establish the cause of every failed run.

The CLI now supplies the existing sanitized task view, applies corrections
and queued tasks, and releases temporary listening holds. Explicit pauses and
approval gates remain in force. With memory enabled, up to 24 conversation
entries persist encrypted for 24 hours; the request context budget remains
fixed. Saved tool results retain their untrusted designation. Reset and
provider/model/privacy changes prevent restoring a task from an old thread.
Summary prompts ask for ordinary words and useful decisions without incidental
IDs, jargon, headings or closing boilerplate; meaningful amounts, deadlines,
uncertainty and missing coverage must remain. Terminal wrapping keeps words
together.

Live synthetic evaluation `c29d43c0-d2c6-40d5-9488-1139aa6732f7` passed four
requests across four fresh CLI processes: create a text file, append to
“that file”, rename it, then recall the changes. Exact file contents and the
rename were checked independently, and an unrelated sentinel stayed intact.
The three file actions took 4,034, 3,880 and 3,732 ms; the recap took 1,481 ms.
The three task runs recorded three model requests, three actions and zero
frames. A synthetic email/Slack briefing used 72 words and passed checks for
the payment amount, scheduled rather than sent status, recruiting item,
missing Slack coverage and absence of the fixture invoice ID, acronym and
Markdown. These are concrete file and summary checks, not arbitrary-app
reliability claims. Metrics remain under the evaluation's local directory;
its isolated profile and fixture were removed.

The rebuilt bundle repeated all four checks successfully in evaluation
`26898855-412a-4d9b-9811-a71ce5e1bc7c`: 4,389, 4,139 and 3,850 ms for the file
actions, 1,532 ms for recall, and a 68-word briefing passing the same checks.
The full offline suite passed 5,022 tests with two legacy speech-data skips
across 150 files. Type checking, formatting and the prompt-size budget passed.
The live microphone recognition limitation below remains separate from these
offline checks.

Two preceding test setups failed: the files provider refused a hidden
configuration path (`TOOL_BAD_PATH`), then the non-interactive CLI declined a
write requiring confirmation (`UserDenied`). The successful test used a
visible isolated folder and an acknowledged autonomous mode only in its
private test profile. Owner settings were not changed.

On this Mac, the built-in microphone input gain measured about 30% and was
raised to 70%. Speaker output was unchanged. Independent recognition probes
timed out while the owner's live voice helper was running, so normal-volume
speech accuracy remains unverified. Experimental voice-processing changes
were discarded; the original native helper and its existing microphone/speech
grants were restored. New activated-turn diagnostics retain only input-level,
length and confidence measurements and fixed phases, without transcripts or
background audio.

## CLI provider failure explanations and connection check (October 2, 2026)

Owner run `7ffb19ee-38d8-4357-b627-af7660524cbc` captured four frames and
recorded four `ProviderUnavailable` events across the initial request and its
continuation. It remains paused with zero executed actions. The old CLI kept
only the retry count, so the original exception and exact cause are unknown.
A provider-only replay of its saved request subsequently returned HTTP 200
and an action proposal in 2,642 ms; the proposal was not executed. A generated
1440-by-919 PNG request of comparable size also returned HTTP 200 in 2,776 ms.
These results establish current request availability, not the cause of the
earlier outage or successful completion of the owner's desktop task.

Transient errors now carry a fixed category, HTTP status and requested wait
time. The runner displays a specific explanation and keeps both native input
and model requests paused when `continue` arrives before a provider cooldown
ends. Updated permanent credit, usage and spend-limit codes stop without
retries. CLI provider diagnostics retain only allow-listed codes, identifiers,
statuses and measurements; raw messages, prompts, images and credentials are
excluded. `/doctor model` and `butler doctor --model` test the configured
vision/tool transport with a generated image and a 20-second deadline.

The installed CLI's new model check reported `reachable: true`,
`usableReply: true` in 1,740 ms with the owner's saved configuration after the
final terminal installation. Its native
permission check reports Screen Recording, Accessibility, Microphone and
Speech Recognition granted and on-device recognition available. Live voice
recognition and desktop input were not exercised during this fix. No new UI
captures were made; the replay read a previously saved encrypted frame.

All 300 focused provider, runner-recovery, diagnostics, boundary and identity
tests passed. The full suite passed 4,873 tests with two skips across 143 files
using `--maxWorkers=2`. Type checking, formatting and terminal installation passed. No native Swift
source changed.

## Conversational CLI, voice and connection setup (October 2, 2026)

Owner runs `1b8668d2-0f05-45ac-9034-384fae6c1198` and
`b1186537-a7e2-419e-a638-1f3863fda09a` captured frames before failing with
`RUN_ERROR` and the fixed provider-connection message. Their original transport
exceptions were not retained, so the exact network cause is unknown. The Node
classifier now handles `AggregateError.errors` and a plain `TypeError: fetch
failed` within the existing bounded retries, without replaying actions or
changing TLS checks. CLI opening clauses can select an existing named window
before capture; protected targets still produce a takeover without capture.

The old `/usr/bin/say -v Arthur` path failed on this Mac because that command's
voice inventory lacked Arthur. The standalone native speech helper now resolves
installed voices and selects Daniel as its default British fallback. A live
spoken fixture and the installed `butler voice test` both reported actual
playback completion. Input has explicit `/listen on` setup, wake/follow-up and
optional push-to-talk events. This Mac reports on-device recognition available
but Microphone and Speech Recognition permission missing; live spoken-command
recognition remains unverified until the owner grants them.

The terminal provides streamed chat, compact animated status, transcript paging,
fresh conversations, typed task approvals, direct `/cua` and MCP-first tasks.
New OpenAI profiles use GPT-6.1 Sol Fast with low effort. The owner profile was
updated after stopping its verified idle old engine. A live text fixture
completed in 1,569 ms; a generated blank-image tool-call fixture completed in
1,988 ms and the API reported `service_tier: fast`. The installed CLI completed
a synthetic greeting with readable and spoken delivery. These fixtures measure
the tested requests, not general desktop-task latency.

Connection setup includes Slack bot reads, the existing Slack/Gmail OAuth flows,
Apple permissions, filesystem/browser recipes, generic stdio/Streamable HTTP
servers, masked headers/environment credentials, MCP JSON imports and discovery
with PKCE for remote OAuth. Tests cover callback state, issuer-scoped encrypted
credentials, cancellation, private error bodies, read coverage and retained
action-approval rules. No new owner account credentials were supplied or
connected during validation.

All 142 unit files passed: 4,858 tests passed and two skipped with
`--maxWorkers=2`. The first four-worker run found a cache-price assertion that
assumed every model used a tenth-rate cache; GPT-6.1 Sol uses one twentieth and
the assertion was corrected. Its timing-sensitive module-conformance check
also failed under host load and passed alone before the complete two-worker
run. Type checking, terminal installation, the executable's help route and the
benchmark dry run passed. No native Swift source changed.

The final OAuth-token handoff fix reconnects transports when their saved
authorization header changes. All 103 focused connection, callback, CLI, MCP,
registry, boundary and identity regressions passed before the final full run;
the terminal bundle was rebuilt and its installed permission check passed.

No live desktop clicks or screenshots were performed in this session. The
Computer Use skill requires its Node REPL surface, which was unavailable;
desktop targeting and refusal behavior were tested with the real runner and
synthetic controllers. The image fixture exercised provider inference only.

## CLI-only local installation (October 2, 2026)

A GUI instance was observed running again from `release/mac-arm64/Butler.app`
after the terminal became the default. The desktop process and its helpers were
stopped. Local app bundles, desktop distribution archives, backup app copies,
renderer/main build outputs, and the installed Electron runtime binary were
removed. No Butler launch-agent files were found.

The package entry point and `butler` executable both target
`dist-terminal/main.cjs`. Desktop launch, smoke and packaging commands and their
scripts were retired, along with the app packaging dependency. Removing that
dependency exposed an undeclared AJV import in the schema-contract tests; AJV is
now an explicit development dependency at the previously installed version.
Shared Node modules, native helpers and their protection rules remain available
to the CLI.

The local terminal installer, type checking and `npm start -- --help` passed.
The full unit suite passed 4,813 tests with two skips across 138 files. An existing
CLI session was left running; the engine lock correctly refused a duplicate
interactive session. No live model, speech or desktop action accuracy is claimed.

The earlier desktop sections below record historical checks. Their app bundles
and packaging commands are no longer part of the current installation.

## Periodic briefings and British conversation (October 2, 2026)

Butler now offers a selectable recurring check, spoken delivery with a readable
copy, source coverage, trusted connected-app reads and a British conversational
persona. See [BRIEFINGS.md](BRIEFINGS.md) for setup and the access boundary.

The full suite passed 4,801 tests with two skips across 137 files, using
`--maxWorkers=4`. Twenty-four unit regressions were added for this change.
After the final timezone, serialized-input bounding and settings-revocation
changes, all 258 tests in eight affected files passed. All four browser flows
passed across the final runs; `output/qa/butler-briefings.png` was visually
inspected. Browser checks also exposed and fixed an existing renderer startup
failure: two settings modules imported Node dependencies through shared barrels.
They now import browser-safe modules; the production build has no Node
externalization warnings.

Type checking, production build, native helper compilation and native safety
checks passed. The initial unrestricted-worker suite encountered host-load
timing failures and a prompt-contract mismatch; the prompt compatibility was
fixed and the bounded-worker suite then passed without weakening those checks.

A live native read reported four applications, no screenshot and no notification
content while notification access was disabled. A voice-helper status check
selected Arthur from eleven available British voices while retaining `en-US`
speech recognition; no audio was played. Summary accuracy and audible latency
have not been measured live. Scheduling, summary fallback, cancellation and
budget behavior are established by the automated checks.

The local Apple Silicon build is
`output/butler-proactive/mac-arm64/Butler.app` (359 MB, ad-hoc signed).
The packaged main/preload bytes and all six native helpers' executable sections
match the current build. Signing initially failed with the disk almost full;
after clearing the replaceable Electron download archive, the framework was
signed and verified, then signing resumed for the remaining app components.
The same verified build was subsequently shipped to the canonical local path,
`release/mac-arm64/Butler.app`, after gracefully quitting the previous app.
The previous bundle is retained in `output/local-backups/` for rollback.
The updated main process, controller and voice helper were confirmed running
from the canonical path. This startup check does not measure task reliability
or audible briefing quality.

Briefings are disabled until enabled and saved in Settings. Connected app
contents still require configured connections and their permissions; this is
not a full data index of every installed app.

## Tools before desktop control (October 2, 2026)

Eligible app tasks now start without desktop capture or input. Connected
providers discover tools concurrently, the complete permitted catalogue is
ranked before the 18-tool limit, and provider serialization preserves that
same limit. A desktop fallback discards the proposal, obtains a fresh screen
and replans. Tools-only completion requires successful tool evidence and
read-back after unverified writes. See [TOOLS.md](TOOLS.md).

Validation: the broad suite passed 4,775 tests with two expectation failures
and two skips. The tool-order assertion was updated for task ranking; an
existing pricing assertion was corrected to match the already-implemented
rule that a configured stronger auditor also audits single-clause tasks.
All 187 checks in that file then passed. Across the final checks, 4,777 tests
passed and two were skipped. Twenty regressions were added for this change.
Type checking, production build and local Apple Silicon app packaging passed;
the packaged main-process bytes were verified against the current build.
The initial sandboxed suite could not open loopback servers (`EPERM`), so the
broad checks were rerun with local server and native-helper access.

The local build is `output/butler-tools-first/mac-arm64/Butler.app` (359 MB,
ad-hoc signed). It was not installed or launched into a real desktop task.
Zero screenshots/native input in the tool path and fresh capture on fallback
are established by the automated checks. Live provider latency, speech
responsiveness, task success rate and false completion rate have not been
remeasured. The earlier live benchmark is not superseded by these checks.

The observer still learns habits from frontmost-app observations rather
than maintaining a full cross-app data index. The Electron shell and the
optional voice model retain their existing resource costs.

Validated September 16, 2026 on an Apple Silicon Mac. This is a development alpha with implemented native paths; automated synthetic success is not a claim of live agent reliability.

The table and follow-ups below the next section are the earlier September 16 baseline; their test counts are superseded by the current change set.

## Current change set: automatic re-aim after a screen change (September 17, 2026)

Scope: one automatic re-aim for a model-proposed pointer action whose input was refused with `STATE_CHANGED`, in `src/core/runner.ts` only (no native, policy or provider change); the `ActionReaimed` journal event and its `ACTION_REAIMED` classification in `src/gym/bench/analyze.ts`. The rule and its limits are in [DEVELOPMENT.md](DEVELOPMENT.md) ("Automatic re-aim").

Measured before the change with `node scripts/analyze-runs.mjs` over this Mac's own diagnostics (38 runs, 18,497 events; window 2026-09-16T08:39:49Z .. 2026-09-17T19:10:49Z):

| Measurement                                          | Value                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Runs with a screen-change rejection                  | 16 of 38                                                                 |
| Screen-change rejections                             | 115 (57 `SCREEN_CHANGED` seen by the runner, 58 `SCREEN_CHANGED_NATIVE`) |
| Applications                                         | Chrome 29/30, Spotlight 9, VS Code 6, Spotify 6                          |
| Proposed action behind the 57 runner-side rejections | click 29, hotkey 16, key 10, type_text 2                                 |
| Median model call / capture / execute                | 2052 ms / 504 ms / 492 ms (about 3.0 s from screenshot to input)         |

The 29 rejected clicks are the ones this change can recover without a model call; keyboard rejections are deliberately out of scope, and a click with no identified control or with several matching ones still costs a model call. The saving per recovered step is one model call plus the capture that follows it (about 2.5 s of the roughly 3 s round trip). How often a fresh frame really yields exactly one matching control on a live animating page is not established by this record: `ACTION_REAIMED` exists so the next analyzer run over live diagnostics can measure it.

| Check                                    | Result                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npx tsc --noEmit`                       | Pass                                                                                         |
| `npx vitest run`                         | 26 files, 1,134 passed, 1 skipped (13 new re-aim cases in `tests/runner-resilience.test.ts`) |
| `npm run build:native`                   | Pass                                                                                         |
| `npm run test:native-safety`             | 1,093 PASS, 0 FAIL (no native code was touched)                                              |
| `npx prettier` on the changed TypeScript | Pass                                                                                         |

New regression cases: a rejected click re-aimed at the moved control with no new model call and one counted action; fallback to the model when the control is gone, when two controls match, when the only match is disabled, when the fresh frame is another application, when the target was never identified and when the re-aim capture fails; `drag` and `type_text` never re-aimed; a replayed plan step never re-aimed (it still abandons the plan); at most one re-aim per proposed action; an approved (`CONFIRM`) step asked for approval again instead of reusing consent; and a re-aim dropped when the user pauses while it captures.

## Current change set: memory, spoken replies and forgiving turn-taking (September 17, 2026)

Scope: local memory, system index, learned skills and `open_file` ([MEMORY.md](MEMORY.md)); spoken replies with the Mac voice, the free on-device Kokoro voice and the opt-in OpenAI voice; patience-based endpoints, segment accumulation, follow-up windows, fragment clarification and continuation amendment ([VOICE_PRODUCT.md](VOICE_PRODUCT.md)). Two independent reviews (memory: 25 confirmed findings; voice: 14 confirmed findings) were fixed and re-verified with tests that fail when each fix is reverted.

| Check                                    | Result                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx tsc --noEmit`                       | Pass                                                                                                                                                                                       |
| `npx vitest run`                         | 21 files, 1008 passed, 1 skipped (real Kokoro data test runs only with `KOKORO_DATA_DIR`)                                                                                                  |
| `npm run test:native-safety`             | 947 PASS, 0 FAIL                                                                                                                                                                           |
| `npm run build`                          | Pass                                                                                                                                                                                       |
| `npm run test:e2e`                       | 3 passed                                                                                                                                                                                   |
| `npm run test:desktop`                   | Passed, 21 checks (one earlier run timed out waiting for Settings under heavy CPU load from a parallel benchmark; it passed on retry)                                                      |
| `npm run package:mac` (unsigned)         | Pass; 347 MB app, ONNX Runtime darwin-arm64 binaries unpacked from asar                                                                                                                    |
| Native index on this Mac                 | 58 apps, 8 folders, 20 recent files; 0.2–0.5 s warm after token and cache fixes                                                                                                            |
| Live built-in intent (“Open Calculator”) | Opened Calculator with no model call; both live runs then paused for a real hardware mouse movement (takeover worked as designed)                                                          |
| Kokoro (onnxruntime-node, fp32, M2)      | 332 MB verified download in 16 s; about 1.3 s cold to first audio; about 0.5 s per short sentence warm; about 700 MB worker memory; 0 word errors in a Whisper round trip during the spike |

Not measured yet (need the microphone, speakers and a person): spoken-reply start latency on device, false activations in follow-up windows, echo with Bluetooth output, cut-off rate for disfluent speech at each patience level, and push-to-talk success for very short answers.

## Current change set: open_app, grounded controls and recoverable run loop (September 16, 2026)

Scope: launch-only `open_app` with native resolution and denial (`LaunchSafety.swift`); grounded `context.controls` including browser web-area controls; Safari page-host detection for protected domains; tolerant single-object extraction from model text; Calculator, search-result-page and heading policy; Dock clicks redirected to `open_app`; executed-target step history, loop and app-switch detection, refusal/outage/native-error recovery, active-time budget and live settings updates; helper auto-restart and parent-death exit; voice stop/pause from final transcripts only; the opt-in live harness.

| Check                                                         | Result                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                    | 492 tests passed (11 files)                                                | Final diff, including the post-review fixes below                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Native Swift checks                                           | 190 passed                                                                 | Frame, wake-policy and launch-safety checks; final diff                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `npm run test:e2e`                                            | 3 passed                                                                   | Final diff                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `npm run test:desktop`                                        | 18 checks passed                                                           | Final diff (development Electron with isolated storage)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `npm run test:native-input`                                   | 24 checks passed before the review-fix round; not re-run on the final diff | Later runs failed only at the Spotlight step: with the unbundled fixture frontmost, macOS did not open Spotlight for a synthetic Command-Space at all (the same helper opened it from VS Code in 0.4–1 s, and the pre-change packaged helper could not reach the step because a 0.46 px pointer echo triggered the old false takeover). The step now records an explicit skip after one bounded retry. The final run was not executed because the user may have been using the Mac |
| `npm run build`, `npm run build:native`, TypeScript, Prettier | Passed                                                                     | Final diff                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Live desktop runs used `npm run test:live` from a terminal on this Mac (source native helper, not the packaged app), GPT-5.4 mini unless noted. Reports: `output/qa/live-task-*.json`.

| Task                                                                      | Result    | Detail                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calculator: 128 × 46 (four earlier runs)                                  | Failed    | Three runs hit their action budgets (25, 16 and 16 actions; $0.121, $0.090, $0.059), with repeated retargets or loop warnings. One run reported completion in 13 actions/45 s/$0.047 but stated 51888, a **wrong result**. The models treated their own entered digit as leftover state and cleared it                                  |
| Calculator: 128 × 46, `claude-sonnet-5`                                   | Failed    | Same clearing behaviour; action budget at 16 actions, $0.184                                                                                                                                                                                                                                                                            |
| Calculator: 128 × 46, after executed-target step memory                   | Completed | Correct 5888 in 5 actions, 22 s, $0.020; one transient provider outage recovered without a pause                                                                                                                                                                                                                                        |
| Safari web search for San Francisco weather                               | Completed | 3 actions, 32 s, $0.013, no approvals                                                                                                                                                                                                                                                                                                   |
| Safari + Calculator: San Francisco temperature °F → °C (earlier attempts) | Failed    | One run hit its 25-action budget ($0.143) after three declined approvals (the results-page unit toggle needed approval) and loop warnings; another stopped at takeover after five unidentified targets ($0.040). Also observed: a Dock mis-click launched Freeform, heading clicks returned `RETRY`, and web controls were not grounded |
| Safari + Calculator: °F → °C (after fixes)                                | Completed | 63 °F = 17.2 °C, correct; 19 actions, 102 s, $0.10, no pauses. Fixes: search-result-host buttons, `AXHeading` content clicks, Dock → `open_app`, web-area control grounding and the app-switch warning                                                                                                                                  |

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

| Check                          | Result                                 | What it establishes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                     | 142 tests passed across nine files     | Schema bounds, private routing, policy, budgets/cancellation, correction invalidation, manual takeover, scoped approval, context sanitization, provider fixtures, encrypted storage, safe env import, endpoint-bound credentials, changed-screen recovery, approval revalidation, consent/upload/withdrawal and seeded task grading; plus transient connection recovery, bounded retries, secret redaction, permanent errors, cancellation during retry delay, partial-body failure and a shared request deadline. Diagnostic checks verify key/content exclusion, rotation/permissions, event deduplication, UUID preservation and non-interference; desktop transport checks cover TLS-record fallback, proxy preservation and certificate failure |
| `npm run build:native`         | Passed                                 | Both Swift helpers compile against AppKit/ScreenCaptureKit/Speech/AVFoundation on this Mac                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `npm run build`                | Passed                                 | TypeScript checks and production renderer/main/preload bundles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `npm run test:e2e`             | Three tests passed                     | Minimal preview, tutorial pill, pause/correction/stop, consent/exclusions/cancel/delete, settings, bundled Space Grotesk and responsive layout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Desktop integration            | Passed                                 | Real Electron shell and OS secure storage, synthetic run, real loopback contribution HTTP, exact-approved export, prohibited pill IPC, restart recovery, withdrawal and deletion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Packaged desktop integration   | Passed                                 | The packaged `.app` launches/restarts and passes the same checks, plus same-run correction/completion, native text-pill expansion, encrypted three-provider env import, key retention across provider switching, no key reuse for custom endpoints, and no credential values in renderer info                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Packaged diagnostic stream     | Passed                                 | Real tutorial action/completion events reach the rotating JSONL log; saved fixture API keys and task text are absent. Native requests, voice status and permission checks are observable without capturing additional data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Live OpenAI API fixture        | Passed                                 | `gpt-5.4-mini` completed a generated project-name form and verified the resulting screen in five calls; 16.503 s total, 8,717 input / 365 output tokens, estimated $0.00818. Uses our actual adapter and action schema; only isolated browser input, no OS input or personal screenshots                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Packaged provider transport    | Connection passed; task fixture failed | Production provider factory loaded in the packaged Electron main runtime received six valid OpenAI responses, including after a 15-second idle gap; each response took 0.9–2.51 s. The model repeatedly clicked and did not finish the generated form within six calls. Estimated $0.00816. Evidence: `output/qa/provider-smoke-desktop-openai.json`; this establishes connectivity, not task success                                                                                                                                                                                                                                                                                                                                                |
| Local configured package       | Passed                                 | Real `.env` keys imported into the user's encrypted store; OpenAI selected. No key values found in renderer info, ciphertext config, or packaged app contents. `.env` remains Git-ignored and mode 0600                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Native pixel/input/wake policy | 56 checks passed                       | Caret/clock/rendering variation and verified control animation are tolerated; changed targets/layout/geometry are rejected. Wake checks cover anchored phrase matching, ignored ambient approvals/commands, silence endpointing, empty-command expiry, hard duration limits and standby recycling                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Native input                   | Seventeen checks passed                | Real clicks and typing succeed in a temporary AppKit window with clock/caret animation. Stationary pointer notifications are ignored while actual cursor movement stops input. Command-A and Command-Shift-K reach the fixture; Spotlight opens without false takeover, owns the observed input context, and Escape dismisses it. Changed focus, moved/relabelled buttons, edited long field values and a second window reject stale input. No API calls or saved screenshots; evidence: `output/qa/native-input-smoke.json`                                                                                                                                                                                                                         |
| Mac arm64 directory package    | Produced                               | `release/mac-arm64/Open Assist.app`, about 316 MB, with both native helpers, local font and custom icon; no Developer ID identity used and no notarization/publication                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Dependency audit               | Zero reported vulnerabilities          | At validation time; not a security certification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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
