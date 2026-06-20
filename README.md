# Anvil

A terminal-based AI coding agent that implements shadow workspace validation, agentic context retrieval, and a planner/executor subagent split at the filesystem and LSP level.

## What it does

Anvil takes a natural language request and a working directory, then plans and applies code changes while validating every edit through a TypeScript language server before committing it to disk. The retrieval layer is agentic — the agent iteratively explores the codebase using AST queries and LSP symbol resolution rather than dumping file contents into a context window. This makes a meaningful difference on tasks that span multiple files: the agent finds what it needs in a handful of targeted tool calls instead of blindly reading everything.

The project was built to understand the architectural decisions that make Cursor work — specifically the shadow workspace, the planner/executor isolation, and the agentic retrieval loop — by implementing them outside an IDE at the filesystem level.

## Architecture

```
┌─────────────────────────────────────────────┐
│                    TUI                      │
│          Ink · event stream · React         │
├─────────────────────────────────────────────┤
│                 Orchestrator                │
│      complexity classifier · todo list      │
├──────────────────────┬──────────────────────┤
│       Planner        │       Executor       │
│   read-only tools    │   shadow-mediated    │
├──────────────────────┴──────────────────────┤
│              Shadow Workspace               │
│       propose → LSP validate → commit       │
├─────────────────────────────────────────────┤
│              Context Engine                 │
│  read_file · ast_search · find_symbol · ... │
└─────────────────────────────────────────────┘
```

**Context Engine** (`src/tools/`, `src/treesitter/`, `src/lsp/`) — the retrieval layer, called by both the Planner and the Orchestrator. Key decision: the LSP client is a module-level singleton per working directory, so the language server is initialized once with full project context and reused across all tool calls in a session.

**Shadow Workspace** (`src/shadow/workspace.ts`) — every proposed edit goes to a temp copy first; the LSP checks it via `textDocument/didChange` and `publishDiagnostics`, and the edit only reaches the real file if diagnostics are clean. Key decision: `textDocument/publishDiagnostics` must be declared in the client's `initialize` capabilities or `typescript-language-server` never pushes notifications — a silent failure that took a session to debug.

**Planner** (`src/agents/planner.ts`) — explores the codebase with read-only tools and writes a structured `plan.json` to `/tmp/anvil/<sessionId>/plan.json`. Key decision: the Planner has no access to `write_file`. The tool set is filtered at the definition level, not enforced by a prompt instruction that the model could ignore.

**Executor** (`src/agents/executor.ts`) — implements the approved plan, routing every write through the shadow workspace. Key decision: file reads are scoped to the paths listed in `plan.filesToModify` and `plan.filesToCreate` — enforced by resolving absolute paths and checking a Set before the tool executes. The Executor cannot read files it wasn't told about.

**Orchestrator** (`src/agents/orchestrator.ts`) — classifies the incoming request and coordinates the other agents. Key decision: complexity is determined by a keyword heuristic plus a distinct file path count; requests that match neither go directly to the Executor, skipping the Planner and the approval gate.

**TUI** (`src/ui/`) — built with Ink (React for CLIs). Key decision: agents emit typed `UIEvent` objects to a global `EventEmitter`; the UI subscribes and renders reactively. No agent calls `process.stdout.write` directly. The plan approval gate (`y`/`n`/`r`) is handled by `useInput` — readline was incompatible with Ink's stdin ownership.

## How it works — a real example

Request: `"Rename the User type to Account across all files"` on a 6-file TypeScript codebase (`test-repo-2/`).

**Planning phase.** The Planner called `ast_search` on the project root to find all type declarations, then `find_symbol` on `User` to get its definition site and every reference. `find_symbol` uses LSP's `textDocument/definition` and `textDocument/references` — it came back with 19 references across 3 files. The Planner then called `read_file` with the specific line ranges around those references, never reading a whole file. Total: 6 tool calls. The resulting plan named `types.ts`, `db.ts`, and `auth.ts` as the files to modify, with ordered steps for each.

**Execution phase.** The Executor received the approved plan and worked through each file:

- `types.ts`: renamed `User` to `Account` in the type definition. Shadow workspace checked it — clean. Committed on attempt 1.
- `db.ts`: renamed the type reference and return annotations. Shadow workspace rejected attempt 1 with 2 type errors (a function parameter and a generic constraint that hadn't been updated). The Executor read the diagnostic output, corrected both, and resubmitted. Clean on attempt 2. Committed.
- `auth.ts`: updated the import and function signatures. Clean on attempt 1. Committed.

During this task, the shadow workspace also caught a pre-existing bug: `all.size` on an array (should be `all.length`) that happened to be adjacent to a renamed reference. The type error surfaced in the diagnostics; the Executor fixed it as part of the retry.

Final output: `[Anvil] Done: Renamed User to Account in types.ts, db.ts, and auth.ts. Fixed incidental type error in db.ts during shadow validation.`

## Shadow Workspace

Cursor implements its shadow workspace as a hidden VS Code window with full language server state. Edits are applied to this shadow window first; the editor's LSP integration sees them immediately and pushes diagnostics back. Cursor also has a fine-tuned Fast Apply model (~70B parameters) that applies diffs at roughly 1000 tokens per second, and it can intercept the terminal to read compiler output natively. The inline diff rendering and the shadow validation are unified at the editor level.

Anvil does the same thing at the filesystem level. When the Executor proposes an edit, `shadowWrite` copies the target file to `/tmp/anvil/<sessionId>/shadow/<filepath>`, applies the new content, then opens the shadow path in a `typescript-language-server` subprocess via JSON-RPC. The edit is sent as a `textDocument/didChange` notification; the server responds with `textDocument/publishDiagnostics`. If errors come back, they go to the Executor as tool output and the real file is never touched.

The critical implementation detail: `publishDiagnostics` is a server-push notification, not a response to a request. If the client doesn't declare `{ textDocument: { publishDiagnostics: { relatedInformation: true } } }` in its `initialize` capabilities, `typescript-language-server` silently omits the notifications. Every diagnostic check returns clean regardless of actual errors. This took the better part of a session to find.

Every shadow cycle — the proposed content (first 300 chars), the diagnostics, and the outcome — is written to `/tmp/anvil/<sessionId>/shadow.log` as newline-delimited JSON. After a complex task, this log shows exactly what the agent tried, what the compiler rejected, and how it corrected itself.

## Getting started

**Install**

```bash
npm install -g anvil-agent
export ANTHROPIC_API_KEY=your_key_here
```

**Initialize a project**

```bash
cd your-project
anvilai init         # interactive setup: languages, ignore dirs, test command
anvilai doctor       # verify everything is installed and configured
```

**Run**

```bash
anvilai "<request>" <path/to/workdir>
```

Examples:

```bash
anvilai "Add a JSDoc comment to fetchUser" ./my-project
anvilai "Rename the User type to Account across all files" ./my-project
```

For complex multi-file requests, Anvil will run the Planner first and show you the full plan before asking `y / n / revise`.

**Slash commands**

After `anvilai init`, three starter commands are available in `.anvil/commands/`:

```bash
anvilai /review .              # review codebase for bugs and type issues
anvilai /document src/auth.ts  # add JSDoc to exported functions
anvilai /test .                # write unit tests for uncovered functions
anvilai --commands             # list all available slash commands
```

**Config**

```bash
anvilai config list                        # show all settings
anvilai config set model claude-opus-4-7   # change the model
anvilai config get model                   # read a single value
```

**Alternative: run from source**

```bash
git clone https://github.com/arpjw/anvil.git
cd anvil
npm install
export ANTHROPIC_API_KEY=your_key_here
npx tsx src/index.ts "<request>" <path/to/workdir>
```

## Project structure

```
src/
  index.ts                     CLI entrypoint, renders Ink app
  agent.ts                     thin entry point, delegates to orchestrator
  agents/
    orchestrator.ts            session coordinator, complexity classifier
    planner.ts                 read-only subagent, produces plan.json
    executor.ts                write subagent, scoped to plan files only
    loop.ts                    shared streaming tool-use loop (all subagents use this)
  tools/
    read_file.ts               direct file read with optional line range
    list_files.ts              directory traversal with glob patterns
    text_search.ts             ripgrep subprocess for pattern search
    ast_search.ts              tree-sitter queries (functions, classes, imports, types)
    find_symbol.ts             LSP definition lookup + all references
    write_file.ts              shadow-mediated writes with retry counter
    index.ts                   tool registry, definitions, and dispatcher
  lsp/
    client.ts                  JSON-RPC LSP client over stdin/stdout, singleton per workdir
  treesitter/
    index.ts                   tree-sitter query runner (TypeScript + Python grammars)
  shadow/
    workspace.ts               shadow copy → didChange → publishDiagnostics → commit loop
    test.ts                    integration test: broken edit → shadow rejects → self-corrects
  ui/
    stream.ts                  typed UIEvent emitter, waitForApproval/resolveApproval bridge
    App.tsx                    root Ink component: header, two-panel layout, approval gate
    components/
      ToolCall.tsx             amber tool name, braille spinner, result preview
      ShadowCycle.tsx          shadow[N/3] → validating → committed / retrying
      PlanDisplay.tsx          full plan with all 7 fields, shown before approval
      StatusBar.tsx            model · phase · elapsed time
```

## Writeup

For a deep dive into the architecture and design decisions — why agentic retrieval beats one-shot RAG for cross-file tasks, how the shadow workspace feedback loop works at the filesystem level, and what changes with editor-level access — read the full technical writeup: [coming soon].
