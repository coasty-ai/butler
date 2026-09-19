import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, posix } from "node:path";

/**
 * Import-direction guard for the layering in docs/MODULARITY.md §4. It is the
 * cheapest substitute for a package split: it reads every module specifier
 * under src/ and fails the moment an arrow points the wrong way.
 *
 * `src/core` is the bottom layer — the run loop, the policy engine, the action
 * schema, the label rules and the memory contract — and depends on zod and
 * nothing else, which is what makes it publishable and embeddable. The cycle
 * core → memory → core existed until PR-1 moved labels.ts and the contract
 * types into core; this test is what keeps it gone.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

/** Every .ts/.tsx file under dir, as repo-relative posix paths. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir)).sort()) {
    const path = posix.join(dir, entry);
    if (statSync(join(root, path)).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/**
 * Module specifiers of one file: `import … from "x"`, `export … from "x"`,
 * `import "x"` and `import("x")`. Whole-line comments are dropped first, so a
 * commented-out import is not an import; anything else that reads like a
 * specifier is reported rather than ignored, because a false alarm is cheap and
 * a missed dependency is not.
 */
function specifiersOf(text: string): string[] {
  const source = text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const found: string[] = [];
  for (const re of [
    // `from` needs whitespace before the quote: the string literal "from" in
    // a list such as ["from", "to"] (a date-key table) is not an import.
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ])
    for (const m of source.matchAll(re)) found.push(m[1]);
  return found;
}
function specifiers(file: string): string[] {
  return specifiersOf(readFileSync(join(root, file), "utf8"));
}

/** Where a relative specifier lands, as a repo-relative path; bare ones stay. */
function target(file: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  return posix.normalize(posix.join(posix.dirname(file), specifier));
}

const srcFiles = walk("src");
const electronFiles = walk("electron");
const coreFiles = srcFiles.filter((f) => f.startsWith("src/core/"));
const providerFiles = srcFiles.filter((f) => f.startsWith("src/providers/"));
const voiceFiles = srcFiles.filter((f) => f.startsWith("src/voice/"));
const assistantFiles = srcFiles.filter((f) => f.startsWith("src/assistant/"));
const toolFiles = srcFiles.filter((f) => f.startsWith("src/tools/"));

/** Collect every violation so one run names them all. */
function offenders(
  files: string[],
  bad: (specifier: string, resolved: string) => string | undefined,
): string[] {
  const list: string[] = [];
  for (const file of files)
    for (const specifier of specifiers(file)) {
      const reason = bad(specifier, target(file, specifier));
      if (reason) list.push(`${file} imports "${specifier}" — ${reason}`);
    }
  return list;
}

