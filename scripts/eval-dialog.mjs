/**
 * Opt-in evaluation of the dialog prompt against a real model. Fake-fetch unit
 * tests cannot tell whether a model follows the ACT/TASK/SAY format or
 * rewrites tasks well, so this script sends the cases in
 * tests/fixtures/dialog-eval.jsonl (injection cases included) to the
 * configured provider and reports act accuracy, format failures, grounding
 * rejections, unsafe sentences and p50/p95 time to first token. Prompt
 * changes are gated on it. It never runs under npm test.
 *
 *   OPEN_ASSIST_DIALOG_EVAL=1 node --import tsx scripts/eval-dialog.mjs \
 *     --provider openai --model gpt-5.4-mini --key-env OPENAI_API_KEY \
 *     [--max-cost 0.50] [--limit 120] [--endpoint URL] [--only injection] \
 *     [--out output/dialog-eval/<model>-v<prompt>.json]
 *
 * The key is read from the named environment variable at run time and never
 * printed; the report carries counts, codes and timings, never the model's
 * words unless --verbose is given (and then on the console only). --out writes
 * the same JSON report to a file, creating its folder, so the numbers a prompt
 * version was gated on can be kept and compared with the next run's.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import {
  DIALOG_PROMPT_VERSION,
  DIALOG_SYSTEM,
} from "../src/assistant/prompt.ts";
import { DialogParser } from "../src/assistant/protocol.ts";
import { arbitrate } from "../src/assistant/arbitrate.ts";
import { buildDialogState, dialogStateJson } from "../src/assistant/state.ts";
import { speakableSentence } from "../src/voice/speakable.ts";
import { planVoiceTurn } from "../src/voice/turns.ts";
import { streamText, textSettings } from "../src/providers/text.ts";
import { defaultSettings } from "../src/core/schema.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
if (process.env.OPEN_ASSIST_DIALOG_EVAL !== "1") {
  console.error(
    "This evaluation spends money on model calls. Set OPEN_ASSIST_DIALOG_EVAL=1 to run it.",
  );
  process.exit(2);
}
const provider = flag("provider", "openai");
const model = flag("model", "gpt-5.4-mini");
const keyEnv = flag("key-env", "OPENAI_API_KEY");
const maxCost = Number(flag("max-cost", "0.5"));
const limit = Number(flag("limit", "1000"));
const only = flag("only", "");
const out = flag("out", "");
const verbose = args.includes("--verbose");
const endpoints = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  ollama: "http://127.0.0.1:11434",
};
const endpoint = flag("endpoint", endpoints[provider] ?? "");
const key = provider === "ollama" ? "" : (process.env[keyEnv] ?? "");
if (provider !== "ollama" && !key) {
  console.error(`No key in $${keyEnv}.`);
  process.exit(2);
}
const settings = textSettings({
  ...defaultSettings,
  privacy: provider === "ollama" ? "PRIVATE_LOCAL" : "PRIVATE_BYOM",
  provider,
  model,
  endpoint,
  // Rough list prices so the cost cap means something; adjust as needed.
  inputPrice: Number(flag("input-price", provider === "ollama" ? "0" : "0.75")),
  outputPrice: Number(
    flag("output-price", provider === "ollama" ? "0" : "4.5"),
  ),
});

const here = dirname(fileURLToPath(import.meta.url));
const cases = readFileSync(
  join(here, "../tests/fixtures/dialog-eval.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("#"))
  .map((line) => JSON.parse(line))
  .filter((c) => !only || (c.tags ?? []).includes(only))
  .slice(0, limit);

const idle = {
  running: false,
  status: "idle",
  recent: [],
  queued: [],
  watches: [],
};
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

const totals = {
  cases: 0,
  actRight: 0,
  actWrong: 0,
  format: 0,
  grounded: 0,
  rejected: 0,
  offers: 0,
  unsafeSentences: 0,
  errors: 0,
  cost: 0,
};
const ttfts = [];
const wrong = [];

for (const c of cases) {
  if (totals.cost >= maxCost) {
    console.error(
      `Cost cap of $${maxCost} reached after ${totals.cases} cases.`,
    );
    break;
  }
  totals.cases++;
  const view = c.view ? { ...idle, ...c.view } : idle;
  const turns = (c.turns ?? []).map((t, i) => ({
    role: t.role,
    channel: "voice",
    text: t.text,
    at: i,
    untrusted: t.untrusted === true,
  }));
  const state = buildDialogState({
    channel: c.channel ?? "voice",
    user: c.user,
    view,
    turns,
    addressAs: c.addressAs,
    agenda: c.agenda,
    notifications: c.notifications,
    openApps: c.openApps,
    heldByVoice: c.heldByVoice === true,
    now: new Date("2026-09-17T14:05:00"),
  });
  const parser = new DialogParser();
  const events = [];
  const started = performance.now();
  let ttft;
  let outcome;
  try {
    const stream = streamText(
      settings,
      key,
      {
        system: DIALOG_SYSTEM,
        input: dialogStateJson(state, 6000),
        maxOutputTokens: 300,
        effort: /^gpt-5\.[1-9]/.test(model) ? "none" : undefined,
      },
      globalThis.fetch,
      new AbortController().signal,
      { deadlineMs: 20000 },
    );
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        outcome = next.value;
        break;
      }
      ttft ??= performance.now() - started;
      events.push(...parser.push(next.value));
    }
    events.push(...parser.end());
  } catch (error) {
    totals.errors++;
    console.error(`${c.id}: ${error?.code ?? "error"}`);
    continue;
  }
  totals.cost += outcome?.usage?.cost ?? 0;
  if (ttft !== undefined) ttfts.push(ttft);
  const head = events.find((e) => e.type === "head")?.head;
  const invalid = events.find((e) => e.type === "invalid")?.code;
  if (!head) {
    totals.format++;
    wrong.push({ id: c.id, expected: c.expect.act, got: `invalid:${invalid}` });
    continue;
  }
  const expected = Array.isArray(c.expect.act) ? c.expect.act : [c.expect.act];
  if (expected.includes(head.act)) totals.actRight++;
  else {
    totals.actWrong++;
    wrong.push({ id: c.id, expected, got: head.act });
  }
  // The router's own plan for the words, then arbitration as main.ts does it.
  const base = planVoiceTurn({
    text: c.user,
    confidence: 0.9,
    source: "wake",
    gateMatches: false,
    now: 1,
    run: c.run,
  });
  const a = arbitrate({
    base,
    head,
    utterance: c.user,
    run: c.run,
    context: turns.filter((t) => !t.untrusted).map((t) => t.text),
    userWords: turns.filter((t) => t.role === "user").map((t) => t.text),
    channel: c.channel ?? "voice",
    heldByVoice: c.heldByVoice === true,
  });
  if (a.proposal !== undefined || a.refused) {
    // A refused rewrite (a paste the user never asked for) counts with the
    // offers: it did not run, and the case's expectation says whether that
    // was right.
    totals.offers++;
    if (c.expect.grounded === true)
      wrong.push({
        id: c.id,
        expected: "grounded task",
        got: `${a.refused ? "refused" : "offer"} (${a.code})`,
      });
  } else if (["start", "revise", "replace", "queue"].includes(a.plan.kind)) {
    totals.grounded++;
    if (c.expect.grounded === false || c.expect.mustNotRun)
      wrong.push({
        id: c.id,
        expected: "no run",
        got: `${a.plan.kind} (${a.code})`,
      });
  }
  if (["approve", "decline", "stop"].includes(a.plan.kind))
    wrong.push({
      id: c.id,
      expected: "never approve/decline/stop",
      got: a.plan.kind,
    });
  for (const e of events)
    if (e.type === "sentence" && speakableSentence(e.text) === undefined) {
      totals.unsafeSentences++;
      if (verbose) console.log(`${c.id}: dropped sentence: ${e.text}`);
    }
  if (verbose)
    console.log(
      `${c.id}: ${head.act}${head.task ? ` | ${head.task}` : ""} | ${events
        .filter((e) => e.type === "sentence")
        .map((e) => e.text)
        .join(" ")}`,
    );
}

const report = JSON.stringify(
  {
    promptVersion: DIALOG_PROMPT_VERSION,
    provider,
    model,
    cases: totals.cases,
    actAccuracy: totals.cases ? totals.actRight / totals.cases : 0,
    actWrong: totals.actWrong,
    formatFailures: totals.format,
    groundedTasks: totals.grounded,
    offers: totals.offers,
    unsafeSentencesDropped: totals.unsafeSentences,
    errors: totals.errors,
    ttftMsP50: Math.round(percentile(ttfts, 0.5)),
    ttftMsP95: Math.round(percentile(ttfts, 0.95)),
    estimatedCost: Number(totals.cost.toFixed(4)),
    wrong,
  },
  null,
  2,
);
console.log(report);
if (out) {
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, report + "\n");
  console.error(`Report written to ${path}`);
}
process.exit(wrong.length ? 1 : 0);
