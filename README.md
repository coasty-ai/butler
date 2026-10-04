# Butler

A macOS personal assistant with a Codex-style chat transcript, animated character graphics, a British butler’s manner, and MCP-first tools with desktop control as a fallback. Chat naturally, ask it to work, or receive regular spoken briefings with an encrypted readable copy.

Butler runs in Node.js and renders chat directly in the terminal. Desktop control uses the existing native macOS helper when a connected tool cannot handle the task.

## Install

Requires macOS 14+, Node.js 22.12+, and Apple’s command-line developer tools (`xcode-select --install` if needed).

```sh
git clone https://github.com/coasty-ai/butler.git
cd butler
npm run install:terminal
export PATH="$HOME/.local/bin:$PATH"
```

The installer builds Butler, refreshes stale native helpers, and installs `~/.local/bin/butler`. It removes development and renderer packages after building, skips the Electron binary download and optional legacy voice runtime, and uses macOS speech. Repeated installs reuse unchanged native builds. Add the PATH line to `~/.zshrc` to keep the command available in new terminals.

Already have this checkout? Run `npm run install:terminal` in its folder.

## Start

```sh
butler
```

On the first launch, Butler offers to get your everyday apps ready. Type **Yes**
once: it checks the Apple apps and installed coding assistants, reuses saved
connections, and uses your signed-in browser or Slack app when Gmail, Slack or
GitHub has no connected tool. It checks desktop permissions before starting
computer use and waits for you to sign in or approve access. Say **Done** or
**Continue setup** after a handoff. Progress is saved across restarts; **Skip
setup** puts it aside, and **Get me ready** brings it back.

Ordinary app access needs no Google developer project or Slack bot token.
Desktop access is shown separately from connected tools. Scheduled API reads
still need an MCP connection. If no working model is configured, Butler offers
a hidden API-key prompt; you can leave it for later or use your local Ollama model.

Preview just the animation without accounts, permissions, or model calls:

```sh
butler --demo
```

Choose a model in Butler and enter its API key at the masked prompt:

```text
Use OpenAI
Set your API key
```

New OpenAI profiles default to GPT-6.1 Sol in Fast mode with low reasoning effort. Existing profiles keep their saved model until you run `/model`. [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode) costs twice the standard token rates; `/fast off` switches back. Anthropic, Google and Ollama also work. A repository `.env` containing an existing provider key is loaded locally. Keys and account tokens are encrypted with a master key stored in macOS Keychain.

Replies stream into the conversation. Page Up/Down scrolls the transcript, Up/Down recalls typed inputs, and `/new` starts a fresh conversation. Natural requests can start tasks; `/run <task>` makes that explicit.

The chat is the everyday interface. Try “Connect my apps”, “Read replies aloud”, “Listen for me”, “Brief me every 30 minutes”, “Pause” or “Stop”. “Help” shows examples; technical commands are optional under `/help advanced`. Type “Yes” or “No” when a task asks for approval. Spoken replies cannot approve actions.

Connections, credentials, preferences and briefing settings use one encrypted profile across restarts, project folders and terminal sessions. Starting Butler again restores them; you do not need to connect each time. A different project still needs its own coding workspace approval. Only one engine controls the Mac at a time.

While a task runs, keep chatting or ask for an inbox, calendar or reminder check. Trusted read tools can answer alongside the task. With background work enabled, listening leaves API work and a separately bound app window running; foreground computer use pauses for speech and resumes afterward unless you asked it to pause. Corrections update the current task. Independent computer tasks wait their turn, with up to three queued; a failed or stopped task cancels that queue. Say “Forget that, instead…” to replace the current task.

Pure greetings such as “Hello” and “How are you?” receive a local reply without a model request or computer task. Requests attached to a greeting still use the normal task and conversation paths.

Simple questions such as “check my reminders” (items due today) or “what’s on my calendar tomorrow?” use the connected Apple read tool directly, without a model call. More involved requests use your chosen model and available tools.

