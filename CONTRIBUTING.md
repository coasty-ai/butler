# Contributing to Butler

Butler is an experimental voice-first agent that operates a Mac. It drives real input on a real desktop, so contributions are held to a few standing rules before anything else.

## Ground rules

- **Safety floors never relax.** Marked synthetic input only, secure fields untouched, protected applications refused, the person's own browser never driven by a benchmark run, no auto-answering of a coding agent's permission prompt. A change that loosens a floor is not accepted, whatever it fixes.
- **Traces stay content-free.** Diagnostics, journals, tests and fixtures carry counts, codes, roles, lengths and hashes, never screen text, file contents or the person's words. `electron/diagnostics.ts` is an allow-list; add a field there deliberately, with a test that a sentence in its place is dropped.
- **Keys and personal data never enter the repository.** `.env` is ignored and has never been committed; keep it that way. Test fixtures are synthetic.
- **Evidence first.** A fix names the run, cycle or live session that showed the defect, then the mechanism, then the change. Commit messages in this repository are long first lines that read as the record of why.

## Setup

Node 22.12 or newer, npm, macOS 14 or newer, Xcode Command Line Tools. See the README for `npm ci`, `npm run dev`, `npm run build:native` and the packaging scripts.

## Before you open a pull request

Run the gate the maintainers run, and check every exit code:

```sh
npx tsc --noEmit -p .
npx prettier --check <files you touched>
npx vitest run <the suites you touched> tests/boundaries.test.ts tests/identity.test.ts
npm run test:native-safety        # when native/macos changed (compiles the pure Swift tests; launches nothing)
node scripts/bench.mjs --dry-run  # when the bench, catalogue or fixtures changed
```

`tests/harness-cycle.test.ts` has two tests that need the main checkout and no live cycle; note them if they fail in a worktree.

## Benchmarks

`docs/BENCHMARK.md` and `docs/HARNESS_LOOP.md` describe the market suite, the probes and the cycle harness. A benchmark cycle drives the Mac it runs on: run it only on a machine nobody is using, never against your own browser, and read the safety section first. Report results as the harness prints them (pass rate with its interval, false-done rate, the failure classes), with the revision and the auditor model.

## What is welcome

- Fixes with a reproducing bench row or probe output.
- New fixture tasks that mirror real everyday work, graded by state rather than screenshots.
- Provider adapters that keep the single GUI-action tool contract.
- Accessibility findings: controls the helper cannot name, focus or press on real applications, with the probe output (`scripts/probe-web-controls.mjs`).

## Licence

By contributing you agree that your contribution is licensed under the MIT licence in `LICENSE`.
