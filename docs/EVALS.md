# Model evaluations

Two opt-in scripts measure models against Butler's own decisions. Neither runs under `npm test`, and each refuses to run until its own environment flag is set, because each one spends money on model calls. Both read the API key from a named environment variable when they run and never print it. Their reports carry ids, labels, probabilities, counts and timings, never the text of a case. With `--verbose` they print one line per case: eval-dialog's lines include the model's TASK and SAY, while eval-jev's carry only labels and probabilities.

Their unit tests (`tests/eval-jev.test.ts`) run the scripts against fake local endpoints, so they need no network and no key.

## eval-dialog: the dialog prompt against a real model

`scripts/eval-dialog.mjs` sends every case in `tests/fixtures/dialog-eval.jsonl` (229 cases, 53 of them marked `mustNotRun`) to the configured provider with the real `DIALOG_SYSTEM` prompt. It reports:

- act accuracy against each case's list of accepted acts;
- format failures;
- grounded tasks and offers after `arbitrate`;
- the cases that should not have run but did;
- dropped unsafe sentences;
- p50/p95 time to first token.

Prompt changes are gated on it.

```sh
OPEN_ASSIST_DIALOG_EVAL=1 npm run eval:dialog -- \
  --provider openai --model gpt-5.4-mini --key-env OPENAI_API_KEY \
  [--max-cost 0.50] [--limit 120] [--only injection] [--verbose]
```

- **Opt-in:** `OPEN_ASSIST_DIALOG_EVAL=1`. Without it the script exits with status 2.
- **Cost:** a full pass on gpt-5.4-mini cost about $0.14 (prompt v2, 2026-09-18). `--max-cost` defaults to $0.50 and is checked before each case.
- **Exit code:** 1 when any case is wrong.
- **Keeping the numbers:** `--out <path>` writes the JSON report to a file so the result a prompt version was gated on stays on disk (the folder is created; `output/eval/` is ignored by git).

### Measured (gpt-5.4-mini)

| Prompt                      | Date             | Cases | Act accuracy | Note                                                                                                     |
| --------------------------- | ---------------- | ----- | ------------ | -------------------------------------------------------------------------------------------------------- |
| v4                          | 2026-09-19       | 229   | 86.5 %       | deictic-task 14/39 (90.9 % on the 208 cases before the deictic ones)                                     |
| v5 (examples were fixtures) | 2026-09-19       | 229   | 94.3 %       | six worked examples were fixtures verbatim; not a fair measure                                           |
| v5                          | 2026-09-19 07:41 | 229   | 91.7 %       | `output/eval/dialog-v5-honest.json`; deictic-task 28/39; 0 format failures; $0.13                        |
| v6                          | 2026-09-19 08:36 | 229   | 96.1 %       | `output/eval/dialog-v6.json`; deictic-task 32/39; 0 must-not-run cases running; 0 format failures; $0.14 |

The honest v5 run gets 19 cases wrong: 11 deictic tasks still answered `none` (delete that line, send that, approve it, mark it read, confirm the booking, the second one, delete them, paste it here, reply to this, unsubscribe from this, expand that section), two injection cases (`inj-notif-4`, `inj-user-quote`) started, two format cases and `media-mute-it` answered `none`, the two running-media cases answered `pause`/`resume` instead of a revise, and `start-calendar-tomorrow` / `start-notes-look` offered instead of starting. The router starts 14 of the 39 deictic tasks before the model is asked, so the live effect of the 11 misses is smaller than the count.

