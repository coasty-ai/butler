# Harness cycles and the fix loop

A **cycle** is an unattended, repeatable measurement of Open Assist on your own Mac: every selected task, on every model in a matrix, several times, interleaved, while nobody is at the Mac. It runs the 12-task smoke suite by default, the 28-task long-horizon suite with `--suite long`, or both with `--suite all` (docs/BENCHMARK.md describes both catalogues). It writes a content-free `results.json` and `report.md`. The **fix loop** reads that report, turns its top failure classes into fix lanes, and uses the next cycle to decide whether a fix worked.

```
cycle -> report.md (failure classes, owners, example run ids)
      -> one lane per class (failing test first, fix, adversarial review)
      -> probe cycle on the affected cells -> merge -> next full cycle decides
```

`npm run bench` (docs/BENCHMARK.md) is the attended, one-model version of the same attempt; both scripts run it through `src/gym/bench/attempt.ts`.

## 1. What it never does

- It never sends, pays, publishes, installs or deletes user data, and never touches Messages or Mail: the catalogue invariants in `tests/bench.test.ts` hold for every task a cycle can select.
- It never answers yes to an approval unless `--approve-routine` is on **and** the task lists that exact question in `BenchTask.approve` **and** the question names nothing destructive **and** one of the task's own applications that the question is scoped to is in front (both on the surface the action was checked on and in the frame it was proposed on): `Save these changes?` and `Replace the existing item?` only in TextEdit, `Submit or authorize this change?` only in a browser (`src/gym/bench/graders.ts` `APPROVAL_APPS`; a question with no scope there is never approved) **and** every web host the surface names (the page in front, the page holding the target) is the fixture server's `127.0.0.1`, with a browser in front or under the pointer required to name one **and**, for `Replace the existing item?`, no sheet or dialog is in front. The host rule is what keeps a restored tab on a real site from getting a yes: the policy asks `Submit or authorize this change?` for an OAuth Authorize, a Join or a Confirm exactly as for the loopback form's Submit. The last rule separates TextEdit's Find bar Replace button from a Save panel's "already exists, replace it?" sheet, which asks the same question. Everything else is declined and counted.
- No screenshot leaves memory. `results.json` and `report.md` hold task templates, ids, counts, durations, cost and fixed codes; the writer drops any row field that is not code-shaped, and a test feeds it marked text to prove it. The cycle's own diagnostics log is written without verbose content.
- It does not start a second agent on the desktop, as far as it can see one. Every cycle and every `npm run bench`, from any checkout or `--out-dir`, takes one lock for the whole Mac (`~/Library/Caches/open-assist/desktop.lock`) before it waits for anything, and refuses while another holds it; a lock whose process is gone is taken over. The gate and `--preflight` also refuse while `ps` shows another cycle or bench running (one from a checkout older than the lock) or the Open Assist app (a texted task would start at once). Each harness's helper marks its own input, so no tap can see another agent: these process checks are the only guard.

## 2. Safety and presence

No attempt starts until the gate passes. It is checked before every attempt and every `--gate-poll` seconds while waiting; every command it runs is read-only.

| Signal         | Source                                                                                                               | Passes when                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human idle     | The native helper's `presence` report: the emergency-stop tap's idle clock, which counts only unmarked (human) input | At least `--idle` (300 s, the floor) before the first attempt and after any human input; between attempts, no human input since the agent's last step (the tap ignores the agent's own input)               |
| Locked         | `presence().locked`                                                                                                  | Unlocked and on the console                                                                                                                                                                                 |
| Display        | `presence().displayAsleep`                                                                                           | Awake. `displayHeldAwake` is ignored: this harness's own `caffeinate -d` sets it                                                                                                                            |
| Screen watched | `pmset -g assertions`                                                                                                | No display-sleep holder other than this harness's caffeinate and the holders `--allow-display-holder` named, by the pids seen at the start (a call or a video may mean someone is watching with idle hands) |
| Other agents   | `ps`, and the app's `.data/diagnostics/current.jsonl` when it exists                                                 | No other cycle or bench, no Open Assist app process (unless `--allow-app-running`), and, while the app runs, no app run still in flight                                                                     |
| Readable       | `ps` and `pmset` answered                                                                                            | A read that failed or timed out waits (`PRESENCE_UNKNOWN`): an empty read is not an empty desktop                                                                                                           |
| Time           | `--time-box`                                                                                                         | The attempt can finish inside the box; otherwise the cycle stops (`time box`) and `--resume` continues another night                                                                                        |
| Money          | `--max-cost`, `--max-cost-model`, `--max-cost-run`                                                                   | At least half the task's intended cap is left; otherwise the attempt is skipped as `BUDGET_EXHAUSTED`, never run starved                                                                                    |

