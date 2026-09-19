# Watching how you work (the observer)

Off by default. With **Settings › Watching › Watch how I work** on, Butler watches the Mac at a low rate so it can learn what repeats: routines (the same applications and sites at the same time of day), procedures (a step list done the same way three or more times) and preferences (habits, one sentence each). Everything it learns is **proposed**; nothing runs until you approve it in Settings, and an approved routine or procedure runs through the same runner, policy, approvals and journal as a task you asked for. Design: `.data/design/observer.md`. Code: `native/macos/Observer.swift` and `electron/controller.ts` (the stream, lane O1), `src/observer/*`, `electron/observer.ts`, `electron/routines.ts`, `src/ui/settings-watching.tsx` (lane O2), `scripts/observer-report.mjs` (lane O3).

## What is recorded

One **frame** whenever the front application, window title, web host or focused field changes, and at most one every 20 seconds while you are active: the bundle id and name of the application in front, the window title (numbers and credential-shaped text removed, at most 120 characters), the web host (never a path or query), the focused field's role and label (never its value), and the names of up to 60 controls. One **action** for each thing you do, as structure: a click, double-click or right-click with the name of what was hit; a key chord such as CMD+S (never a character key alone); a typing burst as the field's label, a character count and a duration (never the characters); a scroll direction and tick count; an application switch; a menu path.

The **tier** you choose adds to a frame:

| Tier                | Stored on this Mac                                                                                               | Sent to the model at consolidation                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Structure (default) | The frame and action fields above                                                                                | The day's timeline: applications, hosts, title stems, field names, action kinds and counts |
| With text           | Also the words on the screen, up to 1,500 characters a frame, with credential-shaped spans removed               | The timeline and about 300 characters of those words per stretch in an application         |
| With pictures       | Also a JPEG of the screen at most 512 px wide, never of a protected surface; removed 24 hours after it was taken | The timeline and the words. Pictures never leave this Mac                                  |

Never recorded, excluded at the source before anything is written: while secure event input is on (a password field), a protected application or site in front (`protectedApps`, `protectedDomains`), the screen locked or the screensaver on, Butler's own runs (an `own_run` frame carries only the run id; the run journal has the rest), and more than a minute of idle time. An excluded frame is written as its code and the application alone, so the report can count exclusions. Keystroke characters, the clipboard and other users' sessions are never read.

Before a line is written the log applies `redactSecrets` to every string and drops the whole frame when `scanText` finds a credential-shaped span; the drop is counted.

## Where, and for how long

