# Tools: the Apple bridge, the files tool, the web tool, the launcher shim and the connection recipes

Tools first, the screen only as fallback: when a connected tool can do the
step, Butler calls it instead of driving windows. This document covers the
first tools Butler ships or connects: the Apple bridge, the built-in files
tool, the built-in web page text tool, and the community servers the recipes connect. The client, the registry, the Settings
pane, the runner's tool step and the policy that decides when a call asks are
documented with the lanes that own them (`.data/design/mcp-lanes.md`); the
shared contract is `src/core/tools.ts`.

## Components

| Layer    | Where                                                                                                                                             | What it does                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules    | `native/macos/AppleRules.swift`                                                                                                                   | Pure, tested: argument parsing and bounds, dates, which calendar or list an add lands in, duplicates, read-back matching, what may be undone, the spoken line shapes, AppleScript escaping, the two fixed Apple-events targets. No I/O.                        |
| Protocol | `native/macos/AppleProtocol.swift`                                                                                                                | The MCP framing (JSON-RPC 2.0 over stdio, one line each way), the catalogue of the nine tools with schemas and annotations, the hidden `undo`, and each tool's flow over an abstract store. No EventKit, no Apple events.                                      |
| Bridge   | `native/macos/Apple.swift` (`coarena-apple`), `Apple-Info.plist`                                                                                  | The live store: EventKit for Calendar and Reminders, `NSAppleScript` from fixed templates for Notes and Mail, the non-prompting Automation preflight before every Apple event, the `status` and `request` commands.                                            |
| Shim     | `native/macos/Launch.swift` (`coarena-launch`)                                                                                                    | Starts a user-added server with TCC responsibility disclaimed and, when asked, without network. Passes stdio through, returns the child's status.                                                                                                              |
| Table    | `src/tools/providers/apple.ts`                                                                                                                    | The bridge as the registry sees it: title, description, tier, consent, date keys, the approval question, and parsers for exactly the recorded result shapes.                                                                                                   |
| Files    | `src/tools/providers/files.ts`, `src/tools/local.ts`                                                                                              | The built-in files tool: six tools over files inside the home folder (read, append, replace, list, rename, move), run in the app's own process (no binary, no MCP framing) under open_file's path rules, verified after every change, with an undo of its own. |
| Web      | `src/tools/providers/web.ts`, `src/tools/local.ts`                                                                                                | The built-in web page text tool: two read tools that fetch one public page by GET (no cookies, one fixed header, http(s) only, never a protected or private host) and hand the model its text whole, headings, lists, rows and links kept, up to maxChars.     |
| Recipes  | `src/tools/providers/recipes.ts`                                                                                                                  | The community servers and the coding agent the pane offers by name, with their argv, consent text, install note, default tools and tier overrides; `serverFromRecipe` shapes one into a settings row.                                                          |
| Install  | `src/tools/install.ts`                                                                                                                            | The app's own install of a recipe's pinned Node package (npm into `<userData>/mcp/<rowId>`), the live argv that runs its bin with `node`, and `--offline` for a pasted npx row that may not reach the network. npx never runs a recipe.                        |
| Tests    | `tests/native/AppleRulesTests.swift`, `AppleProtocolTests.swift`, `LaunchTests.swift`, `tests/tools-apple.test.ts`, `tests/tools-recipes.test.ts` | The fixtures under `tests/fixtures/apple` are the contract: the Swift tests replay every exchange against a fixture store and compare bytes; the app's tests parse the same replies.                                                                           |

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