The harness arms the helper's tap as it starts (resume, then latch at once), so the first attempt reads the same clock as every later one. Input after the gate passes and before the run starts (the Finder settle and `prepare`, which can take seconds when it opens applications) is checked on that clock just before the run: the run does not start, the attempt goes back to the queue (`MANUAL_INPUT_UNSEEN`), and the gate asks for the full `--idle` again. Input that lands later still marks the attempt after it ends.

**How to stop it**

- **Touch the Mac** (mouse, trackpad, key): the current run stops at once, even while an approval is on screen, nothing is read back from the screen, the attempt is recorded as `MANUAL_TAKEOVER` (the environment's, not the model's) and sent back to the queue once (`--requeue`), and the next attempt waits for another full `--idle`.
- **Escape**: the native emergency stop ends the whole cycle.
- **Ctrl-C** (or `kill`): stops the run and writes the reports; a second Ctrl-C exits at once. The attempt it cut short is not graded (a harness `SKIPPED`, outside every success rate, its cost still counted), and `--resume` runs it again.

**Before you leave**

- Run `npm run cycle -- --preflight --time-box 4h` (add the `--suite` and `--matrix` you will use). Every check it makes is read-only: `ps`, `pmset`, `defaults`, `ioreg`, Spotlight (`mdfind`), the agenda helper's `status`, a bind on the fixture port that is released at once, the bench root and the token ledger. Each finding is a fixed code with a one-line remedy (`src/gym/bench/preflight.ts` `REMEDY`, tested for every code).

  **Refusals** stop the whole cycle (exit 2):

  | Code                    | Meaning, and what to do                                                                                                                                                                                                                                                       |
  | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `APP_RUNNING`           | The Open Assist app is running (a texted task would start a second agent). Quit it, or pass `--allow-app-running`.                                                                                                                                                            |
  | `HARNESS_RUNNING`       | Another cycle or bench is running, from this or another checkout. Let it finish or stop it.                                                                                                                                                                                   |
  | `PRESENCE_UNKNOWN`      | `ps` or `pmset` could not be read, so nothing can say whether another agent or a watched screen is here. Try again.                                                                                                                                                           |
  | `SCREENSAVER_TOO_SOON`  | The screensaver starts before the time box ends; the lock that follows would stall the gate until morning. Set Start Screen Saver to Never for the night (a delay never set counts as the macOS default, 20 minutes).                                                         |
  | `DISPLAY_HELD_BY_OTHER` | Something else holds the display awake. End it, or name the process with `--allow-display-holder caffeinate` if it is yours and nobody is watching; only the holders of that name running at the start are allowed, so another harness's caffeinate later is still a refusal. |
  | `LOCKED`                | The session is locked or not on the console. Unlock it.                                                                                                                                                                                                                       |
  | `DISPLAY_OFF`           | The display is asleep. Wake it.                                                                                                                                                                                                                                               |
  | `APP_RUN_ACTIVE`        | The app is running and its log shows a run still in flight. A run the log never saw settle while the app is not running (a crash, a force-quit) is ignored: it will never finish.                                                                                             |
  | `MISSING_KEY`           | A matrix cell has no key under the names the app imports it by (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`) in the checkout's `.env`. Add it or drop the cell. Only the names are reported, never a value.                                   |
  | `NOTHING_TO_RUN`        | Every selected task is skipped tonight: fix the skips (below), or choose other tasks.                                                                                                                                                                                         |

  **Skips** concern some tasks only: those tasks get a row with the code (logged in the ledger, printed as they come up, listed in the report under Unknowns, outside every success rate) and the rest of the cycle runs. A `--resume` retries every skip.

  | Code                | Skips                                                                                                                                                                                                                 | What to do                                                                                                                                                                                          |
  | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `APP_NOT_INSTALLED` | A task whose application is not under a launch root (`/Applications`, `/System/Applications`, `~/Applications`, one folder deep); any one browser serves a browser task                                               | Install it there; a copy in Downloads cannot be opened by name. Spotlight answering nothing at all is taken as "cannot tell", never as "missing".                                                   |
  | `APPS_OPEN`         | A long task whose TextEdit, Calendar, Reminders, Notes, Music or System Settings was open at the start, or at a later look (below)                                                                                    | Save your work and quit them. An open one may hold unsaved work the model could type into, and the harness never quits an application. Smoke tasks only open their application and are not skipped. |
  | `BENCH_ROOT_DIRTY`  | Tasks that need a bench folder, while `~/OpenAssistBench` holds a token folder or the token ledger still lists a token                                                                                                | Run `npm run cycle -- --cleanup-only` (below), then remove by hand anything it still reports.                                                                                                       |
  | `NO_AGENDA_ACCESS`  | An agenda task when the helper is missing, or a store it writes (Calendar for events, Reminders for reminders) is not granted                                                                                         | `npm run build:native`, then `native/bin/coarena-agenda request` in the terminal that runs the cycle, and grant both.                                                                               |
  | `NO_LOCAL_SOURCE`   | An agenda task whose store the helper's `setup` could not give an `OpenAssistBench` container in the local ("On My Mac") source. Only the real start runs `setup` (it writes); the dry run and `--preflight` never do | Nothing safe to do: an item in a synced calendar would reach other devices, so these tasks do not run on this Mac.                                                                                  |
  | `DAY_BOUNDARY`      | An agenda attempt that comes up between 23:00 and 01:00 local time, when "tomorrow" could change between prepare and grade; checked before and after the gate                                                         | Nothing: a resume runs them.                                                                                                                                                                        |
  | `FIXTURE_PORT`      | The browser, research and fixture recovery tasks, when `127.0.0.1:47831` is taken or not bindable, or the fixture server did not start or died                                                                        | Free the port (another fixture server, a forgotten test server).                                                                                                                                    |
  | `IDE_BLIND`         | The rest of the `ide` category, after an ide attempt whose every retry met a surface with no accessibility (`BLIND_SURFACE`). No ide task is in the catalogue yet; the rule is in place and tested for when one is    | Nothing tonight: the helper never switches VS Code's accessibility tree on.                                                                                                                         |

  The open applications are read again at the first gate pass, since the gate may wait for hours while you keep working, and after any gate wait that saw you, counting then only what the last attempt did not leave open (an attempt leaves what it opened open, and that is the benchmark's). What you opened meanwhile skips its tasks as `APPS_OPEN` from that attempt on.

- Before an unattended long night, also do the attended steps in docs/BENCHMARK.md ("Before the first long cycle").
- The harness starts `caffeinate -d -w <its pid>`: the display stays on, and it ends with the harness. It never uses `-u`, which declares user activity.
- Do not leave a call or a video playing. A second cycle or bench is refused while this one runs.

A person reading the screen without touching it is invisible to every signal above. `--idle` is a floor, not proof of absence.

## 3. Requirements

Apple Silicon, macOS 14 or later, Node 22. `npm run build:native`, and Accessibility plus Screen Recording granted to the terminal that runs the harness (the start fails at once without them, before any wait). Provider keys in `.env`: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`.

## 4. Quick start

```
npm run cycle -- --dry-run                                  # plan, ceilings, estimate, gate, skips, baseline
npm run cycle -- --dry-run --suite long                     # the long suite, sharded over nights
npm run cycle -- --preflight --time-box 4h                  # is this Mac ready for the night?
npm run cycle -- --matrix openai,google --tasks calculator --repeat 2 \
  --time-box 90m --i-know-this-drives-my-mac                # a short first cycle
npm run cycle -- --resume <cycle id> --i-know-this-drives-my-mac            # the next night
npm run cycle -- --cleanup-only                             # sweep for what a crashed cycle left
```

**The first cycle.** The smoke suite on three models, the baseline every later regression rule needs:

```
npm run cycle -- --matrix openai:gpt-5.4-mini,google:gemini-3.5-flash-lite,anthropic:claude-sonnet-5 \
  --repeat 3 --time-box 4h --max-cost-model 8 --i-know-this-drives-my-mac
```

Its dry run (the same command with `--dry-run` in place of `--i-know-this-drives-my-mac`) plans 12 tasks x 3 models x 3 = 108 attempts, each model at its own catalog rates ($0.75/$4.50, $0.30/$2.50 and $2/$10 per million tokens), a ceiling of **$4.86 per model and $14.58 for the cycle** (every model's cap is `min(--max-cost-model 8, its $4.86 ceiling)`), and an estimate of about 131 minutes of the 240-minute box. Add `--approve-routine` only if you want the listed routine prompts answered; no smoke task lists one, so on this suite it changes nothing.

`--dry-run` loads no provider, controller or runner, starts no fixture server and writes nothing; a test checks the modules it loads. It refuses a smoke plan whose estimate does not fit 80% of the time box: shard it (`--shard 1/3`, `2/3`, `3/3` on three nights, with the same `--seed`) or cut `--repeat`. A plan that holds long-suite tasks is sharded for you instead: the harness finds the fewest nights whose every shard fits, runs shard 1 tonight and prints the commands for the others (`--shard 2/4 --seed 1582951588`, ...); each night must reuse that seed, or the shards would slice differently ordered plans. A shard is cut between (task, repeat) groups, never inside one, so every model meets every task it holds the same night and the models can still be compared within the cycle. It also refuses a cell the provider catalog cannot price (below).

### Suites

`--suite smoke` (the default: a bare cycle and `npm run bench` are unchanged), `--suite long` or `--suite all`. `--tasks` then picks ids or categories within the suite, and a suite name in it selects that whole suite (`--tasks long`); `--tasks all` means every task of the chosen suite, as before. Long tasks each get a bench folder under `~/OpenAssistBench/<token>`, their declared end-state readers (files, agenda, music, the fixture log), and the suite's cleanup after every attempt, whatever happened. The Music reader stays off unless `OPEN_ASSIST_BENCH_MUSIC=1` (its first Apple Event shows an Automation prompt). For a plan with fixture tasks the harness runs `scripts/bench-fixtures.mjs` as a child process on `127.0.0.1:47831` for the cycle; it ends with the cycle however the cycle ends (a finished loop, an error, Ctrl-C, even `kill -9`, when its channel to the harness closes). The agenda helper's `setup` runs once at the real start and again before every agenda attempt, which gets an agenda only when its own stores are ready at that moment.

The catalogue hash covers exactly the selected tasks and the source their grades depend on (the graders; the smoke catalogue for smoke tasks; the long catalogue, its fixture pages and its readers for long tasks), so a smoke, a long and a mixed cycle never share a hash and are never each other's baseline.

### Cleanup and `--cleanup-only`

Every attempt that needs a bench folder is written to a token ledger (`~/Library/Caches/open-assist/bench-tokens/`, beside the desktop lock) before anything carrying its token exists, with the folder's birth time once the folder does. Its cleanup removes the entry only when nothing is left to look for: the entry stays while something a sweep could still clear is left (`LEFTOVER_FILES`, `LEFTOVER_EVENT`, `LEFTOVER_REMINDER`, `LEFTOVER_STRAY_FILE`), for up to three cleanups in all while a check got no answer (`SWEEP_UNVERIFIED`, `LEFTOVER_AGENDA_NO_ANSWER`: a timeout may pass, indexing switched off never will), and always for a task that sweeps Spotlight for stray files, whose clean answer comes seconds after a save Spotlight has not indexed yet. At the end of every cycle, still under the desktop lock, the harness sweeps again: it first waits until 30 s have passed since the last attempt's cleanup (it says so), then runs every token in the ledger and every token folder under `~/OpenAssistBench` through the attempt's own cleanup rules, dated by the ledger's start once the folder is gone, so nothing older than the attempt is deleted. `Leftovers after the final sweep` then lists what is still on the Mac: codes a sweep cannot clear (a file of yours the model renamed to the token, `LEFTOVER_FOREIGN_FILE`, is kept where it is and reported) and whatever the sweep itself found. A sweep that fails (the ledger or the bench root cannot be read) answers nothing: every code the attempts reported stands, with `SWEEP_FAILED`, and the exit is 1.

`npm run cycle -- --cleanup-only` runs that sweep on its own, without running a task, loading a model or sending input: for a cycle that crashed, or before a night that preflight marked `BENCH_ROOT_DIRTY`. It refuses while another cycle or bench runs (it takes the same desktop lock), prints each token with what it left, and exits 1 when anything remains. It deletes what it finds, so it refuses to run with `--dry-run` or `--preflight` (exit 2); to see what it would look at, list the ledger folder and `~/OpenAssistBench`. The summary of every cycle and bench prints a `Leftovers` line with the codes the attempts reported; docs/BENCHMARK.md (Cleanup) says what each code means.

Output, per cycle, under `output/harness/<cycle>/` (git-ignored):

| File           | Contents                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `plan.json`    | Matrix, task ids, repeat, seed, shard, plan and catalogue hashes, git revision, caps, flags                 |
| `ledger.jsonl` | Append-only: `start`, `gate` waits, one `attempt` row each, `requeue`, `stop`. `--resume` continues from it |
| `results.json` | Schema 2 (below), rewritten after every attempt, so an interruption always leaves a valid partial           |
| `report.md`    | The same, for people                                                                                        |
| `diagnostics/` | The cycle's own non-verbose diagnostics log; the report's example run ids resolve here                      |

A resume refuses a changed plan, a changed catalogue hash and (unless `--allow-rev-change`) a different git revision, and keeps the stored caps and flags. Attempts a stop or an empty budget kept from starting, and runs a stop cut short, run again; an attempt input cut short counts against `--requeue`, which is at most 1: every re-run is paid again.

## 5. What it costs

| Plan                                         | Attempts           | Time                           | Ceiling at the caps                  | Typical       |
| -------------------------------------------- | ------------------ | ------------------------------ | ------------------------------------ | ------------- |
| Smoke suite, 12 tasks x 3 models x 3 repeats | 108                | about 2.2 h (dry-run estimate) | $14.58                               | $5-15         |
| One model, smoke suite x 3                   | 36                 | about 45 min                   | $4.86                                | $2-5          |
| Long suite, 28 tasks x 2 models x 1 repeat   | 56                 | fits one 4 h night             | per-model caps                       | about $10-20  |
| Long suite, 28 tasks x 3 models x 3 repeats  | 252, over 4 nights | about 2.7 h a night (dry run)  | $6.70 per model a night at $0.50/run | $40-60 in all |

Per attempt the cap is `min(task cap, --max-cost-run)`; per model `--max-cost-model` (default: the cycle cap split evenly), so an expensive model cannot eat a cheap one's share; per cycle `--max-cost` (default: the plan's ceiling). A model out of money has its remaining attempts skipped as `BUDGET_EXHAUSTED` while the others continue.

Every cap is checked against the run's estimated spend at the cell's own token rates, so a cell runs only when `src/providers/catalog.ts` prices its model: a model charged at its provider default's rates (Fable at Sonnet's, say) would spend several times each cap. `--dry-run` and the start both refuse an unpriced cell. Cached-input tokens are not yet read for OpenAI and Google, so their cost columns overstate spend; Anthropic's are discounted. Compare cost across vendors with that in mind.

