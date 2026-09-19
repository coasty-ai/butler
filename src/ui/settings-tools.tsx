/**
 * Settings › Tools. The Apple bridge's four consents and the user's own MCP
 * servers. Consents and servers are applied the moment they are changed,
 * through their own bridge calls, so what is shown is what is in force; only
 * the master switch is an ordinary setting saved with the form. Nothing here
 * shows a secret, and a server's descriptions are shown only here.
 */
import React, { useEffect, useState } from "react";
import type { Settings } from "../core/schema";
import {
  TOOL_INSTALL_REMEDY,
  runsNpxOffline,
  type AppleConsent,
  type ProviderState,
  type ToolTier,
} from "../core/tools";
import { RECIPES } from "../tools/providers";
import type { AppInfo, Bridge, ToolServerTest, ToolsStatus } from "./api";

const readable = (error: unknown) =>
  (error instanceof Error ? error.message : "")
    .replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "")
    .trim();

const APPLE: {
  consent: AppleConsent;
  label: string;
  does: string;
  pane: string;
}[] = [
  {
    consent: "calendar",
    label: "Calendar",
    does: "read and add events",
    pane: "Calendars",
  },
  {
    consent: "reminders",
    label: "Reminders",
    does: "read and add reminders",
    pane: "Reminders",
  },
  {
    consent: "notes",
    label: "Notes",
    does: "search titles and add notes",
    pane: "Automation",
  },
  {
    consent: "mail",
    label: "Mail",
    does: "read senders and subjects, and add drafts. Never sends",
    pane: "Automation",
  },
];
/** What the pane says about one provider's state. */
export function stateNote(state: ProviderState, code?: string): string {
  switch (state) {
    case "off":
      return "Off";
    case "starting":
      return "Starting…";
    case "on":
      return "Connected";
    case "changed":
      return "Changed: review";
    case "failed":
      return code === "exhausted"
        ? "Stopped after repeated exits. Retry when you are ready."
        : "Not running";
    case "needs_approval":
      return "Needs your approval";
    case "needs_install":
      // A recipe's package the app installs: missing, or its last install
      // failed (INSTALL_FAILED carries npm's exit status in the trace, never
      // its text). Anything else is the command itself not found.
      return code === "INSTALL_FAILED"
        ? `Could not install the server's package. ${TOOL_INSTALL_REMEDY}`
        : code === "NOT_INSTALLED"
          ? `Not installed. ${TOOL_INSTALL_REMEDY}`
          : "Not found: install Node 22+ or give the full path";
    case "needs_sign_in":
      return "Needs a token";
    case "needs_permission":
      return "Waiting for a macOS permission";
    case "blocked_local":
      return "Not available in Private local";
  }
}
/** What a consent's macOS access means for the user. */
export function accessNote(
  access: ToolsStatus["apple"]["access"][AppleConsent],
  pane: string,
): string {
  switch (access) {
    case "granted":
      return "Allowed.";
    case "denied":
    case "restricted":
      return `Allow Butler in System Settings › Privacy & Security › ${pane}.`;
    case "notDetermined":
      return "macOS will ask the first time.";
    default:
      return "";
  }
}
const tierWord: Record<ToolTier, string> = {
  read: "reads",
  additive: "adds",
  write: "changes",
  destructive: "runs or deletes",
};
/** The one-line summary the collapsed group shows. */
function summary(s: Settings, status: ToolsStatus): string {
  if (!s.tools.enabled) return "Off";
  const connected = status.servers.filter((x) => x.state === "on").length;
  const apple = APPLE.filter((a) => s.tools.apple[a.consent]).length;
  if (!connected && !apple) return "Nothing connected yet";
  return [
    apple ? `${apple} Apple app${apple === 1 ? "" : "s"}` : "",
    connected ? `${connected} server${connected === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
const downloads = (argv: string[]) =>
  argv.some((a) => /(?:^|\/)(?:npx|uvx|bunx)$/.test(a)) &&
  (argv.includes("-y") || argv.some((a) => /(?:^|\/)uvx$/.test(a)));
/**
 * What the consent sheet adds about the argv itself: a pasted npx row that
 * may not reach the network runs offline (the registry adds --offline), so
 * its package must already be in npx's cache; a runner that fetches on
 * first start says so. Nothing for an installed recipe or a plain command.
 */
export function argvNote(argv: string[]): string {
  if (runsNpxOffline(argv))
    return " Runs npx offline inside the network sandbox: the package must already be in npx's cache on this Mac, or the server fails to start at once (ENOTCACHED) rather than hang.";
  if (downloads(argv))
    return " May download the package the first time it starts; not available in Private local.";
  return "";
}
/** Whether a state is the install remedy's: the pane offers Approve again. */
export const installRemedy = (state: ProviderState, code?: string) =>
  state === "needs_install" &&
  (code === "INSTALL_FAILED" || code === "NOT_INSTALLED");

export function SettingsTools({
  s,
  set,
  api,
  busy,
  info,
}: {
  s: Settings;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  api: Bridge;
  busy: boolean;
  info: AppInfo;
}) {
  const [status, setStatus] = useState<ToolsStatus>(info.tools);
  const [apple, setApple] = useState(info.settings.tools.apple);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [paste, setPaste] = useState("");
  const [tests, setTests] = useState<Record<string, ToolServerTest>>({});
  const local = s.privacy === "PRIVATE_LOCAL";
  // Servers start and stop while this panel is open; a failure keeps the last
  // state and never replaces the settings error.
  useEffect(() => {
    setStatus(info.tools);
    setApple(info.settings.tools.apple);
    let current = true;
    const load = () =>
      api
        .toolsStatus()
        .then((next) => current && setStatus(next))
        .catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [info]);
  const apply = async (call: () => Promise<ToolsStatus>) => {
    setWorking(true);
    setError("");
    try {
      setStatus(await call());
    } catch (e) {
      setError(readable(e) || "That didn’t apply. Try again.");
    } finally {
      setWorking(false);
    }
  };
  const test = async (id: string) => {
    setWorking(true);
    setError("");
    try {
      setTests({ ...tests, [id]: await api.testToolServer(id) });
    } catch (e) {
      setError(readable(e) || "The server could not be tested.");
    } finally {
      setWorking(false);
    }
  };
  return (
    <details className="setting-group">
      <summary>
        <span>
          Tools
          <span>{summary(s, status)}</span>
        </span>
      </summary>
      <div className="setting-fields">
        <p>
          Butler does a step with a connected tool whenever one can, and drives
          the screen for the rest. Your model sees each tool’s name, one line
          about what it does and its parameters, and what it returns. Anything a
          tool adds, changes or sends is confirmed on this Mac first, unless you
          set a server’s reads to run without asking.
          {local
            ? " Private local runs only tools that stay on this Mac."
            : " With your own model provider, tool results go to that provider like the screen does."}
        </p>
        <label className="consent">
          <input
            type="checkbox"
            checked={s.tools.enabled}
            onChange={(e) =>
              set("tools", { ...s.tools, enabled: e.target.checked })
            }
          />
          <span>Let Butler use connected tools</span>
        </label>
        <p>
          <b>Apple apps</b>
        </p>
        {status.apple.state === "needs_install" && (
          <p role="status">The Apple bridge is not part of this build.</p>
        )}
        {APPLE.map((a) => (
          <label key={a.consent} className="consent">
            <input
              type="checkbox"
              checked={apple[a.consent]}
              disabled={
                busy || working || status.apple.state === "needs_install"
              }
              onChange={(e) => {
                const on = e.target.checked;
                setApple({ ...apple, [a.consent]: on });
                void apply(() => api.setAppleTool(a.consent, on));
              }}
            />
            <span>
              {a.label}: {a.does}.
              {apple[a.consent] && (
                <> {accessNote(status.apple.access[a.consent], a.pane)}</>
              )}
            </span>
          </label>
        ))}
        <p>
          <b>Servers</b>
        </p>
        <p>
          A server you add runs as you, with its own tools. Connect one from a
          recipe, paste a Claude Desktop block, or import that app’s
          configuration. Nothing starts until you have read what it runs and
          approved it.
        </p>
        <div className="review-buttons">
          {RECIPES.map((recipe) => (
            <button
              key={recipe.id}
              type="button"
              className="secondary"
              disabled={busy || working || (local && !recipe.privateLocal)}
              title={
                local && !recipe.privateLocal
                  ? "Not available in Private local"
                  : recipe.installNote
              }
              onClick={() =>
                void apply(() => api.addToolServer({ recipe: recipe.id }))
              }
            >
              Add {recipe.name}
            </button>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={busy || working}
            onClick={() =>
              void apply(() => api.addToolServer({ claudeDesktop: true }))
            }
          >
            Import from Claude Desktop
          </button>
        </div>
        <label>
          Paste a Claude Desktop {"{"}"mcpServers"{"}"} block
          <textarea
            rows={3}
            value={paste}
            disabled={busy || working}
            onChange={(e) => setPaste(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={busy || working || !paste.trim()}
          onClick={() =>
            void apply(async () => {
              const next = await api.addToolServer({ paste });
              setPaste("");
              return next;
            })
          }
        >
          Import pasted servers
        </button>
        {status.servers.length === 0 && <p>No server connected yet.</p>}
        {status.servers.map((server) => {
          const recipe = RECIPES.find((r) => r.id === server.recipe);
          const preview = tests[server.id];
          return (
            <div key={server.id} className="consent">
              <span>
                <b>{server.name}</b> · {stateNote(server.state, server.code)}
                {server.state === "on" || server.state === "changed"
                  ? ` · ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`
                  : ""}
                <br />
                {server.transport === "http"
                  ? "Remote server over https"
                  : server.resolved
                    ? server.argv.join(" ")
                    : stateNote("needs_install")}
                <br />
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={
                      server.state !== "off" &&
                      server.state !== "needs_approval"
                    }
                    // Approving a row (below) is what enables it.
                    disabled={
                      busy || working || server.state === "needs_approval"
                    }
                    onChange={(e) =>
                      void apply(() =>
                        api.setToolServer(server.id, {
                          enabled: e.target.checked,
                        }),
                      )
                    }
                  />
                  <span>Enabled</span>
                </label>
                {server.state === "failed" && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || working}
                    onClick={() =>
                      void apply(() =>
                        api.setToolServer(server.id, { enabled: true }),
                      )
                    }
                  >
                    Retry
                  </button>
                )}
                <label>
                  Reads
                  <select
                    value={server.trust}
                    disabled={busy || working}
                    onChange={(e) =>
                      void apply(() =>
                        api.setToolServer(server.id, {
                          trust: e.target.value as "ask" | "reads_unattended",
                        }),
                      )
                    }
                  >
                    <option value="ask">Ask on this Mac</option>
                    <option value="reads_unattended">Run without asking</option>
                  </select>
                </label>
                {server.transport === "stdio" && (
                  <label>
                    Network
                    <select
                      value={server.network}
                      disabled={busy || working}
                      onChange={(e) =>
                        void apply(() =>
                          api.setToolServer(server.id, {
                            network: e.target.value as "none" | "internet",
                          }),
                        )
                      }
                    >
                      <option value="none">
                        None{server.sandboxed ? " (enforced)" : ""}
                      </option>
                      <option value="internet">Internet</option>
                    </select>
                  </label>
                )}
                {server.state === "needs_approval" && (
                  <div className="correction-note">
                    <b>Approve and start</b>
                    <p>
                      Butler will run exactly:{" "}
                      {server.transport === "http"
                        ? "a remote server over https"
                        : server.argv.join(" ")}
                    </p>
                    <p>
                      This runs as you
                      {server.disclaimed
                        ? ", with its own macOS permission prompts"
                        : ", with Butler’s macOS permissions"}
                      . {recipe?.consent ?? ""} {recipe?.installNote ?? ""}
                      {argvNote(server.argv)}
                      {local && server.network !== "none"
                        ? " Not available in Private local."
                        : ""}
                    </p>
                    {preview && (
                      <p>
                        {preview.install?.ran && preview.install.ok
                          ? `Installed its package in ${Math.max(1, Math.round(preview.install.durationMs / 1000))} s. `
                          : ""}
                        {preview.ok
                          ? `Lists ${preview.toolCount} tool${preview.toolCount === 1 ? "" : "s"}.`
                          : `Could not connect: ${stateNote(preview.state, preview.code)}`}
                      </p>
                    )}
                    {preview?.ok && (
                      <ul>
                        {preview.tools.map((tool) => (
                          <li key={tool.name}>
                            <b>{tool.name}</b> · {tierWord[tool.tier]}
                            {tool.denied ? " · never called from here" : ""}
                            {tool.description ? ` · ${tool.description}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="review-buttons">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || working || !server.resolved}
                        onClick={() => void test(server.id)}
                      >
                        Test
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={
                          busy ||
                          working ||
                          !server.resolved ||
                          (local && server.network !== "none")
                        }
                        onClick={() =>
                          void apply(() => api.approveToolServer(server.id))
                        }
                      >
                        Approve and start
                      </button>
                    </div>
                  </div>
                )}
                {installRemedy(server.state, server.code) && (
                  <div className="correction-note">
                    <p>
                      Butler will run exactly: {server.argv.join(" ")}.
                      Approving again installs the package first (
                      {recipe?.installNote ?? ""}
                      ).
                    </p>
                    <div className="review-buttons">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || working || !server.resolved}
                        onClick={() =>
                          void apply(() => api.approveToolServer(server.id))
                        }
                      >
                        Approve again and install
                      </button>
                    </div>
                  </div>
                )}
                {server.tools.length > 0 && (
                  <div className="correction-note">
                    <b>Tools</b>
                    <p>
                      Tick the tools Butler may use. A ticked tool is pinned to
                      its description; if the server changes it, the tool is
                      held back until you tick it again.
                    </p>
                    {server.tools.map((tool) => (
                      <label
                        key={tool.name}
                        className="consent"
                        style={tool.denied ? { opacity: 0.5 } : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={tool.on && !tool.changed}
                          disabled={busy || working || tool.denied}
                          onChange={(e) =>
                            void apply(() =>
                              api.setToolTicked(
                                server.id,
                                tool.name,
                                e.target.checked,
                              ),
                            )
                          }
                        />
                        <span>
                          <b>{tool.title || tool.name}</b> ·{" "}
                          {tierWord[tool.tier]}
                          {tool.denied ? " · never called from here" : ""}
                          {tool.changed ? " · Changed: review" : ""}
                          {tool.description ? (
                            <>
                              <br />
                              {tool.description}
                            </>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || working}
                  onClick={() =>
                    void apply(() => api.forgetToolServer(server.id))
                  }
                >
                  Forget
                </button>
              </span>
            </div>
          );
        })}
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
