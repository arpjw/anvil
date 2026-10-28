# Isolated execution and atomic edit batches

## Run and review a session

Start at a Git repository root with all intended source changes committed. Anvil refuses tracked staged or unstaged changes in a new isolated session; untracked code and dependencies are not copied. Local rules, ignore patterns, and memory are copied as regular files. Provider credentials and `.env` files are not copied unless you have committed them into Git yourself.

```bash
anvilai "Rename the parser interface across all files" ./project
# For unattended runs, explicitly authorize shell commands and verification:
anvilai --headless --allow-commands "Fix the parser test" ./project > result.json
```

The terminal displays the execution directory. JSON results include `sourceWorkdir`, `workdir`, `isolation`, `branchName`, `baseCommit` in saved history, and `commitHash`. Worktrees and metadata live under the repository's common Git directory in `anvil/worktrees/` and `anvil/sessions/`. These persist until you remove them deliberately using Git's worktree commands.

Each session starts from the source HEAD. Commands and checks run inside the worktree. Install dependencies there with an approved command such as `npm ci` if needed. Anvil never links a writable execution dependency directory back to the source. Local Git hooks and signing are suppressed for Anvil's automatic creation/commit operations.

With automatic commits enabled, a successful session produces one commit containing project modifications, additions, and deletions, including nonignored shell changes. An explicit verification skip can also finish a session; inspect the result's verification status. Failure and cancellation preserve edits without a final commit. Setting `autoBranch=false` keeps the worktree but disables its automatic final commit.

Review and integrate from your source checkout:

```bash
git show COMMIT_HASH
git cherry-pick COMMIT_HASH
```

Anvil does not merge, push, or replace your source checkout. Its source `.anvil/` does receive session history and usage metadata. Use `--no-isolate` only when you deliberately want in-place execution, including non-Git projects. Resume from the source project with `--resume SESSION_ID`; it reopens the saved worktree. Undo/rollback commands operate on the execution directory shown in the result. Rollback leaves the session branch available as a recovery point and refuses dirty tracked work.

## Command and cancellation policy

Interactive sessions ask for each shell invocation, including package installation, tests, lint, and custom validation commands. `--allow-commands` allows those commands for the run. Headless runs otherwise return a failure when a required command is denied; they do not turn denial into a passing check or ask a model to repair it.

The library exposes `commands: 'ask' | 'allow' | 'deny'` and `isolation: 'worktree' | 'none'`. Callers using `ask` must handle `command_approval_needed` and resolve its invocation ID. Cloud sessions explicitly use the VM's existing workspace with commands enabled.

Command environments keep only PATH, HOME, USER, LOGNAME, LANG, LC_ALL, temporary-directory variables, and Windows shell variables. API keys are not automatically forwarded. Approved programs still have your filesystem and network permissions, can read user configuration, and can address paths outside the worktree. This is a checkout boundary, not a container or hostile-code sandbox. Run untrusted code inside a separately configured VM/container.

Ctrl-C or a library AbortSignal cancels model requests, command execution, and pending plan/hunk/command approvals. Unix command process groups are terminated, including remaining background children; persistent background servers are unsupported. Windows does not provide equivalent descendant containment here. Synchronous compilation/filesystem steps observe cancellation when they return. A second Ctrl-C forces exit and may bypass session-result persistence.

## Multi-file transactions

The model can call:

```json
{
  "edits": [
    {"path": "src/old.ts", "content": null},
    {"path": "src/new.ts", "content": "export const value = 1;\n"},
    {"path": "src/use.ts", "content": "export { value } from './new';\n"}
  ]
}
```

`write_files` snapshots the project and stages all edits before validation. TypeScript checks use the root configuration, affected nested packages, and project references. Without a configuration, changed TS/JS files and their imports are checked. JSON edits receive syntax checking. Other languages rely on final project checks. Existing type errors can block a batch; scripts are not executed inside the staging area. Installed dependencies are available to the compiler through a staging link, which is not used as an execution sandbox.

Review each file's hunks, including empty-file creation/deletion. Rejecting a whole file rejects the whole batch. Partial hunk selection triggers validation of the selected combined result. Deletions must be accepted in full. Source fingerprints and original-content checks reject a proposal if project files changed during review.

The tool supports 1–100 UTF-8 text edits, up to 8 MiB of proposed content, and snapshots up to 20,000 files / 100 MiB. It excludes `.git`, `.anvil`, `node_modules`, and `.env*` from the project snapshot. It rejects writable symlink aliases, binary edits, dependency/state edits, and compiler source/project references outside the staged project. Dependency contents are not fingerprinted, so keep installed dependencies stable during review.

All selected edits either finish or ordinary application failures trigger rollback. A journal outside the project records originals and proposed contents before writes. The next session or transaction invocation recovers an interrupted apply. Recovery preserves conflicting external edits and reports the journal path rather than overwriting them. A process lease prevents concurrent Anvil transactions on the same workspace.

“Atomic” here means the batch's tool-level success/rollback contract. File replacements happen sequentially, so an external watcher can observe intermediate files. Journals and leases live in the OS temporary directory and are not fsync-backed; this is not a power-loss durability guarantee, and OS cleanup can remove recovery data. A crash during stale-lease reclamation may require inspecting/removing the reported `.reclaim` directory after confirming no owner is active. Use Git for durable recovery points.

Cloud VMs use the same batch tool. Dashboard approval happens later and may select a different subset; that subset is not automatically revalidated. PR publication still applies approved files through sequential GitHub API commits, with deletion handled explicitly. Atomic remote branch publication and transaction-group review are separate future work.
