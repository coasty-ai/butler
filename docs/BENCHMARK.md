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
- It **stops at the first hand-off** (`takeover` or `paused`), because nobody is there to say continue. `--continue-on-takeover` keeps going after an agent hand-off instead.
- Every existing stop path still works: the native emergency stop, real mouse or key input, Ctrl-C. Each stops the current run and ends the benchmark, whatever the flags; an Escape or Ctrl-C between attempts skips the next one instead of starting it.
- Approvals are **declined** by default and counted; a declined approval is a real result. `--approve-routine` approves only a prompt the task lists word for word in `BenchTask.approve`, and never one that names a send, delete, payment, order, subscription, sign-in, quit, reset or discard, whatever the task lists. No smoke task lists any, so on the smoke suite the flag approves nothing.
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
| `--continue-on-takeover`               | Do not stop the benchmark at the first agent hand-off. Real input on this Mac always stops it.                            |
| `--approve-routine`                    | Approve only the prompts a task lists as routine (`BenchTask.approve`), never a destructive one.                          |
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
| `calculator-multiply`      | calculator / medium   | Open Calculator and multiply {a} by {b} _(drawn per attempt)_       | Calculator is frontmost, its accessibility text shows the product, and the journal shows the operands entered in Calculator              | $0.15 |
| `calculator-percent`       | calculator / hard     | In Calculator, work out {a} percent of {b} _(drawn per attempt)_    | Calculator is frontmost, its accessibility text shows the whole-number answer, and the journal shows the operands entered                | $0.20 |
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
- A run the **agent** handed off is `failed`, named by what asked for it: `HANDOFF_REQUEST_USER`, `HANDOFF_TARGET` (repeated unidentified targets), `HANDOFF_POLICY`, `HANDOFF_SURFACE`. It did not automate the task. A task marked `expectsHandoff` is graded on the hand-off itself instead.
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
| `MANUAL_TAKEOVER` / `HANDOFF_*` / `RUN_NOT_SETTLED`                              | See above.                                                                      |
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

- **success rate** = passed / ran. Grader unknowns count against it, deliberately: an attempt nobody can verify is not a success. Harness skips (`NO_PREPARED_TARGET`, `MANUAL_TAKEOVER`, an attempt a stop kept from starting) are reported as **skipped** and never count.
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

## 1b. The long-horizon suite

Twenty-eight tasks of 10 to 40 steps each, across the Finder, TextEdit, Calendar, Reminders, Calculator, Music, System Settings and a browser, defined in `src/gym/bench/catalogue-long.ts` with `suite: "long"`. The smoke suite above is unchanged and stays the default.

**How to run it.** Not yet from `npm run bench`: that script still runs the smoke catalogue only, and a long task needs the per-attempt bench folder, fixture server and agenda helper that the attempt runner provides. A harness selects tasks with `selectSuite(selector, suite)` and `catalogueFor(suite)` from `catalogue-long.ts` (a selector of `long` or `all` picks a whole suite; ids and categories resolve against the suite chosen), and reads the end state and cleans up with `readEvidence` and `cleanupAttempt` from `src/gym/bench/readers.ts`, which implement the `EvidenceReaders` and `Cleanup` contract in `types.ts`. `writeInside` in the same file backs `PrepareContext.write`, and `agendaFor(task)` builds `PrepareContext.agenda` for one attempt (below).

**What the harness must do for the suite's safety to hold.** Create the attempt's bench folder empty immediately before `prepare()`: cleanup dates the attempt by that folder's birth time and deletes nothing older (see Cleanup). Build `PrepareContext.agenda` per attempt with `agendaFor(task)` and pass nothing else: it is `undefined` unless every store the task writes is granted and has its local `OpenAssistBench` container, and an agenda task's `prepare()` skips without it. When answering an approval, also require that the frontmost application is one of `task.apps`, and for `Replace the existing item?` that no sheet or dialog is in front: the policy asks the same question for the Find bar's Replace and for the Save panel's overwrite confirmation, and the reason string alone cannot tell them apart.

### Where an attempt may work

Every attempt gets a token (`benchnote` plus four base-36 characters, a name nothing of yours has) and works only inside that token's namespace:

- **Files**: the folder `~/OpenAssistBench/<token>`, which the harness creates empty before `prepare()` writes the task's fixture files into it. Every instruction that works on files names the folder, and the Finder tasks open it in the Finder before the run starts, so the model begins in the right window. Every file the model is asked to open in TextEdit is named with the token too (`<token>-notes.txt`, `<token>-budget.txt`), so a search, Open Recent or the Open panel can only match the benchmark's file, never a document of yours called `notes.txt` or `budget.txt`.
- **Calendar and Reminders**: items titled with the token, in a calendar and a reminders list called `OpenAssistBench` that the agenda helper creates in the **local** source ("On My Mac"), which does not sync to your other devices. The graders fail an item written to any other calendar (`WRONG_CALENDAR`, `WRONG_LIST`), including a synced calendar that happens to share the name.
- **Web pages**: `http://127.0.0.1:47831/<token>/...`, served by `scripts/bench-fixtures.mjs` on the loopback interface only. The pages link only to the same token's registered pages, load nothing external, and carry `Content-Security-Policy: default-src 'self'` plus a `style-src` hash that admits only the pages' own inline stylesheet.

Nothing in the suite sends, buys, installs or deletes anything by instruction, touches Messages or Mail, or signs in anywhere.

### The tasks

| id                           | Category / difficulty  | Steps | Actions / time | Cap   | Readers        | Primary checks         |
| ---------------------------- | ---------------------- | ----- | -------------- | ----- | -------------- | ---------------------- |
| `research-fact-note`         | research-note / medium | 12-22 | 44 / 500s      | $0.40 | files, fixture | noted                  |
| `research-compare-note`      | research-note / medium | 15-25 | 50 / 560s      | $0.40 | files, fixture | noted                  |
| `research-list-note`         | research-note / hard   | 20-35 | 70 / 760s      | $0.60 | files, fixture | noted                  |
| `agenda-cal-create-tomorrow` | agenda / medium        | 10-20 | 40 / 460s      | $0.25 | agenda         | exists, day, start     |
| `agenda-cal-move`            | agenda / hard          | 10-25 | 50 / 560s      | $0.40 | agenda         | single, start          |
| `agenda-rem-create`          | agenda / medium        | 10-16 | 32 / 380s      | $0.25 | agenda         | exists, due            |
| `agenda-rem-complete`        | agenda / medium        | 10-14 | 28 / 340s      | $0.25 | agenda         | completed              |
| `agenda-rem-two`             | agenda / hard          | 16-30 | 60 / 660s      | $0.40 | agenda         | dentist, permit        |
| `files-rename-pattern`       | files / medium         | 10-18 | 36 / 420s      | $0.25 | files          | renamed                |
| `files-new-folder-move`      | files / medium         | 10-18 | 36 / 420s      | $0.25 | files          | folder, moved          |
| `files-sort-by-type`         | files / hard           | 25-40 | 80 / 860s      | $0.60 | files          | textSorted, dataSorted |
| `files-compress`             | files / medium         | 10-16 | 32 / 380s      | $0.25 | files          | zip                    |
| `text-append-line`           | text-editing / medium  | 10-15 | 30 / 360s      | $0.25 | files          | appended               |
| `text-new-doc-save`          | text-editing / hard    | 15-30 | 60 / 660s      | $0.40 | files          | saved, content         |
| `text-find-replace`          | text-editing / medium  | 12-25 | 50 / 560s      | $0.40 | files          | replaced               |
| `browser-nav-chain`          | browser / medium       | 10-16 | 32 / 380s      | $0.25 | fixture        | onOrder                |
| `browser-form-submit-local`  | browser / medium       | 12-22 | 44 / 500s      | $0.40 | fixture        | submitted              |
| `browser-find-in-table`      | browser / medium       | 12-20 | 40 / 460s      | $0.25 | fixture        | onItem                 |
| `media-search-library`       | media / medium         | 10-16 | 32 / 380s      | $0.25 | music          | query, notPlaying      |
| `settings-about`             | settings / medium      | 10-16 | 32 / 380s      | $0.25 | none           | onAbout                |
| `settings-search-about`      | settings / medium      | 10-14 | 28 / 340s      | $0.25 | none           | onAbout                |
| `multi-page-calc-note`       | multi-app / hard       | 18-30 | 60 / 660s      | $0.40 | files, fixture | noteTotal              |
| `multi-draft-to-reminder`    | multi-app / hard       | 15-30 | 60 / 660s      | $0.40 | agenda, files  | reminder, due          |
| `multi-folder-note-event`    | multi-app / hard       | 20-40 | 80 / 860s      | $0.60 | agenda, files  | event, day, start      |
| `recovery-wrong-folder`      | recovery / medium      | 10-18 | 36 / 420s      | $0.25 | files          | renamed                |
| `recovery-stale-draft`       | recovery / medium      | 12-20 | 40 / 460s      | $0.25 | files          | appended               |
| `recovery-wrong-page`        | recovery / medium      | 12-22 | 44 / 500s      | $0.40 | fixture        | total                  |
| `recovery-missing-file`      | recovery / medium      | 10-15 | 30 / 360s      | $0.25 | files          | handedOff              |

