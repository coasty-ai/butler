# Harness cycles and the fix loop

A **cycle** is an unattended, repeatable measurement of Open Assist on your own Mac: every selected task, on every model in a matrix, several times, interleaved, while nobody is at the Mac. It writes a content-free `results.json` and `report.md`. The **fix loop** reads that report, turns its top failure classes into fix lanes, and uses the next cycle to decide whether a fix worked.

```
cycle -> report.md (failure classes, owners, example run ids)
      -> one lane per class (failing test first, fix, adversarial review)
      -> probe cycle on the affected cells -> merge -> next full cycle decides
```

`npm run bench` (docs/BENCHMARK.md) is the attended, one-model version of the same attempt; both scripts run it through `src/gym/bench/attempt.ts`.

## 1. What it never does

- It never sends, pays, publishes, installs or deletes user data, and never touches Messages or Mail: the catalogue invariants in `tests/bench.test.ts` hold for every task a cycle can select.
- It never answers yes to an approval unless `--approve-routine` is on **and** the task lists that exact question in `BenchTask.approve` **and** the question names nothing destructive. Everything else is declined and counted.
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

- Run `npm run cycle -- --preflight --time-box 4h`. It refuses, with a remedy for each, on:

  | Code                    | Meaning                                                                                                                                                                                                                                                                       |
  | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `APP_RUNNING`           | The Open Assist app is running. Quit it, or pass `--allow-app-running`.                                                                                                                                                                                                       |
  | `HARNESS_RUNNING`       | Another cycle or bench is running, from this or another checkout.                                                                                                                                                                                                             |
  | `PRESENCE_UNKNOWN`      | `ps` or `pmset` could not be read, so nothing can say whether another agent or a watched screen is here. Try again.                                                                                                                                                           |
  | `SCREENSAVER_TOO_SOON`  | The screensaver starts before the time box ends; the lock that follows would stall the gate until morning. Set Start Screen Saver to Never for the night (a delay never set counts as the macOS default, 20 minutes).                                                         |
  | `DISPLAY_HELD_BY_OTHER` | Something else holds the display awake. End it, or name the process with `--allow-display-holder caffeinate` if it is yours and nobody is watching; only the holders of that name running at the start are allowed, so another harness's caffeinate later is still a refusal. |
  | `LOCKED`                | The session is locked or not on the console.                                                                                                                                                                                                                                  |
  | `APP_RUN_ACTIVE`        | The app is running and its log shows a run still in flight. A run the log never saw settle while the app is not running (a crash, a force-quit) is ignored: it will never finish.                                                                                             |
  | `NO_LOCAL_SOURCE`       | A selected task writes to Calendar or Reminders and the agenda helper cannot confirm a local (unsynced) source: its `status` said none, or, at the start, `setup` failed (`NO_LOCAL_SOURCE`, `NO_ACCESS`). Only long-suite agenda tasks need it.                              |
  | `FIXTURE_PORT`          | A selected task needs the loopback fixture server and port 47831 is taken.                                                                                                                                                                                                    |

- The harness starts `caffeinate -d -w <its pid>`: the display stays on, and it ends with the harness. It never uses `-u`, which declares user activity.
- Do not leave a call or a video playing. A second cycle or bench is refused while this one runs.

A person reading the screen without touching it is invisible to every signal above. `--idle` is a floor, not proof of absence.

## 3. Requirements

Apple Silicon, macOS 14 or later, Node 22. `npm run build:native`, and Accessibility plus Screen Recording granted to the terminal that runs the harness (the start fails at once without them, before any wait). Provider keys in `.env`: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`.

## 4. Quick start

```
npm run cycle -- --dry-run                                  # plan, ceilings, estimate, gate, baseline
npm run cycle -- --preflight --time-box 4h                  # is this Mac ready for the night?
npm run cycle -- --matrix openai,google --tasks calculator --repeat 2 \
  --time-box 90m --i-know-this-drives-my-mac                # a short first cycle
npm run cycle -- --matrix openai:gpt-5.4-mini,google:gemini-3.5-flash-lite,anthropic:claude-sonnet-5 \
  --repeat 3 --time-box 4h --max-cost-model 8 --i-know-this-drives-my-mac   # a full night
