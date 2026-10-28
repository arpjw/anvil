# Upgrade notes

This source upgrade strengthens the terminal agent first and connects it to the cloud workspace. Publishing these source changes does not publish an npm release or deploy the cloud services.

## Isolated execution and multi-file transactions

Terminal sessions now default to persistent Git worktrees, with per-command approval, explicit headless command opt-in, cancellation, source-checkout preservation, and one final session commit. The new `write_files` tool validates related creates/updates/deletions together and provides rollback plus interrupted-apply recovery. Cloud PR publishing now preserves deletions. Read [the feature guide](docs/isolated-execution.md) before relying on the isolation or atomicity guarantees.

## Delivered

- A working Node 22 build, bundled TypeScript language server, library entry point, compatible tree-sitter grammars, and dependency updates.
- Validation that rejects missing diagnostics and process failures, correct UTF-8 LSP framing, partial-hunk revalidation, preserved file endings, workspace write guards, and conflict-aware atomic writes.
- One lifecycle for simple and planned tasks, verification before completion, explicit failed/cancelled/skipped outcomes, recovery plans, session result history, strict CLI arguments, JSON/NDJSON output, standalone `verify`, and bounded command logs.
- Git recovery against the actual starting commit, refusal to discard dirty tracked work, and commits that exclude unrelated staged files.
- A responsive cloud workspace with plans, revisions, changes, searchable/filterable activity, reconnect handling, log export, session list filters, and a no-services preview.
- Cloud fixes for model-key selection, disconnected approvals, event ordering, stable replay IDs, persisted plans, final diff updates, explicit PR creation, and fresh retries that preserve failed-session records.
- Credential-free CI covering the engine, API, runtime build, and dashboard. The optional AI workflow is manual and exports a patch without pushing it.

## Validation performed locally

- Terminal: build, strict typecheck, ESLint, and 68 regression tests, including a real bundled TypeScript language-server subprocess and real temporary Git repositories.
- Control plane: typecheck and 115 tests using in-memory service adapters.
- Dashboard: typecheck, 4 event regression tests, and an optimized production build; browser checks of plan/changes tabs, scenario switching, activity search/filtering, and mobile layout at 390px.
- VM runtime: TypeScript build, package import compatibility, and a WebSocket startup/cancellation regression test. Evaluation harness: typecheck; no paid benchmark run.
- Dependency audits: no reported vulnerabilities in the terminal package, dashboard, or runtime at the time checked. One moderate advisory remains in the control plane's Drizzle development tooling through legacy esbuild. No major-version override was forced into that toolchain.

## Limits that remain

No paid model call, deployed cloud session, real database migration, GitHub PR creation, Stripe transaction, Docker image build, or Firecracker run was performed. GitHub CI passed for the foundational upgrade; subsequent changes must pass the same workflow before delivery. The provider model registry and price estimates were not independently re-certified.

The legacy `write_file` gate still validates one document; use `write_files` for cross-file transactions. Batch application uses sequential renames and rollback, not simultaneous visibility to external readers or power-loss durability. Some language servers omit diagnostic versions; those notifications use a settling heuristic. Forced process exits may leave only temporary recovery data rather than a finalized session result. Worktrees are not OS sandboxes. Approved shell commands can access the host and make edits outside the file-tool audit stream. Windows descendant-process containment is not implemented. The budget is an estimate checked after each response, not a hard provider spending limit.

Cloud retry starts from a fresh branch checkout. It does not recover a lost VM filesystem. Cloud event ordering and diff updates are tested within a single process; production multi-instance races, transactional uniqueness, and durable external effects need additional integration work. Live authenticated dashboard flows were not exercised against real services.

## Review locally

Run `npm run build && npm run check` at the root. Run `npm run dev` in `cloud/dashboard` and open `/demo` for the sample workspace. The README contains full CLI and development commands.
