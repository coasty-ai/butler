# Benchmark and failure analysis

Two tools for improving Open Assist's automation with evidence instead of guesses.

| Tool                 | Command                | What it costs            | What it touches                              |
| -------------------- | ---------------------- | ------------------------ | -------------------------------------------- |
| Automation benchmark | `npm run bench`        | Real money, real desktop | Drives this Mac with a cloud model           |
| Failure analyzer     | `npm run analyze-runs` | Nothing                  | Reads `.data/diagnostics/*.jsonl`, read-only |

The benchmark answers "how often does it get the task done, in how many steps, for how much?". The analyzer answers "when it fails, why?" over runs that already happened, including the user's real ones.

Run the analyzer freely. Run the benchmark deliberately, watching the screen.

## 1. `npm run bench`

```
npm run bench -- --dry-run                      # list the plan; no model, no desktop
npm run bench -- --tasks calculator --dry-run
npm run bench -- --provider openai --tasks calculator-multiply \
  --repeat 3 --i-know-this-drives-my-mac
```

`npm run bench -- <args>` and `node scripts/bench.mjs <args>` are equivalent.

### Safety

- **It refuses to start without `--i-know-this-drives-my-mac`.** `--dry-run` is the only thing that runs without it, and a dry run loads neither a provider, a controller nor the runner.
- It prints a warning naming the number of runs, the model and the cost ceiling before the first run.
- It **stops at the first hand-off** (`takeover` or `paused`), because nobody is there to say continue. `--continue-on-takeover` keeps going instead.
- Every existing stop path still works: the native emergency stop, real mouse or key input, Ctrl-C. Each stops the current run and ends the benchmark.
- Approvals are **declined** by default and counted; a declined approval is a real result. `--approve-routine` approves prompts whose reason contains none of `send delete pay purchase publish install password security`, the same filter `npm run test:live` uses.
- Every attempt carries the task's own action, time and cost budget, and the benchmark stops when the total budget is spent.

The catalogue itself is side-effect free or self-cleaning. Nothing in it sends, posts, pays, installs, deletes user data, or touches Messages or Mail. The one task that creates something (`notes-create-delete`) creates a note with a marker generated for that attempt and deletes that same note.

### Flags

