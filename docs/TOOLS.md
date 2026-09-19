# Tools: the Apple bridge, the launcher shim and the connection recipes

Tools first, the screen only as fallback: when a connected tool can do the
step, Butler calls it instead of driving windows. This document covers the
first tools Butler ships or connects. The client, the registry, the Settings
pane, the runner's tool step and the policy that decides when a call asks are
documented with the lanes that own them (`.data/design/mcp-lanes.md`); the
shared contract is `src/core/tools.ts`.

## Components

| Layer    | Where                                                                                                                                             | What it does                                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules    | `native/macos/AppleRules.swift`                                                                                                                   | Pure, tested: argument parsing and bounds, dates, which calendar or list an add lands in, duplicates, read-back matching, what may be undone, the spoken line shapes, AppleScript escaping, the two fixed Apple-events targets. No I/O. |
| Protocol | `native/macos/AppleProtocol.swift`                                                                                                                | The MCP framing (JSON-RPC 2.0 over stdio, one line each way), the catalogue of the nine tools with schemas and annotations, the hidden `undo`, and each tool's flow over an abstract store. No EventKit, no Apple events.               |
| Bridge   | `native/macos/Apple.swift` (`coarena-apple`), `Apple-Info.plist`                                                                                  | The live store: EventKit for Calendar and Reminders, `NSAppleScript` from fixed templates for Notes and Mail, the non-prompting Automation preflight before every Apple event, the `status` and `request` commands.                     |
| Shim     | `native/macos/Launch.swift` (`coarena-launch`)                                                                                                    | Starts a user-added server with TCC responsibility disclaimed and, when asked, without network. Passes stdio through, returns the child's status.                                                                                       |
| Table    | `src/tools/providers/apple.ts`                                                                                                                    | The bridge as the registry sees it: title, description, tier, consent, date keys, the approval question, and parsers for exactly the recorded result shapes.                                                                            |
| Recipes  | `src/tools/providers/recipes.ts`                                                                                                                  | The community servers and the coding agent the pane offers by name, with their argv, consent text, install note, default tools and tier overrides; `serverFromRecipe` shapes one into a settings row.                                   |
| Tests    | `tests/native/AppleRulesTests.swift`, `AppleProtocolTests.swift`, `LaunchTests.swift`, `tests/tools-apple.test.ts`, `tests/tools-recipes.test.ts` | The fixtures under `tests/fixtures/apple` are the contract: the Swift tests replay every exchange against a fixture store and compare bytes; the app's tests parse the same replies.                                                    |

`npm run test:native-safety` runs the Swift tests; `node scripts/build-native.mjs`
builds `coarena-apple` and `coarena-launch` beside the other helpers, and
`package.json` ships both in `Resources`.

## The Apple bridge (`coarena-apple`)

A long-lived MCP stdio server. Its own embedded `Info.plist` gives it the
bundle id `ai.coarena.openassist.apple` and the usage strings, so its
Calendars, Reminders and Automation grants are its own: separate from
`coarena-agenda`'s read-only grant and from the controller's Screen Recording
and Accessibility. Each of the four apps is a consent of its own in
`settings.tools.apple`, and each is asked of macOS from Settings only.

### Commands

| Invocation                        | Behaviour                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `coarena-apple`                   | Serves MCP on stdin/stdout until stdin closes. One request in flight at a time.                                                                                                                                          |
| `coarena-apple status`            | `{"access":{"calendar":…,"reminders":…,"notes":…,"mail":…}}` with `granted`, `denied`, `restricted`, `notDetermined` or `unknown`. Never prompts and launches nothing, so Notes or Mail not running reads as `unknown`.  |
| `coarena-apple request <consent>` | The only prompting command (Settings only). EventKit shows its sheet; for `notes` and `mail` the app is started in the background first, then macOS asks about Automation. Gives up after 120 s with the current status. |

### Protocol

Newline-delimited JSON-RPC 2.0; replies have their keys sorted so the same
request gives the same bytes.

| Method                      | Reply                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                | `{ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "coarena-apple", version } }`                                        |
| `notifications/initialized` | nothing (as any notification)                                                                                                                           |
| `ping`                      | `{}`                                                                                                                                                    |
| `tools/list`                | the nine tools below, each with `title`, `description`, `inputSchema`, `outputSchema` and `annotations`                                                 |
| `tools/call`                | `{ content: [{ type: "text", text }], structuredContent, isError: false }`, or `{ content: [{ type: "text", text: "CODE: sentence" }], isError: true }` |
| anything else               | `-32601 Method not found`                                                                                                                               |