| Tool                       | Arguments                                 | Tier / undo        | Result                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files__read_text_file`    | `path`                                    | read               | the file's text, up to 64 KB (`FILE_LIMITS.readBytes`); a larger file is refused with `TOO_LARGE`, never cut                                                                                       |
| `files__append_text_file`  | `path`, `text`, `newline?` (default true) | additive, undoable | `verified: true` after read-back; `facts { kind: "file", name, change: "appended" \| "created", lines }`; `undoToken`                                                                              |
| `files__replace_file_text` | `path`, `text`                            | write, undoable    | the same, `change: "replaced"` (or `"created"`); the previous contents are what undo puts back; `would_erase` at `prepare` when the file holds text and the user's words did not ask to replace it |
| `files__list_directory`    | `path`                                    | read               | one visible entry per line (`name/` for a folder, `name (N bytes)` for a file), up to 200, dotfiles and credential-like names hidden                                                               |
| `files__rename_file`       | `path`, `newName`                         | write, undoable    | the file under its new name in the same folder, verified by stat; `facts { kind: "file", name: newName, change: "renamed", from }`; `undoToken` (undo moves it back); never over an existing item  |
| `files__move_file`         | `path`, `toFolder`                        | write, undoable    | the file, name kept, inside a folder that already exists, verified by stat; `facts { kind: "file", name, change: "moved", folder }`; `undoToken`; never over an existing item                      |

The tool that erases is named for it. In probe cycle 20260919-1952 the note
tasks said "write <fact> into <path>", gpt-5.4-mini matched the verb to the
tool then named `write_text_file`, and the header line the graders require
went with the rest of the file (2 of the 3 tool-route notes: `code-ci-status-
report` NOTE_HEADER_LOST, `msg-group-chat-digest` FACT_NOT_NOTED; the one that
appended, `travel-hotel-shortlist`, kept its header), in 5 to 7 actions where
the editor route took a median of 27. So no tool has "write" in its name:
`append_text_file`'s description carries the verbs a task uses (write, add,
log, note) and `replace_file_text` says it erases and names the other. The
content-keeping rule backs the names: `replace_file_text` on a file that
holds text, when the user's own words say none of replace, overwrite,
rewrite, clear, erase or start over (`REPLACING_WORDS`, `asksToReplace`), is
the `would_erase` problem at `prepare`, a fixed RETRY in every mode ("all"
included: it is a retry, not a question) that tells the model to add with
`append_text_file` or that replacing needs the objective to ask for it; an
empty or absent file may be written, a folder is left to the call, and the
words reach `prepare` as `ToolWords` from the runner (`Runner.userWords`, the
same words policy grounds on; undefined for a rewrite or a wake-up asks for
nothing). Not a floor: the credential deny, the budget, the master switch
and every protected rule sit where they were.

`append_text_file` writes the text on its own line: a newline first when the
file's last line is open, one after unless the text brought its own, so a
header line the file already has stays intact and the fact lands under it;
`newline: false` appends the bytes as given. Both writes create the file when
it does not exist (its folder must), refuse a file that would pass 1 MiB, and
are reported only after the file reads back as written (`READBACK_MISMATCH`
otherwise), which is what makes `finish: true` end a run with "Added a line to
notes.txt." (`toolDoneLine`, never "wrote").

`rename_file` and `move_file` are one call per file. In cycle 20260919-2044
(autonomy all, gpt-5.4-mini) `files-rename-receipts` #2 listed and read the
receipts through the tool (10 tool calls, 0 tool writes), found nothing here
that renames, fell back to Finder clicks and keys and back to the tool, and
was ended `STUCK_LOOP` at 25 actions with nothing renamed. A rename keeps the
file in its folder and takes `newName` as a bare file name (`fileName`: no
slash, not empty, `.` or `..`, at most 255 characters, `BAD_NAME` otherwise;
hidden, excluded or credential-like names are `PROTECTED_PATH`; an executable,
installer, script, bundle or location kind is `EXECUTABLE`, on the new name as
on the old). A move keeps the name and takes `toFolder` as a `~/` folder under
the same path rules, which must exist (`NOT_FOUND`) and be a folder
(`NOT_A_FOLDER`); a bundle kind of folder is `EXECUTABLE`. Neither ever lands
on an existing item, whatever it is (`EXISTS`: nothing is replaced; on a
case-insensitive volume a change of case alone reads as taken), neither acts
on a link (`NOT_A_FILE`: renaming a link's target behind its name, or the link
away from what it points at, stays manual), and both are verified by stat
afterwards (at the new place, gone from the old; `MOVE_FAILED` otherwise).
`finish: true` ends the run with "Renamed receipt-1.txt to its new name." or
"Moved the file to Archive." (the names spoken only when the user said them). The model's core instruction
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
tool is closed-world. A rename's new name is content too (read off the file,
as the receipts' dates were); a move grounds on the file and the folder it
goes to, both places the words can name. With that, the tier table of `src/core/tool-policy.ts`
reads as follows for the files tool. A read is trusted and runs in every
mode. An append the user's own words named by its path runs under "task"
(`TOOL_ALLOWED.grounded`), "flow" and "all"; one they did not name asks
`Add to <name>: <text>?` except under "flow" (undoable) and "all". A write
that replaces the file runs under "task" and "flow" only when the words named
the file and the tool can undo it (`TOOL_ALLOWED.grounded_write`: the rule the
Save button runs under, `askedForLabel`), asks `Change <name>, replacing what
it holds with: <text>?` otherwise, and runs under "all"; before any of that,
a file that holds text is replaced only when the words asked for it
(`would_erase`, above). A rename or a move is a write under the same
`grounded_write` rule: it runs unasked under "task" and "flow" when the words
named the file (and, for a move, the folder), asks `Rename <name> to
<newName>?` or `Move <name> to <folder>?` otherwise, and runs under "all". The
questions are `TOOL_FILE_APPEND`, `TOOL_FILE_WRITE`, `TOOL_FILE_RENAME`,
`TOOL_FILE_MOVE` and `TOOL_FILE_READ` in the approval codes, open with the
closed verbs (Rename and Move joined Add, Change, Delete, Use, Send and Run),
and can be approved neither by a follow-up "yes" nor from the phone. No floor moves: a credential in the arguments is
denied in every mode, the per-run budget and the master switch hold, and
nothing here touches a protected application or host.

### Undo

Every write keeps the file's previous bytes (or the fact that it did not
exist) under its `undoToken` for `TOOL_LIMITS.undoWindowMs`, at most
`FILE_LIMITS.undoTokens` deep; `ToolAccess.undoLast` puts them back, or
removes a file the write created, and refuses with `CHANGED_SINCE` when the
file no longer holds what the write left, so nothing a person typed since is
lost. A file too large to keep (over 1 MiB before the write) changes without
a token. A rename or a move keeps the file's old place under its token and
moves it back, refusing with `CHANGED_SINCE` when the file moved again or
something else has taken its old place. Tokens die with the provider.

### Refusal codes

`BAD_ARGS`, `BAD_PATH`, `BAD_NAME`, `OUTSIDE_HOME`, `PROTECTED_PATH`,
`EXECUTABLE`, `NOT_FOUND`, `NOT_A_FILE`, `NOT_A_FOLDER`, `NOT_TEXT`,
`TOO_LARGE`, `EXISTS`, `CREDENTIAL`, `WRITE_FAILED`, `MOVE_FAILED`,
`READBACK_MISMATCH`, `CHANGED_SINCE`, `FAILED`:
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
TextEdit steps were required, and `savedNote` counts it as the save (a rename
or move is not a save and is not in `FILE_WRITE_TOOLS`). `files-rename-
receipts` grades the folder's names and hashes, never the steps, so four
`rename_file` calls pass it as Finder renames would.

The loop rule reads the tool's tier (`src/core/runner.ts trackLoop`): a
read-tier tool call (list, read, search) is no revisit, as scroll and wait
are not, and is a loop only when the same read with the same arguments comes
three times running with nothing else executed between (`readSpin`); a write
with the same arguments is a revisit like any step. Cycle 20260919-2044
`files-receipts-to-csv` #1 listed the folder and read receipts one at a time,
and the third `list_directory` of the same folder within twelve steps ended
the run `STUCK_LOOP` at 20 actions with 7 tool calls and no write, while it
was still making progress.

A read repeated with the same arguments is answered from the run's own
earlier result when nothing that could change what it reads was executed
between (`Runner.readResults`, keyed by the step's signature and, for
`read_current_page`, the page's address): no other tool call of any tier, no
screen step beyond a capture, a scroll, a wait or a pointer move, and no
takeover. The model reads the earlier result whole behind one line naming
the step it came from (`READ_AGAIN_NOTE`: "Same as step N — nothing changed
it since; the values are already in your history."), the tool is not called,
`ToolCallFinished` carries `repeat: true` with `durationMs` 0, and the step
still counts for the spin rule. Every third read-tier call of a run while no
tool of another tier has been called and one is listed carries
`READS_WITHOUT_WRITE_NOTE` (the count of reads, the verbs to act with;
nothing once a write was tried, nothing when only reads are listed). Cycle
20260920-0327-abc24ae `files-rename-receipts` #3 (45 actions, `STUCK_LOOP`,
`NOT_RENAMED`): `read_text_file` ×13 over a handful of receipts with about 25
captures between, most re-reads of a file already read, `rename_file`
listed and never called; probe 20260920-0158 #1 (24 actions) and #2 (42) had
the same shape.

A refusal at `prepare` is a RETRY carrying the problem's fixed sentence
(`TOOL_REFUSALS[prepared.problem]`), and every problem has a code in
`src/core/decision-codes.ts` (`TOOL_PROBLEM_CODES`, typed over `ToolProblem`
so a new problem without a code does not compile): `TOOL_BAD_ARGS`,
`TOOL_TOO_LARGE`, `TOOL_BAD_PATH`, `TOOL_WOULD_ERASE`, `TOOL_BAD_URL`,
`TOOL_PROTECTED_SITE`, `TOOL_NO_PAGE`, `TOOL_UNKNOWN`, `TOOL_UNAVAILABLE`,
`TOOL_DENYLISTED`. The retarget row names the tool by its trace name and
server off the frozen list (never the model's string), and the bench reads
any `tool_call` retarget as `TOOL_REFUSED`, never `BLIND_SURFACE`.

### What only a live run can confirm

- That gpt-5.4-mini and the other cell models call `files__append_text_file`
  with the path as the instruction writes it once the tool is listed and the
  instruction names it, rather than opening TextEdit; the probe
  `npm run cycle -- --probe FACT_NOT_NOTED --baseline 20260919-1646-09c5412 --autonomy all --repeat 3`
  measures this. Cycle 20260919-1952 showed the route taken (5 to 7 actions)
  and the wrong tool picked; the next probe must show `headerKept` true and
  `noted` true on every tool-route note, with a `replace_file_text` call at
  most one RETRY before the append, so actions stay at or under 8.

- That a run which appends through the tool and then says done passes the
  note graders' `single` (no other item in the folder) and `headerKept` checks
  on a real disk write, and that TextEdit, when the person has the file open,
  shows the appended line (it re-reads a changed file; not a grading concern).

- That `files-rename-receipts` is done by one `rename_file` call per receipt
  (four tool writes, no Finder click or key, `renamed` true) and that
  `files-receipts-to-csv` finishes without a `STUCK_LOOP` ending: its lists
  and reads no longer count as revisits, so the run reaches its appends.

## The web page text tool (built in, in-process)

"Count how many listings are under the cap across all the pages" and
"compare the three vendors into a CSV" ask for an aggregate over pages, and a
frame-by-frame loop over screenshots does that badly: in probe
20260919-2257-efdc2a8 (`STUCK_LOOP`, autonomy all, gpt-5.4-mini)
`research-paginated-listing` #1 (19 actions) and `research-compare-to-csv` #1
(18 actions) each ended `STUCK_LOOP` with `noteRoute: none` and every fact
missing (count and cheapestId; vendor1..3). The shape was `click_control` ×8
with `ActionLoopDetected period 2` (the model paging back and forth between
two controls), a reflection, the same again; every frame was read whole
(`textTruncated` null on all 37 frames, 50–116 text nodes in 3–8 ms) and
every click by name registered `effect: changed`, so neither reading nor
clicking failed. The pages are plain HTML the runner can read in one call, so
the app ships a web tool the runner reaches for first. It is a `LocalServer`
(`src/tools/local.ts`) like the files tool: no helper binary, no MCP framing;
the registry composes it after the files tool (`LOCAL_SERVERS`), gates it by
`settings.tools.web` (on by default) under the master switch, and runs its
calls through the same `prepare`, policy, call and bounding door. To the model
its tools are builtin: `transport: "builtin"`, trusted, local, closed-world,
read tier, so they run unasked in every autonomy mode as the files reads do.

| Tool                     | Arguments                               | Tier | Result                                                                                                                                                                                           |
| ------------------------ | --------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web__read_page_text`    | `url`, `maxChars?` (200–30,000; 12,000) | read | one facts line (`Page: <title> — <host>, <n> characters of text[, cut at <maxChars>; …]`), a blank line, the page's text; `facts { kind: "page", title, host, chars, truncated }`                |
| `web__read_current_page` | `maxChars?`                             | read | the same for the browser's current address, which the runner hands the tool off the frame's `ScreenContext.browserAddress` (`ToolWords.pageAddress`); `no_page` when no browser page is in front |

