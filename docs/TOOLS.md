# Tools: the Apple bridge, the files tool, the launcher shim and the connection recipes

Tools first, the screen only as fallback: when a connected tool can do the
step, Butler calls it instead of driving windows. This document covers the
first tools Butler ships or connects: the Apple bridge, the built-in files
tool, and the community servers the recipes connect. The client, the registry, the Settings
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
| Files    | `src/tools/providers/files.ts`, `src/tools/local.ts`                                                                                              | The built-in files tool: four tools over plain-text files inside the home folder, run in the app's own process (no binary, no MCP framing) under open_file's path rules, read back after every write, with an undo of its own.          |
| Recipes  | `src/tools/providers/recipes.ts`                                                                                                                  | The community servers and the coding agent the pane offers by name, with their argv, consent text, install note, default tools and tier overrides; `serverFromRecipe` shapes one into a settings row.                                   |
| Install  | `src/tools/install.ts`                                                                                                                            | The app's own install of a recipe's pinned Node package (npm into `<userData>/mcp/<rowId>`), the live argv that runs its bin with `node`, and `--offline` for a pasted npx row that may not reach the network. npx never runs a recipe. |
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

## The files tool (built in, in-process)

"Find the number on the page and write it into `~/…/notes.txt`, then save" is
one tool call, and it was twenty screen steps: in cycle 20260919-1646 eight of
twenty-eight attempts found the fact in the browser or Mail and then lost it
between TextEdit's window, the file's header line and Save (`FACT_NOT_NOTED`,
with `NOTE_HEADER_LOST`, `ROW_NOT_APPENDED` and `LINE_NOT_TYPED` beside it,
and three of the five false "done" claims). So the app ships a files tool the
runner reaches for first. It is a `LocalServer` (`src/tools/local.ts`): no
helper binary and no MCP framing; the registry composes it after the Apple
bridge (`LOCAL_SERVERS`), gates it by `settings.tools.files` (on by default)
under the master switch, and runs its calls through the same `prepare`,
policy, call, bounding and undo door as every other tool. To the model its
tools are builtin: `transport: "builtin"`, trusted, local, closed-world, so
they list in Private local too; nothing leaves the Mac through them.

| Tool                      | Arguments                                 | Tier / undo        | Result                                                                                                                               |
| ------------------------- | ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `files__read_text_file`   | `path`                                    | read               | the file's text, up to 64 KB (`FILE_LIMITS.readBytes`); a larger file is refused with `TOO_LARGE`, never cut                         |
| `files__append_text_file` | `path`, `text`, `newline?` (default true) | additive, undoable | `verified: true` after read-back; `facts { kind: "file", name, change: "appended" \| "created", lines }`; `undoToken`                |
| `files__write_text_file`  | `path`, `text`                            | write, undoable    | the same, `change: "replaced"` (or `"created"`); the previous contents are what undo puts back                                       |
| `files__list_directory`   | `path`                                    | read               | one visible entry per line (`name/` for a folder, `name (N bytes)` for a file), up to 200, dotfiles and credential-like names hidden |

`append_text_file` writes the text on its own line: a newline first when the
file's last line is open, one after unless the text brought its own, so a
header line the file already has stays intact and the fact lands under it;
`newline: false` appends the bytes as given. Both writes create the file when
it does not exist (its folder must), refuse a file that would pass 1 MiB, and
are reported only after the file reads back as written (`READBACK_MISMATCH`
otherwise), which is what makes `finish: true` end a run with "Added a line to
notes.txt." (`toolDoneLine`, never "wrote"). The model's core instruction
says to use the tool with the path exactly as the objective writes it when the
objective names a file, instead of opening an editor; the voice fast path
(`src/assistant/tool-answers.ts`) turns "write/add/append/log/put/note `<text>`
in/into/to `~/…/file.txt`" into one `append_text_file` step with no model call
when the path and the text are both in the words.

### Path rules

