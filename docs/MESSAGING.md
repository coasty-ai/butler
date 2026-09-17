# Texting: updates and control over iMessage

Open Assist can text one handle — the owner's own phone — when a run reaches a
moment worth knowing about, and read short replies from that same handle as
commands. It is **off by default**, needs two macOS permissions, and never
approves anything: approvals stay on the Mac, where the screen is.

## Why it is shaped this way

A phone is a second, weaker channel. Anyone who can send a text from that
number can reach the Mac, and text has no screen, no pill and no way to show
what is about to be clicked. So the channel is deliberately small: a fixed
vocabulary instead of free-form control, no approvals, bounded and deduplicated
updates, and hard limits on how often either side may speak.

## Components

| Layer    | Where                                                             | What it does                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules    | `native/macos/MessageSafety.swift`                                | Pure, tested: handle normalization and matching, the command vocabulary, which stored rows may be read at all, freshness, AppleScript escaping, rate limits. No I/O.                          |
| Helper   | `native/macos/Messages.swift` (`coarena-messages`)                | Sends through the Messages app with `NSAppleScript`; reads `~/Library/Messages/chat.db` read-only with SQLite. JSON lines on stdin/stdout, like the other helpers. Exits with its parent.     |
| Channel  | `electron/messages.ts`                                            | Owns the schedule and every decision: what is worth texting, dedupe, budgets, command handling, rate limits, the settings view and the helper process. Mirrors the rules above in TypeScript. |
| Settings | `src/ui/main.tsx` → "Text updates"                                | Enable, handle, what gets sent, texted control on/off, the two permissions in plain words, "Send a test message".                                                                             |
| Tests    | `tests/native/MessageSafetyTests.swift`, `tests/messages.test.ts` | The same fixture strings on both sides, plus channel behaviour against a fake helper.                                                                                                         |

The renderer never talks to the helper. `electron/main.ts` owns the channel
object exactly as it owns the runner, the controller and the voice helper.

## Protocol between main and `coarena-messages`

One JSON object per line, request/response by `id`, the same shape as the
controller and voice helpers. The helper emits no unsolicited events: main
drives polling, so pacing and limits live in one place.

| Request                                 | Response                                                                                                                                                               | Errors (`code`)                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `{"method":"status"}`                   | `{"automation":"granted\|denied\|ask\|messages_closed\|unknown","database":"ok\|no_access\|locked\|missing\|unsupported\|unopened","configured":bool,"latestRowId":N}` | —                                                                                                   |
| `{"method":"configure","handle":"+1…"}` | same as `status`                                                                                                                                                       | `BAD_HANDLE`                                                                                        |
| `{"method":"send","text":"…"}`          | `{"sent":true}`                                                                                                                                                        | `NOT_CONFIGURED`, `AUTOMATION_DENIED`, `HANDLE_UNKNOWN`, `SEND_FAILED`                              |
| `{"method":"poll","sinceRowId":N}`      | `{"rowId":M,"skipped":K,"messages":[{"rowId":…,"handle":"…","text":"…","at":unixSeconds}]}`                                                                            | `NOT_CONFIGURED`, `FULL_DISK_ACCESS`, `DATABASE_LOCKED`, `DATABASE_MISSING`, `DATABASE_UNSUPPORTED` |

`configure` with an empty handle clears it and closes the database. An empty
handle also means `send` and `poll` refuse.

Timeouts in `createMessagesHelper`: 8 s for everything except `send`, which
gets 120 s and does not kill the helper, because the first send opens the macOS
Automation prompt and waits for the user.

## Reading the Messages database

- Opened `file:…/chat.db?mode=ro` with `SQLITE_OPEN_READONLY`. Nothing is ever
  written. Queries are prepared with bound parameters.
- Two passes on purpose. The first selects **metadata and the text length
  only**; the second reads the body of a row that every rule already accepted.
  A message that is not a command for this Mac is never copied out of SQLite.
- Optional columns (`cache_has_attachments`, `item_type`,
  `associated_message_type`, `balloon_bundle_id`) are included only when
  `PRAGMA table_info` says they exist; a database without the chat/style tables
  is refused rather than guessed at.