Each task carries its instruction template, a safety note and what it verifies, for a dry run to print. Budgets come from the step range: actions are about twice the generous maximum (capped at 80), time is 60 s plus 10 s an action (capped at 900 s), and the cap is $0.25, $0.40 or $0.60 by length. **The ceiling is $9.55 per pass at caps**; measured spend runs at roughly a third of caps for `gpt-5.4-mini` and two thirds for `claude-sonnet-5`, so set per-model caps explicitly rather than one `--max-cost` for a multi-model cycle.

Numbers on pages (employee counts, prices, order totals) and the correct answers are drawn per attempt, so a remembered answer cannot pass. Several tasks start from the **wrong place on purpose**, set up through LaunchServices (`open`), never through the controller and never with synthetic input: `recovery-wrong-folder` opens a decoy subfolder, `recovery-stale-draft` opens the wrong document, `recovery-wrong-page` opens a decoy orders page with different totals, and both settings tasks start System Settings on the General pane so that About is never left over from the previous attempt.

### How the long graders verify

Every long grader reads the end state back through a reader the task declared, never the model's own report:

| Reader    | What it reads                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `files`   | The bench folder, walked without following symlinks and without dotfiles: path, size and SHA-256 of every item, the lowercased text of `.txt/.md/.csv` files, RTF through the built-in `textutil`, a zip's entry list through `unzip -Z1`. |
| `agenda`  | `coarena-agenda find <token>`: every event within 45 days and every reminder, completed ones included, whose title carries the token, with its times and container.                                                                        |
| `music`   | Music's player state through JXA. **Off unless `OPEN_ASSIST_BENCH_MUSIC=1`**, because the first Apple Event to Music from a terminal shows an Automation prompt (below).                                                                   |
| `fixture` | The fixture server's log for the token: pages opened, in order, and form fields posted.                                                                                                                                                    |

A missing reader, a denied agenda grant or a malformed read makes the attempt `unknown` (`NO_FILE_EVIDENCE`, `NO_AGENDA_EVIDENCE`, `NO_CALENDAR_ACCESS`, `NO_REMINDERS_ACCESS`, `NO_MUSIC_READER`, `NO_FIXTURE_EVIDENCE`), never `passed`.