The same rules open_file's native resolution applies (`native/macos/
FileSafety.swift indexExcluded`), ported as `homePath`, applied to the path as
written and again to its realpath at call time so a symlink can never lead
out: a `~/` path or the home folder's own absolute prefix; never `..`, `.`, an
empty or hidden component, `node_modules`, `.git`, the Trash, a credential-like
name (`.env*`, `.netrc`, `id_rsa*`, `*password*`, `*secret*`, `credentials`,
`*.pem`, `*.key`, `*.p12`, `*.kdbx`, `*.keychain-db`, `logins.csv` and the rest
of the native list), or `~/Library` except the iCloud Drive subtree; the home
folder itself is never read, listed or written. A write never creates or
touches an executable, installer, script, bundle or location file by
extension (the native `fileRefusedExtensions` list, plus `.plist`), judged on
the realpath's own name, so a symlink called `notes.txt` that points at a
script is the script. A path the rules refuse is the `bad_path` problem at
`prepare`, so policy retries with one fixed sentence and no question is ever
asked about it. Contents are text only: a NUL byte or invalid UTF-8 anywhere
(in the head for a large file) is `NOT_TEXT`. The text a user asked to write
is theirs and is not redacted on the way in, but a credential in it
(`scanText` BLOCK_UPLOAD) is refused by the tool (`CREDENTIAL`) as well as by
policy, as it would not be typed either; what a read returns goes to the
model through the registry's `sanitizeResult` like every result.

### Policy

The path alone grounds a call (`prepare` returns it in its `~/` form as the
only `groundText`, whatever form the model wrote): the text is the file's
content, read off a page the user's words cannot be expected to carry, and the
tool is closed-world. With that, the tier table of `src/core/tool-policy.ts`
reads as follows for the files tool. A read is trusted and runs in every
mode. An append the user's own words named by its path runs under "task"
(`TOOL_ALLOWED.grounded`), "flow" and "all"; one they did not name asks
`Add to <name>: <text>?` except under "flow" (undoable) and "all". A write
that replaces the file runs under "task" and "flow" only when the words named
the file and the tool can undo it (`TOOL_ALLOWED.grounded_write`: the rule the
Save button runs under, `askedForLabel`), asks `Change <name>, replacing what
it holds with: <text>?` otherwise, and runs under "all". The questions are
`TOOL_FILE_APPEND`, `TOOL_FILE_WRITE` and `TOOL_FILE_READ` in the approval
codes, open with the closed verbs, and can be approved neither by a follow-up
"yes" nor from the phone. No floor moves: a credential in the arguments is
denied in every mode, the per-run budget and the master switch hold, and
nothing here touches a protected application or host.

### Undo

Every write keeps the file's previous bytes (or the fact that it did not
exist) under its `undoToken` for `TOOL_LIMITS.undoWindowMs`, at most
`FILE_LIMITS.undoTokens` deep; `ToolAccess.undoLast` puts them back, or
removes a file the write created, and refuses with `CHANGED_SINCE` when the
file no longer holds what the write left, so nothing a person typed since is
lost. A file too large to keep (over 1 MiB before the write) changes without
a token. Tokens die with the provider.

### Refusal codes

`BAD_ARGS`, `BAD_PATH`, `OUTSIDE_HOME`, `PROTECTED_PATH`, `EXECUTABLE`,
`NOT_FOUND`, `NOT_A_FILE`, `NOT_A_FOLDER`, `NOT_TEXT`, `TOO_LARGE`,
`CREDENTIAL`, `WRITE_FAILED`, `READBACK_MISMATCH`, `CHANGED_SINCE`, `FAILED`:
each an `error` outcome whose body begins with the code and one sentence the
model can act on, as the Apple bridge's do.

### The benchmark

Every bench and cycle attempt's Runner carries this tool and nothing else of
the tool layer (`src/gym/bench/tools.ts createBenchTools`: no Apple consent,
so the bridge is never started or asked; no server row), over the Mac's home
folder, so a note task can be done by one `append_text_file` call under the
cycle's regime. The journal records a `tool_call` step with the frontmost
app and the first-party tool id (never an argument or a result);
`browserThenNote` accepts the tool write after the browser steps where
TextEdit steps were required, and `savedNote` counts it as the save.

### What only a live run can confirm

- That gpt-5.4-mini and the other cell models call `files__append_text_file`
  with the path as the instruction writes it once the tool is listed and the
  instruction names it, rather than opening TextEdit; the probe
  `npm run cycle -- --probe FACT_NOT_NOTED --baseline 20260919-1646-09c5412 --autonomy all --repeat 3`
  measures this.
- That a run which appends through the tool and then says done passes the
  note graders' `single` (no other item in the folder) and `headerKept` checks
  on a real disk write, and that TextEdit, when the person has the file open,
  shows the appended line (it re-reads a changed file; not a grading concern).

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

| Recipe        | Connection                                                                                                                                                 | Default tools                                                                      | Consent                                                                                                                                                                                                                        | Install                                                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filesystem`  | stdio `node <mcp>/filesystem/node_modules/.bin/mcp-server-filesystem {folder}`, network none; installs `@modelcontextprotocol/server-filesystem@2026.8.31` | `list_directory`, `read_text_file`, `search_files`                                 | Reads and, if you tick them, changes files inside {folder} only. No network: nothing leaves this Mac through it. Runs as you. Butler installs its package from npm when you test or approve it, and never again while it runs. | Needs Node 22+. Butler installs @modelcontextprotocol/server-filesystem 2026.8.31 into its own folder when you test or approve; that step needs network.                        |
| `playwright`  | stdio `node <mcp>/playwright/node_modules/.bin/playwright-mcp --extension`, internet; installs `@playwright/mcp@0.0.82`                                    | `browser_snapshot`, `browser_navigate` (tiered `write`)                            | Drives your signed-in Chrome through the Playwright extension. Page text reaches the model. Protected websites are still refused by Butler's own policy. Runs as you.                                                          | Needs Node 18+ and the Playwright MCP Bridge extension in Chrome. Butler installs @playwright/mcp 0.0.82 into its own folder when you test or approve; that step needs network. |
| `github`      | http `https://api.githubcopilot.com/mcp/`, `Authorization` header from the vault                                                                           | `search_repositories`, `get_me`, `list_pull_requests`                              | Talks to GitHub over the internet with your personal access token; what its tools read and change there reaches the model. Runs as you, with the token's permissions.                                                          | Needs a GitHub personal access token, stored as the Authorization header (Bearer <token>); OAuth sign-in arrives in a later increment.                                          |
| `slack`       | http `https://mcp.slack.com/mcp`, `Authorization` header                                                                                                   | none                                                                               | Talks to Slack over the internet with your token; the channel and message text its tools read reaches the model. Runs as you, with the token's permissions.                                                                    | Slack's server needs OAuth sign-in, which arrives in a later increment; a user token may work in the meantime (verify). Shown as needs sign-in until a token is stored.         |
| `claude-code` | stdio `claude mcp serve` in {folder}, internet                                                                                                             | `Agent` (destructive, long-running); `Read`, `Glob`, `Grep`, `LS` offered as reads | Runs Claude Code in {folder} with its own permissions and your Claude account; it can read, edit and run code there. Butler asks before each run and reports what it says. Runs as you.                                        | Needs the Claude Code CLI (claude) on this Mac.                                                                                                                                 |

