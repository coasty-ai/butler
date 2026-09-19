/**
 * Settings › Modules (.data/design/modules.md §7). One row per stage of the
 * pipeline: its plain-language name, the adapter in force, a picker
 * (Built-in · a tool from a connected server, listed by server and tool ·
 * an HTTP endpoint · for the recognizer, a command), the "fall back to
 * Built-in on error" switch, the last code and latency the registry saw,
 * and for the site recipes the user file's path, how many entries loaded
 * and which were rejected. Under each row, one sentence on what stays
 * fixed whatever the adapter (§1, §10). Choices are ordinary settings saved
 * with the form; status is read from the registry while the pane is open.
 */
import React, { useEffect, useState } from "react";
import type {
  ChoiceModelChoice,
  ModuleChoice,
  ModulesSettings,
  RecognizerChoice,
  Settings,
} from "../core/schema";
import { PORTS, type PortName } from "../modules/contracts";
import type { ModulesStatus, PortStatus } from "../modules/registry";
import type { AppInfo, Bridge, RecipesStatus, ToolsStatus } from "./api";

/** The stages the pane lists: the registry's ports, the recognizer command, the recipes file and the declared-only stages. */
export type ModuleRow =
  | PortName
  | "recognizer"
  | "recipes"
  | "appOpener"
  | "scroller"
  | "dialogDecider"
  | "taskModel"
  | "memory";
export interface ModuleRowInfo {
  row: ModuleRow;
  name: string;
  does: string;
  /** What never changes, whatever the adapter. */
  fixed: string;
}
export const MODULE_ROWS: readonly ModuleRowInfo[] = [
  {
    row: "recognizer",
    name: "Hearing you",
    does: "listens for the wake phrase and turns speech into words",
    fixed:
      "Whatever hears you, no word acts before the policy has judged it, and a replacement command owns its own microphone permission.",
  },
  {
    row: "clauseSegmenter",
    name: "Cutting a sentence into clauses",
    does: "decides where one request ends and the next begins while you speak",
    fixed:
      "However the sentence is cut, each clause passes the same rules before anything happens.",
  },
  {
    row: "fastDecider",
    name: "Deciding what a clause means",
    does: "turns a clause into a site, a search or an application to open, at once",
    fixed:
      "Whatever decides, a clause with a word of consequence or a credential waits for the end of the sentence, and only navigation may run while you speak.",
  },
  {
    row: "choiceModel",
    name: "The quick choice model",
    does: "answers one fixed multiple-choice question with a probability",
    fixed:
      "A choice model only ever picks one of the options it is given; it never writes text that runs.",
  },
  {
    row: "recipes",
    name: "Site recipes",
    does: "the sites whose search Butler can load by address, and how you say them",
    fixed:
      "A recipe builds only an https address on its own site with your words in the site's own search; a protected site is never loaded.",
  },
  {
    row: "urlOpener",
    name: "Loading a web address",
    does: "sends the browser to a page without keys or clicks",
    fixed:
      "Any address from any adapter must be http or https without credentials and off the protected list; nothing is typed or clicked.",
  },
  {
    row: "appOpener",
    name: "Opening an application",
    does: "brings an application forward by name",
    fixed:
      "Built-in only for now; the policy's rules for opening are unchanged.",
  },
  {
    row: "scroller",
    name: "Scrolling",
    does: "scrolls the page in front until you say stop",
    fixed: "Built-in only for now; scrolling never touches a control.",
  },
  {
    row: "dialogDecider",
    name: "Understanding a request",
    does: "decides whether to answer, act or ask",
    fixed:
      "Your model choice above applies; every step still goes through the policy and approvals.",
  },
  {
    row: "taskModel",
    name: "Doing the task",
    does: "proposes the steps on screen",
    fixed:
      "Your model choice above applies; every step still goes through the policy and approvals.",
  },
  {
    row: "tts",
    name: "Speaking",
    does: "says a sentence aloud",
    fixed:
      "In Private local nothing you are told leaves this Mac: an internet voice is refused before it is asked.",
  },
  {
    row: "memory",
    name: "Remembering",
    does: "recalls and learns from what worked",
    fixed: "Declared for later adapters; memory stays encrypted on this Mac.",
  },
];
const PORT_SET = new Set<string>(Object.keys(PORTS));
const isPort = (row: ModuleRow): row is PortName => PORT_SET.has(row);
type SettingsPort = Exclude<
  keyof ModulesSettings,
  "recognizer" | "choiceModel"
