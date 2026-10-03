# Terminal connections

Start `butler`, then use `/connect <name>`. `butler connect github` also works when no credential prompt is needed. Connections are separate from ChatGPT/Codex desktop plugins; their authentication does not transfer into Butler.

## GitHub

Install GitHub CLI, then run `gh auth login` and `/connect github`. Butler caches its token in the encrypted profile, sets `X-MCP-Readonly: true`, and enables selected repository, issue and pull-request reads. It does not enable GitHub writes. A manually supplied token is entered at a masked prompt and saved encrypted.

[GitHub’s MCP configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md).

## Claude Code and Codex

Install and sign in to each CLI first. Connect while running `butler --cwd /path/to/project`; the persisted server’s working directory is that project. Claude Code exposes its native MCP server with `claude mcp serve`; Butler offers the Agent entry point and available file reads, with a confirmation before coding work.

Current Codex versions removed `codex mcp-server`. Butler’s local `codex_task` MCP bridge calls the supported `codex exec` interface, keeps its workspace sandbox and approval policy, and interrupts its owned process group when a request is cancelled. It reports Codex’s own result without claiming independent verification. It does not use skip-permissions flags or attach to a shared Codex daemon.

[Official Codex integration documentation](https://learn.chatgpt.com/docs/app-server).

## Slack

Slack’s official MCP server requires an internal or Marketplace Slack app with OAuth configured; it does not offer arbitrary dynamic client registration. Create/configure the app at [Slack’s app dashboard](https://api.slack.com/apps), then follow [Slack’s harness connection guide](https://docs.slack.dev/ai/slack-mcp-server/connect-to-harnesses/).

To create the dedicated Butler integration:

1. Open [Your Apps](https://api.slack.com/apps), choose **Create New App → From scratch**, name it **Butler**, and select your workspace. Keep it internal; an unlisted distributed app cannot use Slack MCP.
2. In **OAuth & Permissions**, enable **PKCE**. This makes the app a public client; Slack says the setting cannot be reversed without support, so use a dedicated Butler app rather than changing an app used by another service. [Slack PKCE guide](https://docs.slack.dev/authentication/using-pkce/).
3. Add `http://localhost:53682/callback` under **Redirect URLs** and save it.
4. Under **User Token Scopes**, add these reads:

   ```text
   search:read.public
   search:read.private
   channels:history
   groups:history
   ```

5. Install/approve the app for your workspace. If app approval is restricted, your Slack administrator must approve it and permit MCP access.
6. Open **Basic Information → App Credentials** and copy its **Client ID**. Butler's PKCE desktop flow does not ask for a Client Secret.
7. Start `butler`, run `/connect slack`, enter that Client ID, open the displayed authorization URL, and approve the workspace/account.

Butler uses Slack’s MCP user authorization and token endpoints, with a fresh PKCE verifier and random state on each attempt. It requests public/private channel search and history; it does not request sending or direct-message scopes. Access/refresh tokens are stored encrypted. Rotating refresh tokens can expire, so reconnect if Slack requests it.

## Gmail

What Butler needs: the downloaded JSON file for a **Desktop app OAuth client**, not a Gemini API key, service account, or Gmail password.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create/select a project named **Butler**.
2. Open **APIs & Services → Library**, find **Gmail API**, and enable it.
3. Open **Google Auth platform → Branding**. Create the consent-screen configuration with app name **Butler**, your support email and your developer contact email.
4. In **Audience**, use **External / Testing** for a personal Gmail account and add your Gmail address under **Test users**. An eligible Google Workspace project can use **Internal** for accounts inside that organization.
5. Open **Google Auth platform → Clients → Create client**, choose **Desktop app**, name it **Butler**, and download the JSON. Keep it outside the repository, for example in Downloads. [Google's setup guide](https://developers.google.com/workspace/gmail/api/quickstart/nodejs), [consent-screen guide](https://developers.google.com/workspace/guides/configure-oauth-consent).
6. Start `butler`, run `/connect gmail`, and enter the downloaded file’s full local path. Open the displayed authorization URL and approve the intended Gmail account. Butler requests the `gmail.readonly` scope and receives a local loopback callback, validating state and PKCE before saving encrypted credentials.

Butler’s built-in MCP bridge exposes only `gmail_search` and `gmail_read`. It uses `gmail.readonly`, bounds message bodies and query results, and never calls send, delete or modify endpoints. Google test-mode grants can expire; reconnect when needed.

[Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Gmail API message reads](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list).

## Briefing reads

Use `/briefing-reads` to inspect saved queries. Add a query with `/briefing-read <server__tool> <JSON arguments>` after connecting that tool. Only enabled, trusted, short read tools can be used for unattended briefings. Gmail adds `gmail__gmail_search` with `{"query":"is:unread newer_than:1d","limit":8}`. Other services require an explicit query appropriate to their current tool schema. `/briefing-reads clear` removes the saved queries.

Profiles and the latest readable copy live in `~/.config/butler` (override with `BUTLER_DATA_DIR`). The background log contains status/errors, never briefing text. `butler latest` decrypts and displays the copy on demand. Notification observation is opt-in, bounded to observed banners and excludes protected apps; it is not access to every notification stored by macOS.
