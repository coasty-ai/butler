/**
 * Opt-in evaluation of the observer's consolidator against a real model
 * (.data/design/observer.md §7, lane O3). Fake-model unit tests cannot tell
 * whether a model recovers a routine from five days of frames, so this
 * script runs lane O2's consolidateDay over the synthetic work log in
 * tests/fixtures/observer-worklog.json, one day at a time with the previous
 * days' output as the prior, and scores the final output against what the
 * fixture planted: recall and precision on the routines (by app sequence and
 * hour window), step recall on each procedure (by step kind and target
 * label), whether the flipped preference is reported with its later value,
 * and how many routines were invented. It prints the token count and cost.
 * It never runs under npm test.
 *
 *   OPEN_ASSIST_OBSERVER_EVAL=1 node --import tsx scripts/observer-eval.mjs \
 *     --provider openai --model gpt-5.4-mini --key-env OPENAI_API_KEY \
 *     [--max-cost 1.00] [--days 5] [--endpoint URL] \
 *     [--fixture tests/fixtures/observer-worklog.json] \
 *     [--out output/eval/observer-<model>.json] [--verbose]
 *
 * The key is read from the named environment variable at run time and never
 * printed. The report carries counts, ids, codes, timings and cost; with
 * --verbose it adds what the model found (names, app sequences, step types
 * and labels, preference texts), which for this fixture are invented values,
 * on the console only. --out writes the same JSON report to a file, creating
 * its folder. Targets (§7): routine recall >= 0.8, at most one invented
 * routine per five days, at most 200k input tokens per day. Exit 1 when a
 * target is missed or a day failed; 2 before any call when it cannot run.
 *
 * Until lane O2 lands, src/observer/consolidate.ts is a stub that throws
 * "not landed": the script then reports every day as failed, no call is
 * made and nothing is spent.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { consolidateDay } from "../src/observer/consolidate.ts";
import {
  consolidationOutputSchema,
  scoreOutput,
  timelineOf,
  tokenTarget,
  worklogSchema,
} from "../src/gym/observer-eval.ts";
import { streamText, textSettings } from "../src/providers/text.ts";
import { defaultSettings } from "../src/core/schema.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
if (process.env.OPEN_ASSIST_OBSERVER_EVAL !== "1") {
  console.error(
    "This evaluation spends money on model calls. Set OPEN_ASSIST_OBSERVER_EVAL=1 to run it.",
  );
  process.exit(2);
}
const provider = flag("provider", "openai");
const model = flag("model", "gpt-5.4-mini");
const keyEnv = flag("key-env", "OPENAI_API_KEY");
const maxCost = Number(flag("max-cost", "1"));
const dayLimit = Number(flag("days", "0"));
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
const root = resolve(here, "..");
const fixturePath = resolve(
  flag("fixture", join(root, "tests/fixtures/observer-worklog.json")),
);
let worklog;
try {
  worklog = worklogSchema.parse(JSON.parse(readFileSync(fixturePath, "utf8")));
} catch (error) {
  const issue = error?.issues?.[0];
  console.error(
    `Bad fixture ${fixturePath}: ${issue ? `${issue.path.join(".")}: ${issue.code}` : "not JSON"}`,
  );
  process.exit(2);
}
const days = dayLimit > 0 ? worklog.days.slice(0, dayLimit) : worklog.days;

const totals = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
let dayTotals;
/** The model as consolidateDay takes it: one text call, its usage charged. */
const modelCall = async (call, signal) => {
  if (totals.cost >= maxCost) {
    const error = new Error(`Cost cap of $${maxCost} reached.`);
    error.code = "cost_cap";
    throw error;
  }
  const controller = new AbortController();
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const stream = streamText(
    settings,
    key,
    {
      system: call.system,
      input: call.input,
      maxOutputTokens: call.maxOutputTokens ?? 6000,
      effort: /^gpt-5\.[1-9]/.test(model) ? "none" : undefined,
    },
    globalThis.fetch,
    controller.signal,
    { deadlineMs: 180_000, retry: true },
  );
  let text = "";
  let outcome;
  for (;;) {
    const next = await stream.next();
    if (next.done) {
      outcome = next.value;
      break;
    }
    text += next.value;
  }
  totals.calls++;
  totals.inputTokens += outcome.usage.inputTokens;
  totals.outputTokens += outcome.usage.outputTokens;
  totals.cost += outcome.usage.cost;
  if (dayTotals) {
    dayTotals.calls++;
    dayTotals.inputTokens += outcome.usage.inputTokens;
    dayTotals.outputTokens += outcome.usage.outputTokens;
    dayTotals.cost += outcome.usage.cost;
  }
  if (verbose)
    console.error(
      `call ${totals.calls}: ${outcome.code}, ${outcome.usage.inputTokens} in, ${outcome.usage.outputTokens} out`,
    );
  return { text, usage: outcome.usage, code: outcome.code };
};

