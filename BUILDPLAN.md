# Anvil — Build Plan

> Track progress here. Check off tasks as they're completed in Claude Code sessions.
> Current phase is whatever has the most recent unchecked items.

---

## Phase 1 — Skeleton ✓
**Goal:** A working end-to-end agent loop. One agent, no subagents, no shadow workspace.

- [x] Initialize TypeScript project (`tsconfig`, `package.json`, `eslint`)
- [x] Implement `read_file` tool
- [x] Implement `list_files` tool
- [x] Implement `text_search` tool (ripgrep subprocess)
- [x] Wire Anthropic API call with tool use loop
- [x] Basic CLI entrypoint: `anvilai "<request>"`
- [x] Make a real file edit end-to-end on a test repo
- [x] Write Session 1 log entry

---

## Phase 2 — Context Engine ✓
**Goal:** Agentic, multi-step retrieval that actually understands code structure.

- [x] Integrate tree-sitter (TypeScript + Go + Python grammars)
- [x] Implement `ast_search`: query by node type, extract function signatures, find imports
- [x] Spawn LSP subprocess (`typescript-language-server`)
- [x] Implement `find_symbol`: definition lookup + references via LSP
- [x] Implement `get_diagnostics` via LSP
- [x] Set up sqlite-vec for vector index
- [x] Chunk files and embed on project init
- [x] Implement semantic search tool over vector index
- [x] Benchmark: 10k line repo, 5 test queries, measure tool calls to find correct file
- [x] Write Session 2 log entry

---

## Phase 3 — Shadow Workspace ✓
**Goal:** No edit ever touches the real filesystem until it passes LSP diagnostics.

- [x] Shadow copy mechanism: mirror target file to `/tmp/anvil/<sessionId>/shadow/`
- [x] Apply edit to shadow copy only
- [x] Run LSP diagnostics against shadow copy
- [x] Return diagnostics to agent for self-correction
- [x] Retry loop: max 3 passes per file, escalate on failure
- [x] Commit to real file only on clean diagnostics
- [x] Session log: write every shadow cycle to `shadow.log`
- [x] Test: intentionally broken edit → shadow rejects → agent fixes → commits
- [x] Write Session 3 log entry

---

## Phase 4 — Subagent Split ✓
**Goal:** Separate Planner and Executor with strict tool isolation. User approves plan before any writes happen.

- [x] Define subagent interface and message passing protocol
- [x] Implement Planner subagent (read-only tools only)
- [x] Implement plan format (`plan.json` with all 7 fields)
- [x] Implement Executor subagent (write tools + shadow workspace, scoped reads)
- [x] Implement Orchestrator: spawn/coordinate subagents, own todo list
- [x] User approval gate: show plan, wait for approve/revise
- [x] Concurrent subagent support (`Promise.all` for independent queries)
- [x] `done` tool: clean exit signal with summary
- [x] Test: multi-file refactor flows correctly through all three agents
- [x] Write Session 4 log entry

---

## Phase 5 — TUI ✓
**Goal:** Looks and feels like a real tool. Shadow workspace cycles visible. Live tool call display.

- [x] Integrate Ink (React for CLIs)
- [x] figlet ANVIL header, session ID and workdir beneath
- [x] 28/72 two-panel layout: session info left, activity log right
- [x] ToolCall.tsx: amber tool name, braille spinner, result preview
- [x] ShadowCycle.tsx: shadow[N/3] → validating → ✓ committed / ✖ retrying
- [x] PlanDisplay.tsx: round yellow-border box, all 7 plan fields
- [x] StatusBar.tsx: model · phase (colored) · elapsed time
- [x] Event stream architecture: typed UIEvent union, agents emit events, UI is purely reactive
- [x] waitForApproval/resolveApproval replaces readline for Ink compatibility
- [x] Write Session 5 log entry

---

## Phase 6 — Writeup (in progress)
**Goal:** Technical deep dive published at anvil.aryasomu.com. The document that makes this land at Cursor.

- [ ] Section 1: Why I built this — the three failure modes of naive agents
- [ ] Section 2: Shadow workspace — Cursor's approach vs filesystem-level implementation, publishDiagnostics insight, db.ts self-correction example
- [ ] Section 3: Agentic context retrieval — why RAG fails on codebases, 5-tool retrieval surface, User→Account rename walkthrough
- [ ] Section 4: Subagent isolation — three rules and why each matters, approval gate
- [ ] Section 5: What editor-level access would unlock — the four things you can't do without a VS Code fork
- [ ] Section 6: What I learned — the hardest parts were in the scaffold, not the model
- [ ] Publish at anvil.aryasomu.com
- [ ] Update README to link to writeup
- [ ] Write Session 6 log entry

---

## Phase 7 — Git Integration ✓
**Goal:** Anvil is git-aware. Every session is safe to run on a real codebase because it branches, commits, and can roll back.