| Flag                                   | Meaning                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`                            | List what would run. No provider call, no desktop input, no files written.                                                |
| `--i-know-this-drives-my-mac`          | Required for a real run.                                                                                                  |
| `--provider openai\|anthropic\|google` | Default `openai`. Keys come from `.env`, like the live harness.                                                           |
| `--model <id>`                         | Overrides the provider's default model.                                                                                   |
| `--tasks <ids\|categories>`            | Comma separated. Categories: `browser`, `notes`, `calculator`, `files`, `media`, `multi-app`. Default: everything.        |
| `--repeat N`                           | Attempts per task, 1-20. Rounds are interleaved: every task once, then again.                                             |
| `--max-cost <dollars>`                 | Total budget for the whole benchmark. Default: the sum of the per-task caps.                                              |
| `--memory`                             | Run with the learned-memory path on (recall, built-in intents, learned skills).                                           |
| `--memory-dir <dir>`                   | Where that store lives. Default: a scratch directory in the OS temp folder with its own random key, never a real profile. |
| `--continue-on-takeover`               | Do not stop the benchmark at the first hand-off.                                                                          |
| `--approve-routine`                    | Approve routine, non-consequential approval prompts.                                                                      |
| `--out <file>`                         | Result file. Default `output/bench/<timestamp>.json`.                                                                     |

`--memory` is how you measure whether learning helps: run `--tasks calculator --repeat 3` with and without it and compare median actions, cost and model calls. With memory on, a repeated task can replay with **zero model calls** (`modelCalls` in the result file).

### The catalogue

Twelve tasks. Each has an id, the spoken instruction, the applications it needs, a category, a difficulty, a cost cap, an action budget and a time budget.

| id                         | Category / difficulty | Instruction                                                         | The grader passes when                                                                                                                   | Cap   |
| -------------------------- | --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `browser-open`             | browser / easy        | Open Safari                                                         | `com.apple.Safari` is frontmost                                                                                                          | $0.05 |
| `browser-goto`             | browser / easy        | Go to example.com                                                   | A browser is frontmost and the **committed page host** is `example.com`                                                                  | $0.08 |
| `browser-search`           | browser / medium      | Search the web for the San Francisco weather forecast               | A browser is frontmost, the host is a known search engine, and the address or page text contains "san francisco" and "weather"           | $0.12 |
| `calculator-open`          | calculator / easy     | Open Calculator                                                     | Calculator is frontmost                                                                                                                  | $0.05 |
| `calculator-multiply`      | calculator / medium   | Open Calculator and multiply 128 by 46                              | Calculator is frontmost and its accessibility text shows `5888` (or `5,888`)                                                             | $0.15 |
| `calculator-percent`       | calculator / hard     | In Calculator, work out 17.5 percent of 240                         | Calculator is frontmost and its accessibility text shows `42`                                                                            | $0.20 |
| `notes-open`               | notes / easy          | Open Notes                                                          | Notes is frontmost                                                                                                                       | $0.05 |
| `notes-create-delete`      | notes / hard          | In Notes, create a note containing the marker, then delete it       | The journal shows the marker typed while Notes was frontmost, Notes is frontmost, and the marker is **gone** from the accessibility text | $0.30 |
| `files-open-recent`        | files / medium        | Open the file _(resolved from the system index)_                    | The journal shows `open_file` opening exactly that path with the handling application frontmost, or the window title names the file      | $0.12 |
| `media-open-music`         | media / easy          | Open Music                                                          | Music is frontmost. Nothing is played                                                                                                    | $0.05 |
| `media-youtube-search`     | media / medium        | In the browser, search YouTube for lofi beats. Do not play anything | A browser is frontmost on `youtube.com` with "lofi" in the address or page text                                                          | $0.15 |
| `multi-calculator-browser` | multi-app / hard      | Open Calculator, then switch to the browser and go to example.com   | The journal shows Calculator launched **and** a browser is frontmost on `example.com`                                                    | $0.30 |

`npm run bench -- --dry-run` prints the same information, including each task's safety note.

### How the graders verify

Every grader is deterministic and reads one of two sources. **No grader compares screenshots.**

1. **The end state, read back through the existing native controller** after the run settles:
   - `surface()` gives the frontmost bundle id and `domain`, the committed page host taken from the window's `AXDocument`/`AXURL`. The address-bar edit text is never used, so a half-typed address cannot pass a navigation task.
   - `capture()` gives `frame.appId` and `frame.context`: window title, document name, selected text, visible text, control labels and the browser address. The screenshot itself is discarded.
2. **The run journal**: the executed actions, with the frontmost application at each step, typed-text length, the launched bundle id and the opened file path the native helper reported.

Grading is layered:

- A run in which **real input on this Mac** took over is `unknown` (`MANUAL_TAKEOVER`): the desktop changed under the grader, so nothing can be claimed. Re-run it.
- A run the **agent** handed off (repeated unidentified targets, a policy block, `request_user`) is `failed` (`HANDOFF_TAKEOVER`). It did not automate the task.
- A run that never settled is `unknown` (`RUN_NOT_SETTLED`).
- Otherwise the task's own grader runs. **If it cannot read what it needs, the result is `unknown`, never `passed`.** No accessibility text means `NO_ACCESSIBILITY`; no frontmost application means `NO_FRONTMOST_INFO`; a browser task with no address at all means `NO_BROWSER_ADDRESS`.

Reason codes you will see:

| Code                                                                             | Meaning                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `NOT_FRONTMOST`                                                                  | The required application was not in front at the end.                           |
| `RESULT_NOT_SHOWN`                                                               | Calculator was there, the answer was not.                                       |
| `HOST_MISMATCH`                                                                  | The browser was on a different page.                                            |
| `QUERY_NOT_SHOWN`                                                                | The right host, but the query is nowhere in the page.                           |
| `NOTE_NOT_TYPED`                                                                 | No typing of at least the marker's length happened in Notes.                    |
| `NOTE_NOT_DELETED`                                                               | The marker is still on screen: the note was left behind. **Delete it by hand.** |
| `FILE_NOT_OPENED` / `HANDLER_NOT_FRONTMOST`                                      | The file never opened, or its application did not come forward.                 |
| `CALCULATOR_NOT_LAUNCHED`                                                        | The multi-application task skipped its first half.                              |
| `NO_PREPARED_TARGET`                                                             | Nothing in the system index to open; the attempt was skipped, not failed.       |
| `MANUAL_TAKEOVER` / `HANDOFF_TAKEOVER` / `RUN_NOT_SETTLED`                       | See above.                                                                      |
| `NO_ACCESSIBILITY` / `NO_FRONTMOST_INFO` / `NO_BROWSER_ADDRESS` / `NO_END_STATE` | The grader could not verify. Not a pass and not a failure.                      |

### Reading the numbers

```
task                 #  result   act  secs   cost  appr  retry  tko  reason
-------------------  -  ------  ----  ----  -----  ----  -----  ---  ----------------
calculator-open      1  pass       3   9.4  $0.014    0      0    0
calculator-multiply  1  FAIL      16  71.2  $0.088    0      3    0  RESULT_NOT_SHOWN
```

- **act**: executed actions. Fewer is better; it is the clearest proxy for planning quality.
- **secs**: wall clock for the run, hand-offs included.
- **cost**: the run's own estimated cost from the provider's token usage.
- **appr**: approvals the policy asked for. Every approval is an interruption a user would feel; driving this number down matters as much as the success rate.
- **retry**: unidentified-target retries. High retries with a low action count means the agent is blind, not confused.
- **tko**: hand-offs.

The summary block:

- **success rate** = passed / attempts. Unknown attempts count against it, deliberately: an attempt nobody can verify is not a success.
- **of graded attempts** = passed / (passed + failed), which is what to quote when the Mac was touched mid-run. If the two diverge a lot, the benchmark ran in a noisy environment; re-run it.
- **median actions / median seconds** are over attempts that actually ran; skipped attempts are excluded.
- **total cost** is the sum of every attempt, including failed ones.
- **failure codes** and **by category** show where the loss is concentrated.

The result file at `output/bench/<timestamp>.json` holds the same numbers plus per-attempt checks and the catalogue entries used. **It contains no screen content**: instructions are recorded as their template, so a file name resolved for `files-open-recent` never reaches the file. `output/` is Git-ignored.

Exit status is 0 only when nothing failed and nothing stopped the benchmark early.

### What a full run costs

Prices come from `src/providers/catalog.ts` (standard uncached rates, checked 2026-09-16) and are what the runner's own cost accounting uses:

| Provider  | Default model         | Input $/Mtok | Output $/Mtok |
| --------- | --------------------- | ------------ | ------------- |
| openai    | gpt-5.4-mini          | 0.75         | 4.50          |
| anthropic | claude-sonnet-5       | 2.00         | 10.00         |
| google    | gemini-3.5-flash-lite | 0.30         | 2.50          |

The whole catalogue at `--repeat 1` has a **ceiling of $1.62**: the sum of the twelve caps, which is the most it can spend before the budgets stop it.

Typical spend with `gpt-5.4-mini` is well under that. Measured comparable runs on this Mac: an app launch costs about $0.013-$0.018, a correct Calculator task about $0.02, a two-application task about $0.10, and a failed run that burns its action budget $0.06-$0.14 ([VALIDATION.md](VALIDATION.md)); the median real run in the local diagnostics log cost $0.012. That puts a healthy full pass at roughly **$0.40-$0.90**, and a bad one at the $1.62 ceiling. `claude-sonnet-5` costs roughly 2.5x the input and 2.2x the output, so expect the caps to bind; set `--max-cost` explicitly.

Screenshots dominate the input tokens, so cost scales with actions. A change that halves median actions roughly halves the bill.

### What the benchmark does not measure

Voice: nothing here uses the microphone, the wake phrase, endpointing or spoken replies. Latency from key-down to first action, multi-display behaviour, and anything requiring a sign-in are also out of scope. The catalogue is deliberately safe, so it under-samples the hard, consequential tasks where approvals and policy blocks matter most.

## 2. `npm run analyze-runs`

```
npm run analyze-runs
npm run analyze-runs -- --since 24h
npm run analyze-runs -- --since 2026-09-17T00:00:00Z .data/diagnostics/current.jsonl .data/diagnostics/current.jsonl.1
npm run analyze-runs -- --json --out output/analysis.json
```

Defaults to `.data/diagnostics/current.jsonl`. Extra files (including rotated `current.jsonl.1`) can be passed as positional arguments; they are merged and sorted by time, so a run split across a rotation stays whole. `--since` accepts an ISO timestamp or a window such as `24h`, `7d`, `30m`.

### Content safety

**The diagnostics log contains the user's real screen and speech.** With verbose diagnostics on it holds task text, spoken transcripts, window titles, URLs, file paths and free-form policy reasons.

The report contains **only** counts, event types, application bundle ids, action types, durations, timestamps, run ids and fixed reason codes. Every value that reaches the report passes through one of three narrow readers in `src/gym/bench/analyze.ts`: `code` (a short `[A-Za-z][A-Za-z0-9_]*` token), `bundleId` (reverse-DNS shape) and `count` (a finite number). Free-form text is read in exactly one place, `budgetCode`, which compares a message against a fixed table of the runner's own budget messages and returns a code or nothing; the text is never stored or printed. `tests/bench.test.ts` runs the analyzer over a fixture whose every field carries a marker and asserts the marker, `http` and `~/` never appear in the output.

A report is therefore safe to paste into an issue. Run ids and timestamps are included on purpose, so a human with access to the log can replay the exact run.

### What it reports

1. **Header**: run count, event count, time window, outcome split, median actions and cost per run, and median model-call, capture and execute durations.
2. **How runs ended**: every run classified into one ending reason, with the applications and action types involved and a timestamp plus run id to find it in the log.
3. **Friction inside runs**: every recognised problem pattern with its event count, how many runs it appeared in, the applications involved, and a representative timestamp. A pattern that appears in many runs without ending them is a tax on every task, which is often the better thing to fix.
4. **What to fix next**: the ending reasons ranked by how many runs they ended, each with an owner (`agent`, `user`, `environment`, `none`) and the friction patterns most common _inside_ those runs.

Ending reasons: `COMPLETED`, `ACTION_BUDGET`, `RUNTIME_BUDGET`, `COST_BUDGET`, `POLICY_VIOLATIONS`, `STOPPED_AFTER_MANUAL_TAKEOVER`, `STOPPED_AFTER_HANDOFF`, `STOPPED_WHILE_PAUSED`, `USER_CANCELLED`, `EMERGENCY_STOP`, `HELPER_UNAVAILABLE`, `PROVIDER_FAILED`, `PROVIDER_TIMEOUT`, `RUN_ERROR`, `LEFT_IN_TAKEOVER`, `LEFT_PAUSED`, `LEFT_AWAITING_APPROVAL`, `NOT_SETTLED`.

Friction patterns:

| Pattern                                                                  | Read from                                                         | Means                                                                                                                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNIDENTIFIED_TARGET`                                                    | `ActionRetargetRequested` with a role                             | The policy could not identify what the pointer would hit. No input was sent.                                                                |
| `BLIND_SURFACE`                                                          | `ActionRetargetRequested` with no target and no focused role      | The frontmost application reported no accessibility information at all. Every pointer and typing step there is refused.                     |
| `APP_ALREADY_FRONTMOST`                                                  | `ActionRetargetRequested`, `open_app`, `launcherStatus: resolved` | The model asked to launch the application that was already in front.                                                                        |
| `APP_UNRESOLVED` / `APP_AMBIGUOUS` / `APP_REFUSED`                       | `launcherStatus`                                                  | The name did not resolve to exactly one launchable application.                                                                             |
| `SCREEN_CHANGED` / `SCREEN_CHANGED_NATIVE`                               | `ActionFailed STATE_CHANGED`, `NativeError STATE_CHANGED`         | The screen moved between the screenshot and the input, so the step was rejected.                                                            |
| `ACTION_LOOP` / `APP_SWITCH_THRASH`                                      | `ActionLoopDetected`                                              | The same short cycle repeated, or the run bounced between applications.                                                                     |
| `INVALID_ACTION` / `MALFORMED_RESPONSE` / `MODEL_REFUSED`                | `ActionFailed`, `ProviderMalformed`                               | The model's reply was unusable or declined.                                                                                                 |
| `APPROVAL_REQUESTED` / `APPROVAL_DECLINED` / `POLICY_DENIED`             | `PolicyConfirmationRequested`, `UserDenied`                       | The policy interrupted or blocked a step.                                                                                                   |
| `MANUAL_INPUT_DETECTED` / `MANUAL_TAKEOVER`                              | `NativeUserTakeover`, `UserTakeoverStarted source: manual_input`  | Real input on this Mac.                                                                                                                     |
| `TAKEOVER_STARTED`                                                       | `UserTakeoverStarted` with no source                              | A hand-off whose cause the default diagnostics allow-list does not record. `MANUAL_INPUT_DETECTED` in the same run means it was real input. |
| `RUN_PAUSED`, `PLAN_ABANDONED`, `USER_CORRECTION`, `ACTION_INTERRUPTED`  | as named                                                          | The run stopped and waited, gave up a replayed plan, was corrected, or was cut off mid-step.                                                |
| `HELPER_UNAVAILABLE`, `NATIVE_ERROR`, `NATIVE_STOPPED`, `EMERGENCY_STOP` | native events                                                     | The native side.                                                                                                                            |
| `PROVIDER_*`, `MODEL_CALL_ABORTED`                                       | provider events                                                   | The network and the model endpoint.                                                                                                         |

