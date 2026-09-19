# Coding agents: delegating by voice

"Ask Claude Code to fix the failing test in open-assist." Butler hands the
words to the coding CLI in that folder, tells you what the agent is doing when
you ask, relays every question it asks, and reads you its summary when it is
done. No screen run, no model call of Butler's own: the CLI does the work, the
way it would if you typed at it yourself.

This is the **terminal channel** to a coding agent: it works with any CLI that
has an interactive prompt or a JSON print mode, and needs nothing from the
agent but its binary. The structured channel, Claude Code as an MCP server
(`claude mcp serve`, the `Agent` tool), is a separate lane
(`.data/design/mcp-lanes.md`) and is not duplicated here.

## What you can say

| Say                                                       | Butler                                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| "ask Claude Code to fix the failing test in open-assist"  | Types the task into Claude Code in `~/open-assist`. Spoken: _Claude Code is on it in open-assist._                |
| "have Codex add a dark mode to the settings page"         | Same, with Codex, in the project open in your editor (VS Code, Cursor, Windsurf).                                 |
| "what's the coding agent doing?" / "is it done yet?"      | Answers from the pane, no model: _Claude Code is working in open-assist, 3 minutes in._                           |
| "read me the summary" / "what did it say?"                | Reads the agent's last message, through the same filters every spoken sentence passes; the pill shows it in full. |
| "tell it yes" / "tell it no"                              | Presses the agent's own Yes (or Escape/No) on the question it is showing. The only way that ever happens.         |
| "tell it to use the other approach" / "tell it two"       | Types your words into the session as they are.                                                                    |
| "stop the coding agent" / "tell it to stop"               | Ctrl-C to its pane (SIGINT in print mode). The session stays.                                                     |
| "quit the coding agent" / "close the Claude Code session" | Ends the session.                                                                                                 |
| "stop" (nothing else running)                             | Interrupts every agent at work. So does the native emergency stop when it fires with no run to stop.              |

The agent is named as "Claude Code", "Claude", "Codex" or "the coding agent";
"it" means the one at work. A bare "yes" or "no" never reaches a coding agent:
it stays what it always was, an answer to Butler's own approval question, and
with none pending Butler says there is nothing to approve.

The grammar is deterministic (`src/coding/intents.ts`) and runs before the
router and the dialog model see the words, so a delegation never becomes a
screen task by mistake. Speech has to be heard as clearly as an approval to be
typed into a CLI; otherwise Butler asks you to say it again.

## Where the agent works

Only two sources ever name the folder (`src/coding/project.ts`):

1. **A project you named** — "in open-assist", "in my butler repo", "in
   ~/code/app". A name is looked up under your home folder and the usual code
   folders (`~/code`, `~/Projects`, `~/src`, `~/dev`, `~/Developer`, `~/repos`,
   `~/work`, `~/Documents`, `~/Desktop`); "open assist", "Open-Assist" and
   "open_assist" are the same folder. When the trailing "in …" does not name a
   folder ("add a dark mode in the settings page"), the words stay in the task.
2. **The coding editor in front** — the project in the window title of VS
   Code, Cursor or Windsurf, read the way a watch binds a window (no
   screenshot; protected apps refused). Any other app in front is no project.

A folder must lie inside your home folder (never the home folder itself, its
`Library`, or anything hidden such as `~/.ssh`) or inside a mounted volume.
System paths are refused outright, and Butler says so.

## Two transports, one state machine

**With tmux installed**, every (agent, project) pair gets one detached session,
`butler-claude-open-assist`, started with the agent's own interactive CLI in
that folder:

```
tmux new-session -d -s butler-claude-open-assist -c ~/open-assist -x 160 -y 50 ~/.local/bin/claude
tmux send-keys -t butler-claude-open-assist -l 'fix the failing test'
tmux send-keys -t butler-claude-open-assist Enter
tmux capture-pane -p -J -S -200 -t butler-claude-open-assist      # every second
```

The pill shows the attach command, so you can sit in on the session from any
terminal and type alongside Butler. A session you already have is reused; one
you close ends the delegation. Butler leaves tmux sessions running when it
quits.

**Without tmux** (this Mac today), the CLIs' non-interactive modes run one turn
per process and stream JSON lines into the same classifier:

```
claude -p --output-format stream-json --verbose -- 'fix the failing test'
claude -p --output-format stream-json --verbose --resume <session_id> -- 'now the lint'
codex exec --json -- 'add a dark mode'
codex exec --json resume <thread_id> -- 'and the tests'
```

Later words resume the same conversation by the id the first turn printed;
words said during a turn wait for it to end. The pill says so and that
installing tmux (`brew install tmux`) gives you sessions you can attach to. In
print mode the CLIs cannot ask permission questions: Claude Code refuses the
tool on its own and says so, and Butler relays that refusal as the question it
would have been, adding that only a tmux session lets you answer such questions
yourself.

Both transports build their commands in `src/coding/agents.ts`, as strings a
test pins without running anything (`tests/coding-agents.test.ts`).

## Reading the pane

`src/coding/classify.ts` reads a pane (or one JSON line) into one of a few
states, with no model:

| State       | Claude Code shape                                                                       | Codex shape                                                            |
| ----------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| working     | a spinner line ("✻ Thinking… (3s · esc to interrupt)")                                  | "• Working (8s • esc to interrupt)"                                    |
| asks_yes_no | a box ending "Do you want to proceed?" with "❯ 1. Yes … 3. No, and tell Claude … (esc)" | "Codex wants to run …", "Allow command?", "› 1. Yes (y) … 3. No … (n)" |
| asks_text   | the last message ends with "?", or a highlighted numbered choice                        | same                                                                   |
| idle        | the input box and "? for shortcuts", nothing said since your words                      | "› Ask Codex to do anything", "⏎ send"                                 |
| finished    | idle, with the last "⏺ …" message as the summary                                        | idle, with the last message after the activity lines                   |
| error       | "API Error: …", "rate limit", a dropped connection                                      | "Error: stream disconnected …"                                         |

The question is quoted verbatim from the box, glyphs removed, bounded to 240
characters; the summary to 600. The keys an answer would press are read from
the prompt itself: Codex names them ("(y)", "(n)"); Claude Code takes the plain
option number for yes and Escape for no. The plain "Yes" is the only yes ever
pressed, never a "Yes, and don't ask again".

These shapes are authored in `tests/coding-classify.test.ts` from the two CLIs'
prompt designs; the first live session tunes them. Pane text is untrusted: it
decides only which fixed state applies, and what is read out of it passes the
same filters as any generated sentence (`speakableReport`), so a question that
coaches an approval, asks for a code or carries a credential is not spoken; the
pill shows it instead.

## Permission and safety

- **Butler never answers a coding agent's question.** A permission or yes-or-no
  prompt is relayed as a spoken question, urgently, with a listening window for
  your answer, and stays on screen until you say "tell it yes" or "tell it no".
  `CodingDelegate.answer()` is the only code path that presses a key into such
  a prompt; the pane loop only reads. The delegate takes no settings at all, so
  no autonomy mode ("ask", "task", "flow", "all") changes this
  (`tests/coding-delegate.test.ts` holds a prompt open for an hour of reads).
- **The CLI keeps its own permission mode.** Butler passes no
  `--dangerously-skip-permissions`, `--permission-mode`, `--allowedTools`,
  `--approve-for-me`, `--sandbox`, `--full-auto` or `-c` override; the list is
  `WIDENING_FLAGS` in `src/coding/agents.ts`, and a test checks every command
  against it and every source file for the strings.
- **No secrets are typed.** The task and every relayed line go through the
  credential scanner first (`scanText`); a token, key or password in them is
  refused with a spoken line. Butler never reads `.env` files, and the CLIs get
  a small fixed environment (`HOME`, `PATH`, `TERM`, the locale), never
  Butler's own variables.
- **Only named or open projects**, never system paths (above).
- **Reported like a run.** Diagnostics events (`CodingDelegated`,
  `CodingStateChanged`, `CodingAnswered`, `CodingInterrupted`, `CodingEnded`,
  `CodingTurnStarted`, `CodingTurnEnded`) carry the agent, the transport, a
  hash of the folder (`project`), the state and a code: never the task, the
  pane or a path.

## Progress and completion

State changes are spoken briefly for a delegation asked for by voice, once
each, and shown on the pill (kept for when the pill is free, as a watch's news
is). The same facts go to the progress reporter's cadence, so a phone page or
texted updates hear about a delegation the way they hear about a watched
editor: started, needs you, finished. "How's it going?" with nothing else
running answers about the coding agent. The summary is read on request only.

## Components

| Layer      | Where                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agents     | `src/coding/agents.ts`: the two CLIs, how their names are heard, session names, every tmux and print-mode command, the widening-flag list.       |
| Classifier | `src/coding/classify.ts`: pane and stream readers.                                                                                               |
| State      | `src/coding/state.ts`: one delegation, the reducer over readings, the reporter's vocabulary.                                                     |
| Words      | `src/coding/intents.ts` (what you say), `src/coding/lines.ts` (what Butler says), `src/coding/project.ts` (where the agent works).               |
| I/O        | `electron/coding.ts`: `CodingDelegate` over an injected `CodingIo` (tmux commands, print-mode processes, the file system), `nodeCodingIo()`.     |
| Wiring     | `electron/main.ts`: `codingTurn` before the router, `codingEvent` to speech, pill and reporter, "stop" and the panic button, `closeAll` at quit. |
| Tests      | `tests/coding-agents`, `coding-classify`, `coding-intents`, `coding-project`, `coding-delegate.test.ts`. None runs tmux or a CLI.                |

## What only a live session confirms

- The exact prompt shapes of the installed Claude Code (2.1.x) and Codex
  (0.153.x) TUIs, and that digit keys select an option in Claude Code's
  permission dialog (Escape is its documented "No").
- That `tmux send-keys -l` into each TUI submits on Enter as typed text, and
  that a 160×50 detached pane keeps prompts on one line.
- That `claude -p --output-format stream-json --verbose --resume <id>` and
  `codex exec --json resume <id>` accept a prompt after `--` in the installed
  versions.
- The window titles VS Code, Cursor and Windsurf publish for a folder, and
  that `bindWatch` returns them from an idle Butler.