>;
type AnyChoice = ModuleChoice | ChoiceModelChoice | RecognizerChoice;
type WithFallback = Extract<ModuleChoice, { fallback: boolean }>;
/** An mcp or http choice of a port that falls back (the choice model and the recognizer have no switch). */
const hasFallback = (c: AnyChoice): c is WithFallback =>
  "fallback" in c &&
  typeof (c as { fallback?: unknown }).fallback === "boolean";

/** The picker's value for a choice: builtin, jev, mcp:<server>:<tool>, http, openrouter, command. */
export function choiceValue(
  choice: AnyChoice | undefined,
  row: ModuleRow,
): string {
  if (!choice) return row === "choiceModel" ? "jev" : "builtin";
  if (choice.kind === "mcp") return `mcp:${choice.server}:${choice.tool}`;
  return choice.kind;
}
/** The choice a picker value names, keeping what the previous choice already said. */
export function choiceFromValue(
  value: string,
  row: ModuleRow,
  previous: AnyChoice | undefined,
): AnyChoice | undefined {
  const fallback =
    previous && "fallback" in previous ? previous.fallback : true;
  if (value === "builtin" || value === "jev") return undefined;
  if (value.startsWith("mcp:")) {
    const [, server, ...rest] = value.split(":");
    const tool = rest.join(":");
    return { kind: "mcp", server, tool, fallback };
  }
  if (value === "http") {
    const url = previous && "url" in previous ? previous.url : "";
    return { kind: "http", url, fallback };
  }
  if (value === "openrouter")
    return {
      kind: "openrouter",
      model: previous && "model" in previous ? previous.model : "",
      fallback,
    };
  if (value === "command")
    return {
      kind: "command",
      command: previous && "command" in previous ? previous.command : "",
      args: previous && "args" in previous ? previous.args : [],
    };
  return undefined;
}
/** The adapter in force, in words. */
export function adapterLabel(
  status: PortStatus | undefined,
  choice: AnyChoice | undefined,
  tools: ToolsStatus,
  row?: string,
): string {
  const kind = status?.kind ?? choice?.kind ?? "builtin";
  switch (kind) {
    case "builtin":
      // The choice model's built-in is Jev (the registry reports it as builtin).
      return row === "choiceModel" ? "Jev (OpenRouter)" : "Built-in";
    case "jev":
      return "Jev (OpenRouter)";
    case "openrouter":
      return `OpenRouter · ${status?.model ?? (choice && "model" in choice ? choice.model : "")}`;
    case "http":
      return "HTTP endpoint";
    case "command":
      return "Command";
    case "mcp": {
      const server =
        status?.server ?? (choice && "server" in choice ? choice.server : "");
      const tool =
        status?.tool ?? (choice && "tool" in choice ? choice.tool : "");
      const name = tools.servers.find((s) => s.id === server)?.name ?? server;
      return `${name} · ${tool}`;
    }
  }
}
/** The last call, in words: "ok · 12 ms", "timeout · 620 ms", or nothing yet. */
export function statusLine(status: PortStatus | undefined): string {
  if (!status || !status.calls) return "Not called yet";
  const code = status.lastCode ?? "ok";
  const ms =
    status.lastMs !== undefined ? ` · ${Math.round(status.lastMs)} ms` : "";
  return `${code === "ok" ? "Last call ok" : `Last call failed: ${code}`}${ms} · ${status.calls} call${status.calls === 1 ? "" : "s"}`;
}
/** The recipes file, in words. */
export function recipesLine(status: RecipesStatus | undefined): string {
  if (!status) return "Reading…";
  if (!status.exists)
    return `No file yet: ${status.builtin} built-in site${status.builtin === 1 ? "" : "s"}. Add ${status.path} to add your own.`;
  if (status.error === "not_json")
    return "The file is not valid JSON; the built-ins stand.";
  if (status.error === "not_array")
    return "The file must be a JSON array of entries; the built-ins stand.";
  if (status.error === "unreadable")
    return "The file could not be read; the built-ins stand.";
  const rejected = status.rejected.length
    ? ` ${status.rejected.length === 1 ? "Entry" : "Entries"} ${status.rejected
        .map((r) => `${r.index} (${r.code})`)
        .join(", ")} rejected.`
    : "";
  return `${status.loaded} of your entr${status.loaded === 1 ? "y" : "ies"} loaded over ${status.builtin} built-in: ${status.total} sites.${rejected}`;
}
/** The one-line summary the collapsed group shows. */
export function summary(s: Settings): string {
  const changed = Object.entries(s.modules ?? {}).filter(([, c]) => c).length;
  return changed ? `${changed} changed` : "All built-in";
}
/** Servers and ticked tools a picker may name: connected, and each tool on and unchanged. */
export function pickableTools(
  tools: ToolsStatus,
): { server: string; name: string; tool: string }[] {
  const out: { server: string; name: string; tool: string }[] = [];
  for (const server of tools.servers) {
    if (server.state !== "on" && server.state !== "changed") continue;
    for (const tool of server.tools)
      if (tool.on && !tool.changed && !tool.denied)
        out.push({ server: server.id, name: server.name, tool: tool.name });
  }
  return out;
}

