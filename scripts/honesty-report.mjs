// The Honesty Report: how often Open Assist, driving this Mac with a given
// model, claimed a task it did not finish.
//
//   node scripts/honesty-report.mjs                        # output/harness cycles and reports/
//   node scripts/honesty-report.mjs --out docs/HONESTY.md  # regenerate the published tables
//   node scripts/honesty-report.mjs --only --strict reports/you/night.json  # check one file
//
// Read-only over result files the harness made content-free (task ids,
// counts, durations, cost, fixed codes, model ids, revisions). Every file is
// put through the privacy check again before a number from it is used, and
// the rendered report is checked once more before it is printed or written.
// It never calls a model, never touches the desktop and reads nothing but
// output/harness, reports/ and the paths it is given. The method is in
// docs/HONESTY.md; the logic and its tests are in src/gym/honesty.ts and
// tests/honesty-report.test.ts.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const { register } = await import("tsx/esm/api");
register();
const { MARKERS, groupByRevision, ingest, publishable, spliceReport } =
  await import("../src/gym/honesty.ts");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    only: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    `Usage: node scripts/honesty-report.mjs [--out file] [--only] [--json] [--strict] [path...]

  Reads results.json files (schema 2) and prints the Honesty Report tables as
  Markdown. It always reads this checkout's own cycles
  (output/harness/*/results.json) and the contributed files under reports/;
  a path given here is read as well. A path may be a file or a directory. In
  a directory, a folder holding results.json contributes that file alone (a
  cycle folder's plan.json is not a result); elsewhere every *.json counts,
  up to three levels down (reports/<contributor>/<cycle>.json).

  --out <file>   Write the report there. A file holding the markers
                 <!-- honesty-report:begin --> and <!-- honesty-report:end -->
                 keeps its own text and gets the section between them
                 replaced; a file without them gets the section appended.
  --only         Read the given paths and nothing else, to check one file.
  --json         Print the groups and the refused files as JSON instead.
                 With --out, the file must be a .json file.
  --strict       Exit 1 when any file was refused by the ingest check.`,
  );
  process.exit(0);
}

/** The result files a path stands for. */
function collect(path, depth = 0) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  if (depth > 3) return [];
  if (existsSync(join(path, "results.json")))
    return [join(path, "results.json")];
  const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  return entries.flatMap((entry) =>
    entry.isDirectory()
      ? collect(join(path, entry.name), depth + 1)
      : entry.isFile() && entry.name.endsWith(".json")
        ? [join(path, entry.name)]
        : [],
  );
}

if (values.only && !positionals.length) {
  console.error("--only needs at least one path to read.");
  process.exit(2);
}
// --json writes the whole file: over a document it would replace the method
// and the conflict-of-interest statement that the Markdown run keeps.
if (values.json && values.out) {
  const file = resolve(process.cwd(), values.out);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (
    !file.endsWith(".json") ||
    existing.includes(MARKERS.begin) ||
    existing.includes(MARKERS.end)
  ) {
    console.error(
      `JSON_OUT_NOT_JSON ${relative(root, file)}: --json with --out writes a whole .json file, never a document. Nothing was written.`,
    );
    process.exit(2);
  }
}

// The published page stands on both sources: the maintainers' own cycles and
// every contributed file. A path on the command line adds to them, so a
// regenerate command that names reports/ (or anything else) can never drop
// the maintainers' rows, or anyone's, without --only saying so.
const harness = resolve(root, "output/harness");
const defaults = values.only
  ? []
  : [
      ...(existsSync(harness)
        ? readdirSync(harness, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(harness, entry.name, "results.json"))
            .filter((file) => existsSync(file))
            .sort()
        : []),
      ...collect(resolve(root, "reports")),
    ];
const files = [
  ...defaults,
  ...positionals.flatMap((path) => collect(resolve(process.cwd(), path))),
];

/** A cycle folder's plan, which recorded the revision the cycle began at. */
const planBeside = (file) => {
  const plan = join(dirname(file), "plan.json");
  return basename(file) === "results.json" && existsSync(plan)
    ? readFileSync(plan, "utf8")
    : undefined;
};

// Paths go to the ingest check relative to the repository, which is how it
// tells the maintainers' own output from a contribution and how the report
// names a file without spelling out anyone's folders.
const { cycles, rejected } = ingest(
  [...new Set(files)].map((file) => ({
    path: relative(root, file),
    text: readFileSync(file, "utf8"),
    plan: planBeside(file),
  })),
);

// The last line of defence: a report that carries an address, a home path or
// an attempt marker is not printed, whatever let it through.
const { text: rendered, leaked } = publishable(
  groupByRevision(cycles),
  rejected,
  new Date().toISOString(),
  values.json,
);
if (leaked.length) {
  console.error(`OUTPUT_NOT_CONTENT_FREE ${leaked.join(" ")}`);
  process.exit(3);
}

if (values.out) {
  const file = resolve(process.cwd(), values.out);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = values.json ? rendered : spliceReport(existing, rendered);
  if (next === null) {
    console.error(
      `MARKERS_MALFORMED ${relative(root, file)}: expected one begin marker before one end marker. Nothing was written.`,
    );
    process.exit(2);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  console.log(
    `Wrote ${relative(root, file)}: ${cycles.length} cycle(s), ${rejected.length} refused.`,
  );
} else process.stdout.write(rendered);

if (rejected.length) {
  console.error(
    `${rejected.length} file(s) refused by the ingest check: ` +
      rejected
        .map(
          (r) =>
            `${r.file} (${[...new Set(r.problems.map((p) => p.code))].join(", ")})`,
        )
        .join("; "),
  );
  if (values.strict) process.exit(1);
}