The fetch is a GET of one http or https address with a fixed `User-Agent`
naming Butler (`WEB_USER_AGENT`) and no other header: no cookies, no
credentials, no `Accept`, no `Accept-Encoding` (a server that compresses
anyway is decompressed within the size cap). It follows at most
`WEB_LIMITS.redirects` (3) redirects on the same host, each judged by the
same rules (`REDIRECT_OFF_HOST`, `TOO_MANY_REDIRECTS` otherwise), within
`WEB_LIMITS.timeoutMs` (10 s, the whole fetch; `TIMEOUT`), takes a `text/html`
or `text/plain` response (`NOT_TEXT` for anything else) of at most
`WEB_LIMITS.responseBytes` (2 MiB, refused by `Content-Length` or as it
streams, `TOO_LARGE`), and reports any other status as `HTTP_ERROR` with the
number. An address without a scheme is read as the bench's instructions
write their site (`siteOf`: `127.0.0.1:47831/<token>`): http for a loopback
or private host, https for any other.

The text comes from a minimal HTML-to-text in TypeScript (`htmlToText`; no new
dependency): the title from `<title>`; script, style, noscript, template, svg,
math, iframe, object, embed, nav, head, title and select gone with their
contents, as is anything `hidden` or `aria-hidden`; comments gone; each
heading (`## Heading`), paragraph, list item (`- item`, `1. item`), table row
(cells joined by `|`) and other block on a line of its own; character
references decoded; whitespace folded. A link is its text followed by its
address in parentheses when the address is not the text itself, resolved
against the page and shown as the path on the page's own origin (`Next page
(/tok/listings/2)`, `Details (/tok/vendors/acme)`): the fixture's pagination
and vendor links carry no address in their text, and a page the tool cannot
name is a page the tool cannot read next. The text is capped at `maxChars`
(default 12,000, at most 30,000, a larger value clamped) with
`WEB_TEXT_CUT_MARKER` as its last line when cut and the facts line saying
so; the whole result passes the registry's `sanitizeResult` (invisible
characters, credential redaction) at the tool's own cap
(`ToolSpec.resultChars`, `WEB_LIMITS.resultChars`), and a credential finding
in the text (`scanText` BLOCK_UPLOAD) drops the whole result with
`CREDENTIAL`, as the files tool refuses to write one.

Two caps stood between a page read and the model, and both moved for this
tool alone. The registry's `sanitizeResult` cut every result body at
`TOOL_LIMITS.resultChars` (1,500), so `ToolSpec.resultChars` lets a tool set
its own (the web tool: 30,400, the text at its cap and the facts line;
nothing else sets one). The model's copy of the history (`modelHistory`) cut
every entry's result at `MODEL_RESULT_CHARS` (640), so the newest entry,
when it is a `tool_call`, now carries its result whole up to
`MODEL_TOOL_RESULT_CHARS` (31,000); on the step after it is cut at 640 like
every other, so the prompt never carries two pages and the values the model
needs travel in its `note`, as the core instruction says: a page to be read
in full, counted over or compared with another is read with the web tool,
`read_current_page` for the page in front or `read_page_text` with an
address from the objective or a link an earlier page text shows, the values
carried in the note of the next step, never paged through screenshots
(380 characters; the `tests/trim.test.ts` pins moved 17,400 → 17,800 and
19,200 → 19,600 with the reason). `TOOL_LIMITS.list` moved from 16 to 18:
the nine Apple tools, the six files tools and the two web tools are 17, and
the seat a user's server had beside every first-party tool is kept.

### Floors

An address is judged at `prepare` (a fixed RETRY, never a question, in every
mode) and again at `call` and on every redirect: not http or https, with
credentials, empty, over 2,048 characters or holding a control character is
`bad_url` (`BAD_URL`); a host on `settings.protectedDomains` (equal or under,
as `open_url` judges it) is `protected_site`, whose sentence is
`PROTECTED_SITE_REFUSAL` behind "No input was sent."; an address on this Mac
or a private network is `bad_url` (`LOCAL_ADDRESS`): loopback, a bare name,
`.local`, `.localhost`, `.internal`, `.lan`, `.intranet` and `.home.arpa`
names, and the ranges 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
192.168/16 and 224/3 for IPv4, the unspecified and loopback addresses,
fc00::/7, fe80::/10 and a mapped IPv4 for IPv6, in the decimal and hex forms
the URL parser normalises. The same test runs over every address DNS answers
for a public name (`guardedLookup`), so a name that resolves inward is refused
before a connection is made. The one exception is an origin the registry
names in `LocalProviderOptions.loopbackOrigins`: the bench's own registry
(`src/gym/bench/tools.ts createBenchTools`) names its fixture server's,
`http://127.0.0.1:47831` (`FIXTURE_ORIGIN`), and the app names none, so
nothing of the owner's app fetches loopback by default. A bench run is marked
`origin: "bench"` at `runner.start`, but the allowance lives in the registry
the bench builds, which only `scripts/bench.mjs` and `scripts/harness-cycle.mjs`
do. Under `PRIVATE_LOCAL` the tool lists as the files tool does: the fetch is
a local act (no model is involved in it), and the page's text then goes to
the configured model as part of the step like any tool result, which is where
the same text goes today off the screen. The credential deny in the
arguments, the per-run budget and the master switch hold as for every tool.