export function SettingsModules({
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
  const [status, setStatus] = useState<ModulesStatus | undefined>();
  const [tools, setTools] = useState<ToolsStatus>(info.tools);
  const [recipes, setRecipes] = useState<RecipesStatus | undefined>();
  const [error, setError] = useState("");
  const local = s.privacy === "PRIVATE_LOCAL";
  useEffect(() => {
    setTools(info.tools);
    let current = true;
    const load = () => {
      api
        .modulesStatus()
        .then((next) => current && setStatus(next))
        .catch(() => {});
      api
        .toolsStatus()
        .then((next) => current && setTools(next))
        .catch(() => {});
    };
    load();
    api
      .recipesStatus()
      .then((next) => current && setRecipes(next))
      .catch(() => {});
    const timer = setInterval(load, 5000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [info]);
  const modules: ModulesSettings = s.modules ?? {};
  const update = (
    row: keyof ModulesSettings,
    choice: AnyChoice | undefined,
  ) => {
    const next: ModulesSettings = { ...modules };
    if (choice) (next as Record<string, AnyChoice>)[row] = choice;
    else delete next[row];
    set("modules", next);
  };
  const reread = async () => {
    setError("");
    try {
      setRecipes(await api.recipesStatus());
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : "") || "The file could not be read.",
      );
    }
  };
  const pickable = pickableTools(tools);
  return (
    <details className="setting-group">
      <summary>
        <span>
          Modules
          <span>{summary(s)}</span>
        </span>
      </summary>
      <div className="setting-fields">
        <p>
          Every stage of what Butler does is a part you can swap: a tool on a
          connected server, an HTTP endpoint, or for hearing you, a command. The
          rules do not move with it. Whatever a part answers is judged exactly
          as the built-in’s answer would be: the policy, approvals, protected
          sites and the journal stay the same.
          {local
            ? " Private local keeps every part on this Mac."
            : " With your own model provider, a part on the internet sees what the built-in would have seen."}
        </p>
        {MODULE_ROWS.map((row) => {
          const key = row.row as keyof ModulesSettings;
          const choice =
            row.row === "recipes" ||
            row.row === "appOpener" ||
            row.row === "scroller" ||
            row.row === "dialogDecider" ||
            row.row === "taskModel" ||
            row.row === "memory"
              ? undefined
              : modules[key];
          const portStatus = isPort(row.row) ? status?.[row.row] : undefined;
          const value = choiceValue(choice, row.row);
          const pluggable = isPort(row.row) || row.row === "recognizer";
          return (
            <div key={row.row} className="consent">
              <span>
                <b>{row.name}</b> · {row.does}.
                <br />
                {row.row === "recipes" ? (
                  <>
                    {recipesLine(recipes)}{" "}
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void reread()}
                    >
                      Re-read
                    </button>
                  </>
                ) : pluggable ? (
                  <>
                    Now: {adapterLabel(portStatus, choice, tools, row.row)}
                    {isPort(row.row) ? ` · ${statusLine(portStatus)}` : ""}
                    <br />
                    <label>
                      Use
                      <select
                        value={value}
                        disabled={busy}
                        onChange={(e) =>
                          update(
                            key,
                            choiceFromValue(e.target.value, row.row, choice),
                          )
                        }
                      >
                        {row.row === "choiceModel" ? (
                          <option value="jev">Jev (OpenRouter)</option>
                        ) : (
                          <option value="builtin">Built-in</option>
                        )}
                        {row.row === "recognizer" ? (
                          <option value="command">A command</option>
                        ) : (
                          <>
                            {pickable.map((t) => (
                              <option
                                key={`${t.server}:${t.tool}`}
                                value={`mcp:${t.server}:${t.tool}`}
                              >
                                {t.name} · {t.tool}
                              </option>
                            ))}
                            <option value="http">HTTP endpoint</option>
                            {row.row === "choiceModel" && (
                              <option value="openrouter">
                                OpenRouter model
                              </option>
                            )}
                          </>
                        )}
                      </select>
                    </label>
                    {choice?.kind === "http" && (
                      <label>
                        Endpoint (https, JSON in and out)
                        <input
                          type="url"
                          value={choice.url}
                          disabled={busy}
                          onChange={(e) =>
                            update(key, { ...choice, url: e.target.value })
                          }
                        />
                      </label>
                    )}
                    {choice?.kind === "openrouter" && (
                      <label>
                        Model id
                        <input
                          type="text"
                          value={choice.model}
                          disabled={busy}
                          onChange={(e) =>
                            update(key, { ...choice, model: e.target.value })
                          }
                        />
                      </label>
                    )}
                    {choice?.kind === "command" && (
                      <>
                        <label>
                          Command
                          <input
                            type="text"
                            value={choice.command}
                            disabled={busy}
                            onChange={(e) =>
                              update(key, {
                                ...choice,
                                command: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          Arguments (one per line)
                          <textarea
                            rows={2}
                            value={choice.args.join("\n")}
                            disabled={busy}
                            onChange={(e) =>
                              update(key, {
                                ...choice,
                                args: e.target.value
                                  .split("\n")
                                  .map((a) => a.trim())
                                  .filter(Boolean),
                              })
                            }
                          />
                        </label>
                        <p>
                          The command speaks the voice helper’s JSON-lines
                          protocol and asks macOS for its own microphone
                          permission (docs/MODULES.md).
                        </p>
                      </>
                    )}
                    {choice && hasFallback(choice) && (
                      <label className="consent">
                        <input
                          type="checkbox"
                          checked={choice.fallback}
                          disabled={busy}
                          onChange={(e) =>
                            update(key, {
                              ...choice,
                              fallback: e.target.checked,
                            })
                          }
                        />
                        <span>
                          Fall back to Built-in when it fails, times out or
                          answers badly (off: the stage skips)
                        </span>
                      </label>
                    )}
                  </>
                ) : (
                  <>Built-in only for now.</>
                )}
                <br />
                <small>{row.fixed}</small>
              </span>
            </div>
          );
        })}
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
