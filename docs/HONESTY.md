# Honesty Report

How often Open Assist, driving a Mac with a given model, **claimed a task it did not finish**. The tables at the end of this page are generated from the unattended benchmark harness. Everything above them is written by hand and says how to read them, who produced them, and what they can and cannot contain.

The headline number is the **false-done rate**: of the attempts in which the model said `done` and the grader reached a verdict, the share whose verified end state was wrong. A model that gets a task wrong and says so has failed. A model that gets it wrong and says `done` has failed in the way this report exists to count.

## Method

**Where the numbers come from.** Every row is built from `results.json` files (schema 2) written by the harness cycle runner (`scripts/harness-cycle.mjs`, documented in `docs/HARNESS_LOOP.md`). The runner drives this Mac unattended through the same runner, policy and native controller the app uses, one task at a time, across a matrix of models. `docs/BENCHMARK.md` describes the tasks, the graders and what "verified end state" means for each. `node scripts/honesty-report.mjs` reads the maintainers' own cycles (`output/harness/*/results.json`) and every contributed file under `reports/`, and renders the tables. `src/gym/honesty.ts` holds the logic, and `tests/honesty-report.test.ts` checks it on synthetic results.

**What is counted.** For each model (a cell, `provider:model`) within one revision group:

| Column            | Definition                                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ran by            | `maintainers` for this repository's own `output/harness`, the folder name for a file under this repository's `reports/<contributor>/`, `unattributed` for a file anywhere else, including an `output/harness` folder outside this repository. |
| Attempts          | Planned attempts that reached the results file.                                                                                                                                                                                               |
| Ran               | Attempts the model actually got. Harness and environment skips (`NO_PREPARED_TARGET`, `BUDGET_EXHAUSTED`, `SKIPPED`, `MANUAL_TAKEOVER`, `MANUAL_INPUT_UNSEEN`) are excluded because the model never got a fair run.                           |
| Success [95%]     | passed / ran, with a Wilson 95% interval. A grader `unknown` counts against success on purpose: an attempt nobody can verify is not a success.                                                                                                |
| Graded            | passed / (passed + failed): the rate over attempts that got a verdict.                                                                                                                                                                        |
| False done [95%]  | Attempts with run status `completed` and grade `failed`, over attempts with run status `completed` and a verdict (`passed` or `failed`), with a Wilson 95% interval. Shown as k/n whatever n is, and never hidden.                            |
| Unverifiable done | The model said `done` and the grader could not tell. This is grader debt. It is reported separately so it can neither inflate nor hide the false-done rate.                                                                                   |
| Hand-offs         | Share of ran attempts in which the agent handed the task back to the user at least once (`request_user`, an unidentified target, the policy or a protected surface). Real input on this Mac is a harness skip, not a hand-off.                |
| Median actions    | Over ran attempts.                                                                                                                                                                                                                            |
| $/success         | Every attempt's cost in the cell divided by its passes. Failures are paid for.                                                                                                                                                                |
| Cycles            | How many cycles contributed to the row.                                                                                                                                                                                                       |

A second table gives the whole honesty 2x2 per model as counts: what the model said (`done` or not) against what the grader found (passed, failed, unknown). "Not done, failed" is an honest failure: the model gave up, handed off or ran out of budget, and the end state is indeed wrong. "Not done, passed" includes the tasks whose correct outcome is a hand-off. A third table gives success by category (passed/ran) with one column per model. It is descriptive: a cell holds a handful of attempts.

The definitions are the harness's own (`honesty()` and `ran()` in `src/gym/bench/report.ts`). The report recomputes them from each row's run status and grade rather than reading the row's flags, so drift in a writer cannot move the headline.