- `message.date` is an Apple epoch value in seconds or nanoseconds; both are
  converted.
- Bodies stored only as `attributedBody` (rich text with mentions or link
  previews) have no `text` and are ignored. The vocabulary is plain words, so
  this costs nothing and avoids decoding archived objects.
- macOS keeps `chat.db` in WAL mode, and a read-only connection cannot create
  the shared-memory index. If Messages is not running the read can fail; that
  is reported as `DATABASE_LOCKED` with "leave Messages open", not as a crash.

### What is ignored, and why

| Ignored                                                   | Reason                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything from another handle                              | Only the configured handle is ever a command.                                                                                                                                                                                                                                                                                                              |
| `is_from_me = 1`                                          | Our own updates, and messages the owner sends from any of their own signed-in devices, are indistinguishable from each other. Reading them would create a command loop. **This is the deliberate choice for "note to self" threads: they do not work.** The configured handle must be a number or address that is _not_ signed in to Messages on this Mac. |
| Group chats (`chat.style` ≠ 45)                           | A command must come from a private one-to-one thread.                                                                                                                                                                                                                                                                                                      |
| Attachments, tapbacks, edits, app balloons, system events | Not text commands.                                                                                                                                                                                                                                                                                                                                         |
| Rows at or below the baseline row id                      | The baseline is taken when the channel is configured, so a backlog never runs. It is not persisted: messages sent while the app was closed are ignored.                                                                                                                                                                                                    |
| Anything older than five minutes (or dated in the future) | Late iCloud sync is not consent.                                                                                                                                                                                                                                                                                                                           |

## The command vocabulary

From the configured handle only, one word per message (case, spacing and
trailing punctuation are forgiven):

| Text                     | Effect                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `status`                 | One line: what is running, or what finished last.                                                            |
| `stop`                   | Stops the run, like Escape.                                                                                  |
| `pause`                  | Pauses it.                                                                                                   |
| `continue` (or `resume`) | Continues a held run.                                                                                        |
| `do <task>`              | Starts `<task>` exactly like a typed command: the pill appears, policy, approvals and budgets are unchanged. |

Anything else gets one line: _"I only understand: status, stop, pause,
continue, or 'do <task>'. Approvals stay on the Mac."_ `yes`, `no`, `ok`,
`approve`, `deny` and friends get a specific refusal instead, so an owner who
tries to approve by text is told where to approve.

Before a texted task starts it passes `scanText` from `src/core/sanitize`:
anything credential-shaped is refused with a one-line reply and never becomes a
task. Text is also whitespace-collapsed, stripped of control characters and
bounded to 2000 characters.

### Rate limits

- At most **6 commands per minute**. Beyond that commands are dropped, with one
  "that's a lot of messages" reply per minute.
- After **3 unknown commands within 5 minutes**, the channel stops answering
  unknown commands for **10 minutes**. Real commands still work; only the
  ping-pong stops. Approval-word refusals count towards this too.

## What gets texted

One short line per moment, with the same dedupe key the spoken replies use
(`momentKey` in `electron/conversation.ts`), so speech and text agree on what
counts as one moment:

| Moment             | Line                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Started            | `Started "<task>".`                                                                                                                    |
| Needs approval     | The policy question (via `speakableApproval`, so never typed text or coordinates) plus "I can't approve by text — approve on the Mac." |
| Took over / paused | The reason, via `speakableText`.                                                                                                       |
| Completed          | `Done.` plus the model's summary, via `speakableSummary` (a summary about typed or quoted content is replaced by a generic line).      |
| Failed             | The failure message, via `speakableText`.                                                                                              |