`~/Library/Application Support/coarena-open-assist/observer/YYYY-MM-DD.jsonl.enc`, one file per local day, append-only, each line one event sealed with AES-256-GCM under the vault master key with AAD `observer` (the same key and scheme as memory's `memory.enc`; `src/storage/vault.ts` `seal`/`unseal`). A day holds at most 50 MB; frames beyond it are dropped and counted. Raw days are kept **14 days** (Settings, 1–90) and deleted at start-up and at midnight; pictures are stripped from frames 24 hours after they were taken. `budget.json` in the same folder holds one day key and the input-token count consolidation spent that day, so a restart does not double the budget; it carries nothing else.

What consolidation learns is stored in memory (`memory/memory.enc`, version 2: `routines`, `procedures`, and `preferences` with `source: "observed"`), bounded like the rest of memory (100 routines, 100 procedures, 200 preferences) and deleted with "Forget what Butler learned".

## How to delete it

- **Settings › Watching › Forget today** deletes today's file; **Forget all** deletes every day's. Today's counters restart.
- **Settings › Learning › Forget everything** deletes memory, including every routine, procedure and observed preference.
- Deleting the `observer` folder by hand is the same as Forget all.
- Turning the switch off stops the stream; it deletes nothing, retention still runs.

## Pausing

"Hey Butler, stop watching" pauses the stream at once (the same rule as spoken stop: whole utterance, nothing else in it), as does the menu-bar item **Watching how you work (pause)**. While paused the log writes nothing (late frames are counted as dropped), the menu-bar title loses its eye, and the item reads **Watching paused (resume)**. Resuming needs the words ("start watching") or Settings; nothing resumes on its own. "Start watching" with the setting off says to turn it on in Settings first: consent lives there.

## What is sent to the model, and when

Consolidation runs when you have been idle for **10 minutes** (Settings), at most every two hours, and once when the day ends (or at the next quiet minute after it). It renders the day's log as a **timeline**: one line per stretch in an application with its bundle id and name, host, title stems, focused field names, and action kinds with counts; at tier "With text" or "With pictures" about 300 characters of the screen's words per stretch; never a picture. The text is cut to fit what is left of the day's budget (**200,000 input tokens**, Settings), the words dropping first, then the latest stretches.

It goes to the **task model** you configured, under one fixed instruction (`CONSOLIDATION_INSTRUCTION` in `src/observer/consolidate.ts`) that names the timeline as data, not instructions. Under **Private local** only the local Ollama model is asked, and a setting that names anything else is refused before a byte leaves (`privacy` in the diagnostics). Under Bring-your-own-model the day's timeline reaches your provider, and the Watching pane says so in plain words.

The reply must be one JSON object with `routines`, `procedures` and `preferences`; anything else is rejected whole and nothing is merged (`parse`). Accepted proposals merge into memory as `status: "proposed"`: a duplicate (the same step sequence or trigger, or three quarters of the same tokens) adds its evidence to the existing entry, which keeps its status (approved stays approved, a refusal stays refused); a routine or procedure unseen for 30 days retires; an observation that contradicts a preference lowers its weight before any replay reads it.

Never sent: pictures, keystrokes, the contents of fields, anything from an excluded frame, and the memory store itself.

## Proposals and approval

**Settings › Watching › What I've learned** lists each proposal with its evidence (days seen, last seen, window, confidence; observed runs and step count; how often a preference was seen) and three buttons: **Approve**, **Not this** (drops it; fresh evidence may bring it back), **Never** (kept as refused; consolidation will not propose it again). Approved entries show their replay counts.

- An approved **procedure** becomes a Skill (`src/memory/skills.ts`'s shape) and joins the runner's replay machinery as every learned skill does: a hint to the model until two successes, then a replay without model calls, and its successes and failures are its replay counts.
- An approved **routine** becomes a schedule (`electron/routines.ts`): once a minute, a routine whose local weekday and hour window are now, and which has not run today, starts as an ordinary run with `origin: "routine"` and `taskSource: "user_words"`, its task text the approved procedure's trigger when it names one, else a sentence from its steps ("Open Slack, then Mail, then Safari at youtube.com."). It starts only while watching is on and learning is on, no run is going, nobody is talking to Butler, the Mac is unlocked, you are not typing in one of its applications, and either background mode is allowed or presence says the screen may be taken. Memory's recall carries the approved preferences relevant to the task into the run's `MemoryContext`, bounded as always.
- An approved **preference** joins recall like a correction would; a proposed one never reaches the model.

Butler offers a new routine aloud at most once a day ("I noticed you open Slack, Mail and Linear weekdays around 9 in the morning. Want that as a routine? You can approve it in Settings, under Watching."), only while you are present and no run is going. Approval by voice is not wired yet; the offer points to Settings.

## The evidence loop

Each replay's end is recorded as `RoutineRun {routineId, outcome}` and moves the routine's confidence: completed +0.10, corrected (the run had a correction) −0.15, declined (stopped) −0.10, failed −0.15, undone (an undo within a minute of the run's end) −0.30. Two corrections or undos in a row send an approved routine back to **proposed** with the corrections attached, shown in the pane. Below 0.30 confidence an approved routine waits for you rather than running. `learnFromRun` folds corrections into preferences as it does for every run.

## Diagnostics

Counts and codes only, through the allow-list in `electron/diagnostics.ts`: `ObserverFrame {appId, excluded?, bytes?}`, `ObserverAction {kind}`, `ObserverDropped {reason, dropped}` (the helper's own drops), `ObserverFrameDropped {reason}` (the log's), `ObserverConsolidated {code, reason, frames, actions, tokens (input), outputTokens, cost, routines, procedures, preferences, durationMs}`, `RoutineStarted`/`RoutineRun {routineId, outcome}`, `RoutineOffered`, `ObserverApplied {on, tier}`, `ObserverRetention {removed, imagesExpired}`, `ObserverForgotten {scope}`, `ProposalDecided {kind, code}`. The report (`scripts/observer-report.mjs`) reads `WorkLog.digest()`: per day `frames`, `actions`, `bytesWritten`, `bytesDropped`, `framesDropped`, `excluded` by code and `apps` by bundle id; memory's `routines`, `procedures`, `preferences` by status; `replays` by outcome.

## What only a live day confirms

That the native stream's frames arrive at the cadence and with the exclusions the design states; that a real day's timeline fits the budget at tier "With text"; that the configured model returns the JSON asked for often enough (the eval in docs/EVALS.md scores it); that `fs` retention at midnight runs while the Mac sleeps through it (it runs again at start-up); and that a routine's replay through the runner completes without the owner's hands.