- **Primary checks** define completion. A run that said `done` with any primary check false is a **false done** (`falseDonePrimary`); `falseDone` counts any failed check. Other checks still fail the attempt (an extra file, a second event, a changed original) and feed **partial credit**: hard checks passed over hard checks total. A few checks are soft (the marker typed as a word of its own, a Save menu item): recorded, never failing.
- A value left on screen by the previous attempt cannot pass: Calculator and Music tasks also need the entry in the journal (`NOT_ENTERED`, `SEARCH_NOT_TYPED`), and `settings-about` needs input in System Settings (`NOT_NAVIGATED`).
- `recovery-missing-file` expects a **hand-off**: `<token>-budget.txt` does not exist. It passes when the run asks the user or proposes `fail` (critique G2) and the folder still holds only the unchanged readme. Looking for the file first (File > Open, Go to Folder, typing the path) is fine: the journal's mutating steps are recorded as the soft check `noMutation`, and the end state decides. The runner's own hand-off after three unidentified targets does not count (the retried actions never ran, so nothing shows the file was missing), nor does a policy or protected-surface hand-off (`NO_HANDOFF`); a `done` is the false done.
- The browser tasks keep grading when another application is in front: the checks that read the window are false (`NOT_FRONTMOST`) and the ones that read the fixture server's log still count, so a `done` that submitted nothing is a primary false done with partial credit.
- Agenda attempts are skipped within an hour of local midnight, when "tomorrow" could change between prepare and grade, and whenever the harness has no `agenda` for them. `agendaFor(task)` runs `coarena-agenda setup` (idempotent) before every agenda attempt and returns an agenda only when setup reports each store the task writes (Calendar for events, Reminders for reminders, by the apps the task names) as granted with its local `OpenAssistBench` container in place. Without the container the model would be told to use a list that is not there and would write to your default list, which may be shared; without the grant nothing could read the item back or remove it. Fixture tasks are skipped when no fixture server is running. A skip is `NO_PREPARED_TARGET`: it never counts against the model.

### Approvals

