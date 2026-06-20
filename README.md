# Anvil

A terminal AI coding agent that validates every change through a TypeScript language server before writing it to disk.

```bash
npm install -g anvil-agent
anvilai "Rename the User type to Account across all files" ./my-project
```

---

## What makes it different

Most coding agents write files and hope for the best. Anvil runs every proposed edit through `typescript-language-server` in a shadow copy of your project first. If the edit introduces type errors, the agent reads the diagnostics, self-corrects, and retries — your real files are never touched until the change is clean.

The context layer is agentic rather than one-shot. Instead of loading the whole codebase into the prompt, Anvil uses AST queries (tree-sitter) and LSP symbol lookup to find exactly what it needs: the definition site of a type, the files that import it, the lines around each reference. A cross-file rename typically takes 6–8 targeted reads, not a full directory dump.

For multi-file tasks, Anvil runs a Planner subagent first. You see the full plan — which files change, in what order, and why — before any writes happen. Approve, reject, or revise before a single line changes.

After execution, Anvil runs a verification pass: it re-runs your configured test command and checks for type errors. If the verification fails, it attempts to self-correct. Each session is also committed on a new git branch per-file, so every change is reversible with a single command.

---

## Install

```bash
npm install -g anvil-agent
```

Requires Node 18+. The TypeScript language server is bundled and does not need a separate install.

**Set your API key.** Anvil supports Claude, GPT, Gemini, and Moonshot. On first run, an interactive picker lets you select a model — it will tell you which environment variable to set.

```bash
export ANTHROPIC_API_KEY=...   # Claude Sonnet 4.6 (default) or Opus 4.8
export OPENAI_API_KEY=...      # GPT-5.5, GPT-5.5 Pro, GPT-5.4
export GEMINI_API_KEY=...      # Gemini 3.5 Flash, Gemini 3.1 Pro
export MOONSHOT_API_KEY=...    # Kimi K2.6, Kimi K2.7 Code
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

**2. Plan.** For complex tasks, the Planner uses read-only tools — `ast_search`, `find_symbol`, `read_file` — to map the codebase and produce a structured plan: which files to touch, in what order, and what each change accomplishes.

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

**6. Verify.** After execution, Anvil runs your configured test command and checks for remaining type errors. If verification fails, it attempts to fix the failures before reporting done.

**7. Memory.** A summary of what changed is appended to `.anvil/memory.md` so future sessions have context on what was done and why.

**Rollback.** If a session goes wrong, `--rollback <sessionId>` uses git to restore every file the session touched.

---

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

| Component | Source | Role |
|---|---|---|
| Orchestrator | `src/agents/orchestrator.ts` | Classifies requests, coordinates subagents, manages git branch |
| Planner | `src/agents/planner.ts` | Read-only exploration, produces `plan.json` |
| Executor | `src/agents/executor.ts` | Applies plan, all writes shadow-mediated |
| Shadow Workspace | `src/shadow/workspace.ts` | LSP validation gate before disk commit |
| Context Engine | `src/tools/`, `src/lsp/`, `src/treesitter/` | AST queries, symbol lookup, file reads |
| Verifier | `src/execution/verifier.ts` | Post-execution test and type-check pass |
| TUI | `src/ui/` | Ink/React interface, plan approval gate |

---

## Run from source

```bash
git clone https://github.com/arpjw/anvil.git
cd anvil
npm install
export ANTHROPIC_API_KEY=your_key_here
npx tsx src/index.ts "<request>" <path/to/workdir>
```

---

## Technical writeup

A deep dive into the shadow workspace implementation, why agentic retrieval outperforms one-shot RAG on cross-file tasks, and how Cursor's architecture maps to what Anvil does at the filesystem level: [coming soon].