“Check my inbox” or “Read my five newest unread Gmail messages and tell me which need attention” uses one Gmail search, parallel message reads and one summary call when those read tools are trusted. Each reported passage is checked against its message, with suggestions labelled separately and incomplete coverage stated. One-shot inbox checks start only the Gmail connection:

```sh
butler --ask "Check my inbox"
```

After discovery, unused Claude Code, Codex and Playwright connections retain their tool catalogues and release their processes. Recent catalogues stay encrypted for up to a day, avoiding repeated discovery on restart. The first task reconnects and validates the live tool pins; used connections stay running for background work.

For spoken replies and voice input:

```text
Read replies aloud
Test your voice
Listen for me
```

Approve Microphone and Speech Recognition for Butler's standalone voice helper when macOS asks. Say **Hey Butler**, then your request; follow-up listening continues the conversation after a reply. Option-Space offers push-to-talk when the helper has Accessibility access. Start with `butler --listen` to enable voice setup immediately. `/listen off` disables input, `/voice off` disables replies, and `/doctor` checks the model, voice and desktop permissions. Output uses an installed British voice, preferring Daniel; `/voice list` and `/voice <name>` select another.

## Connect your apps

Tell Butler:

```text
Connect my apps
Set up Gmail and Slack
Show my connections
```

The first-launch flow and “Get me ready” use ordinary app access when a connected
tool is unavailable. “Connect my apps” or “Set up Gmail and Slack” explicitly
configure API/MCP connections instead. Butler checks GitHub, Gmail, Slack,
Claude Code, Codex and the four Apple app bridges. It reuses saved grants,
GitHub CLI sign-in and installed coding CLIs. Gmail API setup can reuse a single
unambiguous Desktop client download in Downloads or the project folder. Missing
developer credentials use a guided browser handoff; after your part, say
“Continue setup” to verify the same accounts. Approved tokens use a hidden
prompt and never enter the chat model. Service registration, account choices
and access approvals stay with you.

GitHub connects in read-only mode. Claude Code uses `claude mcp serve`. Codex uses Butler’s local MCP bridge to the installed, signed-in Codex CLI. Coding tasks ask for approval and run in the project folder chosen when connecting; use `butler --cwd /path/to/project` for a different project.

Slack can use a **bot token (`xoxb-…`)** for reads from conversations the bot has joined. An app token (`xapp-…`) is unnecessary for scheduled reads. `/connect slack oauth` instead uses Slack's official MCP user authorization. Gmail needs a Google Desktop OAuth client JSON with Gmail API enabled, then your account approval. Their wizards explain setup; the built-in Gmail and Slack bot bridges provide reads.

Connect Calendar, Reminders, Notes and Mail through `/connect apple` or their individual names. The custom wizard supports local stdio or remote Streamable HTTP MCP servers, OAuth, bearer tokens, custom headers, environment variables and no authentication. Import Claude/Cursor/VS Code MCP JSON to reuse configurations. `/tools`, `/tool server__tool on|off`, `/trust server reads|ask` and `/disconnect server` manage access. Credentials are entered at masked prompts and stored encrypted. See the [connection guide](docs/TERMINAL.md).

`/apps` lists installed applications and connection paths. Each account still needs its own authorization; apps without an API or MCP can use desktop control.

## Regular briefings

Inside Butler:

```text
Brief me every 30 minutes
Watch my notifications
Catch me up
Show the last briefing
```

Each check uses available app/window context, observed notification banners and configured, trusted MCP reads. Butler suggests priorities, speaks the result with macOS’s British voice, and saves an encrypted readable copy. It reports missing coverage. It cannot inspect every app’s entire history or the complete Notification Center database.

Once briefings are enabled, say “Brief me”, “Catch me up”, or “What needs my attention?” for a fresh check. These requests use batched reads and one summary call.

Use `/briefing-reads` to see the current queries and `/briefing-read server__tool {"query":"..."}` to add a trusted read tool. Gmail adds a bounded unread-mail query; Slack bot setup adds a bounded recent-activity query. Use `/briefings off` to disable scheduled checks. Checks wait during tasks, speech or while the Mac is locked.

To keep briefings running after leaving the interactive terminal, first quit Butler with `/quit`, then:

```sh
butler daemon start
butler latest
butler daemon status
butler daemon stop
```

The background process keeps running after the terminal closes, until stopped or the Mac restarts. It delivers briefings without activating the microphone. It does not install a login service. Only one interactive/background engine runs at a time.

Background briefings start only the MCP servers used by your saved read queries, leaving unused coding agents and browser bridges off. Interactive sessions load all enabled connections. One-shot conversation with `butler --ask "..."` does not start MCP servers unless it needs tools.

The daily briefing token allowance persists encrypted across restarts. Butler reserves estimated usage before requesting a summary and accounts for larger reported usage afterward. Once the allowance is used, checks continue with a local recap and readable copy. If the allowance record cannot be read or saved, Butler uses a local recap. The allowance covers briefing summaries; conversations and tasks have separate model usage.

## Memory

Tell Butler “Remember that I prefer concise briefings”. Preferences and completed task history persist encrypted locally and are recalled when relevant. “What do you remember about me?” shows a readable account. “Turn memory off” stops recall and learning; “Remember our conversations” restores them. `/memory advanced` lists preference IDs; `/forget <ID>` removes a preference and `/forget all` clears saved memory. Keep credentials in the hidden connection/key prompts.

With memory enabled, the last 24 conversation entries also persist encrypted for up to 24 hours, including completed task results. Follow-ups such as “append to that file” can use this context after restarting. Model requests still have a fixed context budget, so this is bounded memory. `/new` clears the thread; switching models or privacy modes starts a new scope. Task results supply facts, never permission to repeat an action. Queued tasks do not survive quitting.

## Controls and macOS permissions

`/yes` and `/no` answer task approvals; `/stop`, `/pause`, `/resume` and Ctrl-C control work. Spoken approval never authorizes an action requiring a click or typed confirmation. Ctrl-D or `/quit` exits. `/help` lists commands.

For desktop control, name an already open app in your task (for example, `/run Summarize the visible note in Notes`). Butler can bind that window while its terminal stays in front. `/cua Summarize the visible note in Notes` explicitly selects desktop control without trying MCP first. Opening requests also bind an existing named window. Terminal windows remain protected; a closed app or task needing foreground interaction may require you to open the app or take over.

MCP-only tasks do not need screen recording. For desktop control, use `/permissions` to check and request Screen Recording and Accessibility. Grant access to the terminal host macOS identifies, then fully quit and reopen that host if requested. `butler permissions` checks access without requesting it.

Permission checks use the native helper’s current access status. After granting access, reopen the terminal host if macOS requires it.

If a task reports a model connection failure, run `/doctor model` inside Butler
or `butler doctor --model` from your shell. This makes a small paid request using
your selected model and a generated image, and reports connection and response
status. Network failures, request timeouts, HTTP rate limits and service outages
have specific messages. When the service requests a wait, `continue` stays paused
until that wait ends. Billing and spend limits require updating the account.
Local diagnostics in `~/.config/butler/diagnostics/current.jsonl` retain HTTP
statuses, known transport codes and timings, without prompts, screenshots,
credentials or raw error bodies.

## Development

Restore the full development dependencies before running the test suite:

```sh
npm ci --ignore-scripts
npm run build:terminal
npm start
npm run check
ELECTRON_OVERRIDE_DIST_PATH=/tmp/butler-electron-tests npm test -- --maxWorkers=4
```

The override lets legacy speech unit tests resolve Electron without downloading its desktop binary; their process spawns are mocked.

Butler ships as a CLI. `npm start`, `npm run dev`, and `npm run build` all target the terminal agent. Desktop app launch and packaging commands have been retired.

This is a development alpha. Offline tests validate policies, terminal behavior and mocked services; they do not establish arbitrary desktop reliability or live speech/model accuracy. See [validation](docs/VALIDATION.md) and [privacy](docs/PRIVACY.md).

Measured improvements and live-test limits are recorded in [the 3 October overnight evaluation](docs/OVERNIGHT_EVALUATION_2026-10-03.md).

Open source under the [MIT license](LICENSE).
