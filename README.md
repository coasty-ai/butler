# Butler

A macOS personal assistant with a Codex-style chat transcript, animated character graphics, a British butler’s manner, and MCP-first tools with desktop control as a fallback. Chat naturally, ask it to work, or receive regular spoken briefings with an encrypted readable copy.

Butler runs in Node.js. Its terminal interface does not launch Electron or a browser. Desktop control uses the existing native macOS helper when a connected tool cannot handle the task.

## Install

Requires macOS 14+, Node.js 22.12+, and Apple’s command-line developer tools (`xcode-select --install` if needed).

```sh
git clone https://github.com/coasty-ai/butler.git
cd butler
npm run install:terminal
export PATH="$HOME/.local/bin:$PATH"
```

The installer builds Butler, builds any missing native helpers, and installs `~/.local/bin/butler`. It skips the Electron binary download and the optional legacy voice inference runtime; the CLI uses macOS speech. Add the PATH line to `~/.zshrc` to keep the command available in new terminals.

Already have this checkout? Run `npm run install:terminal` in its folder.

## Start

```sh
butler
```

Preview just the animation without accounts, permissions, or model calls:

```sh
butler --demo
```

Choose a model in Butler and enter its API key at the masked prompt:

```text
/model openai gpt-6.1-sol fast
/key
```

New OpenAI profiles default to GPT-6.1 Sol in Fast mode with low reasoning effort. Existing profiles keep their saved model until you run `/model`. [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode) costs twice the standard token rates; `/fast off` switches back. Anthropic, Google and Ollama also work. A repository `.env` containing an existing provider key is loaded locally. Keys and account tokens are encrypted with a master key stored in macOS Keychain.

Replies stream into the conversation. Page Up/Down scrolls the transcript, Up/Down recalls typed inputs, and `/new` starts a fresh conversation. Natural requests can start tasks; `/run <task>` makes that explicit.

Simple questions such as “check my reminders” (items due today) or “what’s on my calendar tomorrow?” use the connected Apple read tool directly, without a model call. More involved requests use your chosen model and available tools.

“Check my inbox” or “Read my five newest unread Gmail messages and tell me which need attention” uses one Gmail search, parallel message reads and one summary call when those read tools are trusted. Each reported passage is checked against its message, with suggestions labelled separately and incomplete coverage stated. One-shot inbox checks start only the Gmail connection:

```sh
butler --ask "Check my inbox"
```

Unused Claude Code and Codex connections keep their approved tool catalogue available while releasing their processes after discovery. The first task reconnects and checks the tool pins again; a connection stays running once used so its background work can continue.

For spoken replies and voice input:

```text
/voice on
/voice test
/listen on
```

Approve Microphone and Speech Recognition for Butler's standalone voice helper when macOS asks. Say **Hey Butler**, then your request; follow-up listening continues the conversation after a reply. Option-Space offers push-to-talk when the helper has Accessibility access. Start with `butler --listen` to enable voice setup immediately. `/listen off` disables input, `/voice off` disables replies, and `/doctor` checks the model, voice and desktop permissions. Output uses an installed British voice, preferring Daniel; `/voice list` and `/voice <name>` select another.

## Connect your apps

In Butler:

```text
/connect
/connect all
/connect github
/connect claude-code
/connect codex
/connect slack bot
/connect gmail
/connect apple
/connect filesystem
/connect playwright
/connect mcp
/connect import /path/to/mcp-config.json
/connections
/apps
```

GitHub reuses `gh auth login` when available and connects in read-only mode. Claude Code uses `claude mcp serve`. Codex uses Butler’s local MCP bridge to the installed, signed-in Codex CLI. Coding tasks ask for approval and run in the project folder chosen when connecting; use `butler --cwd /path/to/project` for a different project.

Slack can use a **bot token (`xoxb-…`)** for reads from conversations the bot has joined. An app token (`xapp-…`) is unnecessary for scheduled reads. `/connect slack oauth` instead uses Slack's official MCP user authorization. Gmail needs a Google Desktop OAuth client JSON with Gmail API enabled, then your account approval. Their wizards explain setup; the built-in Gmail and Slack bot bridges provide reads.

Connect Calendar, Reminders, Notes and Mail through `/connect apple` or their individual names. The custom wizard supports local stdio or remote Streamable HTTP MCP servers, OAuth, bearer tokens, custom headers, environment variables and no authentication. Import Claude/Cursor/VS Code MCP JSON to reuse configurations. `/tools`, `/tool server__tool on|off`, `/trust server reads|ask` and `/disconnect server` manage access. Credentials are entered at masked prompts and stored encrypted. See the [connection guide](docs/TERMINAL.md).

`/apps` lists installed applications and connection paths. Each account still needs its own authorization; apps without an API or MCP can use desktop control.

## Regular briefings

Inside Butler, choose the interval in minutes:

```text
/briefings 30
/notifications on
/briefing
/latest
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

## Memory

Tell Butler `Remember that I prefer concise briefings`, or use `/remember <preference>`. Preferences and completed task history persist encrypted locally and are recalled when relevant. `/memory` lists preferences and their IDs; `/memory off` stops recall and learning; `/memory on` restores them. `/forget <ID>` removes a preference and `/forget all` clears saved memory. Keep credentials in `/key` or `/connect`.

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
npm test -- --maxWorkers=4
```

Butler ships as a CLI. `npm start`, `npm run dev`, and `npm run build` all target the terminal agent. Desktop app launch and packaging commands have been retired.

This is a development alpha. Offline tests validate policies, terminal behavior and mocked services; they do not establish arbitrary desktop reliability or live speech/model accuracy. See [validation](docs/VALIDATION.md) and [privacy](docs/PRIVACY.md).

Open source under the [MIT license](LICENSE).
