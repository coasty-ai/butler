import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";
import { toolServerSchema, type ToolServer } from "../core/schema";
import { scanText } from "../core/sanitize";
import { RESERVED_PROVIDERS, TOOL_LIMITS } from "../core/tools";

/**
 * A Claude Desktop `{"mcpServers": {…}}` block, pasted or read from
 * claude_desktop_config.json, becomes rows the user still has to approve:
 * every row arrives disabled and unconsented, remote entries are skipped,
 * `${…}` is never expanded from the app's environment, and anything that
 * reads like a secret moves to the vault. An error never echoes the input.
 */
export const IMPORT_MAX_BYTES = 64 * 1024;
export const SECRET_NAME =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const IMPORT_ERROR =
  'Could not import servers. Paste a Claude Desktop {"mcpServers": …} block of at most 64 KB.';
export interface ImportedSecret {
  id: string;
  name: string;
  value: string;
}
export interface ImportResult {
  rows: ToolServer[];
  secrets: ImportedSecret[];
  counts: {
    added: number;
    skippedRemote: number;
    refused: number;
    secretsMoved: number;
  };
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";

/** A settings id from the block's label: lowercase, dashes, never reserved, never taken. */
export function serverId(label: string, taken: ReadonlySet<string>): string {
  let slug = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 34);
  if (!/^[a-z0-9]/.test(slug)) slug = `s-${slug}`.replace(/-$/, "");
  if (RESERVED_PROVIDERS.has(slug)) slug += "-server";
  let id = slug;
  for (let n = 2; taken.has(id); n++) id = `${slug}-${n}`;
  return id;
}
/** The server map of a Claude Desktop config, or of a pasted inner block. */
function serversOf(parsed: unknown): Record<string, unknown> | undefined {
  if (!isObject(parsed)) return undefined;
  if (isObject(parsed.mcpServers)) return parsed.mcpServers;
  return Object.values(parsed).every(isObject) ? parsed : undefined;
}

export function importServers(
  text: string,
  existing: readonly ToolServer[],
  now: number,
): ImportResult {
  if (Buffer.byteLength(text) > IMPORT_MAX_BYTES) throw new Error(IMPORT_ERROR);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(IMPORT_ERROR);
  }
  const servers = serversOf(parsed);
  if (!servers) throw new Error(IMPORT_ERROR);
  const taken = new Set(existing.map((row) => row.id));
  const result: ImportResult = {
    rows: [],
    secrets: [],
    counts: { added: 0, skippedRemote: 0, refused: 0, secretsMoved: 0 },
  };
  for (const [label, entry] of Object.entries(servers)) {
    if (!isObject(entry)) {
      result.counts.refused++;
      continue;
    }
    if (
      isString(entry.url) ||
      (isString(entry.type) &&
        /^(?:sse|http|streamable-?http)$/i.test(entry.type))
    ) {
      result.counts.skippedRemote++;
      continue;
    }
    const command = entry.command;
    const args = entry.args ?? [];
    const env = entry.env ?? {};
    const strings = [
      command,
      ...(Array.isArray(args) ? args : []),
      ...(isObject(env) ? [...Object.keys(env), ...Object.values(env)] : []),
    ];
    if (
      !isString(command) ||
      !command.trim() ||
      !Array.isArray(args) ||
      !args.every(isString) ||
      !isObject(env) ||
      !Object.values(env).every(isString) ||
      // A relative command would resolve against whatever folder the app
      // happens to run in; "${…}" would expand from the app's environment.
      (command.includes("/") && !isAbsolute(command)) ||
      strings.some((value) => isString(value) && value.includes("${")) ||
      existing.length + result.rows.length >= TOOL_LIMITS.servers
    ) {
      result.counts.refused++;
      continue;
    }
    const id = serverId(label, taken);
    const plain: Record<string, string> = {};
    const secretEnv: string[] = [];
    const secrets: ImportedSecret[] = [];
    for (const [name, value] of Object.entries(env as Record<string, string>)) {
      if (
        SECRET_NAME.test(name) ||
        scanText(value).some((finding) => finding.action === "BLOCK_UPLOAD")
      ) {
        secretEnv.push(name);
        secrets.push({ id, name, value });
      } else plain[name] = value;
    }
    const row = toolServerSchema.safeParse({
      id,
      name: label.trim().slice(0, 40) || id,
      transport: "stdio",
      command,
      args,
      env: plain,
      secretEnv,
      cwd: isString(entry.cwd) ? entry.cwd : "",
      addedAt: now,
    });
    if (!row.success) {
      result.counts.refused++;
      continue;
    }
    taken.add(id);
    result.rows.push(row.data);
    result.secrets.push(...secrets);
    result.counts.secretsMoved += secrets.length;
    result.counts.added++;
  }
  return result;
}
