# Anvil

A terminal coding agent with a validation gate, reviewable edits, and a cloud workspace built around the same execution engine.

Anvil explores a repository, plans larger changes, applies edits, and runs project checks. You can use the terminal interface, consume structured CLI output, or review a cloud session in the dashboard.

## Start from source

Use Node **22 LTS** (see `.nvmrc`). Native tree-sitter modules require a C++ build toolchain when a compatible prebuilt binary is unavailable.

```bash
git clone https://github.com/arpjw/anvil.git
cd anvil
nvm use
npm ci
npm run build
node dist/index.js --help
node dist/index.js doctor ./your-project
```

Set the environment variable for your selected model, then run a task:

```bash
export ANTHROPIC_API_KEY=your_key
node dist/index.js "Add input validation to src/parser.ts" ./your-project
```

The model picker supports configured Anthropic, OpenAI, Gemini, and Moonshot models. Provider availability and access depend on your account. `anvilai` is the executable name in the npm package; these source changes are not a published release.

## What works

- **Plan, approve, revise.** Multi-file requests go through a read-only planner. Review the goal, affected files, steps, risks, and verification criteria before execution. Simple requests skip planning.
- **Isolate the checkout.** Terminal sessions use a dedicated Git worktree and branch by default. Your original tracked files, branch, and index stay in place. Resume reuses the session worktree.
- **Edit related files together.** `write_files` stages creates, updates, and deletions as one batch, checks the combined TypeScript/JSON result, reviews selected hunks, and rolls back the batch if applying any file fails. Interrupted batches recover on the next invocation.
- **Validate proposed edits.** TypeScript and JavaScript edits are checked through a bundled language server; JSON receives syntax validation. Missing diagnostics, disconnects, and timeouts reject the proposal. Other file types defer to project checks.
- **Review exact changes.** Approve individual hunks. The selected result is validated again, and writes check that the original file has not changed in the meantime. Diff application preserves end-of-file newlines and CRLF content.
- **Verify before completion.** Type checks, lint, tests, and custom `VALIDATE:` commands run after execution, with up to two repair rounds. Failed checks fail the session. Missing or disabled checks are explicitly reported as skipped.
- **Keep recovery information.** Results live in `.anvil/sessions/`. Recovery plans and shadow logs live under `/tmp/anvil/<session-id>/`; temporary data may be cleared by the OS.
- **Use Git deliberately.** Isolated sessions require clean tracked source files, record the exact starting commit, and collect file-tool and shell changes into one session commit after checks finish. `autoBranch=false` leaves the session worktree uncommitted for manual review. Git hooks and commit signing are disabled for automatic branch/worktree creation and commits.
- **Inspect execution.** Live workflow phases, bounded command output, per-file diffs, usage estimates, session history, and structured results make progress visible.

Worktrees isolate checkout state, not operating-system permissions. Approved shell commands still run as your user and can reach files and the network outside the worktree. Interactive sessions ask before each shell command, including project checks. Headless sessions deny commands unless you pass `--allow-commands`. See [execution and transaction guarantees](docs/isolated-execution.md) for exact boundaries.

## Terminal workflows

```bash
# Project conventions and diagnostics
anvilai init ./project
anvilai doctor ./project
anvilai verify ./project --json

# Plan without editing project files
anvilai --dry-run --json "Refactor the parser across all files" ./project

# One JSON result on stdout; progress goes to stderr
anvilai --headless --allow-commands --budget 2 "Fix the parser test" ./project

# NDJSON events followed by a result frame
anvilai --stream-json --allow-commands --budget 2 "Fix the parser test" ./project

# History and recovery
anvilai history ./project --json
anvilai --resume SESSION_ID ./project
anvilai undo src/parser.ts /path/from/result/workdir
anvilai --rollback SESSION_ID /path/from/result/workdir

# Explicit legacy in-place mode, also needed for a non-Git directory
anvilai --no-isolate "Fix the parser" ./project
```

Headless mode auto-approves plans and hunks, but does not implicitly approve shell commands. The result includes `workdir`, `sourceWorkdir`, `isolation`, and `commitHash`. Review the commit and cherry-pick it into the source checkout when ready; Anvil does not merge it automatically. `--budget` is an estimated usage threshold checked after model responses, not a prepaid hard billing cap. `--no-verify` records skipped verification, never a passing check. `--help` lists all flags.

Dependencies and untracked code are not copied into a new worktree. Install dependencies in the displayed session directory with an approved command when needed. Local `.anvil/rules.md`, `ignore`, and `memory.md` are copied; slash commands are resolved from the source project.

Resume rereads the original plan against the session workspace; it does not infer that a whole step is complete just because one filename appears in a log. Undo restores a selected file from the session's actual base commit. Rollback refuses uncommitted tracked work rather than discarding it.

Project configuration includes `.anvil/rules.md`, `.anvil/commands/`, and `.anvil/memory.md`. Global options are available through `anvilai config list|get|set`; API key values are redacted. Disable automatic Git commits with `anvilai config set autoBranch false`.

## Cloud workspace

The dashboard includes a responsive session workspace with a phase tracker, plan revision, file diff review, activity search and filters, reconnect state, log export, and explicit PR creation. Replayed events retain stable IDs and are merged into the current activity window.

Preview it without provider keys, a database, or authentication:

```bash
cd cloud/dashboard
npm ci
npm run dev
# Open http://localhost:3000/demo
```

The preview is labeled sample data and runs no agent. Live routes require Clerk configuration. The cloud runtime imports this repository's public library API, uses the selected model, and forwards structured lifecycle events. It relies on the control plane's final diff review and PR workflow, so it does not create local Git commits inside the VM.

Cloud retry starts a **fresh checkout in a new session**. The old session's diffs and history remain available. Phase checkpoints are progress metadata, not VM filesystem snapshots. See [cloud setup](cloud/README.md) and [upgrade notes](UPGRADE_NOTES.md) for integration limits.

## Development and checks

```bash
# Terminal engine, real bundled LSP fixture, Git recovery, and CLI regressions
npm run build
npm run check

# API and lifecycle tests use in-memory services
cd cloud/control-plane
bun install --frozen-lockfile
bun run typecheck
bun test

# Dashboard event tests and production build
cd ../dashboard
npm ci
npm run check
npm run build

# From the repository root, after building the terminal library
cd cloud/vm/runtime
npm ci
npm run build
npm test
```

CI runs these checks without model credentials or paid services. The optional [headless workflow example](docs/examples/headless-ci.yml) is manual, saves a reviewable patch, and does not push changes.

See [architecture](ARCHITECTURE.md) for implementation details. The existing [build plan](BUILDPLAN.md) and session notes retain historical design context; they are not a claim that every integration has been deployed or validated.