**Cost basis.** Cost is the runner's own estimate from the token usage the provider reports, at the standard rates for that exact model id in `src/providers/catalog.ts` (`modelPrices`, checked against each vendor's price list on the date in its comment). The benchmark scripts hand the model to `selectProvider`, which prices it from that table; a model the table does not price gets zero rates and the provider refuses to start, so no row is priced at another model's rate. `tests/provider-usage.test.ts` fails if a script that runs a model picks it after the provider instead. An announced price change is in the table with its date (Gemini 3.6, 3.7 and 3.8 Flash rise to $1.50/$7.50 on 2027-01-01), and a cycle set up on or after that date is charged the new rate.

Prompt-cache reads are charged at the cached rate for Anthropic, and for the OpenAI and Google models whose cached rate the table lists (a tenth of the input rate for every one listed). Any other model's cached tokens are charged at the full input rate, because cached rates differ by model (GPT-4o's is half its input rate) and an understated cost would let a run past its budget. Revisions before 2026-09-18 charged OpenAI's `cached_tokens` and Gemini's `cachedContentTokenCount` at the full input rate, which overstated those two vendors against Anthropic; their costs are not comparable with later groups. The remaining known biases all overstate cost: a gateway endpoint gets no cache discount because its upstream rate is unknown; Gemini 3.5 Flash-Lite lists no caching price, so its cached tokens are charged in full; Claude Fable 5.1 cache hits cost 0.025x input but are charged at the 0.1x every Anthropic model gets; GPT-5.5 and GPT-5.4 above 272k prompt tokens and Gemini Pro above 200k are charged at the small-prompt rate (one step here is far smaller); and a price rise is charged from midnight UTC, a few hours before the vendor's own midnight. Gemini's hourly cache storage is not in the response and is not counted.

**Intervals.** The Wilson score interval is used rather than the normal approximation because cells are small and rates sit near 0% or 100%. Its bounds stay inside [0, 100], and 0 of n gets a real upper bound: 10% at n = 36, 6% at n = 60, 4% at n = 90. A row with fewer than 30 ran attempts is marked † and is descriptive only. At n = 9 the interval on a 50% rate is ±27 points, at n = 36 ±16, and at n = 90 ±10. Detecting a ten-point difference between two models with 80% power needs roughly 390 attempts per model at a 50% baseline. Nothing on this page is that large yet, and the intervals show it.

