import { afterEach, expect, test } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { McpCatalogues } from "../src/terminal/catalogues";
import type { Tool } from "@modelcontextprotocol/client";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "butler-catalogue-"));
  roots.push(root);
  const key = randomBytes(32);
  let now = 100000;
  return {
    root,
    key,
    cache: new McpCatalogues(root, key, () => now),
    advance: (ms: number) => (now += ms),
  };
};
const tool: Tool = {
  name: "read_note",
  description: "Synthetic private catalogue description",
  inputSchema: { type: "object", properties: { name: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
test("catalogues persist encrypted with private permissions and require the same approved connection", () => {
  const f = fixture();
  f.cache.save("fixture", "approved-command-and-credential-signature", [tool]);
  expect(
    new McpCatalogues(f.root, f.key, () => 100000).read(
      "fixture",
      "approved-command-and-credential-signature",
    ),
  ).toEqual([tool]);
  const file = join(f.root, "fixture.enc");
  expect(readFileSync(file).includes(Buffer.from(tool.description!))).toBe(
    false,
  );
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(
    f.cache.read("fixture", "changed-command-or-credentials"),
  ).toBeUndefined();
  expect(
    new McpCatalogues(f.root, randomBytes(32), () => 100000).read(
      "fixture",
      "approved-command-and-credential-signature",
    ),
  ).toBeUndefined();
});
test("expired and future-dated discovery falls back to a fresh connection", () => {
  const f = fixture();
  f.cache.save("fixture", "signature", [tool]);
  f.advance(24 * 60 * 60 * 1000 - 1);
  expect(f.cache.read("fixture", "signature")).toEqual([tool]);
  f.advance(1);
  expect(f.cache.read("fixture", "signature")).toBeUndefined();
  expect(
    new McpCatalogues(f.root, f.key, () => 99999).read("fixture", "signature"),
  ).toBeUndefined();
});
test("tampering and oversized stored data are cache misses", () => {
  const f = fixture();
  f.cache.save("fixture", "signature", [tool]);
  const file = join(f.root, "fixture.enc"),
    data = readFileSync(file);
  data[data.length - 1] ^= 1;
  writeFileSync(file, data);
  expect(f.cache.read("fixture", "signature")).toBeUndefined();
  writeFileSync(file, Buffer.alloc(128 * 1024 + 29));
  expect(f.cache.read("fixture", "signature")).toBeUndefined();
});
test("invalid names, duplicate tools, empty lists and oversized discovery are not stored", () => {
  const f = fixture();
  f.cache.save("../outside", "signature", [tool]);
  f.cache.save("empty", "signature", []);
  f.cache.save("duplicate", "signature", [tool, tool]);
  f.cache.save("large", "signature", [
    { ...tool, description: "x".repeat(128 * 1024) },
  ]);
  f.cache.save(
    "many",
    "signature",
    Array.from({ length: 65 }, (_, i) => ({ ...tool, name: "tool_" + i })),
  );
  f.cache.save("invalid", "signature", [{ ...tool, name: "bad name" }]);
  expect(readdirSync(f.root)).toEqual([]);
  expect(f.cache.read("../outside", "signature")).toBeUndefined();
});