npm run cycle -- --resume <cycle id> --i-know-this-drives-my-mac            # the next night
```

`--dry-run` loads no provider, controller or runner and writes nothing; a test checks the modules it loads. It refuses a plan whose estimate does not fit 80% of the time box: shard it (`--shard 1/3`, `2/3`, `3/3` on three nights) or cut `--repeat`. A shard is cut between (task, repeat) groups, never inside one, so every model meets every task it holds the same night and the models can still be compared within the cycle. It also refuses a cell the provider catalog cannot price (below).

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

| Plan                                          | Attempts | Time         | Ceiling at the caps | Typical      |
| --------------------------------------------- | -------- | ------------ | ------------------- | ------------ |
| Smoke suite, 12 tasks x 3 models x 3 repeats  | 108      | about 2.5 h  | $14.58              | $5-15        |
| One model, smoke suite x 3                    | 36       | about 45 min | $4.86               | $2-5         |
| Long suite (increment 2), 2 models x 1 repeat | about 64 | about 3 h    | per-model caps      | about $10-20 |

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
6. **Unknowns**: grader debt (`NO_ACCESSIBILITY`, `NO_END_STATE`, `GRADER_ERROR` for a grader that threw on its evidence, ...) counts against success; harness and environment skips (`NO_PREPARED_TARGET`, `BUDGET_EXHAUSTED`, `SKIPPED`, `MANUAL_TAKEOVER`, `MANUAL_INPUT_UNSEEN`) are excluded from the success denominator and reported apart. Over 10% unknown means a grader lane comes before any model lane. Leftovers (benchmark items cleanup could not remove) are listed here.
7. **Gate log**: waits by reason, the longest, and how often someone stayed at the Mac for over an hour.
8. **Attempts**: one line each.

How much a number can say: a 10-point change at 80% power needs about 390 attempts per arm at a 50% success rate (199 at 10% or 90%). One model on the smoke suite at `--repeat 3` is 36 attempts: its interval is about ±16 points and the z rule flags a drop of about 19. The report prints its own sensitivity next to the regression table (the drop it can flag, and the attempts per arm a 10-point drop from the baseline's rate would need), so "unchanged" is never read as "proven equal".

## 7. Regressions and exit codes

A baseline (`--baseline auto`) is the most recent finished cycle at the **same git revision and catalogue hash**, run from a clean tree, that covers this plan's tasks and shares a model; every such cycle at that revision is pooled. Cycles at different revisions or catalogue hashes are never compared (a grader change changes the metric), and neither is a cycle run from uncommitted changes (`DIRTY_TREE`: its revision names code it did not run); the report says why instead of printing a number. One baseline of the same design (the same matrix, tasks, repeats and shard, whatever the seed that ordered them): paired by task and repeat (McNemar). Otherwise the pooled two-proportion z test.

| Verdict        | Rule                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| `regression`   | success fell by 10 points or more at one-sided p < 0.05 (for a failure class: its rate rose) |
| `improvement`  | the mirror                                                                                   |
| `inconclusive` | a 10-point move without significance, or fewer than 12 attempts on a side                    |
| `new` / `gone` | a class in 3 or more attempts now and none before / none now in 36 or more attempts          |

A `PROVIDER_*` class moving by 10 points is reported as an environment shift that confounds the comparison. Those codes come from the analyzer over each cycle's own diagnostics log, which is why the comparison reads each cycle's stored failure classes rather than its rows.

Exit codes: `0` finished, no regression, nothing left behind; `1` finished with a regression or leftovers; `2` a usage error or a refusal; `3` stopped early (time box, cost cap, hand-off with `--stop-on-handoff`, Escape, error); `130` Ctrl-C. A low pass rate never sets the exit code: failures are results.

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
3. `--probe <CLASS> --baseline <cycle>` runs only the cells and categories the class touched, at the same caps and gate. A probe is evidence for a merge, never for "fixed": its tasks are the ones the fix was tuned on.
4. A class is **fixed** when, at the merged revision and in the next full cycle, its rate's Wilson upper bound is below 10% (5% for `HANDOFF_*` and `FALSE_DONE`, which breach trust), no agent-owned class rose by 10 points significantly, and no model's success regressed. It is **parked** after three lanes that failed to move it.

## 12. The Honesty Report

`results.json` (schema 2) is the unit of contribution: it carries `catalogueHash` and `harnessVersion`, and nothing about the contributor's screen. The Honesty Report is generated from every `output/harness/*/results.json` on a machine plus contributed files placed under `reports/<contributor>/<cycle>.json`; ingest re-runs the privacy check (no marker text, no URL, no home path, codes only). Rows are grouped by git revision and catalogue hash and never pooled across either. Per model: attempts, success with its interval, graded success, **false-done rate** (never hidden), agent hand-off rate, median actions, cost per success, cycles contributing. Rows under 30 attempts are shown as descriptive.

## 13. Limits

- Voice is not measured; a run starts from typed task text.
- One display, no VM reset: desktop drift between attempts is real, which is why the models are interleaved and the Finder is brought forward (through LaunchServices, not input) before every attempt.
- A person reading without touching is invisible to the gate.
- Until the long suite lands, tasks read nothing beyond the grading capture and cleanup only removes an empty bench folder; `--suite` and the suite's readers arrive with it.