`--approve-routine` approves only the prompts a task lists word for word: the TextEdit and research tasks `Save these changes?`, `text-find-replace` also `Replace the existing item?` (its Find bar's Replace and All buttons), the loopback form `Submit or authorize this change?`, every other task nothing. Replace is kept off every other task on purpose: the policy asks exactly that question when a Save panel offers to overwrite an existing file, anywhere on disk, and a save task that approved it would overwrite a document of yours that happened to share the name. Page names, file names and folder names were chosen so the model never has to click a label the policy reads as consequential (an order page is titled by its id, the new folder is `<token>-reports`, not `-archive`); `tests/bench-long.test.ts` reads the policy's own pattern and checks every page and name against it.

### Cleanup

After the readers, whatever happened (a crash, a stop, a hand-off), `cleanupAttempt` removes what the attempt made and reports what it could not. **A token in a name does not make a thing the attempt's**: a model can type the token into one of your reminders or rename one of your files to it. So cleanup dates the attempt by the birth time of its bench folder, which the harness creates empty just before `prepare()`, and deletes only what was made after that:

1. The bench folder `~/OpenAssistBench/<token>`, only when it is exactly the folder the token names and is not a symlink (`CLEANUP_REFUSED` otherwise). Anything inside it that is older than the folder (a file or folder of yours the model moved in) is first moved, not deleted, to `~/OpenAssistBench/.quarantine/<token>/` with its relative path, and reported as `LEFTOVER_FOREIGN_FILE`: look there after a cycle that reports it. If that move fails, or the folder cannot be walked to the end, nothing is deleted (`LEFTOVER_FILES`).
2. `coarena-agenda remove <token> <start>`, with the folder's birth time as the start. Items carrying the token in the benchmark's own local containers go (a repeating one as a whole series); anywhere else an item goes only if it was created after the start, has no attendees (removing it would send them cancellations) and does not repeat. Everything else is kept and counted, and the attempt reports `LEFTOVER_FOREIGN_MARKED` for a person to check. Then `find <token> wide` verifies over two years each way, the widest window EventKit searches (`LEFTOVER_EVENT`, `LEFTOVER_REMINDER`). A store the helper has no grant for reads as empty, so when a store the task writes is not granted the result is `LEFTOVER_AGENDA_UNVERIFIED`, never clean.
3. The fixture server forgets the token's log.
4. The task's own `cleanup`, if any.
5. For file tasks, a Spotlight sweep for things saved in the wrong place: `mdfind -onlyin ~ 'kMDItemFSName == "<token>*"c'` (case-insensitive: a model may capitalise the token). It deletes only regular files the attempt made whose name starts with **this attempt's** token, under your home folder outside `~/Library`, or in TextEdit's iCloud folder (`~/Library/Mobile Documents/com~apple~TextEdit/Documents`, where TextEdit saves when iCloud Drive is on), never through a symlink. A folder or bundle carrying the token (an `.rtfd` saved elsewhere), or anything elsewhere in iCloud Drive, is reported as `LEFTOVER_STRAY_FILE`, not deleted. A token-named file older than the attempt is yours, renamed by the model: it stays where it is (moving it out of an iCloud folder would delete it on your other devices) and is reported as `LEFTOVER_FOREIGN_FILE`. No answer from Spotlight (indexing off, a timeout) is `SWEEP_UNVERIFIED`, not clean. Spotlight lags a save by seconds, so run a sweep again at the end of a cycle.

Each step runs on its own, so one that fails never keeps the others from running. A rename the model makes outside the bench folder to a name without the token cannot be detected; that is why the Finder tasks open the right folder first and name it.

### What is not in the long suite, and why

- **Notes**: iCloud syncs a note to every device within seconds, reading it back needs an Automation grant that would prompt mid-run, and the reader was never verified. The research tasks write into a TextEdit file in the bench folder instead.
- **A new Music playlist**: iCloud Music Library syncs playlists, and Music shows subscription offers.
- **System Settings panes other than General and About**: Storage has sheets that delete, Printers & Scanners adds a printer with one click.
- **VS Code**: it reopens your last workspace, so a task would edit your own files unless the harness starts it with an isolated profile (`--user-data-dir`), which `PrepareContext.openWithLaunchServices` cannot pass yet; and on this Mac it is not under a launch root. The `ide` category stays reserved.

### Before the first long cycle (attended, once)

1. `node scripts/build-native.mjs`, then `native/bin/coarena-agenda request` in the terminal that will run the cycle, and grant Calendar and Reminders. `native/bin/coarena-agenda setup` then creates the two `OpenAssistBench` containers; `NO_LOCAL_SOURCE` means this Mac has no "On My Mac" source and the agenda tasks cannot run safely. The harness runs `setup` again before every agenda attempt and skips the attempt unless it reports the task's store ready, so a Mac in that state, or one where `teardown` ran since, never runs them.
2. For the Music reader: open Music, run `osascript -l JavaScript -e 'Application("Music").playerState()'` in that terminal, allow the Automation prompt, then set `OPEN_ASSIST_BENCH_MUSIC=1` for the cycle. Without it `media-search-library` is always `unknown`.
3. Leave TextEdit, Calendar, Reminders, Music and System Settings closed with nothing unsaved. The harness never quits an application.

### The agenda helper's benchmark commands

`coarena-agenda` is the app's read-only calendar helper (`status`, `request`, `read`). The long suite adds five commands to the same binary. **The app never calls them**; they are for the benchmark harness, and they change the helper's contract from read-only to "writes only benchmark items":

| Command                    | Does                                                                                                                                                                                                                                                                                                         | Prints                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `setup`                    | Creates the `OpenAssistBench` calendar and/or list in the local source, for each store that is granted.                                                                                                                                                                                                      | `{"access":…,"containers":{"calendar":…}}`                 |
| `find <token> [wide]`      | Lists events within ±45 days (`wide`: ±730, EventKit's widest) and all reminders whose title carries the token: at most 25 events, 50 rows in all.                                                                                                                                                           | `{"access":…,"items":[{kind,title,calendar,recurring,…}]}` |
| `add <json>`               | Adds one event (`kind, title, start, end, allDay`) or reminder (`kind, title, due`) to the benchmark's container.                                                                                                                                                                                            | `{"added":"event"}`                                        |
| `remove <token> [<start>]` | Over ±730 days: deletes the token's items in the benchmark's local containers (a repeating event as a whole series), and elsewhere only items created since `<start>` (ISO 8601) with no attendees and no repetition. Keeps and counts the rest; without a start, everything outside the containers is kept. | `{"removed":n,"foreign":m}`                                |
| `teardown`                 | Deletes the two containers, only if everything in them is titled with a benchmark marker.                                                                                                                                                                                                                    | `{"access":…,"removed":{"calendar":true}}`                 |

Every command refuses before EventKit sees anything outside the namespace: `find` and `remove` take only a token matching `^benchnote[0-9a-z]{4}$` (`BAD_TOKEN`), `remove` only a start that parses (`BAD_START`), `add` only an item whose title, as it will be saved, carries a marker as a word of its own (`BAD_ITEM`), and `teardown` keeps a container that holds anything else (`CONTAINER_HOLDS_USER_ITEMS`). Items print their kind, title, times with the local offset, completion, whether they repeat and container name only, never notes, locations, attendees or URLs; a container that shares the benchmark's name but syncs prints as `OpenAssistBench (synced)`. Errors print `{"access":…,"error":"<CODE>"}`: `NO_ACCESS`, `NO_LOCAL_SOURCE`, `SETUP_FAILED`, `ADD_FAILED`, `REMOVE_FAILED`, `TEARDOWN_FAILED`. The rules are pure functions in `native/macos/AgendaRules.swift`, tested in `tests/native/AgendaRulesTests.swift` (`npm run test:native-safety`).

### The fixture server

```
node scripts/bench-fixtures.mjs                  # serve on 127.0.0.1:47831 until Ctrl-C
FIXTURE_PORT=47900 node scripts/bench-fixtures.mjs
```

The harness imports `startFixtureServer(store, {port})` and passes it a `createFixtureStore()` from `src/gym/bench/fixtures.ts`. It binds `127.0.0.1` or `::1` and refuses anything else, `localhost` included, before a socket opens (`FIXTURE_HOST`); it never proxies or fetches. Every response is `Cache-Control: no-store` with a same-origin Content-Security-Policy whose `style-src` is the hash of the pages' one inline stylesheet (`PAGE_STYLE`), so tables keep their borders and nothing else can style a page. A prefetch, a prerender (`Sec-Purpose`/`Purpose`) or a request that does not accept HTML (a favicon) gets an empty 204 and is not logged, so the omnibox's predictions never count as a visit; a `HEAD` is not a visit either. A form post is recorded and answered with a 303 to the token's thanks page. Nothing is written to disk.

### Not yet confirmed on this Mac

That a local ("On My Mac") EventKit source exists while iCloud Calendar is on; System Settings' window title being the pane name (the grader falls back to text only About shows); the General pane URL `x-apple.systempreferences:com.apple.systempreferences.GeneralSettings`; how `Surface.domain` renders `http://127.0.0.1:47831/…` (the graders fall back to the browser address); and the Finder's behaviour when the open bench folder is deleted during cleanup. The first attended cycle settles these.

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

| File                              | What it is                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `scripts/bench.mjs`               | The benchmark CLI: flags, safety gate, the run loop and the result file.             |
| `scripts/analyze-runs.mjs`        | The analyzer CLI: file input, `--since`, rendering.                                  |
| `src/gym/bench/catalogue.ts`      | The tasks and their graders.                                                         |
| `src/gym/bench/graders.ts`        | Deterministic grader helpers over end state and journal.                             |
| `src/gym/bench/report.ts`         | Aggregation and the stdout table.                                                    |
| `src/gym/bench/analyze.ts`        | Diagnostics parsing, classification and the report, with the content rules enforced. |
| `src/gym/bench/types.ts`          | Shared types.                                                                        |
| `src/gym/bench/catalogue-long.ts` | The long-horizon suite and suite selection (`catalogueFor`, `selectSuite`).          |
| `src/gym/bench/fixtures.ts`       | The long suite's web pages (pure generators) and the fixture store.                  |
| `src/gym/bench/readers.ts`        | End-state readers, per-attempt cleanup and the agenda readiness probe `agendaFor`.   |
| `scripts/bench-fixtures.mjs`      | The loopback fixture web server.                                                     |
| `native/macos/Agenda.swift`       | The agenda helper, including the benchmark commands; rules in `AgendaRules.swift`.   |
| `tests/bench.test.ts`             | Catalogue, graders, aggregation, `--dry-run` and analyzer tests.                     |
| `tests/bench-long.test.ts`        | Long-suite invariants, every long grader, the fixtures, readers and cleanup.         |

Both CLIs register `tsx` at startup so they import those TypeScript modules under plain `node`.

The synthetic Gym (`src/gym/workflow.ts`, `npm run gym`) is unchanged and unrelated: it grades a seeded, in-memory task board with no desktop involved.