A line that is not JSON is `-32700 Parse error` (id `null`); a message that is
not an object, lacks `jsonrpc: "2.0"` or a method is `-32600 Invalid Request`;
a `tools/call` without a string `name`, with non-object `arguments`, or naming
a tool that does not exist (`mail_send`, `osascript`, …) is `-32602`.

### Tools

Annotations: every read has `readOnlyHint: true`; every add has
`readOnlyHint: false, destructiveHint: false`; all are `openWorldHint: false`.
Dates in arguments are `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS]`, local time
unless they carry `Z` or an offset. The schema states this by `pattern`
(`AppleRules.dayPattern` for `from`/`to`, which take whole days;
`AppleRules.momentPattern` for `start`, `end`, `due`, `dueBefore`, `since`),
never by `format: "date-time"`: the client validates arguments with the MCP
SDK's Ajv before a call, and `date-time` there is RFC 3339 with an offset,
which would refuse the local form the bridge documents (measured). The
patterns fix the shape; ranges (month 13, hour 24) are the bridge's
`BAD_ARGS`. The fast path (`src/assistant/tool-answers.ts`) sends whole days
for a listing and filters "tonight", "this morning" and "this afternoon" on
the lines it gets back. Dates in results carry the local offset
(`2026-09-19T18:00:00-07:00`).

| Tool                    | Arguments                                        | Tier / consent                 | Result `structuredContent`                                                                                  |
| ----------------------- | ------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `calendar_list_events`  | `from`, `to` (days, inclusive, ≤ 31 days)        | read / calendar                | `{ lines, more }` — `Sat 19 Sep, 6 PM to 7 PM: Dentist (Home)`, `Mon 21 Sep, all day: Offsite (Work)`       |
| `calendar_create_event` | `title`, `start`, `end?`, `allDay?`, `calendar?` | additive, undoable / calendar  | `{ created: { kind: "event", title, start, end, allDay, calendar }, verified: true, undoToken }`            |
| `reminders_list`        | `list?`, `dueBefore?`                            | read / reminders               | `{ lines, more }` — `Pay rent, due Wed 16 Sep 9 AM (Home)`, `Someday (Ideas)`                               |
| `reminders_create`      | `title`, `due?`, `list?`                         | additive, undoable / reminders | `{ created: { kind: "reminder", title, due?, list }, verified: true, undoToken }`                           |
| `notes_search`          | `query`                                          | read / notes                   | `{ lines, more }` — `Meeting notes (Work)`; titles and folder names only                                    |
| `notes_create`          | `title`, `body?` (≤ 4000), `folder?`             | additive, undoable / notes     | `{ created: { kind: "note", title, folder }, verified: true, undoToken }`                                   |
| `mail_unread`           | `limit?` (1–20, default 10)                      | read / mail                    | `{ lines, more }` — `Dana Li: Quarterly plan, 2 h ago`; sender name, subject, age; never a body             |
| `mail_search`           | `from?`, `subject?`, `since?` (at least one)     | read / mail                    | same lines                                                                                                  |
| `mail_draft`            | `to[]`, `subject`, `body?`                       | additive, undoable / mail      | `{ created: { kind: "draft", subject, recipients }, verified: true, undoToken }` — a draft; nothing is sent |

Reads return at most 20 lines of at most 200 characters, `more` counting the
rest, and never a note body, mail body, location, attendee or URL. Adds are
read back from the store by identifier before they are reported, which is
what `verified: true` means; the text block reads `Added event Dentist to
Home: Sat 19 Sep, 6 PM to 7 PM.` and never carries a store identifier.

Rules an add is held to, before the store is touched: title 1–100 characters
on one line; start no more than a day ago and no more than a year ahead;
duration 1 minute to 24 hours, or 1 to 31 whole days when `allDay`; the
target calendar or list exists, accepts changes and is neither subscribed nor
the birthdays calendar (a named one must match exactly; none means the store's
default); every recipient a well-formed address, at most 20; any key not in
the schema (attendees, alarms, URLs, notes, priority, cc, send…) refused.

### Refusal codes

The text of an `isError` result begins with the code, then one sentence the
model can act on. `NO_ACCESS` and `DUPLICATE` are the two the client maps to
outcomes of their own (`denied`, `duplicate`); the rest are `error`.

