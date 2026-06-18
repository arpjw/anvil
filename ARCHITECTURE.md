# Anvil — Architecture

> The permanent technical reference. Describes what exists, not what is planned.
> Update this file when a layer is built or a decision is made. Never speculative.

---

## Overview

Anvil is a terminal-based AI coding agent written in TypeScript. It replicates the core architectural innovations that make Cursor effective — shadow workspace validation, agentic context retrieval, and a planner/executor subagent split — outside of an IDE, at the filesystem level.

A user request flows through five layers in sequence:

```
User Request
     │
     ▼
┌─────────────────────┐
│     Orchestrator    │  main agent loop, global state, todo list
└────────┬────────────┘
         │ spawns
    ┌────┴──────┐
    ▼           ▼
┌────────┐  ┌──────────┐
│Planner │  │ Executor │
└───┬────┘  └────┬─────┘
    │             │ writes to shadow first
    ▼             ▼
┌──────────────────────┐
│   Shadow Workspace   │  temp copy → LSP diagnostics → commit or retry
└──────────┬───────────┘
           │ tools
           ▼
┌──────────────────────┐
│   Context Engine     │  read_file, list_files, text_search, find_symbol, ast_search
└──────────────────────┘
```

---

## Layer 1: Orchestrator

The main agent loop. Single instance per session.

**Responsibilities:**
- Receive user request
- Decide: plan-first (complex, multi-file) or execute-directly (simple, single-file)
- Spawn Planner and Executor subagents
- Own the todo list — no subagent touches it
- Hold global session state
- Present plan to user for approval before execution begins
- Handle subagent errors and retries at the session level

**Tool access:** all tools except file write (delegates writes to Executor)

**State shape:**
```typescript
type OrchestratorState = {
  sessionId: string
  request: string
  plan: Plan | null
  todos: Todo[]
  status: 'planning' | 'awaiting_approval' | 'executing' | 'done' | 'error'
}
```

---

## Layer 2: Planner Subagent

Explores the codebase and produces a structured plan. Spawned by Orchestrator.

**Responsibilities:**
- Explore codebase using read-only context engine tools
- Identify relevant files, symbols, and dependencies
- Write a structured plan to `/tmp/anvil/<sessionId>/plan.json`
- Return plan path to Orchestrator

**Tool access:** `read_file`, `list_files`, `text_search`, `find_symbol`, `ast_search` — no write access

**Plan format:**
```typescript
type Plan = {
  goal: string
  context: string                // what the planner found and why it matters
  filesToModify: string[]
  filesToCreate: string[]
  steps: string[]
  verificationCriteria: string[]
  risks: string[]
}
```

---

## Layer 3: Executor Subagent

Takes an approved plan and applies edits. Spawned by Orchestrator after plan approval.

**Responsibilities:**
- Read the approved plan
- Apply edits via the shadow workspace (never directly to real files)
- Receive diagnostic feedback and self-correct (max 3 passes per file)
- Commit clean edits to the real filesystem
- Report results to Orchestrator

**Tool access:** `write_file` (shadow-mediated), `read_file` (scoped to plan files only) — no broad codebase access

---

## Layer 4: Shadow Workspace

Validates every edit before it touches the real filesystem.

**Mechanism:**
1. Executor proposes an edit to a file
2. Shadow workspace copies the file to `/tmp/anvil/<sessionId>/shadow/<filepath>`
3. Edit is applied to the shadow copy
4. Relevant language server is spawned against the shadow copy
5. Diagnostics are collected (errors, warnings)
6. If clean → edit commits to real file, shadow copy deleted
7. If errors → diagnostics returned to Executor for another pass
8. After 3 failed passes → escalate to Orchestrator

**Supported language servers:**
- TypeScript: `typescript-language-server`
- Go: `gopls`
- Python: `pylsp`

**Session log:** every shadow cycle is logged to `/tmp/anvil/<sessionId>/shadow.log` — proposal, diagnostics, outcome.

---

## Layer 5: Context Engine

The retrieval layer. Called by Planner and Orchestrator. Retrieval is agentic — iterative exploration, not one-shot RAG.

**Tools:**

| Tool | Implementation | Description |
|------|---------------|-------------|
| `read_file` | fs | Direct file read with optional line range |
| `list_files` | glob | Directory traversal with pattern matching |
| `text_search` | ripgrep subprocess | Fast pattern search across codebase |
| `find_symbol` | LSP `textDocument/definition` + `references` | Where a symbol is defined and used |
| `ast_search` | tree-sitter | Query by node type (functions, classes, imports) |

**Vector index:** SQLite + sqlite-vec. File chunks embedded at project init, used for semantic search when keyword search is insufficient. Rebuilt on file change.

---

## Data Flow: End to End

```
1. User: "add retry logic to the HTTP client"
2. Orchestrator: complex request → spawn Planner
3. Planner: ast_search for HTTP client → find_symbol for request function
         → text_search for error handling patterns → write plan.json
4. Orchestrator: present plan to user → user approves
5. Orchestrator: spawn Executor with plan
6. Executor: read plan → propose edit to http_client.ts
7. Shadow Workspace: copy file → apply edit → run tsc --noEmit
         → 1 type error → return to Executor
8. Executor: fix type error → re-propose
9. Shadow Workspace: clean → commit to real file
10. Executor: report done → Orchestrator: session complete
```

---

## Key Design Decisions

**Why TypeScript:** Cursor's stack is TypeScript. Staying in the same language ecosystem is deliberate alignment with the target audience for this project.

**Why not RAG:** One-shot vector search doesn't handle cross-file dependencies. The Planner uses iterative agentic retrieval — it decides what to look up based on what it finds.

**Why subagent tool isolation:** The Executor has no broad read access. It sees only what the Planner surfaced. This keeps context tight and prevents the Executor from contaminating its own context window with irrelevant code.

**Why shadow workspace at the filesystem level:** Cursor implements this as a hidden VS Code window. Without editor-level access, the equivalent is: temp file + LSP subprocess + diagnostic feedback loop. Same principle, different substrate.
