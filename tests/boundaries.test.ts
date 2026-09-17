import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
function specifiers(file: string): string[] {
  const source = readFileSync(join(root, file), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const found: string[] = [];
  for (const re of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ])
    for (const m of source.matchAll(re)) found.push(m[1]);
  return found;
}

/** Where a relative specifier lands, as a repo-relative path; bare ones stay. */
function target(file: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  return posix.normalize(posix.join(posix.dirname(file), specifier));
}

const srcFiles = walk("src");
const coreFiles = srcFiles.filter((f) => f.startsWith("src/core/"));
const providerFiles = srcFiles.filter((f) => f.startsWith("src/providers/"));

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
    expect(srcFiles.length).toBeGreaterThan(20);
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