**Grouping.** Rows are never pooled across a git revision or a catalogue hash. A code change changes the subject and a grader change changes the metric, so each (revision, catalogue) pair is its own group with its own tables. A short and a full hash of the same commit count as one revision; a short hash that two different commits share stays apart. A cycle from a tree with uncommitted changes, or from a file that does not say whether the tree was clean, is a revision of its own. A cycle resumed at a different revision (the cycle runner's `--allow-rev-change`) is refused with `REV_CHANGED`: its rows do not say which revision each ran at, so it can be neither placed nor split. The report finds this from the revision in the cycle's own `plan.json` beside its results, or from `cycle.gitRevs` where a file records every revision it ran at; a contributed file with neither cannot show it. A cycle that arrives twice (same id and start, say a maintainers' file also copied under `reports/`) is counted once. Groups are listed newest first.

**Ranking.** There is none. Within a group, rows are in cell-name order. Compare models by their intervals, and only within a group. Comparisons across groups are confounded by the code, the tasks and the environment, and the report does not make them.

## Conflict of interest

The people who build Open Assist run these benchmarks, write the graders and publish this page. That is a conflict of interest, and the page is designed around it:

- Every row from this repository's own `output/harness` is marked **maintainers** in the "Ran by" column. Rows contributed by others carry the contributor's folder name.
- Rows are **unranked**. The maintainers do not get to put their preferred model first, and neither does anyone else.
- The false-done column is never hidden or footnoted away, whatever it says about the product.
- The graders are deterministic. They read the end state through the same native controller the app uses, never compare screenshots, and never trust the model's own summary. `unknown` is a first-class outcome and counts against success. The graders are in `src/gym/bench/graders.ts` and `src/gym/bench/catalogue.ts`, with tests, so a grader that flatters the product can be found by reading it.
- The maintainers chose the tasks. A task set can favour one model's strengths over another's; the catalogue hash in each group heading names exactly which tasks and graders produced it.
- Anyone can reproduce a row. The harness, the tasks, the prices and this script are in the repository, and a contributed `results.json` is accepted on the same terms as the maintainers' own.

The failures that make these numbers worse (a model that says `done` without doing the task, a hand-off that should have been a completion, an unverifiable end state) are the ones the harness exists to find. The fix loop in `docs/HARNESS_LOOP.md` works from the same files.

## What is collected, and what is not

A results file is content-free by construction and is checked for that again on ingest. It contains:

- Task ids, categories and difficulties, and the task's instruction **template**. It never holds a filled instruction, which could name one of the user's files.
- Counts: actions, approvals, retries, hand-offs by source, loops, no-progress steps, model calls, tokens.
- Durations, costs and timestamps.
- Fixed reason codes (`HOST_MISMATCH`, `NO_ACCESSIBILITY`, `STOPPED_AFTER_HANDOFF`, …), grade checks by name, and the run's status.
- Model ids, provider names, the git revision, whether the tree was dirty, the catalogue hash, the harness version, and the macOS version and architecture.

It never contains screen text, screenshots, window titles, page addresses, file names or paths, typed text, spoken text, the user's name or account, or any key.

The ingest check in `src/gym/honesty.ts` refuses a whole file when:

- anything in it holds an address (`http`), a home path (`~/`, `/Users/`, `/home/`), or an attempt marker (`benchnote` plus four characters, which only an attempt's parameters carry);
- a row has a code outside `^[A-Z][A-Z0-9_]*$` or a known field outside its fixed shape;
- a row has an unknown string or key that could be a sentence, a file name or a path.

A contributed file is published whole, so the check covers the whole file, not only the rows the tables use. A refused file is listed under "Excluded files" with its codes, and nothing from it is counted. A file outside the repository is named by its last two path segments only. The rendered report is checked once more for an address, a home path or a marker, and is not written if one is found.

Nothing is uploaded by this script. Publishing is a git commit of this page.

## Contributing a results file

Run a cycle on your own Mac (`docs/HARNESS_LOOP.md`), then place `output/harness/<cycle>/results.json` at `reports/<your-name>/<cycle>.json` in a pull request. `node scripts/honesty-report.mjs --only --strict reports/<your-name>/` shows what the report will make of it and exits non-zero if the ingest check refuses it. Your row is grouped with everyone else's at the same revision and catalogue hash, marked with your folder name, and ranked no higher or lower than anyone's. Because the file records only templates, ids, counts and codes, contributing one reveals nothing about your screen.

## What this page cannot tell you

- How Open Assist does on your Mac, with your apps and your settings. Every row comes from someone's own machine.
- Anything about voice. The harness hands each instruction to the runner as text.
- Whether someone watched the screen during a run without touching it. The presence gate sees input, not eyes.
- Anything at all from a row with a handful of attempts. The † marks those.

## Regenerating this page

```
node scripts/honesty-report.mjs --out docs/HONESTY.md
```

This reads both sources, `output/harness` and `reports/`. A path given on the command line is read as well, never instead; only `--only` narrows the input, and it is meant for checking one file, not for this page. Only the section between the markers below is replaced; the text above them is kept. If the markers are missing, the section is appended; if they do not pair up, nothing is written. `--json` never writes over this page: with `--out` it takes only a `.json` file.

<!-- honesty-report:begin -->

## Results

Generated 2026-09-18 from 0 cycle(s), 0 attempt(s), in 0 revision group(s). Every row is Open Assist driving the named model. Numbers are never pooled across revisions or catalogues. Rows are listed by provider and model, never ranked; a row run by the maintainers of Open Assist says so. A row with fewer than 30 attempts ran is marked † and is descriptive only.

_No cycles have been ingested yet. Run a harness cycle, then `node scripts/honesty-report.mjs --out docs/HONESTY.md`._

<!-- honesty-report:end -->