**Done when:** Running a multi-file edit auto-creates a branch, commits each file with a meaningful message, and `anvilai --rollback` returns the repo to pre-session state.

- [x] Read git context at session start: current branch, last 10 commits, staged/unstaged diff — inject into orchestrator system prompt
- [x] Auto-branch before any multi-file edit: `anvil/session-<sessionId>-<date>` naming convention
- [x] Commit each file immediately after shadow workspace confirms clean: meaningful commit message generated by the agent describing what changed and why
- [x] `anvilai --rollback <sessionId>`: revert all commits from a session, delete the session branch, restore original state
- [x] PR description generation: after session completes, generate a structured PR description (summary, files changed, motivation, testing notes) and write it to `.anvil/pr-<sessionId>.md`
- [x] Git-aware context tools: `git_log` tool (last N commits with diffs), `git_diff` tool (current unstaged changes), `git_blame` tool (who last touched a line and when) — all callable by planner
- [x] Expose git context in TUI: current branch shown in left panel, commit count for session updated live
- [x] Test: run a multi-file refactor, verify branch created, each file committed, rollback restores original state cleanly
- [x] Write Session 7 log entry

---

## Phase 8 — Context Depth ✓
**Goal:** Rich context references in requests. Anvil understands @mentions, loads project rules automatically, and remembers decisions across sessions.

**Done when:** `anvilai "fix the auth error in @src/auth.ts using the pattern from @src/db.ts"` resolves both files, loads `.anvil/rules.md`, and applies memory from previous sessions.

- [x] **@file mentions**: parse `@<filepath>` in requests, resolve to absolute path, pre-load file content into planner context before exploration starts — agent never has to search for explicitly mentioned files
- [x] **@symbol mentions**: parse `@<SymbolName>` in requests, run `find_symbol` automatically at session start, inject definition + references into context
- [x] **@docs mentions**: parse `@<url>` in requests, fetch the URL content, strip to readable text, inject into planner context — lets agent use external documentation
- [x] **@web mentions**: parse `@web:<query>` in requests, run a web search, inject top 3 results as context — agent can reference current library docs or error explanations
- [x] **`.anvil/rules.md`**: auto-loaded at every session start if present in workdir. Contains repo-specific instructions: code style, off-limits directories, naming conventions, testing requirements. Injected into orchestrator system prompt before any agent runs.
- [x] **`.anvil/memory.md`**: persistent memory file. Orchestrator appends a summary entry after every session: what was changed, what decisions were made, what patterns the codebase uses. Planner reads this at session start to avoid re-learning the codebase from scratch.
- [x] **`.anvil/ignore`**: like `.gitignore` but for Anvil. Files and directories listed here are never read, listed, or modified by any agent. Enforced in `list_files`, `read_file`, `ast_search`, and `write_file`.
- [x] Update TUI to show active context sources in left panel: which @mentions resolved, whether rules.md and memory.md were loaded
- [x] Test: session with @file, @symbol, @docs mentions — verify all resolve correctly and appear in planner context before first tool call
- [x] Write Session 8 log entry

---

## Phase 9 — Execution Environment
**Goal:** Anvil can run commands, read their output, and react. Edits are verified by actually running the code, not just type-checking it.

**Done when:** After making edits, Anvil runs the test suite, reads failures, and autonomously fixes them — all in one session without user intervention.

- [x] **`run_command` tool**: executes a shell command in the workdir, captures stdout + stderr + exit code, returns to agent. Timeout enforced (30s default, configurable). Blocked commands list: `rm -rf /`, `sudo`, anything touching outside workdir.
- [x] **`run_tests` tool**: detects test runner from project config (`package.json` scripts, `pytest.ini`, `Cargo.toml`) and runs it. Returns pass/fail count, failing test names, error output. Agent uses this to verify edits worked.
- [x] **Post-execution verification pass**: after executor marks session done, orchestrator automatically runs `run_tests` + type-check. If failures found, spawns a new executor pass with the failure output as context. Max 2 auto-fix rounds.
- [x] **Build verification**: detect build command from project config, run it after edits, surface build errors to executor for self-correction — same feedback loop as shadow workspace but at the build level.
- [x] **Headless / CI mode**: `anvilai --headless "<request>" <workdir>` — no TUI, no approval gate, JSON output to stdout, exit code 0 on success / 1 on failure. Designed for use in GitHub Actions or other CI pipelines.
- [x] **`anvilai --dry-run`**: runs the full planner pass, prints the plan, but does not spawn executor. No files are touched. Useful for previewing what a complex request would do.
- [x] **Command output in TUI**: `run_command` and `run_tests` results shown in activity log with colored pass/fail indicators, test count, and collapsible error details
- [x] Test: make a broken edit manually, run `anvilai "fix the failing tests"`, verify agent reads test output and fixes the root cause
- [x] Write Session 9 log entry