### Trace

`ToolCallFinished` carries the tool and server codes (`read_page_text`,
`web`), the outcome and the result size like any tool step. The provider's
own `WebPageRead` line carries `{ tool, server: "web", outcome, resultBytes,
host }`, where `host` is the registrable domain alone (`traceHost`:
`example.com`, `bbc.co.uk`) or one of `loopback`, `private`, `ip` for a
literal address; the diagnostics stream's `host` field (`electron/diagnostics.ts
hostCode`) keeps exactly that shape and drops a URL, a path, an IP or a
sentence. The path never enters a trace.

### Refusal codes

`BAD_ARGS`, `BAD_URL`, `PROTECTED_SITE`, `LOCAL_ADDRESS`, `NO_PAGE`,
`TIMEOUT`, `TOO_LARGE`, `NOT_TEXT`, `TOO_MANY_REDIRECTS`, `REDIRECT_OFF_HOST`,
`HTTP_ERROR`, `FETCH_FAILED`, `CREDENTIAL`, `FAILED`: each an `error` outcome
whose body begins with the code and one sentence the model can act on; an
abort of the run's signal is the `interrupted` outcome.

### The benchmark

Every bench and cycle attempt's Runner carries the files tool and the web
tool and nothing else of the tool layer (`createBenchTools`). The research
graders' `visited` checks read the fixture server's own log
(`src/gym/bench/fixtures.ts createFixtureStore`): every GET of a registered
page that is not a side request (`isSideRequest`: a prefetch or prerender
purpose, or an `Accept` without `text/html` or `*/*`) is a visit, and the
tool sends no `Accept` header at all, which the store reads as `*/*`. So a
tool read of a fixture page counts as a visit with no grader change
(`tests/tools-web.test.ts` "counts a tool read of a fixture page as a
visit"), and `noteRoute` is unchanged: the note is still written by the
files tool.

### What only a live run can confirm

- That gpt-5.4-mini reads the two research tasks' pages by the tool once it
  is listed and the instruction names it:
  `npm run cycle -- --probe STUCK_LOOP --baseline 20260919-2044-60630f0 --autonomy all --repeat 3`
  and `--probe FACT_NOT_NOTED --baseline 20260919-1646-09c5412 …` must show
  `ToolCallFinished web read_page_text ok` (four reads for
  `research-paginated-listing`, four for `research-compare-to-csv`: the
  index and three vendor pages), `visited` true on every page, the facts
  noted (`count` and `cheapestId`; `vendor1..3`) through `noteRoute: tool`,
  and no `ActionLoopDetected period 2` over `click_control`.
- That the page text the tool returns for the fixture's listings and vendor
  pages reads as the tests' synthetic markup does (the fixture's `table()`
  and `link()` are the shapes the tests use), and that the model follows
  `Next page (/tok/listings/2)` by calling `read_page_text` with the address
  as shown rather than clicking it.
- What a 12,000-character result costs a step on the cell models (about
  3,000 input tokens once, then 640 characters), against the scroll, capture
  and model call it replaces.

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
