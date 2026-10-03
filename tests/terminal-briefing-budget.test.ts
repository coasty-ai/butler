import { afterEach, expect, test } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TerminalBriefingBudget } from "../src/terminal/briefing-budget";
import { seal } from "../src/storage/vault";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "butler-briefing-budget-"));
  roots.push(root);
  const key = randomBytes(32),
    file = join(root, "budget.enc");
  return { file, key, budget: new TerminalBriefingBudget(file, key) };
};
test("a new instance reloads the encrypted daily reservation with private permissions", () => {
  const f = fixture();
  expect(f.budget.load()).toBeUndefined();
  const book = { day: "2026-10-03", tokens: 1900 };
  f.budget.save(book);
  expect(new TerminalBriefingBudget(f.file, f.key).load()).toEqual(book);
  expect(readFileSync(f.file).includes(Buffer.from(book.day))).toBe(false);
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
});
test("tampering, wrong keys and oversized records are errors rather than unused allowance", () => {
  const f = fixture();
  f.budget.save({ day: "2026-10-03", tokens: 1900 });
  expect(() =>
    new TerminalBriefingBudget(f.file, randomBytes(32)).load(),
  ).toThrow();
  const bytes = readFileSync(f.file);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(f.file, bytes);
  expect(() => f.budget.load()).toThrow();
  writeFileSync(f.file, Buffer.alloc(4097));
  expect(() => f.budget.load()).toThrow();
});
test("invalid updates preserve the previous reservation", () => {
  const f = fixture(),
    book = { day: "2026-10-03", tokens: 1900 };
  f.budget.save(book);
  expect(() => f.budget.save({ ...book, tokens: -1 })).toThrow();
  expect(() => f.budget.save({ ...book, tokens: NaN })).toThrow();
  expect(() => f.budget.save({ ...book, day: "invalid" })).toThrow();
  expect(f.budget.load()).toEqual(book);
});
test("authenticated but malformed records cannot turn into a new allowance", () => {
  const f = fixture();
  for (const book of [
    { day: "2026-10-03", tokens: -1 },
    { day: "2026-10-03", tokens: 1.5 },
    { day: "2026-99-99", tokens: 1900 },
    { day: "2026-10-03", tokens: 1900, extra: true },
  ]) {
    writeFileSync(
      f.file,
      seal(
        f.key,
        Buffer.from(JSON.stringify(book)),
        "terminal-briefing-budget",
      ),
    );
    expect(() => f.budget.load()).toThrow();
  }
});
