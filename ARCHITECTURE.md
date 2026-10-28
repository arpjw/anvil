# Anvil architecture

## Execution path

`src/index.ts` parses commands and selects the terminal or headless interface. `src/api.ts` exports the orchestration API for the VM runtime without starting the CLI. There is one active session per process because the event stream and language-server manager are shared.

`runOrchestrator` loads project context, classifies the request, and runs the planner for larger tasks. A plan contains a goal, context, file lists, ordered steps, verification criteria, and risks. Approval can accept, reject, or supply revision feedback. Simple requests use a minimal plan and the same execution and verification lifecycle.

The executor receives the chosen client, model, and budget. Its file tools are restricted to a nonempty approved file list. It must call `done` and have no unresolved write failures to report completion. That signal ends execution only; the orchestrator still runs project verification and any repair rounds before emitting terminal success.

## Edit gate

`src/shadow/workspace.ts` stores proposals and logs under `/tmp/anvil/<session-id>/`. TypeScript/JavaScript use an in-memory language-server document view, JSON uses syntax checking, and other formats defer to project validation. LSP frames use UTF-8 byte lengths. Diagnostics are version filtered where the server provides versions; versionless notifications use a settling interval. Missing responses and server failure reject validation.

Hunk review applies the selected patch with the `diff` package and revalidates the result. The real document view is restored after the proposal. `commitContent` checks the expected original content and existence, writes a temporary sibling file, then renames it into place. Successful writes have separate audit records containing a SHA-256 digest. Validation alone does not create a committed audit record.

Workspace guards reject file writes outside the repository, symlink escapes, and `.git` edits. These guards apply to file tools, not the general shell tool. This is a document validation gate, not a fully isolated workspace or a multi-file transaction.

## Verification and persistence

`ValidationEngine` reports typecheck, lint, tests, and custom checks independently, including command, duration, status, and skip reason. A nonzero exit remains a failure even when a diagnostic parser cannot understand the output. The verifier builds repair plans for up to two rounds. No discovered checks means skipped verification, not passing verification.

Structured session results are atomically saved under `.anvil/sessions/`; conversation and usage records are saved separately. Plans are workspace-bound in temporary storage. Resume rereads the original plan against current files. Completion, failure, and cancellation are distinct events; terminal success is emitted only after execution and verification policy finish.

When automatic branching is enabled, the starting branch and exact commit are recorded. The tracked worktree must be clean. Files recorded by `write_file` are committed individually after verification, excluding unrelated staged changes. Undo uses the recorded base commit; rollback refuses dirty tracked work and retains the session branch. Edits made directly through shell commands do not have the same file-event accounting and should be reviewed in Git.

## Context and tools

The context layer combines file and text reads, tree-sitter queries, LSP symbol navigation, project rules, conversation history, and semantic search. Semantic indexing uses Voyage when configured and local TF-IDF otherwise. Tree-sitter grammar initialization is lazy and native failures are reported. Command output has bounded retained and streamed buffers; timeouts return failure.

## Cloud path

The control plane is Bun/Hono with Postgres, Redis, Clerk, and GitHub adapters. It selects the provider key before queuing a session. A VM receives setup instructions, clones the branch, and imports the built library. Git credentials are passed only to the clone process, not embedded in the remote URL. Cloud runs disable local automatic branching; PR creation is an explicit control-plane action after completion and diff review.

Runtime messages are serialized through the event relay. Persistent activity has stable IDs for replay. Ordinary tool warnings do not fail the session; explicit terminal failures do. Plans are persisted independently of the bounded replay window. Repeated edits to a file preserve its initial content, update its final diff, and reset approval. VM absolute paths are normalized before use in GitHub operations.

The dashboard merges replay and live events, bounds the visible history, exposes reconnect failures, and closes terminal streams. It provides plan approval/revision, diff review, status filters, activity search, and a clearly labeled no-services preview at `/demo`.

Cloud phase checkpoints are observational metadata. The legacy `/resume` route now retries from the source branch in a new session and returns `recovery: "fresh_checkout"`; it does not restore a VM snapshot. Tests cover the in-memory service contracts, not production database concurrency, provider behavior, VM isolation, or end-to-end billing.