| Code                                                        | When                                                                                                                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BAD_ARGS`                                                  | A missing, unknown, mistyped, out-of-range or multi-line argument. The sentence names the argument.                                                                                                      |
| `NO_ACCESS`                                                 | macOS has not granted the app (EventKit not full access; Automation `-1743` or not yet asked).                                                                                                           |
| `NO_CALENDAR`, `NO_LIST`, `NO_FOLDER`                       | The named container does not exist or cannot be changed. The sentence lists the ones that can.                                                                                                           |
| `DUPLICATE`                                                 | An event with the same title and start in that calendar, or a reminder with the same title and due date in that list, is already there. Nothing is added, so a retry after a timeout adds nothing twice. |
| `READBACK_MISMATCH`                                         | The item read back after saving is not what was asked.                                                                                                                                                   |
| `SAVE_FAILED`, `REMOVE_FAILED`, `TIMEOUT`, `FAILED`         | The store did not do it; the AppleScript did not answer within 15 s; anything else.                                                                                                                      |
| `NOT_CREATED_HERE`, `NOT_FOUND`, `HAS_ATTENDEES`, `REPEATS` | `undo` refusals (below).                                                                                                                                                                                 |

### Undo

`undo { token }` is answered but never listed, so the model never sees it;
`ToolAccess.undoLast` calls it with the `undoToken` an add returned. It removes
only an item this very process added, and only when taking it back touches
nobody else: an event with attendees (`HAS_ATTENDEES`) or a repeating item
(`REPEATS`) stays; an unknown token is `NOT_CREATED_HERE`; an item already gone
is `NOT_FOUND`. A draft is deleted from Mail; a note is deleted from Notes. The
token map lives in the process and is dropped when it exits.

### Apple events

Notes and Mail are driven through `NSAppleScript` from fixed templates in
`Apple.swift`; only `AppleRules.appleScriptLiteral`-escaped strings and
integers are ever interpolated, so no title or body can close a literal or add
a statement (the `MessageSafety` precedent). The targets are the two bundle
ids in `AppleTarget`, `com.apple.Notes` and `com.apple.mail`, and nothing an
argument says can change them. Before every call the bridge runs
`AEDeterminePermissionToAutomateTarget` without prompting; a target that is
not running is started in the background first. Notes bodies are written as
escaped HTML with the title as the first line, which is how Notes names a
note. A draft is made visible in Mail and saved; it is never sent, and there
is no `mail_send`.

### Fixtures

Every file under `tests/fixtures/apple` is `{ store?, exchange: [{ in, out }] }`:
`store` describes a fixture store (clock, zone, access, calendars, events,
lists, reminders, folders, notes, mail, undo tokens, a `drift` flag that
corrupts read-backs); each `in` is a request object or a raw line, each `out`
the exact reply or `null` for a notification. `AppleProtocolTests.swift` replays
them against `AppleServer` over `FixtureStore` and compares bytes;
`tests/tools-apple.test.ts` checks that the table's `lines()` and `facts()`
accept every recorded reply and reject any shape with a key missing or added,
and that `dateKeys` cover every parameter `tools-list.json` pins to a date
pattern, and that the SDK's validator accepts the local forms against those
schemas.

## The launcher shim (`coarena-launch`)

```
coarena-launch [--no-network] -- <absolute command> [args…]
```

`posix_spawn` with `responsibility_spawnattrs_setdisclaim(attr, 1)`, the SPI
behind Electron's `utilityProcess` `disclaim` option, so a server the user
added is its own responsible process for TCC and asks for its own access under
its own name instead of inheriting Butler's grants. `--no-network` wraps the
command in `/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny
network-outbound (remote ip))(deny network-outbound (remote unix-socket
(path-literal "/private/var/run/mDNSResponder")))'`, which denies outbound IP,
loopback and DNS while stdio keeps working (measured on macOS 14.2.1; `curl`
exits 6). stdin, stdout and stderr pass through; SIGTERM, SIGINT and SIGHUP are
forwarded to the child; the exit status is the child's (128 + signal when it
was killed).

| Exit | Code (the only stderr line the shim writes) | When                                                                                            |
| ---- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 64   | `LAUNCH_BAD_COMMAND`                        | No `--`, an unknown flag, no command, a relative or non-executable command, or the spawn failed |
| 69   | `LAUNCH_NO_SANDBOX`                         | `--no-network` asked for but `/usr/bin/sandbox-exec` is missing; nothing runs                   |
| 70   | `LAUNCH_NO_DISCLAIM`                        | The disclaim call is not available                                                              |

