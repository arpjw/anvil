# Anvil — Session Log

> One entry per Claude Code session. Write it before closing the session.
> The next session starts by reading the most recent entry here + current phase in BUILDPLAN.md.

---

## Session Template

```
## Session N — [Date]
**Phase:** N — [Phase Name]
**Duration:** ~Xh

### What was accomplished
- 

### Decisions made
- 

### What broke / was surprising
- 

### State of codebase at close
- 

### Next session should start with
- 
```

---

<!-- Entries go below, newest at top -->

## Session 5 — June 18, 2026
**Phase:** 5 — TUI + Polish
**Duration:** ~1h

### What was accomplished
- Built src/ui/stream.ts: typed UIEvent union, global singleton, waitForApproval/resolveApproval
- Built App.tsx: figlet ANVIL header, 28/72 two-panel layout, 18-item rolling activity log
- Built ToolCall.tsx: amber tool name, braille spinner, result preview
- Built ShadowCycle.tsx: shadow[N/3] → validating → committed/retrying flow
- Built PlanDisplay.tsx: round yellow-border box, all 7 plan fields
- Built StatusBar.tsx: model · phase (colored) · elapsed time
- Replaced all console.log/stderr calls with uiStream.push(event) across all agents
- Removed readline from orchestrator — approval now resolves via Ink key input

### Decisions made
- Event stream architecture: agents are completely decoupled from UI
- waitForApproval/resolveApproval Promise pattern instead of readline
- 18-item rolling log cap to prevent overflow in right panel
- Two-panel layout: 28% session info / 72% activity log

### What broke / was surprising
- readline had to be fully removed — it conflicts with Ink's input handling

### State of codebase at close
- All 5 phases complete, TUI verified on both simple and complex test paths
- Phase transitions IDLE → PLANNING → EXECUTING → DONE visible in status bar
- Errors surface in red in activity log

### Next session should start with
- Phase 6: The writeup
- Document shadow workspace, context retrieval, subagent isolation with evidence from logs
- Publish and link from README

## Session 4 — June 18, 2026
**Phase:** 4 — Subagent Split
**Duration:** ~1h

### What was accomplished
- Built src/agents/loop.ts: shared streaming tool-use loop extracted from agent.ts (DRY base for all subagents)
- Built src/agents/planner.ts: Planner subagent with all read-only tools + write_plan terminal tool; produces plan.json to /tmp/anvil/<sessionId>/plan.json
- Built src/agents/executor.ts: Executor subagent restricted to read_file/write_file/done; enforces allowedSet path restriction from plan's filesToModify+filesToCreate
- Built src/agents/orchestrator.ts: routes simple vs complex via keyword/file-path heuristic; displays plan, runs y/n/revise approval loop; reports escalations
- Added done tool to src/tools/index.ts; loop.ts breaks outer loop immediately on done
- Thinned src/agent.ts to a one-liner delegating to runOrchestrator
- Added process.exit(0) to src/index.ts — prevents hang after executor completes
- Full pipeline verified: Orchestrator → Planner (read-only exploration) → plan displayed → user approves → Executor (scoped writes through shadow workspace) → committed

### Decisions made
- Complexity heuristic is keyword-based + distinct file path count (≥2) — cheap, good enough, revisable
- Executor path restriction uses resolved absolute paths in a Set for O(1) deny-fast access checks
- done tool handled in loop.ts, not by executeTool — keeps tool routing clean, signals "break outer"
- Promise.all scaffold around runPlanner for future concurrent exploration tasks already wired in
- Simple requests bypass the planner entirely with an auto-generated minimal plan — avoids approval gate overhead for trivial edits

### What broke / was surprising
- process.exit(0) was required — without it the process hung after executor finished (async LSP subprocess kept event loop alive)
- Executor must use resolve(workdir, path) to normalize relative paths before checking allowedSet, or paths with ./ prefix silently bypass the restriction

### State of codebase at close
- src/agents/ (loop.ts, planner.ts, executor.ts, orchestrator.ts) all built and verified
- Full Orchestrator → Planner → Executor → Shadow Workspace → Commit pipeline working end-to-end
- All four phases (skeleton, context engine, shadow workspace, subagent split) working together

### Next session should start with
- Phase 5: TUI + Polish
- Integrate Ink (React for CLIs) or Blessed
- Session list panel, inline tool call display, shadow workspace cycle visualization
- SQLite session persistence

