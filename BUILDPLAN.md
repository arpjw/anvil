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

- [ ] Integrate tree-sitter (TypeScript + Go + Python grammars)
- [ ] Implement `ast_search`: query by node type, extract function signatures, find imports
- [ ] Spawn LSP subprocess (`typescript-language-server`)
- [ ] Implement `find_symbol`: definition lookup + references via LSP
- [ ] Implement `get_diagnostics` via LSP
- [ ] Set up sqlite-vec for vector index
- [ ] Chunk files and embed on project init
- [ ] Implement semantic search tool over vector index
- [ ] Benchmark: 10k line repo, 5 test queries, measure tool calls to find correct file
- [ ] Write Session 2 log entry

---

## Phase 3 — Shadow Workspace
**Goal:** No edit ever touches the real filesystem until it passes LSP diagnostics. The feedback loop that makes edits trustworthy.

**Done when:** An intentionally broken edit is proposed, rejected by shadow workspace, self-corrected, and committed — all automatically.

- [ ] Shadow copy mechanism: mirror target file to `/tmp/anvil/<sessionId>/shadow/`
- [ ] Apply edit to shadow copy only
- [ ] Run LSP diagnostics against shadow copy
- [ ] Return diagnostics to agent for self-correction
- [ ] Retry loop: max 3 passes per file, escalate on failure
- [ ] Commit to real file only on clean diagnostics
- [ ] Session log: write every shadow cycle to `shadow.log`
- [ ] Test: intentionally broken edit → shadow rejects → agent fixes → commits
- [ ] Write Session 3 log entry

---

## Phase 4 — Subagent Split
**Goal:** Separate Planner and Executor with strict tool isolation. User approves plan before any writes happen.

**Done when:** A complex multi-file request flows through Orchestrator → Planner (user approves plan) → Executor → Shadow Workspace → committed edits.

- [ ] Define subagent interface and message passing protocol
- [ ] Implement Planner subagent (read-only tools only)
- [ ] Implement plan format (`plan.json` with all 7 fields)
- [ ] Implement Executor subagent (write tools + shadow workspace, scoped reads)
- [ ] Implement Orchestrator: spawn/coordinate subagents, own todo list
- [ ] User approval gate: show plan, wait for approve/revise
- [ ] Concurrent subagent support (`Promise.all` for independent queries)
- [ ] Test: multi-file refactor flows correctly through all three agents
- [ ] Write Session 4 log entry

---

## Phase 5 — TUI + Polish
**Goal:** Looks and feels like a real tool. Shadow workspace cycles visible. Sessions persistent.

**Done when:** A non-technical person watching over your shoulder understands what's happening at every moment.

- [ ] Integrate Ink (React for CLIs) or Blessed for TUI
- [ ] Session list panel (left) + chat/log panel (right)
- [ ] Inline tool call display: show active tool, args, result summary
- [ ] Shadow workspace cycle display: "validating... 2 errors... retrying... clean ✓"
- [ ] SQLite session persistence: save/resume sessions
- [ ] Config file: model selection, LSP binary paths, project root
- [ ] Write Session 5 log entry

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
