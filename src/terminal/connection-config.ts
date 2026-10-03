import {
  moduleEndpoint,
  toolServerSchema,
  type ToolServer,
} from "../core/schema";
import { containsSecret } from "../voice/speakable";
import { RESERVED_PROVIDERS, TOOL_LIMITS } from "../core/tools";

export interface ImportedConnection {
  row: ToolServer;
  secrets: Record<string, string>;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Import the usual Claude/Cursor or VS Code MCP JSON without logging credentials. */
export function importConnections(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ImportedConnection[] {
  if (!object(value))
    throw new Error("Use an MCP JSON object with mcpServers or servers.");
  const servers =
    value.mcpServers ||
    value.servers ||
    (object(value.mcp) && value.mcp.servers);
  if (
    !object(servers) ||
    !Object.keys(servers).length ||
    Object.keys(servers).length > TOOL_LIMITS.servers
  )
    throw new Error(
      "The MCP configuration must contain a bounded, non-empty server map.",
    );
  const ids = new Set<string>();
  return Object.entries(servers).map(([name, config]) => {
    if (!object(config))
      throw new Error("Each MCP server must be a configuration object.");
    let id = name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36);
    if (RESERVED_PROVIDERS.has(id)) id = "mcp-" + id;
    if (!id || ids.has(id))
      throw new Error("MCP server names must have unique usable identifiers.");
    ids.add(id);
    const secrets: Record<string, string> = {};
    const secretValues = (kind: "env" | "header", input: unknown) => {
      if (input === undefined) return [];
      if (!object(input))
        throw new Error(
          "MCP environment variables and headers must be objects.",
        );
      return Object.entries(input).map(([key, raw]) => {
        if (typeof raw !== "string" || raw.length > 16_000)
          throw new Error("MCP credentials must be bounded string values.");
        const resolved = raw.replace(
          /\$\{([A-Z_][A-Z0-9_]*)\}/g,
          (_match, variable) => {
            if (!env[variable])
              throw new Error(`Missing environment variable: ${variable}.`);
            return env[variable]!;
          },
        );
        if (resolved.includes("${"))
          throw new Error(
            "Resolve interactive MCP placeholders before importing.",
          );
        secrets[`mcp:${id}:${kind}:${key}`] = resolved;
        return key;
      });
    };
    const url = typeof config.url === "string" ? config.url : "";
    if (
      url &&
      (!moduleEndpoint(url) ||
        /[?&](?:token|access_token|api[_-]?key|key|secret|auth|authorization)=/i.test(
          url,
        ))
    )
      throw new Error(
        "MCP endpoints need HTTPS (HTTP only on localhost). Put credentials in headers, not URLs.",
      );
    if (config.type === "sse" || config.transport === "sse")
      throw new Error(
        "Use a Streamable HTTP endpoint or a local stdio proxy for an older SSE server.",
      );
    const command = typeof config.command === "string" ? config.command : "";
    const args = config.args ?? [];
    if (!url && !command)
      throw new Error("Each MCP server needs an executable or an endpoint.");
    if (
      containsSecret(command) ||
      (Array.isArray(args) &&
        args.some(
          (arg) =>
            typeof arg === "string" &&
            (containsSecret(arg) ||
              /^--?(?:token|api[-_]key|password|secret|authorization)(?:=|$)/i.test(
                arg,
              )),
        ))
    )
      throw new Error(
        "Put MCP credentials in environment variables or headers, not command arguments.",
      );
    try {
      const row = toolServerSchema.parse({
        id,
        name: name.slice(0, 40),
        transport: url ? "http" : "stdio",
        url,
        command,
        args,
        cwd: config.cwd ?? "",
        addedAt: Date.now(),
        network: config.network ?? "internet",
        secretEnv: secretValues("env", config.env),
        secretHeaders: secretValues("header", config.headers),
      });
      return { row, secrets };
    } catch (error) {
      // Zod errors can echo supplied values. Do not expose a config containing secrets.
      if (
        error instanceof Error &&
        error.message.startsWith("Missing environment")
      )
        throw error;
      throw new Error(
        "Invalid MCP configuration. Check the executable, argument array, working folder and credential names.",
      );
    }
  });
}
