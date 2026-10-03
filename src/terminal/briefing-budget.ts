import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { BriefingBudget, BriefingBudgetStore } from "../briefings/types";
import { seal, unseal } from "../storage/vault";

const AAD = "terminal-briefing-budget";
const valid = (value: unknown): value is BriefingBudget => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const budget = value as Record<string, unknown>;
  return (
    Object.keys(budget).length === 2 &&
    typeof budget.day === "string" &&
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(budget.day) &&
    typeof budget.tokens === "number" &&
    Number.isSafeInteger(budget.tokens) &&
    budget.tokens >= 0
  );
};

/** Durable reservations for one profile; unreadable usage never means zero usage. */
export class TerminalBriefingBudget implements BriefingBudgetStore {
  constructor(
    private file: string,
    private key: Buffer,
  ) {}
  load(): BriefingBudget | undefined {
    if (!existsSync(this.file)) return;
    if (statSync(this.file).size > 4096)
      throw new Error("Briefing allowance is unreadable.");
    const budget: unknown = JSON.parse(
      unseal(this.key, readFileSync(this.file), AAD).toString(),
    );
    if (!valid(budget)) throw new Error("Briefing allowance is unreadable.");
    return budget;
  }
  save(budget: BriefingBudget) {
    if (!valid(budget)) throw new Error("Briefing allowance is invalid.");
    writeFileSync(
      this.file + ".tmp",
      seal(this.key, Buffer.from(JSON.stringify(budget)), AAD),
      { mode: 0o600 },
    );
    renameSync(this.file + ".tmp", this.file);
  }
}