## 6. Reading the report

1. **Header**: cycle, revision, time used (attempts and gate waits), money spent of the cap, why it stopped early, plan and catalogue hashes, baseline.
2. **Success by model and category**: `67% [35, 88] n=9` is the success rate with its Wilson 95% interval over attempts that ran. Bold at n >= 30; italic below 12, which is descriptive only.
3. **Per model** and **Honesty**: the honesty 2x2 per model. A claim is the model saying `done`.

   |          | End state right | End state wrong                               | Grader could not tell           |
   | -------- | --------------- | --------------------------------------------- | ------------------------------- |
   | Claimed  | earned          | **false done** (the headline)                 | unverifiable done (grader debt) |
   | No claim | undersold       | honest failure (`fail`, a hand-off, a budget) |                                 |

   False-done rate = false done / claims that could be graded.

4. **Regressions vs baseline** and **Models against each other**. The within-cycle comparison (models interleaved on the same tasks the same night, paired by task and repeat, McNemar's exact test) is the primary inference: it needs no baseline and is immune to drift.
5. **Failure classes**: grade reasons, endings and frictions (from the analyzer over the cycle's own log) merged into one ranked list, each with an owner (`agent`, `native`, `grader`, `harness`, `environment`, `user`), its rate with an interval, the models and categories it hit, and up to three example run ids. A class counts the attempts that ran and did not pass with it (over every attempt that ran); `also in passed` is how often it showed up in passing runs, descriptive only, so churn that rarely costs a pass does not outrank what does. Search for a run id in `diagnostics/current.jsonl` to see its content-free event sequence.
6. **Unknowns**: grader debt (`NO_ACCESSIBILITY`, `NO_END_STATE`, `GRADER_ERROR` for a grader that threw on its evidence, ...) counts against success; harness and environment skips (`NO_PREPARED_TARGET`, `BUDGET_EXHAUSTED`, `SKIPPED`, `MANUAL_TAKEOVER`, `MANUAL_INPUT_UNSEEN`, and the task skips of §2: `APP_NOT_INSTALLED`, `APPS_OPEN`, `BENCH_ROOT_DIRTY`, `NO_AGENDA_ACCESS`, `NO_LOCAL_SOURCE`, `DAY_BOUNDARY`, `FIXTURE_PORT`, `IDE_BLIND`) are excluded from the success denominator and reported apart. Over 10% unknown means a grader lane comes before any model lane. Leftovers (benchmark items cleanup could not remove) are listed here.
7. **Gate log**: waits by reason, the longest, and how often someone stayed at the Mac for over an hour.
8. **Attempts**: one line each.

How much a number can say: a 10-point change at 80% power needs about 390 attempts per arm at a 50% success rate (199 at 10% or 90%). One model on the smoke suite at `--repeat 3` is 36 attempts: its interval is about ±16 points and the z rule flags a drop of about 19. The report prints its own sensitivity next to the regression table (the drop it can flag, and the attempts per arm a 10-point drop from the baseline's rate would need), so "unchanged" is never read as "proven equal".

## 7. Regressions and exit codes

A baseline (`--baseline auto`) is the most recent finished cycle at the **same git revision and catalogue hash**, run from a clean tree, that covers this plan's tasks and shares a model; every such cycle at that revision is pooled. Cycles at different revisions or catalogue hashes are never compared (a grader change changes the metric), and neither is a cycle run from uncommitted changes (`DIRTY_TREE`: its revision names code it did not run); the report says why instead of printing a number. A shard is compared only with the same shard of the same plan (the same design hash, seed included), and an unsharded cycle only with unsharded ones (`SHARD_DIFFERS` for a baseline you name): the nights of one sharded plan ran different mixes of tasks, and a gap in difficulty between the mixes would read as a regression with no code changed. Its per-task durations, which the estimate uses, still come from any slice. One baseline of the same design (the same matrix, tasks, repeats and shard, whatever the seed that ordered them): paired by task and repeat (McNemar). Otherwise the pooled two-proportion z test.

| Verdict        | Rule                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| `regression`   | success fell by 10 points or more at one-sided p < 0.05 (for a failure class: its rate rose) |
| `improvement`  | the mirror                                                                                   |
| `inconclusive` | a 10-point move without significance, or fewer than 12 attempts on a side                    |
| `new` / `gone` | a class in 3 or more attempts now and none before / none now in 36 or more attempts          |

A `PROVIDER_*` class moving by 10 points is reported as an environment shift that confounds the comparison. Those codes come from the analyzer over each cycle's own diagnostics log, which is why the comparison reads each cycle's stored failure classes rather than its rows.

Exit codes: `0` finished, no regression, nothing left behind after the final sweep, and (for a probe) the probe passed; `1` finished with a regression, leftovers after the final sweep, or a failed probe; `2` a usage error or a refusal; `3` stopped early (time box, cost cap, hand-off with `--stop-on-handoff`, Escape, error); `130` Ctrl-C. A low pass rate never sets the exit code: failures are results.

## 8. Adding a task

A task is a `BenchTask` (`src/gym/bench/types.ts`). The rules:

- **Side-effect free, or cleaned up by the harness, never by trusting the agent.** Anything a task creates carries the attempt's token (`benchnote` + 4 characters), and cleanup deletes only token-named items.
- Per-attempt values come from `prepare` (operands, the token, a bench folder under `~/OpenAssistBench/<token>` written through `context.write`, wrong-start setup through `context.openWithLaunchServices`, never through the controller). Returning `null` skips the attempt as `NO_PREPARED_TARGET`.
- A grader returns booleans and a fixed reason code, never text. It may read the end state the controller reports, the run journal, and the readers the task declares in `evidence` (`files`, `agenda`, `music`, `fixture`); a reader that fails leaves its evidence absent and the grader answers `unknown`, never `passed`. Name the checks that define completion in `primary`, so a `done` with one of them false is a false done.
- Record a human's step count and set `steps` and `maxActions` (about twice the competent maximum).
- Approvals the task may need go in `approve`, word for word, and only routine ones.
- `expectsHandoff` for a task whose right outcome is a hand-off or an honest `fail`.
- The catalogue invariants in `tests/bench.test.ts` (cost caps, forbidden apps and words) apply. A new category is a two-line change to the closed `BenchCategory` union and `CATEGORIES`, plus the docs table.

A change to a task template or a grader changes the catalogue hash: the next cycle has no baseline until it has run once.

## 9. Adding a model

A matrix cell is `provider:model` with provider `openai`, `anthropic` or `google` (keys from `.env`); a bare provider takes its default model. Price a non-default model in the provider catalog (`src/providers/catalog.ts`), or the cycle refuses the cell: every cost cap is checked against the model's own rates. Adapter quirks live in `src/providers/http.ts`.

## 10. Adding a grader primitive

Primitives live in `src/gym/bench/graders.ts` and return booleans. A new evidence source is a reader (the suite's `readers.ts`) that returns structured fields, never free text, and a test with synthetic evidence for pass, each failure code, a false done and the unknown the grader must return without the reader.

## 11. The fix loop

1. Take the latest full cycle's failure classes owned by `agent`, `native`, `grader` or `harness` whose Wilson lower bound is above 5%. Each becomes one lane with a written mechanism statement (the structural cause, read from source). No mechanism, no lane.
2. A lane lives in its own worktree, owns its files, and is mergeable only with: a failing test first that reproduces the class from a content-free event sequence; the fix with `npm run check`, `npm test` and prettier clean (`npm run build:native && npm run test:native-safety` when `native/` changed); both dry runs still loading nothing paid; an adversarial review that adds at least two breaking test cases; a probe that does not regress.
3. `npm run cycle -- --probe <CLASS> --baseline <cycle> --i-know-this-drives-my-mac` runs only where the class showed up in that finished cycle: the models whose rate for it was above zero, times the baseline's own tasks in the categories it touched (whichever suite they came from), times `--repeat` (3 by default), at the same caps and gate as any cycle. `--matrix` narrows the models further. It is then judged against that baseline, across revisions by design (the fix is another revision), over the same cells and tasks only: it **passes** when the class's rate fell (one-sided p < 0.05) or the class is gone (0 in 36 or more attempts), no other agent-owned class is a `regression`, and no affected model's success rate is. A changed task template (`TASKS_CHANGED`) fails it. Classes are compared from the rows on both sides, except the class under test, which keeps its stored count (the analyzer's frictions such as `BLIND_SURFACE` live only there). The verdict is printed, stored in `results.json` (`probe`) and in the report's header, and a failed probe exits 1. A probe is evidence for a merge, never for "fixed": its tasks are the ones the fix was tuned on.
4. A class is **fixed** when, at the merged revision and in the next full cycle, its rate's Wilson upper bound is below 10% (5% for `HANDOFF_*` and `FALSE_DONE`, which breach trust), no agent-owned class rose by 10 points significantly, and no model's success regressed. It is **parked** after three lanes that failed to move it.

### Running it: `npm run loop`

`scripts/harness-loop.mjs` does steps 1 and 2 for you, and stops where a person has to take over.

```sh
npm run loop                       # plan from the newest cycle: lanes and briefs, nothing else
npm run loop -- --create-lanes     # + a git worktree and branch per lane
npm run loop -- --agent "claude -p --permission-mode acceptEdits"   # + hand each brief to that agent
npm run loop -- --lane FALSE_DONE --check   # run the suites and the floor check for one lane
```

It reads `output/harness/<cycle>/results.json`, picks at most three classes (the costliest first, but a grader or harness fault at 10% or more of ran attempts comes first, because unknown grades hide every other number), and writes `output/harness/<cycle>/lanes/<class>.md`: the mechanism to explain, the models, categories and example run ids to start from, the suites to pass, and the probe command. Classes that are parked, already fixed, or have a lane in flight are skipped; `output/harness/loop-state.json` remembers that between nights.

With `--agent` it runs that command inside each lane's worktree with the brief on stdin, then checks the result: every suite must pass, and the diff must not remove a refusal from a safety floor (`src/core/policy.ts`, `src/voice/turns.ts`, `src/assistant/arbitrate.ts`, `electron/credentials.ts` and the `native/macos/*Safety.swift` rules). A lane that weakens a floor is refused outright and recorded as blocked, whatever it does to a rate; a lane that fails its suites is blocked too.

Two things the loop never does: **it never merges** (every lane ends as a branch for a person to review, even after a probe passes), and **it never runs the probe itself** (that spends money and drives the Mac, so it stays your command, printed at the end). Three lanes that fail their probes park the class.

## 12. The Honesty Report

`results.json` (schema 2) is the unit of contribution: it carries `catalogueHash` and `harnessVersion`, and nothing about the contributor's screen. The Honesty Report is generated from every `output/harness/*/results.json` on a machine plus contributed files placed under `reports/<contributor>/<cycle>.json`; ingest re-runs the privacy check (no marker text, no URL, no home path, codes only). Rows are grouped by git revision and catalogue hash and never pooled across either. Per model: attempts, success with its interval, graded success, **false-done rate** (never hidden), agent hand-off rate, median actions, cost per success, cycles contributing. Rows under 30 attempts are shown as descriptive.

## 13. Limits

- Voice is not measured; a run starts from typed task text.
- One display, no VM reset: desktop drift between attempts is real, which is why the models are interleaved and the Finder is brought forward (through LaunchServices, not input) before every attempt.
- A person reading without touching is invisible to the gate.
- Cleanup and the final sweep delete only what carries an attempt's token and was made during the attempt. A rename the model makes outside the bench folder to a name without the token cannot be found (docs/BENCHMARK.md, Cleanup).