---

## Phase 10 — Edit Quality
**Goal:** Every edit surface is trustworthy and user-controlled. Diffs are visible before commit. Interrupts are safe. Images can be used as context.

**Done when:** User can review a colored per-file diff, accept/reject individual hunks, interrupt mid-session safely, and paste a screenshot as task context.

- [x] **Diff view before commit**: after shadow workspace confirms clean but before committing to real file, render a colored unified diff in the TUI (green additions, red deletions). User sees exact line-by-line changes.
- [x] **Per-hunk accept/reject**: in the diff view, user can navigate hunks with arrow keys and accept (a) or reject (r) individual changes. Rejected hunks are excluded from the commit. Accepted hunks commit immediately.
- [x] **DiffView.tsx component**: new Ink component. Shows filename header, line numbers, colored diff lines, hunk navigation controls, accept/reject keybindings. Integrates with the event stream — `diff_ready` event triggers display.
- [x] **Graceful interrupt (Ctrl+C handling)**: intercept SIGINT during execution. Instead of killing the process, pause after the current file completes. Show what was done so far, what remains. Prompt: "Stop here? (y = commit what's done, n = continue, r = rollback everything)". Never leave files in a half-edited state.
- [x] **Multimodal input**: `anvilai --image <path> "<request>"` — accepts a PNG/JPG of an error message, UI mockup, or diagram. Image is base64-encoded and passed as vision context to the planner. Planner describes what it sees and uses it to inform the plan.
- [x] **Session resume**: `anvilai --resume <sessionId>` — reload a previous session's plan and memory, continue from where it left off. Useful when a session was interrupted or when a plan needs multiple execution passes.
- [x] **Edit size guard**: before spawning executor, estimate token count of all planned edits. If over threshold (e.g. 20 files), warn user and ask for confirmation. Prevents runaway sessions on large codebases.
- [x] Test: run a multi-file session, reject one hunk in the diff view, verify that hunk is excluded from the committed file while all others apply cleanly
- [x] Test: interrupt mid-session with Ctrl+C, choose rollback, verify all files restored to pre-session state
- [x] Write Session 10 log entry

---

## Phase 11 — Distribution
**Goal:** Anyone can install and run Anvil in under 60 seconds. No manual LSP setup, no repo cloning.

**Done when:** `npm install -g anvil-agent && anvilai "add error handling to main.ts" .` works on a fresh machine with no prior setup.

- [ ] **Compiled binary**: use `bun build --compile` to produce a single self-contained executable for macOS (arm64 + x64), Linux (x64), Windows (x64). No Node.js required to run.
- [ ] **npm package**: publish as `anvil-agent` on npm. Entry point: `anvilai` CLI command. Includes compiled binaries for all platforms via `optionalDependencies` pattern (same as esbuild).
- [ ] **Auto LSP install**: on first run, detect which language servers are missing for the workdir's languages. Prompt user once: "TypeScript files detected. Install typescript-language-server? (y/n)". Run `npm install -g <server>` automatically on yes. Store installed state in `~/.anvil/lsp.json`.
- [ ] **`~/.anvil/config.json`**: global config file. Stores: default model, API key (alternative to env var), preferred LSP binary paths, default retry count, TUI preferences (color scheme, panel widths). `anvilai config set <key> <value>` CLI command to edit.
- [ ] **Custom slash commands**: `.anvil/commands/` directory in project root. Each `.md` file is a slash command: filename is the command name, content is the system prompt. `anvilai /review` runs the `review.md` command against the current repo. Listed in TUI with `/` prefix.
- [ ] **`anvilai init`**: interactive setup command for a new project. Creates `.anvil/rules.md` (prompts for code style, off-limits dirs, test command), `.anvil/ignore`, `.anvil/commands/` with starter commands (review, document, test). Adds `.anvil/memory.md` to `.gitignore`.
- [ ] **`anvilai doctor`**: diagnostic command. Checks: API key set, LSP servers installed for detected languages, ripgrep available, Node version, available disk space in `/tmp`. Prints pass/fail for each check with fix instructions.
- [ ] **GitHub Actions integration**: publish `arpjw/anvil-action` — a reusable GitHub Action that runs Anvil in headless mode. Inputs: `request`, `workdir`, `anthropic_api_key`. Outputs: `session_id`, `files_modified`, `pr_description`. Example workflow: on PR open, run `anvilai "fix any type errors"` and commit the result.
- [ ] **README install section**: clear, copy-pasteable install instructions. Three paths: npm global install, compiled binary download, run from source.
- [ ] **`anvilai --version`**: prints current version from `package.json`.
- [ ] Test: fresh machine (or Docker container with no Node globals), `npm install -g anvil-agent`, run against a TypeScript project, verify LSP auto-installs and session completes successfully
- [ ] Write Session 11 log entry