## Session 3 — June 18, 2026
**Phase:** 3 — Shadow Workspace
**Duration:** ~1h

### What was accomplished
- Built src/shadow/workspace.ts: shadowWrite, commitToReal, clearSession
- Extended LSP client with diagnostics support: publishDiagnostics listener, checkContent, revertContent
- write_file.ts now thin — all shadow logic in src/shadow/
- sessionId threaded from crypto.randomUUID() at CLI startup through all tool calls
- shadow.log: JSON entry per cycle (timestamp, proposed content excerpt, diagnostics, outcome)
- Test proves full cycle: broken edit rejected → diagnostics returned → agent self-corrects → commits clean

### Decisions made
- LSP-in-memory approach (didChange) rather than actual temp file copy — avoids file system race conditions
- 400ms debounce + 8s global timeout for diagnostics to settle
- Max 3 retry passes per file before escalating to orchestrator

### What broke / was surprising
- Critical fix: textDocument/publishDiagnostics must be declared in initialize capabilities
  or typescript-language-server never sends diagnostic push notifications. Silent failure.

### State of codebase at close
- Full shadow workspace pipeline working end-to-end
- src/shadow/workspace.ts, src/lsp/client.ts extended, write_file.ts thinned
- All three phases (skeleton, context engine, shadow workspace) working together

### Next session should start with
- Phase 4: Subagent split
- Orchestrator → Planner (read-only) → Executor (writes via shadow workspace)
- User approval gate between plan and execution

---

## Session 2 — June 17, 2026
**Phase:** 2 — Context Engine
**Duration:** ~1h

### What was accomplished
- Integrated tree-sitter with TypeScript and Python grammars
- Built ast_search.ts: 5 query types (functions, classes, imports, interfaces, types)
- Built full JSON-RPC LSP client over stdin/stdout with initialize handshake
- Built find_symbol.ts: definition + references, verified AppError resolves across 3 files (19 refs)
- Created test-repo-2: 6-file TypeScript service (~250 lines) with layered cross-file imports
- Verified agent navigates via list_files → ast_search → find_symbol → targeted read_file (no blind full-file reads)

### Decisions made
- LSP client as module-level singleton per workdir — avoids spawning multiple language server processes
- Opens all TS/JS files before querying LSP to give it full cross-file context
- ast_search capped at 20k chars output
- find_symbol locates typescript-language-server by walking node_modules/.bin (no global install required)

### What broke / was surprising
- Peer-dep warnings on tree-sitter grammars — harmless, works fine

### State of codebase at close
- src/treesitter/index.ts, src/lsp/client.ts, src/tools/ast_search.ts, src/tools/find_symbol.ts all built and verified
- All 5 Phase 2 tools registered in src/tools/index.ts
- Agent behavior confirmed: agentic retrieval working, not brute-force reading

### Next session should start with
- Phase 3: Shadow Workspace
- Build shadow copy mechanism, LSP diagnostics loop, retry on failure, commit only on clean

---

## Session 1 — June 17, 2025
**Phase:** 1 — Skeleton
**Duration:** ~1h

### What was accomplished
- Initialized TypeScript project (tsx, execa, openai SDK pointed at Kimi)
- Implemented read_file, list_files, text_search, write_file tools
- Built agent.ts: streaming tool-use loop, stderr for tool activity, stdout for text
- Built CLI entrypoint: takes request string + optional workdir arg
- Created test-repo/main.ts with two unhandled fetch calls as test target
- Full skeleton verified — structure is clean and modular

### Decisions made
- Using Kimi (moonshot-v1) via OpenAI-compatible SDK instead of Anthropic for cost
- Tool activity to stderr, model text to stdout — keeps piping clean
- 40k char cap on read_file to avoid context blowout on large files
- Auto mkdir in write_file — agent shouldn't have to think about directory existence

### What broke / was surprising
- Nothing structural broke — end-to-end run confirmed clean with MOONSHOT_API_KEY

### State of codebase at close
- All Phase 1 tasks complete including live end-to-end verification
- Agent correctly added error handling to test-repo/main.ts fetch calls
- src/tools/ clean and modular, agent loop solid, CLI works

### Next session should start with
- Move to Phase 2: tree-sitter integration for ast_search
- Integrate typescript-language-server for find_symbol and get_diagnostics