`LaunchTests.swift` drives the built shim as a process; the 69 path is seen
through a second build compiled with `-D LAUNCH_TEST_NO_SANDBOX_EXEC`, which
points the shim at a path that does not exist.

## Connection recipes

A recipe becomes a `settings.tools.servers` row through `serverFromRecipe`:
disabled, unconsented, trust `ask`, the folder the user picked filled into
`{folder}`. The pane shows the exact argv, the consent text and the install
note before the row can be enabled, and ticks only `defaultTools` when the
server first lists its tools. Only `filesystem` may run in PRIVATE_LOCAL
(stdio, `network: "none"`, under the sandbox); the others are BYOM only.

| Recipe        | Connection                                                                       | Default tools                                                                      | Consent                                                                                                                                                                                 | Install                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filesystem`  | stdio `npx -y @modelcontextprotocol/server-filesystem {folder}`, network none    | `list_directory`, `read_text_file`, `search_files`                                 | Reads and, if you tick them, changes files inside {folder} only. No network: nothing leaves this Mac through it. Runs as you. Fetches the package with npx the first time.              | Needs Node 22+ (npx fetches @modelcontextprotocol/server-filesystem the first time).                                                                                    |
| `playwright`  | stdio `npx @playwright/mcp@latest --extension`, internet                         | `browser_snapshot`, `browser_navigate` (tiered `write`)                            | Drives your signed-in Chrome through the Playwright extension. Page text reaches the model. Protected websites are still refused by Butler's own policy. Runs as you.                   | Needs Node 18+ and the Playwright MCP Bridge extension in Chrome (npx fetches @playwright/mcp the first time).                                                          |
| `github`      | http `https://api.githubcopilot.com/mcp/`, `Authorization` header from the vault | `search_repositories`, `get_me`, `list_pull_requests`                              | Talks to GitHub over the internet with your personal access token; what its tools read and change there reaches the model. Runs as you, with the token's permissions.                   | Needs a GitHub personal access token, stored as the Authorization header (Bearer <token>); OAuth sign-in arrives in a later increment.                                  |
| `slack`       | http `https://mcp.slack.com/mcp`, `Authorization` header                         | none                                                                               | Talks to Slack over the internet with your token; the channel and message text its tools read reaches the model. Runs as you, with the token's permissions.                             | Slack's server needs OAuth sign-in, which arrives in a later increment; a user token may work in the meantime (verify). Shown as needs sign-in until a token is stored. |
| `claude-code` | stdio `claude mcp serve` in {folder}, internet                                   | `Agent` (destructive, long-running); `Read`, `Glob`, `Grep`, `LS` offered as reads | Runs Claude Code in {folder} with its own permissions and your Claude account; it can read, edit and run code there. Butler asks before each run and reports what it says. Runs as you. | Needs the Claude Code CLI (claude) on this Mac.                                                                                                                         |

`claude mcp serve` (Claude Code 2.1.221, measured) lists 25 tools with no
annotations, `Bash`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`,
`Workflow`, `Cron*`, `SendMessage` and `EnterWorktree` among them; the recipe's
`allowTools` is the whole of what the pane ever offers, so none of those can be
ticked or called. Delegation is the `Agent` tool (`prompt`, `description`, …);
its question is `Run Claude Code in <folder>?`, never approvable by phone or
follow-up, and a call may take minutes, which the runner treats like a watch.

## What only a live run can confirm

- That macOS attributes `coarena-apple`'s Calendars, Reminders and Automation
  prompts to "Butler Apple" (its embedded plist) rather than to the app or the
  terminal, and that a child of `coarena-launch` prompts as itself: the
  disclaim is an SPI and the attribution is TCC's to make (Gate 0).
- The AppleScript shapes against real Notes and Mail: that `default folder of
default account` and `make new note … with properties {body}` name the note
  after its first line; that `messages of inbox whose read status is false`
  walks newest first within the 50-row scan; that `save` on an outgoing
  message lands it in Drafts and `delete outgoing message id N` takes it back
  after a save; the time these take on a large mailbox against the 15 s script
  timeout and the client's 20 s call timeout.
- EventKit's stored end for an all-day event (the rules accept both the last
  day's midnight and its last second).
- That `sandbox-exec` and the disclaim behave the same on the macOS release the
  user runs; if either fails, PRIVATE_LOCAL refuses user servers and BYOM rows
  say "runs with Butler's access".