The analyzer degrades gracefully: on a log written with the **default** (non-verbose) allow-list, outcomes, friction patterns and most endings are unchanged; only the budget codes disappear, because their messages are not written. Those runs are reported as `RUN_ERROR`.

### Using the output

Read it in this order.

1. **Owner first.** Patterns owned by `user` (real input, a deliberate stop) are not defects. Subtract them before judging reliability, and note how often they happen: a run that is constantly interrupted is telling you the tasks take too long.
2. **Ranked endings.** The top `agent`-owned ending is the biggest single win available.
3. **"inside those runs".** The ending says where the run died; the contributors say what killed it. `ACTION_BUDGET` with `UNIDENTIFIED_TARGET` inside is a grounding problem, not a budget problem, and raising the budget would only make it cost more.
4. **High-event, low-ending patterns.** A pattern with hundreds of events but few endings is a tax: it is spending actions, seconds and tokens on every task. This is where median actions comes down.
5. **Replay one.** Take the representative run id and timestamp, find it in `.data/diagnostics/current.jsonl`, and read the actual sequence with the content the log holds locally.
6. **Fix, then prove it.** Re-run the matching benchmark category before and after. The analyzer tells you what to change; the benchmark tells you whether the change worked.

Two shapes worth naming, because they look similar and are not:

- **Blind surface.** `BLIND_SURFACE` concentrated in one bundle id means that application exposes no accessibility tree. No amount of model improvement fixes it; the fix is a different route into that application (keyboard shortcuts, `open_app`, a URL scheme) or an explicit hand-off that says so.
- **Screen churn.** `SCREEN_CHANGED` in most runs means the capture-to-input window is too slow for an animating page, not that the model is wrong. The lever is the pipeline's latency and the revalidation rule, and the median capture and execute durations in the header tell you how much room there is.

## Where the code lives

| File                         | What it is                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `scripts/bench.mjs`          | The benchmark CLI: flags, safety gate, the run loop and the result file.             |
| `scripts/analyze-runs.mjs`   | The analyzer CLI: file input, `--since`, rendering.                                  |
| `src/gym/bench/catalogue.ts` | The tasks and their graders.                                                         |
| `src/gym/bench/graders.ts`   | Deterministic grader helpers over end state and journal.                             |
| `src/gym/bench/report.ts`    | Aggregation and the stdout table.                                                    |
| `src/gym/bench/analyze.ts`   | Diagnostics parsing, classification and the report, with the content rules enforced. |
| `src/gym/bench/types.ts`     | Shared types.                                                                        |
| `tests/bench.test.ts`        | Catalogue, graders, aggregation, `--dry-run` and analyzer tests.                     |

Both CLIs register `tsx` at startup so they import those TypeScript modules under plain `node`.

The synthetic Gym (`src/gym/workflow.ts`, `npm run gym`) is unchanged and unrelated: it grades a seeded, in-memory task board with no desktop involved.
