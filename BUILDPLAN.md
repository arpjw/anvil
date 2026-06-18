# Anvil — Build Plan

> Track progress here. Check off tasks as they're completed in Claude Code sessions.
> Current phase is whatever has the most recent unchecked items.

---

## Phase 1 — Skeleton
**Goal:** A working end-to-end agent loop. One agent, no subagents, no shadow workspace. Prove the basic pipeline works on a real file before adding complexity.

**Done when:** Running `anvil "add error handling to main.ts"` on a real repo makes a correct edit.

- [x] Initialize TypeScript project (`tsconfig`, `package.json`, `eslint`)
- [x] Implement `read_file` tool
- [x] Implement `list_files` tool
- [x] Implement `text_search` tool (ripgrep subprocess via execa)
- [x] Wire Kimi/Moonshot API (OpenAI-compatible) tool-use loop with streaming
- [x] Basic CLI entrypoint: `anvil "<request>" [workdir]`
- [x] Make a real file edit end-to-end on a test repo
- [x] Write Session 1 log entry

---

## Phase 2 — Context Engine
**Goal:** Agentic, multi-step retrieval that actually understands code structure. The agent should locate relevant code in an unfamiliar 10k+ line codebase in under 5 tool calls.

**Done when:** Given a medium codebase and a natural language request, the agent finds the right files without being told where to look.

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

## Phase 3 — Shadow Workspace
**Goal:** No edit ever touches the real filesystem until it passes LSP diagnostics. The feedback loop that makes edits trustworthy.

**Done when:** An intentionally broken edit is proposed, rejected by shadow workspace, self-corrected, and committed — all automatically.

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

## Phase 4 — Subagent Split
**Goal:** Separate Planner and Executor with strict tool isolation. User approves plan before any writes happen.

**Done when:** A complex multi-file request flows through Orchestrator → Planner (user approves plan) → Executor → Shadow Workspace → committed edits.

- [x] Define subagent interface and message passing protocol
- [x] Implement Planner subagent (read-only tools only)
- [x] Implement plan format (`plan.json` with all 7 fields)
- [x] Implement Executor subagent (write tools + shadow workspace, scoped reads)
- [x] Implement Orchestrator: spawn/coordinate subagents, own todo list
- [x] User approval gate: show plan, wait for approve/revise
- [x] Concurrent subagent support (`Promise.all` for independent queries)
- [x] Test: multi-file refactor flows correctly through all three agents
- [x] Write Session 4 log entry

---

## Phase 5 — TUI + Polish
**Goal:** Looks and feels like a real tool. Shadow workspace cycles visible. Sessions persistent.

**Done when:** A non-technical person watching over your shoulder understands what's happening at every moment.

- [x] Integrate Ink (React for CLIs) or Blessed for TUI
- [x] Session list panel (left) + chat/log panel (right)
- [x] Inline tool call display: show active tool, args, result summary
- [x] Shadow workspace cycle display: "validating... 2 errors... retrying... clean ✓"
- [ ] SQLite session persistence: save/resume sessions
- [ ] Config file: model selection, LSP binary paths, project root
- [x] Write Session 5 log entry

---

## Phase 6 — Writeup
**Goal:** The document that makes this project land at Cursor. Evidence-based, problem-first, honest about tradeoffs.

**Done when:** Someone at Cursor reads it and learns something about the problem they work on every day.

- [ ] Section 1: The problem — why naive coding agents fail (with specific failure examples from your own logs)
- [ ] Section 2: Shadow workspace — what it is, why it matters, how you implemented it at the filesystem level vs Cursor's editor level
- [ ] Section 3: Context retrieval — naive grep vs agentic AST/LSP retrieval, benchmark results
- [ ] Section 4: Subagent isolation — why tool boundaries matter, what breaks without them
- [ ] Section 5: What you'd do next with editor-level access
- [ ] Publish to personal site or SSRN
- [ ] Link from GitHub README
- [ ] Write final session log entry
