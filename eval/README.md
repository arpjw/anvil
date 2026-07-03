# Anvil SWE-bench Verified harness

Runs Anvil headlessly against SWE-bench Verified tasks and reports a resolution rate.

```bash
cd eval
npm install
export ANTHROPIC_API_KEY=...
npx tsx cli.ts --tasks 50 --output ./results
```

Flags: `--tasks <n>` `--output <dir>` `--resume` `--model <id>` `--concurrency <n>`.

## What this harness does

For every task:

1. `git clone <repo>` into `/tmp/anvil-eval/<instance_id>/` and check out `base_commit`.
2. Apply `test_patch` — the tests are staged **before** Anvil runs so the agent can run them if it wants.
3. Invoke `runHeadless(problem_statement, workdir, noVerify=true, model)` — auto-approves the plan and every diff hunk.
4. Detect the test runner (`pytest` / `npm`), run only `FAIL_TO_PASS + PASS_TO_PASS`, parse pass/fail per test id.
5. **Resolved** iff every `FAIL_TO_PASS` now passes **and** every `PASS_TO_PASS` still passes.
6. Persist `<instance_id>.json` to the output dir before moving on, then delete the working copy.

Batches of `--concurrency` tasks (default 3) run at once.

## What this harness does NOT do

Both worth knowing before you interpret the score:

**No environment isolation.** Upstream SWE-bench pins Python version, pip deps, and sometimes system packages per instance. This harness runs `python -m pytest` against your host env. Tasks that need a specific Python or a fresh venv will look "unresolved" even when the agent's diff is correct. The upstream harness runs each task in a purpose-built Docker container to sidestep this.

**No SNAPPY parquet decoding.** The spec asks for `parquetjs-lite`, but the upstream file is SNAPPY-compressed and `parquetjs-lite` doesn't support SNAPPY. The loader tries parquet first and, on failure, falls back to HuggingFace's `datasets-server` rows API — which returns the same records as JSON and works reliably. If you want the parquet path to actually succeed, swap the reader for `hyparquet` (supports SNAPPY) or pre-decompress the file.

**The score is a lower bound.** Between the env issues above and Anvil's own no-verify shortcut in headless mode, the number you get here should not be compared directly to the SWE-bench leaderboard. It's useful as a regression signal ("this branch went from 8/50 → 12/50") and as a source of concrete failure examples to iterate on.

## Files

- `swe_bench.ts` — dataset loader (parquet with JSON API fallback).
- `run.ts` — per-task pipeline: clone → patch → Anvil → pytest → score.
- `score.ts` — aggregate + `printReport`.
- `cli.ts` — arg parsing + orchestration.