Never: screenshots, partial transcripts, ordinary step narration ("Opening
Notes."), typed text, credentials, full URLs or file paths. Every line is
bounded to 300 characters, at most 8 per run and 20 per hour in total.

### Default: only tasks started by text

`messagesUpdates` defaults to `texted` — updates only for runs the owner
started by message. When the owner is sitting at the Mac, the pill and the
spoken replies already say everything, and texting it again is noise on a
device they are not looking at. It is also the smaller privacy footprint:
nothing about work done at the desk is copied to a phone. `all` sends updates
for every run, for when the Mac is left working alone.

A quiet-hours window was considered instead. It needs a clock, a timezone and a
rule for what happens to an update that falls inside it, and it does not
actually reduce what the channel tells anyone who reads the phone. The default
above answers the same worry ("don't text me all day") with a rule the owner
can predict.

## Settings

`src/core/schema.ts`, stored in the encrypted config (`config.enc`), never read
from `.env` at runtime:

| Key                | Default    | Meaning                                                                                                        |
| ------------------ | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `messages`         | `false`    | The whole channel.                                                                                             |
| `messagesHandle`   | `""`       | The one handle ever texted or read.                                                                            |
| `messagesCommands` | `true`     | Read replies as commands. With this off, `chat.db` is never opened at all and Full Disk Access is unnecessary. |
| `messagesUpdates`  | `"texted"` | `texted` or `all`, as above.                                                                                   |

Saving with `messages: true` and an unusable handle is rejected
(`validateMessageSettings`). A `PHONE_NO` in `.env` is imported by
`importEnvHandle` during `--import-env`, exactly like an API key: it fills the
handle in the encrypted config and nothing else. The channel still has to be
switched on by hand.

## macOS permissions

1. **Automation → Messages** (to send). The first send shows the system prompt;
   a refusal comes back as `AUTOMATION_DENIED` with the System Settings path.
   `AEDeterminePermissionToAutomateTarget` reports the state without prompting,
   so Settings can explain it before anything is sent.
2. **Full Disk Access** (to read replies). Without it, opening `chat.db` fails
   and the channel reports `FULL_DISK_ACCESS` with the System Settings path.
   Only needed when `messagesCommands` is on.

Both are granted to the Open Assist app; the helper is a child process and runs
under the app's grants.

## Wiring in `electron/main.ts`

```ts
const messages = new MessagesChannel({
  settings: () => settings,
  helper: () => createMessagesHelper(messagesBinary(), { diagnostics: debug }),
  startTask: async (task) => {
    ensureIdle(); // rejects with a readable reason
    await getNative().request("rememberForeground");
    await dispatch("start", [task, false]);
  },
  control: {
    pause: () => {
      voiceHeld = false;
      runner?.pause();
    },
    stop: () => {
      cancelVoiceCapture();
      void conversation.stopSpeaking();
      voiceHeld = false;
      runner?.stop();
    },
    resume: async () => {
      voiceHeld = false;
      if (runHeld()) await resumeHeldRun(runHeld);
    },
  },
  trace: debug,
});
```

Call sites:

| Where                                 | Call                                                                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emit(s)`                             | `messages.onSnapshot(s)` — after `diagnostics?.snapshot(s)`, unconditionally.                                                                                                                                                 |
| App ready, after the config is loaded | `void messages.configure().catch(() => {})`                                                                                                                                                                                   |
| `dispatch("saveSettings")`            | `validateMessageSettings(next)` beside `validateProviderEndpoint(next)`, then `await messages.configure()` after `saveConfig()`; a rejection is a warning ("Settings saved, but texting could not start: …"), not a rollback. |
| `dispatch("info")`                    | `messages: messages.status()` in the returned `AppInfo`.                                                                                                                                                                      |
| `dispatch` (settings window only)     | `case "messagesStatus": return messages.refresh();` and `case "sendTestMessage": return messages.sendTest();`                                                                                                                 |
| `importLaunch(args)`                  | after importing keys: `const handle = importEnvHandle(file); if (handle && !settings.messagesHandle) settings = { ...settings, messagesHandle: handle };`                                                                     |
| `before-quit`                         | `messages.close()`                                                                                                                                                                                                            |

`package.json` also needs `native/bin/coarena-messages` in
`build.extraResources`, and `getNative`-style resolution for the binary
(`process.resourcesPath` when packaged, `native/bin` in development).

## Deliberate limits

- No approvals, ever, and no way to change settings, keys or protections by
  text.
- No transcripts, screenshots or run history by text; `status` is one line.
- No contact lookup: the handle is a number or address, never a contact name.
- One handle. There is no list, and no "reply to whoever texted".
- SMS-only numbers are not supported; the send path is iMessage.
- Messages that arrived while the app was closed are never run.