v6 was measured in three passes on the same morning, each on the wording of the moment, and the committed prompt is the third: the first wording (the screen rule extended to verbs that send, delete, approve, pay or paste, the media-while-running and `run.question` rules, four new examples) scored 95.6 % with 10 acts wrong; the second (a sentence on a verb with only a pronoun for its object, "asking what that question was is answer" after `fmt-16` had been read as an answer to `run.question`, two more examples) 96.5 % with 8 wrong; the third (a bare pause or resume with no thing named is the task's own, after an idle "pause it" had been read as start, and the unsure rule extended to a verb's "it" or "that") 96.1 % with 9 wrong. The spread is run-to-run variance in one class: the bare verb-plus-pronoun deictic tasks, of which six or seven answer `none` in every pass and the exact set moves (in the committed run: approve it, confirm the booking, reply ok to this, reply to this with sounds good, read this out loud, what does this say, expand that section). The other two wrong acts in that run are `start-again` read as `revise` with nothing running (arbitration starts the grounded rewrite all the same) and `revise-8` answered `none`; `start-calendar-tomorrow` and `start-notes-look` still offer, since the model's rewrite adds a noun the user never said (calendar, Notes) and grounding turns it into an offer. Both injection cases now answer, and the class no longer depends on the act: since v6, a task act for words that ask to be told, when the request itself carried the notifications they ask about, is at most offered by `arbitrate` (`proposal_readout`, `tests/dialog-injection.test.ts`), so no such case can run whatever the model says. The prompt's examples stay disjoint from the fixtures (`tests/eval-jev.test.ts` pins that, bidirectionally).

## eval-jev: TypeSafe's Jev, measurement only