`<mcp>` is `~/Library/Application Support/coarena-open-assist/mcp` (the app's
`userData` and `mcp`), one folder per row id.

### The install step

`npx -y <package>` never worked from a recipe. The Filesystem row ran through
`coarena-launch --no-network`, and inside that sandbox npx never answers: even
with the package cached it asks the registry for the `latest` dist-tag, the
blocked request hangs, and the 10 s connect timeout reports `REQUEST_TIMEOUT`
with the row stuck on "Starting…" (measured 2026-09-19 with a JSON-RPC
`initialize` probe: bare `npx -y …` 858 ms; through the shim without the
sandbox 3.2 s; with it, 0 bytes for 25 s). `npx --offline` answers inside the
sandbox only when npx's cache already holds the package and its whole
dependency tree, and `npm cache add` caches the tarball alone, so a fresh Mac
fails with `ENOTCACHED`. So the app owns the install:

- A recipe that runs a Node package names it in `install` as package, version
  and bin (`src/core/tools.ts NodeInstall`), the version pinned by hand, never
  a tag, the bin read from the package's own `bin` field (`@playwright/mcp`
  renamed its bin between 0.0.50 and 0.0.70, so the bin is part of the pin).
  The recipe's `command` is `node` and its `args` are the server's own; the
  registry puts the installed bin in front (`src/tools/install.ts liveArgs`).
