# Anvil

A terminal AI coding agent that validates every change through a TypeScript language server before writing it to disk.

```bash
npm install -g anvil-agent
anvilai "Rename the User type to Account across all files" ./my-project
```

---

## What makes it different

Most coding agents write files and hope for the best. Anvil runs every proposed edit through `typescript-language-server` in a shadow copy of your project first. If the edit introduces type errors, the agent reads the diagnostics, self-corrects, and retries — your real files are never touched until the change is clean.

The context layer is agentic rather than one-shot. Instead of loading the whole codebase into the prompt, Anvil uses AST queries (tree-sitter), LSP symbol lookup, and an embedding-backed `semantic_search` to find exactly what it needs — the definition site of a type, the files that import it, or the region of code that best matches a fuzzy question like "where is the retry logic". A cross-file rename typically takes 6–8 targeted reads, not a full directory dump. The semantic index is built at session start (Voyage-3 when `VOYAGE_API_KEY` is set, TF-IDF cosine similarity otherwise — no external service required).

For multi-file tasks, Anvil runs a Planner subagent first. You see the full plan — which files change, in what order, and why — before any writes happen. Approve, reject, or revise before a single line changes.

After execution, the ValidationEngine runs a four-phase sweep — type check, lint, tests, and any custom `VALIDATE:` commands you've declared in `.anvil/rules.md`. Failures come back as a structured fix plan that the executor uses for up to two auto-fix rounds. Each session is also committed on a new git branch per-file, so every change is reversible with a single command.

You can watch the full session progress through a 10-phase workflow indicator in the TUI: Initializing → Exploring → Planning → Awaiting approval → Branching → Executing → Verifying → Fixing → Committing → Complete.

---

## Install

Three paths — pick one:

**npm (recommended)**

```bash
npm install -g anvil-agent
```

Requires Node 18+. TypeScript language server is bundled.

**Compiled binary (no Node required)**

```bash
# macOS arm64
curl -L https://github.com/arpjw/anvil/releases/latest/download/anvilai-darwin-arm64 -o anvilai && chmod +x anvilai && sudo mv anvilai /usr/local/bin/

# macOS x64 / Linux x64 / Windows: swap the filename above
```

Built with `bun build --compile`. Zero runtime dependencies — the binary boots faster than the Node CLI.

**From source**

```bash
git clone https://github.com/arpjw/anvil.git && cd anvil
npm install
npx tsx src/index.ts "<request>" <path/to/workdir>
```

Verify the install:

```bash
anvilai --version
anvilai doctor
```

**Set your API key.** Anvil supports Claude, GPT, Gemini, and Moonshot. On first run, an interactive picker lets you select a model — it will tell you which environment variable to set.

```bash
export ANTHROPIC_API_KEY=...   # Claude Sonnet 4.6 (default), Opus 4.8 / 4.7 / 4.6, Haiku 4.5
export OPENAI_API_KEY=...      # GPT-4o, GPT-4o mini, o3, o4-mini
export GEMINI_API_KEY=...      # Gemini 2.5 Pro, Gemini 2.5 Flash
export MOONSHOT_API_KEY=...    # Moonshot v1 (8K / 32K / 128K context)
```

---

## Usage

**Initialize a project**

```bash
cd your-project
anvilai init      # interactive setup: languages, ignore dirs, test command, style rules
anvilai doctor    # verify configuration and tool availability
```

**Run a task**

```bash
anvilai "<request>" [path/to/workdir]
```

```bash
anvilai "Add JSDoc to all exported functions in src/auth.ts" ./my-project
anvilai "Rename the User type to Account across all files" ./my-project
anvilai "Extract the validation logic in submitOrder into a pure function" ./my-project
```

For simple single-file tasks, Anvil skips the planner and executes directly. For complex multi-file requests, it runs the Planner first and shows the full plan before prompting `y / n / revise`.

**Slash commands**

After `anvilai init`, three starter commands are available in `.anvil/commands/`. These are plain `.md` files — edit them or add your own.

```bash
anvilai /review .              # scan codebase for bugs and type issues
anvilai /document src/auth.ts  # add JSDoc to exported functions
anvilai /test .                # write unit tests for uncovered functions
anvilai --commands             # list all available slash commands
```

**Flags**

```
--model <id>             Select model directly, skip interactive picker
--dry-run                Plan only — print the plan, do not execute
--no-verify              Skip the post-execution verification pass
--headless               No TUI — outputs JSON result to stdout (for CI)
--image <filepath>       Attach an image as context (PNG/JPG/WebP/GIF)
--resume <sessionId>     Resume a previously interrupted session
--rollback <sessionId>   Revert all file changes from a session
--commands               List available slash commands
--version                Print the installed anvil-agent version
```

**Config**

```bash
anvilai config list                          # show all settings
anvilai config set model claude-opus-4-8     # switch model
anvilai config set autoBranch false          # disable per-session git branching
anvilai config set autoVerify false          # disable verification pass
anvilai config get model                     # read a single value
```

---

## How it works

**1. Classify.** The Orchestrator decides whether the request is simple (single-file, single concept) or complex (multi-file, cross-cutting). Simple tasks skip the planner and execute immediately.

**2. Plan.** For complex tasks, the Planner uses read-only tools — `ast_search`, `find_symbol`, `semantic_search`, `text_search`, `read_file` — to map the codebase and produce a structured plan: which files to touch, in what order, and what each change accomplishes. `semantic_search` is backed by a session-local embedding index kicked off at plan start (Voyage-3 if `VOYAGE_API_KEY` is set, TF-IDF fallback otherwise).

