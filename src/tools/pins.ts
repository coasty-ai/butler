import { createHash } from "node:crypto";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** What a ticked tool is pinned to; any later listing that differs is drift. */
export interface PinnedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}
/**
 * The pin stored beside a tick (settings.tools.servers[].tools[name].pin):
 * a changed description, schema or annotation drops the tool from the list
 * until the user reviews it (CVE-2025-54136, the rug pull).
 */
export function toolPin(tool: PinnedTool): string {
  return sha256(
    JSON.stringify([
      tool.name,
      tool.title,
      tool.description,
      tool.inputSchema,
      tool.annotations,
    ]),
  );
}
/** Content-free identity for traces: "s" or "t" and the first 12 hex characters of a sha256. */
export function traceCode(prefix: "s" | "t", text: string): string {
  return prefix + sha256(text).slice(0, 12);
}
/**
 * What approving a server pins (approvedCommand): the exact argv the pane
 * showed, the working folder, the environment names and the URL. Any change
 * needs a new approval.
 */
export function commandHash(o: {
  argv: readonly string[];
  cwd: string;
  envNames: readonly string[];
  url: string;
}): string {
  return sha256(JSON.stringify([o.argv, o.cwd, [...o.envNames].sort(), o.url]));
}
