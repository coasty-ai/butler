# The voice loop

The voice loop measures the distance to "I never have to type or use the mouse" the only way that counts: it **speaks** the suite's prompts through the speakers into the running, packaged Butler.app, watches what the app did from its own diagnostics and from the Mac's state (osascript), names each failure, and writes a content-free `results.json` and `report.md` that the fix loop (`docs/HARNESS_LOOP.md` §11) turns into fix lanes. Nothing is injected: the wake word, the recognizer, the routing, the run and the spoken reply are the real ones. It is the voice-level sibling of the bench harness cycle, whose §13 says "Voice is not measured"; this closes that gap.

```
npm run voice:loop -- --i-know-this-speaks-to-my-mac
  -> output/voice/<cycle>/{results.json, report.md, lanes/<CLASS>.md, turns.jsonl, diagnostics/current.jsonl}
  -> npm run loop -- --output output/voice          (selectLanes / laneBrief, unchanged)
  -> you fix, rebuild and relaunch Butler.app (the loop never does)
  -> next cycle at the same suite hash compares class rates
```

## 1. What it never does

- **Never approves.** No turn says yes, sure, go ahead or any approval phrase (a suite invariant rejects them; `ask-deictic`'s "sure go for it" is allowed only because the task pins it to a question). A confirmation or a click asked for is **declined** with "`Hey Butler`, stop", and the loop verifies the run ended within 5 s.
- **Never speaks after an unheard prompt or a takeover.** "Stop" is spoken only for a run still going or a pending confirmation; a late stop after an unheard prompt used to collide with the next one. A person at the Mac (`UserTakeoverStarted{manual_input}`, `NativeUserTakeover`, or an `HIDIdleTime` reset the app's own actions cannot explain) ends the cycle silently with exit 3; a run the takeover paused is yours to resume or stop.
- **Never launches, relaunches, quits or packages the app.** Preflight refuses unless exactly one `release/mac-arm64/Butler.app` process is running (`NOT_PACKAGED_APP`). Rebuilding and relaunching are your steps between cycles.
- **Never the owner's data.** Suite invariants (`src/gym/voice/suite.ts validateSuite`, tested on the fixture) forbid Messages, Mail, FaceTime and the words send, pay, purchase, publish, install, delete my, empty trash, password; every `delete`/`rm` in a cleanup must be scoped on its line to the attempt's `{token}`, its `{benchDir}`, files `-newer {marker}`, or a Notes creation-time window with content words. Browsing uses example.com and en.wikipedia.org only; screenshots are deleted unopened; apps are quit only if the loop opened them; the output volume is restored after every task.
- **One agent on the desktop.** The same desktop lock as the cycle and the bench (`~/Library/Caches/open-assist/desktop.lock`, `script: "voice-loop"`), and `ps` is checked for another cycle or bench.
- **Content-free artifacts.** `results.json`, `report.md` and the briefs carry codes, ids, booleans, numbers and the fixture's own catalogue text; never a transcript, a reply, a URL, a path or a note body. Those go to the local `turns.jsonl` only, and a test feeds marked text through the report to prove it.

## 2. Requirements and preflight

The app must run **with verbose diagnostics** (`COARENA_DIAGNOSTICS_VERBOSE=1`): `Command.text`, `RunState.task` and `RunState.message` are verbose-only fields, and heard/misheard and the task-word checks depend on them. Preflight is read-only (`ps`, `ioreg`, `plutil`, `osascript -e 'get volume settings'`, `shortcuts list`, the diagnostics tail) and refuses with exit 2 on:

| Code                      | Meaning and remedy                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_PACKAGED_APP`        | Not exactly one `release/mac-arm64/Butler.app` process with bundle id `ai.coarena.openassist`. Launch it yourself; a dev Electron is refused.        |
| `HARNESS_RUNNING`         | A cycle, bench or another voice loop is running, or holds the desktop lock. Wait or stop it.                                                         |
| `DIAGNOSTICS_NOT_VERBOSE` | The app's environment lacks `COARENA_DIAGNOSTICS_VERBOSE=1` and its newest `Command`/`RunState` carries no text. Relaunch with the variable set.     |
| `NOT_LISTENING`           | The latest `wake_status` says `listening: false`, or none was seen since the app started. Turn on "Hey Butler" in the tray; check the microphone.    |
| `PERMISSIONS`             | No `Permissions` event since app start, or one with screen, accessibility, microphone or speech false. Open Butler's Settings once; grant them.      |
| `VOLUME`                  | Output muted or below 35. The loop speaks at the volume it finds (`V`) and enforces it before every turn.                                            |
| `RUN_LEFT_OPEN`           | The log's newest run is not terminal. Say stop to the app yourself or wait.                                                                          |
| `QUIET`                   | Only with `--require-quiet`: no standby trace (`BUTLER_TRACE_STANDBY=1`) to judge the room by. Without the flag this is a warning (`QUIET_UNKNOWN`). |

Per-task **skips** (not refusals): `NOTES_AUTOMATION` (the terminal may not control Notes; probed only in a real run, since the probe may launch Notes) skips `dictate-notes-line` and `multi-notes-shopping-list`; `SHORTCUT_MISSING` (no Shortcuts shortcut named `Butler Voice Loop: Focus Off`) skips `sys-do-not-disturb`. Safari's "Allow JavaScript from Apple Events" is not required: the checks that need it are `optional` and read as unknown.

## 3. Running a cycle

`npm run voice:loop` is `node scripts/voice-loop.mjs`; the script is the I/O shell only (it speaks, polls the diagnostics log, runs osascript and writes files), and every rule lives in the pure modules `src/gym/voice/{suite,grade,classify,report}.ts`, tested in `tests/voice-loop.test.ts`.

```sh
npm run voice:loop -- --dry-run                         # validate the suite, print preflight facts and the plan; speaks nothing
npm run voice:loop -- --dry-run --only fast-start       # ids, tags or categories, comma-separated
npm run voice:loop -- --repeat 3 --i-know-this-speaks-to-my-mac        # the recommended real cycle (~2 h)
npm run voice:loop -- --noisy --i-know-this-speaks-to-my-mac           # include the three noisy-room tasks
npm run voice:loop -- --idle-seconds 45 --voice Samantha --rate 175 --wake "Hey Butler" --i-know-this-speaks-to-my-mac
npm run voice:loop -- --report-only 20260919-2200-75ed88e              # re-render from the ledger
```

Leave the Mac after starting it: no prompt is spoken until `HIDIdleTime` is at least `--idle-seconds` (45), and after any human input the full idle is required again. Between tasks only "no input since the app's own last `ActionExecuted` plus 3 s" is needed, because the app's synthetic clicks move `HIDIdleTime` like a hand would (`presence.ts idleRequired`). Ctrl-C once stops after the current turn (a running run is stopped, cleanup runs, reports are written); twice exits at once.

**The per-task gate** (`src/gym/voice/grade.ts voiceGate`, polled every second, cap 10 min, in this order): no open run (`RUN_OPEN`; trial 05:43 showed a run left paused turns the next prompt into `resume_refused`), no open follow-up window (`FOLLOWUP_OPEN`), 800 ms since the app last spoke (`SPEAKING`, the echo guard), 5 s with no non-chatter event (`BUSY`), `wake_status listening: true` (`NOT_LISTENING`), a quiet room when the standby trace is on (`NOISE`: the two newest `standby_trace level` rms under `floor + 0.35 × (speech − floor)`, calibrated against the loop's own first `say`, and no `textLength > 0` trace in 10 s), the volume at `V` (`VOLUME`), and idle (`HID_ACTIVE`). Setup runs after the gate, and the gate is checked once more before speaking. Every wait is logged with its reason.

**The turn.** A marker file is touched, the diagnostics offset noted, the prompt spoken as `"<wake>, <say>"` (one `say` call; the comma is the pause the wake rule needs), then events are polled every 250 ms until: a terminal `RunState`; an answer or question with 6 s of quiet; no wake within `unheardMs` (20 s; nothing more is said); a confirmation or `needClick` (declined with stop); a takeover (cycle aborts); or the task's timeout (a run still going is stopped and graded `RUN_INCOMPLETE`). Later utterances of a multi-turn task fire on their trigger (`followup_open` for the 3 s continuation window, `ActionExecuted`, `RunState paused`, `speech_started` for barge-in) and wait out the app's speech unless barging in. Then state checks run (osascript), cleanup runs (always), the volume is restored, and `results.json`/`report.md`/`lanes/` are rewritten. If the run is still open after a stop the cycle aborts (`RUN_LEFT_OPEN`).

## 4. The suite

`tests/fixtures/voice-suite.json`: 39 tasks in nine categories (app, dictation, browsing, question, correction, multi-step, system, wake, noisy); 36 without `--noisy`, minus the probe skips. Each task has `say` (what follows the wake phrase), `heard` (a regex over a transcript that carries no punctuation, so `\bnotes?\b`, never `Notes,`), an `expect` (outcome `answer | run | question | stop | pause | resume | revise | confirmation | silence | interrupt`, with `runCompleted`, `noConfirmation`, `taskWords`, `frontmost`, `state` checks, `replyHas`, `noMutation`, `maxActions`, `actionTypes`), `setup`/`cleanup` scripts with `record` for values later steps read as `{state.<name>}`, `tags`, `notes`, and optional `turns[]` for multi-utterance tasks. Placeholders: `{token}` (`voiceloop` + 4 base-36 chars), `{benchDir}` (`~/OpenAssistBench/voice-{token}`), `{wake}`, `{marker}`. The default selection's estimate (Σ timeouts + 12 s a task) must stay under an hour; the test checks it.

The suite hash (`sha256` of the fixture plus `grade.ts` and `classify.ts`) is stored in every `results.json`; cycles at different hashes are never compared.

## 5. Grading and failure classes

`summarizeTurn` (the trial prototype's summary, typed) reads one utterance's events from the moment `say` started: `wakeMs`, `transcriptMs`, `endpointMs` (transcript − say end), plan, decided act and code, early start, run, actions and mutations, confirmations, takeover sources, status timeline, spoken reply and its latency, follow-up window, speech, standby levels, capture timings. **Heard** means the wake phrase within 15 s and the task's key words in the transcript (lowercased, punctuation stripped); **misheard** means a transcript without them; **unheard** means neither. `gradeTurn` applies the expectation and the osascript evidence; `classify` names the turn, first match wins:

| #   | Class               | When                                                                                                                                                                                                                                                                                      | Fine owner      | Cost |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---- |
| 1   | `ENV_NOT_READY`     | A preflight or gate refusal for the turn (`subcode`: `NOT_LISTENING`, `SETUP_FAILED`, `RUN_LEFT_OPEN`, …)                                                                                                                                                                                 | harness         | 0    |
| 2   | `TAKEOVER`          | A person touched the Mac; the cycle aborts and says nothing                                                                                                                                                                                                                               | user            | 0    |
| 3   | `UNHEARD_NOISY`     | Unheard, task tagged `noisy`                                                                                                                                                                                                                                                              | recognizer/gate | 2    |
| 4   | `UNHEARD`           | Unheard                                                                                                                                                                                                                                                                                   | recognizer/gate | 3    |
| 5   | `MISHEARD`          | Heard something else                                                                                                                                                                                                                                                                      | recognizer/gate | 4    |
| 6   | `WRONG_PLAN`        | Heard, but the wrong kind of thing happened: a run for a question, an answer for a command, `resume_refused`, `FALSE_WAKE`, wrong task words, a late stop                                                                                                                                 | dialog core     | 5    |
| 7   | `NEEDS_CLICK`       | `noConfirmation` and a `PolicyConfirmationRequested`, a `needClick` plan, or a hand-off takeover (`request_user`, `handoff`, `policy`, `surface`)                                                                                                                                         | runner/policy   | 10   |
| 8   | `RUN_FAILED`        | Terminal `failed`, or cancelled by the app itself                                                                                                                                                                                                                                         | runner/policy   | 6    |
| 9   | `RUN_INCOMPLETE`    | Still going at the timeout (the loop stopped it), or not completed where completion was required                                                                                                                                                                                          | runner/policy   | 6    |
| 10  | `WRONG_STATE`       | Completed, but a state, frontmost, reply or mutation check is false (`FALSE_DONE` when the check is `primary`). A non-optional check that could not be read is `ENV_NOT_READY/STATE_UNREADABLE` (grader debt), judged just before this row so it never masks an unheard or misrouted turn | runner/policy   | 8    |
| 11  | `SLOW_FIRST_ACTION` | _Soft_: passed, but the first action came more than 4 s after the transcript                                                                                                                                                                                                              | runner/policy   | 2    |
| 12  | `SLOW_REPLY`        | _Soft_: passed, but the reply came more than 3 s (answers) or 2 s (acks) after the transcript                                                                                                                                                                                             | dialog core     | 1    |

A turn has at most one hard class and may add one soft class; soft classes never fail it. `TAKEOVER` and `ENV_NOT_READY` are reported apart under Environment and excluded from the ran-turn denominator. Classes are ranked by count × cost; rates carry Wilson 95% intervals, so at n ≈ 33 a class needs three hits to earn a lane, which is why `--repeat 3` is the real cycle. `NEEDS_CLICK` and `WRONG_STATE` are the trust breaches: fixed only at 5% with the interval under it (10% for the rest).

Latency budgets (`grade.ts LATENCY`): wake ≤ 3 s after `say` starts, endpoint ≤ 3.8 s after it ends, first action ≤ 2.5 s after the transcript (class at 4 s), reply ≤ 1.5 s (class at 3 s / 2 s), capture total ≤ 900 ms. The report prints p50/p95 of each.

## 6. Output and the fix loop

`output/voice/<cycle>/` holds `plan.json`, `ledger.jsonl` (append-only; `--report-only` re-renders from it), `results.json` (schema 2 superset: `kind: "voice"`, `failureClasses` in the bench's exact `FailureClass` shape), `report.md`, `turns.jsonl` (local: transcripts, task text and messages), `diagnostics/current.jsonl` (the collected event slices, each with `voiceTurn: "<taskId>#<attempt>[/t<n>]"` so a brief's example run ids resolve by grep), and `lanes/<CLASS>.md` (the voice fix brief per class: the mechanism note prefixed with the fine owner and the files it names, the evidence to open, the example turns, the floors, the probe).

Because `results.json` is schema 2 and `failureClasses` map fine owners to the loop's (recognizer/gate, dialog core, runner/policy, native → `agent`; harness → `harness`; `STATE_UNREADABLE` → `grader`; `TAKEOVER` → `user`, never a lane), the fix loop reads it unchanged:

```sh
npm run loop -- --output output/voice                 # lanes and briefs from the newest voice cycle
npm run loop -- --output output/voice --create-lanes  # + a worktree and branch per lane
```

`laneBrief` prints the class note verbatim, so the brief carries the owner and the evidence pointer. Every brief repeats the two rules: **a safety floor is never relaxed** (`src/core/policy.ts`, `src/voice/turns.ts`, `native/macos/WakePolicy.swift`, `native/macos/TurnPolicy.swift` and the other `FLOOR_PATHS` may gain a rule, never lose one; a refusal that costs a `NEEDS_CLICK` stays, the route must avoid the control or you accept it), and **the loop never merges**. The probe for a lane is your command: rebuild and relaunch the app, then `npm run voice:loop -- --only <the class's task ids> --repeat 3 --cycle-id probe-<class>-<id> --i-know-this-speaks-to-my-mac`, and compare against the cycle at the same suite hash (the report's "Against the previous cycle" table: `improved / regressed / inconclusive / new / gone`, one-sided p < 0.05; at n ≈ 33 most verdicts are inconclusive and the report says how many attempts a 10-point change would need).

## 7. Reading the report

1. Header: cycle, git rev, app version/build/executable mtime, voice/rate/wake, idle, noisy, quiet calibration (floor/speech/threshold or "no trace"), suite hash, time used, gate waits, why it stopped early.
2. **North star**: hands-free success (passed with zero confirmations and zero clicks asked for, over ran turns, with its interval) and p50/p95 of first action, reply, wake, endpoint and capture.
3. Pass rate by category and tag (italic under n = 12).
4. Failure classes by count × cost: owner, count, rate [interval], seconds lost, categories, example turn ids, the mechanism note, the evidence line.
5. Environment: takeovers and not-ready turns, and the abort if any.
6. Against the previous cycle.
7. Per-turn table, gate log, preflight facts and skipped tasks with remedies.

## 8. Limits and open points

- Quiet thresholds (`floor + 0.35 × (speech − floor)`) and the `[[volm]]`/`[[slnc]]` speech markup are unconfirmed constants; the report prints the calibration so they can be tuned.
- `Permissions` is logged only on the Settings IPC and the verbose flag is inferred from the app's environment or its newest events; logging both at app start would let preflight tell without a prior command.
- The DND assertion file's shape on this macOS is unconfirmed, so `sys-do-not-disturb` grades on run completion with an optional check.
- A person reading without touching is invisible to the gate, as in the bench.