- At the consent preview (`registry.test`, the pane's Test) and at the
  approval (`approveToolServer`, the pane's Approve and start), the registry
  runs `registry.install(id)` first: when the bin under
  `<mcp>/<rowId>/node_modules/.bin/` is not executable or the installed
  `package.json` is not at the pinned version, it runs
  `npm install --prefix <mcp>/<rowId> --no-audit --no-fund --ignore-scripts --loglevel=error <package>@<version>`
  with npm resolved as every command is (`src/tools/resolve.ts`), the fixed
  child environment (HOME, TMPDIR, LANG, LC_ALL, PATH), network allowed,
  output ignored, a 180 s bound. Nothing fetched from the registry runs at
  install time (`--ignore-scripts`; the pinned servers ship built). Then it
  connects once and lists as before. The pane's preview says "Installed its
  package in N s."
- The live argv is
  `coarena-launch [--no-network] -- <node> <mcp>/<rowId>/node_modules/.bin/<bin> <args>`;
  npx is never on it. `approvedCommand` hashes that argv, so the consent sheet
  shows the command that runs.
- The runtime path never fetches. A row whose package is gone (a fresh Mac, a
  deleted folder) reads `needs_install` with code `NOT_INSTALLED`; one whose
  last install in this session failed reads `needs_install` with
  `INSTALL_FAILED`. Both say "Approve the server again to install it; needs
  Node 22 and network for that step", and the pane offers Approve again and
  install in those states. The connect timeout stays the backstop for anything
  else. Traces: `ToolInstallStarted` with the server's code,
  `ToolInstallFinished` with the server and `durationMs`, `ToolInstallFailed`
  with the server, a `code` (`INSTALL_FAILED`, `TIMED_OUT` or
  `NPM_NOT_FOUND`), npm's `exitCode` as a number when it exited, `timedOut`
  and `durationMs`; never a line of npm's output, a package name or a path.
- The install reaches registry.npmjs.org with the package name and version and
  nothing else, only while you test or approve, in Private local too (the
  Filesystem server is the one recipe that runs there); the server itself then
  runs with no network.

### Rows from before

A Filesystem or Playwright row added before this change stores the npx form
(`npx -y @modelcontextprotocol/server-filesystem <folder>`). The registry
computes the new argv for it (npx's own arguments and the package are dropped,
the folder kept), so its `approvedCommand` no longer matches and the pane shows
the consent sheet again with the real command; Test or Approve installs the
package and pins the new argv. Nothing is migrated in the stored row.

A pasted or imported row (no recipe) runs as given, with one change: when its
command is `npx` and it declares `network: "none"`, the registry adds
`--offline` right after `npx`, so a package missing from npx's cache fails at
once with `ENOTCACHED` instead of hanging on the registry; the consent sheet
says so. Such a row's approval pins the argv with `--offline`.

`npm run tools:check` (`scripts/mcp-check.mjs`) is the headless check of this
path on the developer's Mac: the Apple bridge's status, the Filesystem recipe's
install into a scratch root with a space in its path, the preview, a second
preview that skips the install, then `configure`, the list, `prepare` and one
`list_directory` call. It prints codes, counts and tool names only.

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
- The Settings pane through the install: that Test and Approve and start keep
  the pane in its working state for the length of an npm install without a
  progress line (the IPC returns once), that the preview then reads "Installed
  its package in N s. Lists 14 tools.", that an install failure shows the
  remedy and the Approve again and install button, and that a row from before
  shows the consent sheet again with the node argv. `npm run tools:check`
  proves the path headlessly, not the pane.
