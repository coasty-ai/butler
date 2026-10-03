# Butler

A macOS terminal assistant with a British butler’s manner, animated character graphics, MCP-first tools, and spoken briefings with an encrypted readable copy. Type naturally, ask it to work, or leave it running in the background.

Butler runs in Node.js. Its terminal interface does not launch Electron or a browser. Desktop control uses the existing native macOS helper when a connected tool cannot handle the task.

## Install

Requires macOS 14+, Node.js 22.12+, and Apple’s command-line developer tools (`xcode-select --install` if needed).

```sh
git clone https://github.com/coasty-ai/butler.git
cd butler
npm run install:terminal
export PATH="$HOME/.local/bin:$PATH"
```

The installer builds Butler, builds any missing native helpers, and installs `~/.local/bin/butler`. It skips the Electron binary download. Add the PATH line to `~/.zshrc` to keep the command available in new terminals.

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
/model openai
/key
```

Anthropic, Google and Ollama also work. A repository `.env` containing an existing provider key is loaded locally. Keys and account tokens are encrypted with a master key stored in macOS Keychain.

## Connect your apps

In Butler:

```text
/connect github
/connect claude-code
/connect codex
/connect slack
/connect gmail
/connections
```

GitHub reuses `gh auth login` when available and connects in read-only mode. Claude Code uses `claude mcp serve`. Codex uses Butler’s local MCP bridge to the installed, signed-in Codex CLI. Coding tasks ask for approval and run in the project folder chosen when connecting; use `butler --cwd /path/to/project` for a different project.

Slack requires an internal or Marketplace Slack app approved for its MCP server, PKCE enabled, its Client ID, and your account approval. Gmail requires a Google Desktop OAuth client JSON with Gmail API enabled, then your account approval. Their terminal wizards explain each step. Gmail access is read only; neither connection enables automatic sending. See the [connection guide](docs/TERMINAL.md).

## Regular briefings

Inside Butler, choose the interval in minutes:

```text
/briefings 30
/notifications on
/briefing
/latest
```

Each check uses available app/window context, observed notification banners and configured, trusted MCP reads. Butler suggests priorities, speaks the result with macOS’s British voice, and saves an encrypted readable copy. It reports missing coverage. It cannot inspect every app’s entire history or the complete Notification Center database.

Use `/briefing-reads` to see the current queries and `/briefing-read server__tool {"query":"..."}` to add a trusted read tool. Gmail adds a bounded unread-mail query when connected. Use `/briefings off` to disable scheduled checks. Checks wait during tasks or while the Mac is locked.

To keep briefings running after leaving the interactive terminal, first quit Butler with `/quit`, then:

```sh
butler daemon start
butler latest
butler daemon status
butler daemon stop
```

The background process keeps running after the terminal closes, until stopped or the Mac restarts. It does not install a login service. Only one interactive/background engine runs at a time.

## Controls and macOS permissions

Type to converse. `/run <task>` explicitly starts work. `/yes` and `/no` answer task approvals; `/stop`, `/pause`, `/resume` and Ctrl-C control work. Ctrl-D or `/quit` exits. `/voice off` disables spoken conversation replies. `/help` lists commands. The terminal version accepts text input; microphone listening remains in the earlier desktop version.

For desktop control, name an already open app in your task (for example, `/run Summarize the visible note in Notes`). Butler can bind that window while its terminal stays in front. Terminal windows remain protected.

MCP-only tasks do not need screen recording. For desktop control, use `/permissions` to check and request Screen Recording and Accessibility. Grant access to the terminal host macOS identifies, then fully quit and reopen that host if requested. A grant for the earlier Butler.app may not cover Terminal or iTerm. `butler permissions` checks access without requesting it.

The desktop permission checklist now uses the helper’s current answer: a historical denial no longer keeps “restart needed” stuck after access becomes available. If macOS grants access but the current helper cannot use it yet, it reports restart needed. Locally rebuilt, ad-hoc-signed app copies can need a new grant.

## Development

```sh
npm run build:terminal
npm start
npm run check
npm test -- --maxWorkers=4
```

This is a development alpha. Offline tests validate policies, terminal behavior and mocked services; they do not establish arbitrary desktop reliability or live speech/model accuracy. The previous desktop client remains available through explicit `dev:desktop`, `build:desktop` and `start:desktop` commands; see [desktop documentation](docs/DESKTOP.md), [validation](docs/VALIDATION.md), and [privacy](docs/PRIVACY.md).

Open source under the [MIT license](LICENSE).
