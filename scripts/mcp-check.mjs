// Headless check of the tool layer's connection path, as the app makes it:
// the registry (src/tools/registry.ts) with the helper binaries in native/bin,
// the coarena-launch shim, the vault empty. Prints codes, counts and tool
// names only — never a description, a file name or a result's text.
//
//   node --import tsx scripts/mcp-check.mjs [--folder <dir>] [--keep-home]
//
// What it does, in order:
//   1. Apple bridge: `coarena-apple status` through registry.appleAccess()
//      (never prompts), then the builtin provider's state after configure().
//   2. A user row from the Filesystem recipe (npx server-filesystem over stdio,
//      network "none", through the shim): registry.test() = connect once,
//      list, disconnect — the consent sheet's preview.
//   3. configure() with that row enabled and consented, the first ticks saved
//      as the pane saves them, then access().list/prepare/call of the read
//      tool list_directory on the folder, and the outcome code.
// Exit 0 when every step answered; 1 when a step failed (its code printed).
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createToolRegistry } from "../src/tools/registry.ts";
import { RECIPES, FOLDER } from "../src/tools/providers/recipes.ts";
import { defaultSettings, settingsSchema } from "../src/core/schema.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const folder = resolve(flag("folder", join(homedir(), "OpenAssistBench")));
if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
const keepHome = args.includes("--keep-home");
// The registry's home is the user's home, as the app passes app.getPath("home"):
// commands are resolved under it (~/.nvm, ~/.volta, ~/.local/bin).
const home = homedir();
const scratch = mkdtempSync(join(tmpdir(), "mcp-check-"));
const root = resolve(new URL("..", import.meta.url).pathname);
const helper = (name) => join(root, "native/bin", name);
const shim = helper("coarena-launch");

const recipe = RECIPES.find((r) => r.id === "filesystem");
if (!recipe) throw new Error("no filesystem recipe");
let row = {
  id: "filesystem",
  name: "Filesystem",
  transport: "stdio",
  command: recipe.command,
  args: recipe.args.map((a) => (a === FOLDER ? folder : a)),
  env: {},
  secretEnv: [],
  cwd: "",
  url: "",
  secretHeaders: [],
  enabled: true,
  consented: false,
  trust: "ask",
  network: recipe.network,
  approvedCommand: "",
  recipe: recipe.id,
  tools: {},
  addedAt: Date.now(),
};
let settings = settingsSchema.parse({
  ...defaultSettings,
  tools: { ...defaultSettings.tools, enabled: true, servers: [row] },
});
const events = [];
const registry = createToolRegistry({
  settings: () => settings,
  credentials: () => ({ env: {}, headers: {} }),
  helper,
  launch: () => (existsSync(shim) ? shim : undefined),
  home,
  version: "mcp-check",
  trace: (event, data) => events.push({ event, ...pick(data) }),
  onTicks: (id, tools) => {
    // As the pane saves a server's first ticks: pinned defaults.
    row = { ...row, tools };
    settings = { ...settings, tools: { ...settings.tools, servers: [row] } };
    console.log(
      `ticks saved for ${id}: ${Object.entries(tools)
        .filter(([, t]) => t.on)
        .map(([name]) => name)
        .join(", ")}`,
    );
  },
});
function pick(data) {
  const out = {};
  for (const [k, v] of Object.entries(data ?? {}))
    if (
      typeof v === "number" ||
      typeof v === "boolean" ||
      (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(v))
    )
      out[k] = v;
  return out;
}
let failed = false;
const step = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};
try {
  console.log(
    `helpers: ${["coarena-apple", "coarena-launch"].map((n) => `${n}=${existsSync(helper(n)) ? "present" : "MISSING"}`).join(", ")}`,
  );
  // 1. Apple bridge status (never prompts).
  const access = await registry.appleAccess();
  // Mail's Automation state cannot be read without prompting, so "unknown" there is the bridge's honest answer.
  step(
    "apple bridge status",
    ["calendar", "reminders", "notes"].every((k) => access[k] !== "unknown"),
    JSON.stringify(access),
  );

  // 2. Consent preview: connect once, list, disconnect (through the shim and npx).
  row = { ...row, consented: true, approvedCommand: registry.approval(row) };
  settings = { ...settings, tools: { ...settings.tools, servers: [row] } };
  console.log(
    `argv: ${registry
      .argv(row)
      .map((a) => (a.startsWith("/") ? a.split("/").pop() : a))
      .join(" ")}`,
  );
  const t0 = performance.now();
  const preview = await registry.test("filesystem");
  step(
    "filesystem test (connect, list, disconnect)",
    preview.ok,
    `${preview.toolCount} tools in ${Math.round(performance.now() - t0)} ms${preview.code ? `, code ${preview.code}` : ""}: ${preview.tools.map((t) => `${t.name}[${t.tier}${t.denied ? ",denied" : ""}]`).join(" ")}`,
  );

  // 3. The live path: configure, list for a request, prepare, call.
  await registry.configure();
  await new Promise((r) => setTimeout(r, 1500));
  const status = registry.status();
  for (const s of status.servers)
    console.log(
      `server ${s.id}: state ${s.state}${s.code ? ` (${s.code})` : ""}, ${s.tools.length} tools listed`,
    );
  const door = registry.access({ synthetic: false });
  step("access door open", !!door);
  if (door) {
    const ac = new AbortController();
    const listed = await door.list(
      "list the files in my bench folder",
      ac.signal,
    );
    const spec = listed.tools.find((t) => t.id.endsWith("list_directory"));
    step(
      "list_directory offered",
      !!spec,
      `${listed.tools.length} tools offered${spec ? `; tier ${spec.tier}, trusted ${spec.trusted}` : ""}`,
    );
    if (spec) {
      const prepared = door.prepare(spec, { path: folder });
      step(
        "prepare list_directory",
        prepared.ok,
        prepared.ok ? "" : `code ${prepared.code}`,
      );
      if (prepared.ok) {
        const t1 = performance.now();
        const outcome = await door.call(spec, { path: folder }, ac.signal);
        const text = outcome.text ?? outcome.result?.text ?? "";
        step(
          "call list_directory",
          outcome.code === "ok",
          `code ${outcome.code}, ${Math.round(performance.now() - t1)} ms, ${String(text).split("\n").filter(Boolean).length} lines returned`,
        );
      }
    }
  }
} catch (error) {
  step(
    "unexpected",
    false,
    `${error?.code ?? error?.name ?? "error"}: ${String(error?.message ?? "").slice(0, 200)}`,
  );
} finally {
  await registry.closeAll().catch(() => {});
  const codes = {};
  for (const e of events) {
    const k = `${e.event}${e.code ? ":" + e.code : ""}`;
    codes[k] = (codes[k] ?? 0) + 1;
  }
  console.log(`trace: ${JSON.stringify(codes)}`);
  if (!keepHome) rmSync(scratch, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