**3. Approve.** The plan is displayed in the TUI. Type `y` to proceed, `n` to cancel, or `r` to revise with a follow-up instruction.

**4. Branch.** If `autoBranch` is enabled (default), Anvil creates a `anvil/<sessionId>` git branch before any writes. Each file is committed individually as it's completed.

**5. Execute.** The Executor works through the plan. Every `write_file` call goes through the shadow workspace:

```
propose edit
  → copy file to /tmp/anvil/<session>/shadow/
  → send textDocument/didChange to typescript-language-server
  → wait for publishDiagnostics
  → clean? commit to real file : send diagnostics back to agent, retry
```

Each shadow cycle is logged to `/tmp/anvil/<session>/shadow.log` as newline-delimited JSON.

**6. Verify.** The ValidationEngine runs a four-phase sweep against the working tree: type check (`tsc --noEmit` / `mypy` / `cargo check`), lint (ESLint or pylint), test suite (auto-detected — jest, vitest, pytest, cargo, go), and any custom shell commands declared in `.anvil/rules.md` as `VALIDATE: <cmd>`. Failures are grouped by phase and turned into a fix plan that the Executor consumes for up to two auto-fix rounds. Clean verification is required for the session to land in memory and generate a PR description.

**7. Memory.** A summary of what changed is appended to `.anvil/memory.md` so future sessions have context on what was done and why.

**Rollback.** If a session goes wrong, `--rollback <sessionId>` uses git to restore every file the session touched.

**Phase visibility.** Every checkpoint above emits a `phase_transition` UIEvent, and the TUI shows a live `Phase N/10: Label` indicator. In headless / cloud runs, these events forward to whatever's consuming the stream — the CLI, the JSON output, or the hosted dashboard.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                    TUI                      │
│  Ink · event stream · 10-phase workflow bar │
├─────────────────────────────────────────────┤
│                 Orchestrator                │
│  complexity classifier · workflow phases    │
├──────────────────────┬──────────────────────┤
│       Planner        │       Executor       │
│   read-only tools    │   shadow-mediated    │
├──────────────────────┴──────────────────────┤
│              Shadow Workspace               │
│       propose → LSP validate → commit       │
├──────────────────────┬──────────────────────┤
│  EmbeddingService    │  ValidationEngine    │
│  session index       │  typecheck · lint    │
│  voyage-3 / TF-IDF   │  · tests · custom    │
├──────────────────────┴──────────────────────┤
│              Context Engine                 │
│  read_file · ast_search · find_symbol       │
│  · semantic_search · text_search · git_*    │
└─────────────────────────────────────────────┘
```

| Component | Source | Role |
|---|---|---|
| Orchestrator | `src/agents/orchestrator.ts` | Classifies requests, coordinates subagents, drives the 10-phase workflow |
| Planner | `src/agents/planner.ts` | Read-only exploration, produces `plan.json`; kicks off embedding indexing |
| Executor | `src/agents/executor.ts` | Applies plan, all writes shadow-mediated |
| Shadow Workspace | `src/shadow/workspace.ts` | LSP validation gate before disk commit |
| Context Engine | `src/tools/`, `src/lsp/`, `src/treesitter/` | AST queries, symbol lookup, semantic + text search, git tools |
| EmbeddingService | `src/services/embedding/` | Session-scoped semantic index (Voyage-3 or TF-IDF fallback) powering `semantic_search` |
| ValidationEngine | `src/services/validation/` | Sequential typecheck → lint → tests → custom rules; produces structured fix plans |
| Verifier | `src/execution/verifier.ts` | Runs the ValidationEngine and coordinates auto-fix rounds |
| WorkflowPhase | `src/agents/workflow.ts` | 10-phase state machine + `phase_transition` events |
| TUI | `src/ui/` | Ink/React interface, plan approval gate, diff review, phase indicator |

---

## Run from source

```bash
git clone https://github.com/arpjw/anvil.git
cd anvil
npm install
export ANTHROPIC_API_KEY=your_key_here
npx tsx src/index.ts "<request>" <path/to/workdir>
```

Optional env vars are documented in [`.env.example`](.env.example) — most notably `VOYAGE_API_KEY` to enable Voyage-3 embeddings for `semantic_search` (TF-IDF fallback otherwise).

---

## Hosted / cloud

The same agent runs in a hosted control plane under [`cloud/`](cloud/):

- **Control plane** (`cloud/control-plane/`) — Bun + Hono API, Postgres via Drizzle, Redis pub/sub for SSE, Clerk auth, Stripe metered billing, Octokit-based GitHub integration.
- **VM runtime** (`cloud/vm/`) — Docker / Firecracker driver, in-VM agent that forwards every `UIEvent` (including `phase_transition`) back to the control plane over a websocket.
- **Dashboard** (`cloud/dashboard/`) — Next.js 16 + Clerk 6 + Tailwind v4. Live SSE session view, plan approval, per-file diff review, one-click "Open PR", billing / usage page, and a waitlist landing.

See [`cloud/README.md`](cloud/README.md) for local dev + deploy setup and [`cloud/docs/api.md`](cloud/docs/api.md) for the full API reference.

---

## Technical writeup

A deep dive into the shadow workspace implementation, why agentic retrieval outperforms one-shot RAG on cross-file tasks, and how Cursor's architecture maps to what Anvil does at the filesystem level: [coming soon].
