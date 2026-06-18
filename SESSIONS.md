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