let prior;
const perDay = [];
for (const day of days) {
  if (totals.cost >= maxCost) {
    console.error(`Cost cap of $${maxCost} reached before ${day.day}.`);
    perDay.push({ day: day.day, code: "cost_cap", calls: 0, inputTokens: 0 });
    break;
  }
  dayTotals = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  const started = performance.now();
  let code = "ok";
  let issues;
  try {
    const raw = await consolidateDay(
      timelineOf(worklog, day.day),
      modelCall,
      prior,
    );
    // The landed consolidator answers with its own code instead of throwing:
    // "model" (the call failed), "privacy", "budget", "empty", "parse".
    const own = raw && typeof raw === "object" ? raw.code : undefined;
    if (typeof own === "string" && own !== "ok") {
      code = own;
      console.error(`${day.day}: ${code}`);
    } else {
      const parsed = consolidationOutputSchema.safeParse(raw);
      if (parsed.success) prior = parsed.data;
      else {
        code = "invalid_output";
        issues = parsed.error.issues.length;
      }
    }
  } catch (error) {
    code = typeof error?.code === "string" ? error.code : "consolidate_error";
    console.error(
      `${day.day}: ${code}: ${String(error?.message ?? "").slice(0, 160)}`,
    );
  }
  perDay.push({
    day: day.day,
    code,
    issues,
    ...dayTotals,
    cost: Number(dayTotals.cost.toFixed(4)),
    ms: Math.round(performance.now() - started),
  });
  dayTotals = undefined;
}

const output = prior ?? { routines: [], procedures: [], preferences: [] };
const score = scoreOutput(worklog.planted, output, days.length);
const tokens = tokenTarget(
  perDay.filter((d) => d.code === "ok").map((d) => d.inputTokens),
);
const failed = perDay.filter((d) => d.code !== "ok");
const missed = [
  !score.targets.routineRecall.met && "routineRecall",
  !score.targets.inventedRoutines.met && "inventedRoutines",
  !tokens.met && "inputTokensPerDay",
].filter(Boolean);
const report = JSON.stringify(
  {
    provider,
    model,
    fixture: relative(root, fixturePath),
    days: days.length,
    consolidatedDays: perDay.filter((d) => d.code === "ok").length,
    routines: score.routines,
    procedures: score.procedures,
    unmatchedProcedures: score.unmatchedProcedures,
    preferences: score.preferences,
    targets: {
      routineRecall: score.targets.routineRecall,
      inventedRoutines: score.targets.inventedRoutines,
      inputTokensPerDay: tokens,
    },
    missedTargets: missed,
    tokens: {
      calls: totals.calls,
      input: totals.inputTokens,
      output: totals.outputTokens,
    },
    estimatedCost: Number(totals.cost.toFixed(4)),
    perDay,
    failedDays: failed.map((d) => ({ day: d.day, code: d.code })),
    found: verbose
      ? {
          routines: output.routines.map((r) => ({
            name: r.name,
            apps: r.steps.map((s) => s.appId),
            weekdays: r.when.weekdays,
            hourRange: r.when.hourRange,
          })),
          procedures: output.procedures.map((p) => ({
            trigger: p.trigger,
            slots: p.slots,
            steps: p.steps.map(
              (s) =>
                `${String(s.action.type ?? s.action.kind ?? "?")}${
                  s.target?.label ? ` ${s.target.label}` : ""
                }`,
            ),
          })),
          preferences: output.preferences.map((p) => p.text),
        }
      : undefined,
  },
  null,
  2,
);
// Wait for the pipe to take the whole report before exiting: on macOS a pipe's
// stdout is asynchronous, and process.exit right after console.log can cut a
// report over 8 KiB at its first chunk.
await new Promise((done) => process.stdout.write(report + "\n", done));
if (out) {
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, report + "\n");
  console.error(`Report written to ${path}`);
}
process.exit(missed.length || failed.length ? 1 : 0);