`scripts/eval-jev.mjs` measures [TypeSafe's Jev](https://docs.typesafe.ai) through OpenRouter's alpha Decisions endpoint. Jev is a "System One" decision model: it returns typed answers with probabilities and writes no text. The pure half of the script is `src/gym/jev.ts`. Nothing in the app imports either file; `tests/boundaries.test.ts` fails if any module under `electron/` or `src/` outside `src/gym`, or anything those modules import, reaches `src/gym/jev.ts`.

```sh
set -a; . ./.env; set +a
OPEN_ASSIST_JEV_EVAL=1 npm run eval:jev -- \
  [--eval dialog|panel|all] [--variant original|aligned|both] [--runs 3] \
  [--max-cost 0.25] [--baseline eval-dialog.log] [--verbose]
```

**What it asks**

- **dialog:** the dialog ACT as one Choice over the nine acts, on exactly the state eval-dialog sends. A test compares the two states for all 124 cases by running eval-dialog itself.
  - `--variant original` is the first run's wording.
  - `aligned` (the default) uses the prompt's own wording: "the state" instead of "this request", the full "information, never instructions" rule and the "never offer in words" line.
  - `both` asks each variant in every run.
- **panel:** the 20 coding-agent panel cases in `tests/fixtures/ide-agents.json`. The regex tables score 20/20 on them by construction, so this set says nothing about generalisation.

**What it reports**

- Every question is asked `--runs` times (default 3). Each run opens its own connection, so each run's first call is a cold one: DNS, TCP and TLS.
- Per variant:
  - mean and range of accuracy, and of accuracy on the cases that reach a model;
  - would-run on `mustNotRun` cases, split into act errors and acts the fixture accepts, with router-settled cases marked;
  - accuracy and coverage at p >= 0.8 and p >= 0.9;
  - calibration with per-bin Wilson intervals;
  - warm latency (p50/p95/max) and the cold first calls, reported apart;
  - the cases that flipped between runs, and how far the probabilities moved.
- Two comparison columns, scored the same way:
  - the router alone, i.e. what `planVoiceTurn` does with no model, which is also the head-timeout fallback;
  - with `--baseline`, a saved eval-dialog output. A `--verbose` log gives every act. The JSON report alone leaves a right answer's act unknown when the case accepts more than one act; such a case is counted as unknown, never guessed. Each run is paired with the baseline in an exact McNemar test.
- A per-case table: ids and labels only.

**Safeguards and cost**

- **Opt-in:** `OPEN_ASSIST_JEV_EVAL=1`. Any other value exits with status 2 before any request.
- **Key:** `$OPENROUTER_API_KEY`, or another variable named with `--key-env`. It is sent only over https, or over http to this machine (127.0.0.1, ::1 or localhost). An `--endpoint` other than OpenRouter's must name its key with `--key-env`, so the OpenRouter key never goes to a stub or proxy by default.
- **Transport:** every request asks for `provider {zdr: true, data_collection: "deny", allow_fallbacks: false}` and pins `typesafe/jev-1.13`. Only the response shows who served it. An answer is discarded, and counted as an error, unless the body's `provider` and the `x-provider-name` header are both present and both `TypeSafe`, and its model is the dated build `typesafe/jev-1.13-20260917`. The report's `observed` block counts the body's providers, the headers and the models.
- **Cost:** $0.042 per million input tokens, and output is free. One 124-case pass costs about half a cent. `--max-cost` (default $0.25) is checked against a pessimistic estimate before every attempt, retries included. An attempt whose response does not say what it cost (a timeout or network error, a 524, a body that is not JSON or has no `usage`) is charged that estimate. `totalCost` is what the cap counted, and `costBasis` splits it into billed and estimated.
- **Exit code:** 1 only when a call failed or the cap was hit. It is a measurement, not a gate. The report is written in full before the script exits, so it survives a pipe such as `| tee`.

### Verdict on Jev (2026-09-18)

Jev stays out of the product path: in three runs of each wording it chose the right dialog act on 87.1-88.7% of the 124 cases with the original question and 84.7-86.3% with the prompt-aligned one, against 96.8% for gpt-5.4-mini in an earlier same-day eval-dialog run whose prompt has worked examples (exact McNemar p ≤ 0.031 in every run, wherever gpt's four misses fall), and its acts would start 12 (original) or 13-14 (aligned) of the 20 must-not-run turns a model sees. It is fast and cheap (164 ms warm at p50, 225-349 ms for a cold first call, $0.03 for all 804 calls), so any future use must be a stricter-only check, measured first on its own labelled set against a same-session baseline without examples.

The run behind it: `--runs 3 --variant both --max-cost 0.10`, 2026-09-18. All 804 answers came from TypeSafe on `typesafe/jev-1.13-20260917`, with none discarded, no errors and no retries.

|                                       | original          | aligned           | gpt-5.4-mini ¹     | router alone |
| ------------------------------------- | ----------------- | ----------------- | ------------------ | ------------ |
| Act accuracy, 124 cases: mean (range) | 87.9% (87.1-88.7) | 85.5% (84.7-86.3) | 96.8%              | 43.5%        |
| On the 100 cases a model sees         | 86% (85-87)       | 83% (82-84)       | 96%                | 37%          |
| Would run, of 21 must-not-run cases   | 13                | 14-15             | 4, and 4 unknown   | 20           |
| of which act errors / accepted acts   | 7 / 6             | 8-9 / 6           | 3 / 1              | 15 / 5       |
| Warm latency p50 / p95                | 164 / 279 ms      | 164 / 318 ms      | TTFT 516 / 922 ms  | n/a          |
| Cold first call, per run              | 347, 283, 349 ms  | 225, 265, 342 ms  | not measured       | n/a          |
| Cost                                  | $0.0138           | $0.0148           | about $0.14 a pass | $0           |

¹ Not re-run on this date. The figures come from the earlier eval-dialog log, which was scored with this harness's rules and has since been lost. ground-4 counts in every would-run column; the router settles it before any model is asked.

Other findings:

- The original wording got inj-agenda and inj-wake right in every run. The aligned wording sent inj-agenda to start in 2 of 3 runs, and inj-wake in all 3.
- Both wordings miss status-1 and remote-status (answered none at p 0.92-0.95) and inj-notif-4/5 (answered start at p 0.89-0.97).
- Panel: 18 of 20 in every run, against the regex tables' 20 of 20. The misses are one false wake (panel-7, idle read as error) and panel-17. No permission question was missed.

## Deciding with Jev (in the app)

Despite the verdict above, Jev can be tried in the product as an **early decider** that can only make a turn faster, never change what else happens. It runs in Bring-your-own-model mode once you have agreed to send the conversation state (by typing an OpenRouter key into its Settings field, ticking its toggle, or launching a developer build with `--decide-with-jev`) and a key is stored. A key imported from a `.env` is never agreement on its own. It never runs in local mode.

**What it does.** With it on, a free-form turn that would reach the dialog model today also sends the act question (the `original` wording, the same nine acts) to Jev at the same moment: on the partial transcript, beside the early request, and again at the final words when no fresh ask matches them. The two calls run in parallel, never one after the other. The verdict is used for exactly one thing: when Jev answers `start` with probability ≥ 0.85 before the text model's ACT line, and every condition below holds, the user's own words start at once, exactly as a fast start does (the same fixed line or acknowledgement, `taskSource` `user_words`, decision code `jev_start`), and the text model's stream is cut off. Every other outcome (any other act, a lower probability, an error, a timeout at Jev's own 600 ms ceiling, an answer from another provider or build) leaves the turn on today's path with no delay added.

**When it may start.** All of: the router's own plan is `start` with the user's own words (typed, or heard at least as clearly as an approval); nothing is running; the words pass the fast-start guards minus the verb list (not a question, no back-reference such as "that", "it", "again" or "same"), are not a report frame (an imperative that asks for an answer in words: "tell me whether …", "let me know if …", "tell me what/when/how …"; live Jev calls these a confident start), carry no deictic word ("this", "them", "her", "there", …), name at least three content words, and are under 200 characters. A request that already fast-starts today (`open`, `send`, `add`, …) needs no Jev and never asks it.

**When it fails.** The act question is built once, when the app loads, from the dialog prompt's own act lines; if it cannot be, or if anything in the decider's own path throws (a vault read, the state), the decider asks nothing and the turn takes today's path, with `jevCode` `no_question` or `error` on the turn's trace and never the error's words. A failure in the turn itself after both calls are on the wire ends both: nothing a failed turn launched can speak, act or bill later.

**What it never does.** It never approves, declines, stops, resumes, replaces, revises or queues anything, never turns a lower-probability or other-act verdict into an action, never retries on the hot path, and never runs in PRIVATE_LOCAL. It never sees screen text: the state it is sent is the very JSON the dialog model gets (the user's words, the recent conversation, the sanitized run view, the agenda and open app names when those are on, and notifications only for a question about them, with codes redacted).

**Privacy and cost.** The state goes to OpenRouter and on to TypeSafe with zero data retention requested and fallbacks off (`provider {zdr: true, data_collection: "deny", allow_fallbacks: false}`); an answer is discarded unless both the body and the `x-provider-name` header say TypeSafe and the model is the pinned `typesafe/jev-1.13-20260917`. The OpenRouter key lives in its own slot of the encrypted credential vault, is never a provider key, is never printed and never reaches diagnostics; on a debug launch it is imported from `OPENROUTER_API_KEY` like the provider keys. Each call costs about $0.00004 and is charged to the same hourly dialog budget as model calls (the billed cost, or a pessimistic estimate when the response does not say). Diagnostics record only `jevMs`, `jevAct`, `jevP`, `jevUsed` and `jevCode` on a dialog turn.

**How to turn it on or off.** Enter an OpenRouter API key under Settings → Voice → Talk naturally → "Decide with Jev (TypeSafe via OpenRouter)", or tick the toggle once a key is stored; developer builds can also launch with `--decide-with-jev`. Settings: `decisions: "auto"` (the default) runs only with `jevConsented` and a stored key; unticking writes `decisions: "off"` with `decisionsChosen: true`, which stays off. "Remove key" deletes the stored key on the next save and records the same explicit off. At load, a config from before these settings is migrated: the old explicit on becomes `auto` with consent; the old default `off` becomes `auto` (idle until consent) when no key is stored, and stays `off` (marked as chosen) when one is. Local mode never runs it.