describe("module boundaries", () => {
  it("scans the directories it is guarding", () => {
    // A rename must fail this test, not quietly empty it.
    expect(coreFiles.length).toBeGreaterThan(5);
    expect(providerFiles.length).toBeGreaterThan(2);
    expect(voiceFiles.length).toBeGreaterThan(2);
    expect(assistantFiles.length).toBeGreaterThan(2);
    expect(toolFiles.length).toBeGreaterThan(3);
    expect(srcFiles.length).toBeGreaterThan(20);
    expect(electronFiles.length).toBeGreaterThan(5);
  });

  it("reads every import form and no string literal that happens to say from", () => {
    expect(
      specifiersOf(
        [
          'import { a } from "./a";',
          "import type { B } from '../b';",
          'export * from "./c";',
          'import "./d";',
          'const e = await import("./e");',
          '// import { f } from "./f";',
          'const dateKeys = ["from", "to"];',
          'const range = { from: "2026-09-18", to: "2026-09-19" };',
          'read("Calendar", "calendar_list_events", ["from", "to"]);',
        ].join("\n"),
      ).sort(),
    ).toEqual(["../b", "./a", "./c", "./d", "./e"]);
    // The table that tripped the scanner once: src/tools/providers/apple.ts
    // names its date keys ["from", "to"] and imports only the contract.
    expect(specifiers("src/tools/providers/apple.ts")).toEqual([
      "../../core/tools",
    ]);
  });

  it("keeps src/core free of the layers above it", () => {
    expect(
      offenders(coreFiles, (specifier, resolved) => {
        if (specifier === "electron" || specifier.startsWith("electron/"))
          return "src/core must not depend on Electron";
        if (specifier.startsWith("node:"))
          return "src/core must run anywhere and imports no Node builtin";
        if (!specifier.startsWith(".")) return undefined; // zod and friends
        if (!resolved.startsWith("src/core/"))
          return `src/core must not import ${resolved}; move the shared piece into src/core instead`;
        return undefined;
      }),
    ).toEqual([]);
  });

  it("keeps src/providers free of src/memory", () => {
    expect(
      offenders(providerFiles, (_specifier, resolved) =>
        resolved.startsWith("src/memory/")
          ? "src/providers must not depend on src/memory (playbooks live in src/providers)"
          : undefined,
      ),
    ).toEqual([]);
  });

  /**
   * src/assistant is the conversational layer above voice and providers:
   * pure like core, so the same view of a run answers voice, texts and the
   * phone remote, and so nothing below it (voice) can reach back up into it.
   */
  it("keeps src/assistant pure and above src/voice", () => {
    expect(
      offenders(assistantFiles, (specifier, resolved) => {
        if (specifier.startsWith("node:"))
          return "src/assistant runs anywhere and imports no Node builtin";
        if (!specifier.startsWith(".")) return undefined;
        if (!/^src\/(?:assistant|core|voice|providers)\//.test(resolved))
          return `src/assistant may import only src/core, src/voice and src/providers, not ${resolved}`;
        return undefined;
      }),
    ).toEqual([]);
    expect(
      offenders(voiceFiles, (specifier, resolved) => {
        if (specifier.startsWith("node:"))
          return "src/voice imports no Node builtin";
        if (!specifier.startsWith(".")) return undefined;
        if (!/^src\/(?:voice|core)\//.test(resolved))
          return `src/voice may import only src/core, not ${resolved}`;
        return undefined;
      }),
    ).toEqual([]);
  });

  /**
   * src/tools is the tool layer under Electron main: the MCP client, the
   * registry and the first-party tables. It knows the core contract, Node and
   * the SDK, and nothing about the UI, the gym, the assistant or voice.
   */
  it("keeps src/tools to the core contract, Node and the MCP SDK", () => {
    expect(
      offenders(toolFiles, (specifier, resolved) => {
        if (specifier === "electron" || specifier.startsWith("electron/"))
          return "src/tools must not depend on Electron";
        if (specifier.startsWith("node:")) return undefined;
        if (!specifier.startsWith("."))
          return specifier.startsWith("@modelcontextprotocol/")
            ? undefined
            : `src/tools may import only @modelcontextprotocol/* packages, not ${specifier}`;
        if (!/^src\/(?:tools|core)\//.test(resolved))
          return `src/tools may import only src/core and src/tools, not ${resolved}`;
        return undefined;
      }),
    ).toEqual([]);
  });

  /**
   * src/gym/jev.ts measures a third-party model (TypeSafe's Jev, through
   * OpenRouter) for scripts/eval-jev.mjs only. The app must never reach it,
   * directly or through another module: it would send screen text to two
   * new third parties. Only src/gym may import it, and nothing the app
   * imports from src/gym may lead to it.
   */
  it("keeps the Jev eval out of the app", () => {
    const JEV = "src/gym/jev.ts";
    const resolveFile = (resolved: string): string | undefined =>
      [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}/index.ts`]
        .map((path) => path.replace(/\.js$/, ".ts"))
        .find((path) => existsSync(join(root, path)) && /\.tsx?$/.test(path));
    expect(
      offenders(
        [
          ...electronFiles,
          ...srcFiles.filter((f) => !f.startsWith("src/gym/")),
        ],
        (specifier, resolved) =>
          specifier.startsWith(".") && resolveFile(resolved) === JEV
            ? "the app must never import the Jev eval (src/gym/jev.ts)"
            : undefined,
      ),
    ).toEqual([]);
    // Transitively: everything the app's own modules reach.
    const reached = new Map<string, string>();
    const queue = [
      ...electronFiles,
      ...srcFiles.filter((f) => !f.startsWith("src/gym/")),
    ];
    for (const file of queue) reached.set(file, file);
    while (queue.length) {
      const file = queue.shift()!;
      for (const specifier of specifiers(file)) {
        if (!specifier.startsWith(".")) continue;
        const next = resolveFile(target(file, specifier));
        if (!next || reached.has(next)) continue;
        reached.set(next, file);
        queue.push(next);
      }
    }
    expect(reached.has(JEV) ? `${reached.get(JEV)} leads to ${JEV}` : "").toBe(
      "",
    );
  });

  it("keeps Electron out of src/ entirely", () => {
    expect(
      offenders(srcFiles, (specifier) =>
        specifier === "electron" || specifier.startsWith("electron/")
          ? "nothing under src/ may import Electron; keep it runtime-neutral"
          : undefined,
      ),
    ).toEqual([]);
  });
});
