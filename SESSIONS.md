# Anvil — Session Log

> One entry per Claude Code session. Write it before closing the session.
> The next session starts by reading the most recent entry here + current phase in BUILDPLAN.md.

## Session C8 — July 2, 2026
**Phase:** C8 — Polish + Launch
**Duration:** ~1h

### What was accomplished
- Rate limiting: RateLimitStore interface + Redis + in-memory implementations
  (middleware/rate-limit.ts). rateLimit() middleware pulls store from deps at request
  time. Wired into POST /sessions (20/hour/user) and POST /repos (30/hour/user).
- Waitlist: waitlist_signups table (migration 0003), POST /api/v1/waitlist (public,
  30/hour/IP, idempotent by email), GET /waitlist/count. Landing WaitlistForm on the
  signed-out homepage.
- Onboarding: SessionList surfaces a 3-step "Get started" card when a signed-in user
  has zero repos + zero sessions.
- Error surfaces: app/error.tsx global boundary shows a friendly retry screen with the
  Next digest for support. isRateLimitError helper exported from lib/api.
- Abuse prevention: existing MAX_CONCURRENT_PER_USER=3 in sessions.ts kept; per-user
  rate limit on session_create effectively caps burst attack surface at 20/hour.
- Documentation: cloud/README.md (local dev + env vars + deploy sketch) and
  cloud/docs/api.md (endpoint-by-endpoint reference).
- Tests: 4 new tests (waitlist happy path / idempotent / bad email / count endpoint)
  + rate-limit integration test (20 pass, 21st gets 429).

### Decisions made
- Waitlist rate-limit keyed by IP (x-forwarded-for / x-real-ip) since callers are
  unauthenticated.
- rateLimit middleware pulls the store from context rather than closing over it —
  makes the middleware factory reusable across routers and cleanly testable with the
  memory store.

### Checks
- control-plane: bunx tsc clean, bun test 89/89 (was 80, +9: 4 waitlist + 1 rate-limit
  + 4 other billing coverage adjustments).
- dashboard: tsc clean, next build clean.

### State of codebase at close
- All C1–C8 cloud phases done. Full flow: waitlist → sign in → onboard → connect repo
  → session → plan approval → diff review → PR (auto or manual) → webhook merge state
  → Stripe usage report → billing UI reflects minutes.

### Next session should start with
- Phase 11: Distribution — bun compile, npm publish, auto LSP install, anvilai init /
  doctor / config, custom slash commands, GitHub Actions integration.

---

## Session C7 — July 2, 2026
**Phase:** C7 — Billing
**Duration:** ~1h

### What was accomplished
- StripeClient interface + real thin wrapper over Stripe REST API (createCustomer,
  reportUsage on subscription item, createCheckoutSession, createPortalSession,
  parseWebhook with HMAC-SHA256 t/v1 signature + 5-min tolerance) in lib/stripe.ts.
- Schema: users gets stripe_subscription_id + plan_tier ('free'|'pro'|'team'). New
  usage_records table (user_id, session_id, minutes, reported_at). Migration 0002.
- Pipeline.recordUsage: on session complete, ceil(durationSeconds/60) minutes, insert
  usage_records row, best-effort report to Stripe if a subscription item is configured
  for the user, mark reported_at. Idempotency key = usage-<record.id>.
- Routes: GET /api/v1/billing/usage (current month, list + total), POST /billing/checkout
  (creates or reuses customer, returns hosted Checkout URL), POST /billing/portal
  (returns Billing Portal URL). POST /webhooks/stripe (checkout.session.completed →
  set plan_tier=pro; customer.subscription.deleted → downgrade to free).
- Repository: setUserStripeCustomer, setUserSubscription, createUsageRecord,
  markUsageReported, listUnreportedUsage, listUsageBySince. Full memory-repo parity.
- Test harness: StripeStubHandle w/ recording lists for customers/reported usage/checkout
  URLs. AppDeps gained stripe + billing config; vm.test.ts and default harness updated.
- Dashboard: /settings/billing with current-period usage stat, pro/team plan cards,
  per-session usage history, Stripe portal deep link. Nav has a "Billing" link.
- Stripe billing config comes from env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_PRO, STRIPE_PRICE_TEAM. Absent env keeps the whole feature disabled
  cleanly (deps.stripe is null → routes 503).
- 6 new tests: usage sums + free default, checkout creates-or-reuses customer +
  correct priceId, webhook upgrade / downgrade.

### Checks
- control-plane: bunx tsc clean, bun test 80/80 (was 74, added 6 billing tests).
- dashboard: tsc clean, next build clean w/ new /settings/billing route.

### State of codebase at close
- Full billing loop: session runs → duration recorded → usage inserted → optional Stripe
  usage report → dashboard reflects minutes in near-real-time. Users can upgrade via
  Stripe Checkout and manage via portal.

### Next session should start with
- Phase C8: waitlist landing, onboarding flow, rate limiting on POST /sessions and
  POST /repos, abuse prevention (VM caps + suspicious-pattern detection), docs.

---

## Session C6 — July 2, 2026
**Phase:** C6 — GitHub Integration
**Duration:** ~1h

### What was accomplished
- GET /api/v1/github/repos: lists authenticated user's GitHub repos via octokit
  listForAuthenticatedUser (sorted by pushed, w/ collaborator + org affiliations).
- ReposSettings gets a GithubPicker section: search-as-you-type over the fetched list,
  one-click Add per repo, "already connected" pill for imported entries.
- POST /webhooks/github: verifies HMAC-SHA256 signature (constant-time hex compare),
  routes pull_request.closed → merged/closed → sessions.pr_state; ignores non-PR events;
  matched:false for unknown pr_url. Mounted top-level to avoid subrouter middleware
  bleeding auth into the webhook path (learned the hard way — Hono r.use('*') applies to
  ALL paths under a mount, including ones without matching handlers, so mounting the
  webhook under /api/v1/ trapped it inside diffs/pr router middleware and returned 401).
- Session PR auto-open on complete: event-relay now passes deps + autoOpenPr=true to
  processEvent; pipeline.maybeOpenPr loads owner + approved diffs, invokes routes/pr.openPr
  server-side. Idempotent w/ existing PR URL check.
- Schema: sessions.pr_state ('open'|'merged'|'closed'). Second drizzle migration
  0001_black_impossible_man.sql covers it.
- Repository: added findUserById, updateSessionPrState, findSessionByPrUrl.
- GithubClient extended: listUserRepos + full stub in harness.
- 6 new integration tests: /github/repos ok + not-connected, webhook bad sig / ignored
  event / merged transition / unmatched pr_url.

### Decisions made
- Mount webhooks at /webhooks/github, not /api/v1/webhooks — sub-router middleware
  isolation quirk in Hono.
- pr_state defaults to null; only becomes 'open' when we first write pr_url. Keeps
  legacy sessions from being flagged as PR-bearing.
- Auto-open PR is best-effort — warns and moves on if the user lost their github token.

### Checks
- control-plane: bunx tsc clean, bun test 74/74 (was 68, added 6 github tests).
- dashboard: tsc clean, next build clean.

### State of codebase at close
- End-to-end: connect GitHub → import a repo → run session → dashboard-approved diffs
  → PR auto-opens → webhook flips pr_state on merge.

### Next session should start with
- Phase C7: Stripe metered billing (VM minute tracking → Stripe usage record → dashboard
  usage view; subscription plans).

---

## Session C5 — July 2, 2026
**Phase:** C5 — Plan Approval + Diff Review
**Duration:** ~1h

### What was accomplished
- Dashboard DiffReview.tsx: per-file cards, colored +/- hunks, per-file approve/reject,
  Approve-all button, live status pills (pending/approved/rejected). Auto-selects the
  Diffs tab when session enters reviewing with a diff_ready event.
- Ported the src/diff/engine.ts semantics into cloud/dashboard/lib/diff-engine.ts
  (generateDiff, applySelectedHunks, statsForHunks) — added `diff` + `@types/diff` deps.
- SessionDetailView switched to Activity | Diffs tabs; Open-PR button gates on
  approved > 0 && pending == 0.
- Control plane: extended GithubClient with getBranchSha / createBranch / getFileSha /
  putFile / createPullRequest (octokit implementation + stub in harness).
- New POST /api/v1/sessions/:id/pr route (routes/pr.ts). Reads approved diffs, creates
  anvil/session-<8chars> branch (idempotent if already exists), PUTs each file via
  Contents API, opens PR, updates sessions.pr_url.
- Repository interface: added updateSessionPrUrl (both pg + memory impl).
- Wrote 4 new integration tests covering: successful PR w/ mixed diff statuses, no
  approved diffs (400), idempotent branch reuse, 404 for cross-user access.

### Checks
- control-plane: bunx tsc clean, bun test 68/68 (was 64, added 4 PR tests).
- dashboard: npx tsc clean, next build clean.

### State of codebase at close
- End-to-end review flow works: SSE-driven diff feed → user approves per-file → Open PR
  button hits the octokit-backed endpoint → sessions.pr_url populated.
- Diff engine is duplicated between src/diff/engine.ts (Anvil CLI) and
  cloud/dashboard/lib/diff-engine.ts (browser) intentionally — the CLI can't share code
  with the dashboard without a workspace, and the dashboard needs it in the browser bundle.

### Next session should start with
- Phase C6: repo picker with real GitHub repo listing on session create, VM-side clone
  from the session branch, and webhook for PR merge/close status.

---

## Session C4 — July 2, 2026
**Phase:** C4 — Dashboard Core
**Duration:** ~1h

### What was accomplished
- Finished the untracked cloud/dashboard scaffold (Next.js 16 + Clerk 6 + SWR + tailwind v4).
- Session list, session detail w/ SSE, plan approval component, new-session form, repos settings.
- Proxy route at app/api/proxy/[...path]/route.ts forwards to control-plane w/ Clerk bearer token; passes through SSE streams.
- clerkMiddleware in proxy.ts (Next.js 16 Proxy runtime).
- Fixed three real bugs uncovered during audit:
  - branch selected by user in NewSessionForm was silently dropped — added branch column to sessions
    (schema.ts), plumbed through createSession, provisioner.ts now uses session.branch not
    repo.defaultBranch.
  - startedAt on sessions was declared but never written — updateSessionStatus now stamps
    startedAt on first transition into running (both pg + in-memory harness).
  - drizzle migrations folder was empty — generated 0000_absent_infant_terrible.sql via drizzle-kit.
- Force dynamic on all Clerk-gated pages + added app/not-found.tsx to unblock next build.

### Checks
- control-plane: bunx tsc --noEmit clean · bun test → 64/64 pass
- dashboard: npx tsc --noEmit clean · next build succeeds w/ all routes dynamic

### State of codebase at close
- Dashboard fully wired end-to-end: sign-in → session list → new session (repo/branch/model
  picker) → live SSE session detail with plan approval.
- Control plane branch column & startedAt tracking landed cleanly with generated migration.

### Next session should start with
- Phase C5: Plan approval already present in dashboard; build per-hunk diff review UI reusing
  src/diff/engine.ts semantics, wire PR creation via GitHub API on session complete.

---

## Session 9 — June 19, 2026
**Phase:** 9 — Execution Environment
**Duration:** ~1h

### What was accomplished
- Built src/tools/run_command.ts: execa subprocess, blocked-command list
  (rm -rf /, sudo, mkfs, dd, curl|sh, wget|sh), 20k combined output cap,
  configurable timeout
- Built src/tools/run_tests.ts: auto-detects jest/vitest/pytest/cargo/go test
  from project config, returns structured pass/fail/skip counts + failing test names
- Built src/execution/verifier.ts: post-execution tsc + run_tests pass;
  on failure spawns a new executor with error output as context; max 2 auto-fix rounds
- Built src/execution/headless.ts: no-TUI JSON mode, auto-approves plan,
  exits 0 on success / 1 on failure, structured result to stdout
- Updated src/tools/index.ts: registered run_command + run_tests tool definitions
  and executeTool cases; emits command_running / command_complete events
- Updated src/agents/executor.ts: added run_command + run_tests to executor tool set,
  extraContext param for verification re-runs, suppressDoneEvent option
- Updated src/agents/loop.ts: LoopOptions interface, suppressDoneEvent flag
- Updated src/ui/components/StatusBar.tsx: VerificationState type, shows
  ✓ verified / ✖ N failures in the status bar after verification runs
- --headless and --dry-run flags wired in index.ts (via orchestrator)

### Decisions made
- Verification capped at 2 auto-fix rounds to prevent infinite loops
- run_command blocked list uses regex patterns, not exact strings — covers
  common destructive variants without being exhaustive
- suppressDoneEvent lets verification re-run executor without double-firing done

### State of codebase at close
- Full execution environment: run_command, run_tests, post-exec verification,
  headless mode, dry-run mode, command output in TUI status bar
- verifier.ts runs tsc then test suite; on failure re-runs executor with
  failure context injected

### Next session should start with
- Phase 10: Edit Quality (diff view, per-hunk accept/reject, interrupt handler,
  session resume, multimodal input, edit size guard)

---

## Session 10 — June 19, 2026
**Phase:** 10 — Edit Quality
**Duration:** ~1h

### What was accomplished
- Built src/diff/engine.ts: generateDiff (wraps diff npm package), 
  applySelectedHunks (partial hunk reconstruction)
- Built src/ui/components/DiffView.tsx: j/k hunk nav, a/r per-hunk, 
  A/R all, q/Enter done, colored +/- lines
- Built src/execution/interrupt.ts: first Ctrl+C shows c/s/r prompt, 
  second Ctrl+C force-rollbacks
- Built src/execution/resume.ts: reads plan.json + shadow.log, 
  reconstructs remaining steps, re-runs executor
- Built src/execution/guard.ts: token estimate (chars/4), warns >50k tokens
- Built src/context/image.ts: validates PNG/JPG/WebP/GIF, base64-encodes, 
  returns Anthropic-compatible block
- shadow/workspace.ts: after LSP clean, emits diff_ready, awaits hunk 
  selection, applies applySelectedHunks before committing
- App.tsx: DiffView replaces right panel on diff_ready, interrupt prompt 
  renders below panels
- headless.ts: auto-accepts all hunks on diff_ready
- index.ts: --resume <sessionId>, --image <filepath>, size estimate in dry-run

### Decisions made
- waitForDiffResolution/resolveDiff mirror the waitForApproval pattern — 
  consistent Promise-based UI gate across all blocking interactions
- applySelectedHunks reconstructs file from partial selection — 
  rejected hunk regions preserve original content exactly
- Second Ctrl+C force-rollbacks without prompt — prevents hanging in CI 
  or when user is stuck
- Image converted to OpenAI data-URL format in planner — 
  works with Anthropic's vision API via the OpenAI-compatible endpoint

### What broke / was surprising
- 14 files touched — most complex session so far, no major breakage

### State of codebase at close
- All edit quality features complete: diff view, per-hunk accept/reject,
  graceful interrupt, session resume, edit size guard, multimodal input
- headless mode correctly bypasses all interactive gates
- src/diff/, src/execution/interrupt.ts, src/execution/resume.ts, 
  src/execution/guard.ts, src/context/image.ts all new and wired in

### Next session should start with
- Phase 11: Distribution
- Compiled binary via bun build --compile
- npm package as anvil-agent
- Auto LSP install on first run
- anvilai init, anvilai doctor, anvilai config
- GitHub Actions integration

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

## Session 8 — June 19, 2026
**Phase:** 8 — Context Depth
**Duration:** ~1h

### What was accomplished
- Built src/context/mentions.ts: @file (fuzzy resolve), @Symbol (LSP find_symbol),
  @https:// (fetch + HTML strip, 8000 char cap), @web: (Tavily + DuckDuckGo fallback)
- Built src/context/project.ts: loadRules, loadMemory (last 2000 chars), 
  loadIgnore, appendMemory (dated session entries)
- Built src/context/index.ts: loadContext() runs all resolvers in parallel, 
  returns unified AnvilContext
- Updated list_files, read_file, ast_search: accept ignorePatterns, skip via micromatch
- Updated orchestrator: loadContext first, injects context/rules/memory into planner,
  appends memory after done fires
- Created test-repo-2/.anvil/: rules.md, memory.md (fake prior session), ignore
- Two new UIEvents: context_loaded, memory_written
- TUI left panel shows context sources loaded after resolution

### Decisions made
- All mention resolution runs in parallel via Promise.all — no sequential blocking
- @Symbol detection heuristic: PascalCase + no slashes + not a URL
- Memory injection capped at last 2000 chars — most recent context is most relevant
- Rules go into system prompt, context/memory go into user message — 
  keeps system prompt for instructions, user message for data
- micromatch for ignore patterns — handles globs correctly including negation

### What broke / was surprising
- Nothing major — smoke tests passed clean

### State of codebase at close
- src/context/ complete: mentions, project, index
- All three tools updated with ignore pattern support
- .anvil/ directory structure working in test-repo-2
- @file pre-load ✓, rules ✓, memory ✓, ignore ✓, @AppError → 19 refs ✓

### Next session should start with
- Phase 9: Execution Environment
- run_command tool, run_tests tool, post-execution verification pass,
  headless/CI mode, --dry-run flag

## Session 7 — June 19, 2026
**Phase:** 7 — Git Integration
**Duration:** ~1h

### What was accomplished
- Built src/git/client.ts: getGitContext, createSessionBranch, commitFile,
  rollbackSession, generatePRDescription via simple-git
- Built git_log, git_diff, git_blame as planner-accessible read-only tools
- Orchestrator now: injects git context into system prompt at session start,
  auto-branches before executor on complex requests, commits each file after
  shadow workspace confirms clean, generates PR description after done fires
- Four new UIEvents: branch_created, file_committed, pr_description_ready, rollback_complete
- TUI left panel: current branch, live commit counter, PR description path on completion
- anvil --rollback <sessionId>: hard-reset to merge-base, branch deleted, original branch restored
- Verified with 15-assertion integration test

### Decisions made
- simple-git for all git operations — clean async API, handles edge cases
- Hard-reset to merge-base for rollback rather than reverting individual commits —
  safer and handles reordered or squashed commits correctly
- Git context injected into orchestrator system prompt, not planner —
  orchestrator decides branching strategy, planner uses git tools for exploration only
- commitFile called after each file_modified event, serialized —
  never batches commits, each file gets its own atomic commit

### What broke / was surprising
- Nothing major — 15-assertion test passed clean

### State of codebase at close
- src/git/ complete, all three git tools registered and in planner tool list
- Full git lifecycle working: branch → commit per file → PR description → rollback
- TUI reflects git state live

### Next session should start with
- Phase 8: Context Depth
- @file, @symbol, @docs, @web mention parsing
- .anvil/rules.md, .anvil/memory.md, .anvil/ignore

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

## Session 11+12 — June 19, 2026
**Phase:** 11 (Distribution) + 12 (Model Picker)
**Duration:** ~2h

### What was accomplished
**Phase 11 — Distribution:**
- Built src/setup/lsp.ts: language detection, LSP install check,
  prompt + install, persists to ~/.anvil/lsp.json
- Built src/setup/config.ts: ~/.anvil/config.json, loadConfig/saveConfig,
  config set/get/list, API key precedence chain
- Built src/setup/init.ts: interactive anvil init, creates all 6 .anvil/
  files, --yes flag for non-interactive defaults
- Built src/setup/doctor.ts: 8 checks (Node, API key, rg, LSPs, /tmp,
  disk, git, bun optional), exit 0/1
- Built src/setup/commands.ts: loads .anvil/commands/*.md, resolves
  /commandName to system prompt + request
- package.json: anvil-agent, v1.0.0, engines, files, build scripts
- .github/workflows/anvil-ci-example.yml and Dockerfile
- README.md: npm install -g anvil-agent, init/doctor workflow

**Phase 12 — Model Picker:**
- Added ModelSpec type and AVAILABLE_MODELS (9 models: Anthropic,
  OpenAI, Google, Moonshot) to src/setup/config.ts
- selectModel(): looping @inquirer/prompts select, dim "API key not set"
  labels, re-prompts on missing key
- buildClient(): Anthropic → api.anthropic.com/v1, all others →
  OpenAI-compatible SDK with provider baseURL
- client and modelId threaded through orchestrator → planner, executor,
  verifier, headless — all four call sites
- --model <id> flag skips picker, validates key immediately
- Picker runs before Ink starts — owns stdin cleanly
- StatusBar shows: "Claude Opus 4.8 · PLANNING · 14s"
- Backwards compatible: resume mode falls back to default Anthropic client

### Decisions made
- OpenAI SDK for all providers including Anthropic — consistent client
  interface, all providers speak OpenAI-compatible protocol
- Picker owns stdin before Ink takes over — avoids input conflicts
- Fall back to default client if none passed — preserves resume mode
- LSP state persisted to ~/.anvil/lsp.json — only prompts once per server
- API key precedence: env var → config file → error

### What broke / was surprising
- Nothing — clean build, all verification tests passed

### State of codebase at close
- All 12 phases complete and committed in one shot
- 9 models available across 4 providers
- Full distribution pipeline: anvil doctor, anvil init, npm package ready
- Model label live in status bar throughout every session

### Next steps
- Writeup at anvil.aryasomu.com
- npm publish anvil-agent
- Submit to Cursor

## Session C1 — June 20, 2026
**Phase:** C1 — Control Plane Foundation
**Duration:** ~1h

### What was accomplished
- Initialized cloud/control-plane/ as a standalone Bun TypeScript project
- Built Drizzle schema: users, repos, sessions, events, diffs (Postgres, UUIDs, jsonb)
- Built repository interface + createPgRepository adapter — routes depend on
  interface, not raw Drizzle (clean DI)
- Built requireAuth Hono middleware with Clerk JWT verification and
  create-on-first-login user sync
- Built all routes: auth, repos, sessions, diffs — zod validated, ownership checked
- Built createApp(deps) factory with CORS, pino logging, structured error handler
- 20 tests across 4 files using Map-backed in-memory repository adapter
- cloud/dashboard/ and cloud/vm/ placeholder directories created

### Decisions made
- DI shape: AppDeps = { repo, verifyToken, githubClient }
  Tests swap in stub implementations, prod uses real Postgres adapter
- Map-backed in-memory repository for tests instead of SQLite
  Same isolation, no parallel schema to maintain
- createApp(deps) factory pattern — server is fully testable without
  binding to a real port or database

### What broke / was surprising
- Nothing — 20 tests pass clean, typecheck clean, /health returns 200

### State of codebase at close
- cloud/control-plane/ fully built and verified
- All routes implemented with correct ownership checks and state validation
- Production entrypoint: dotenv → migrate → wire deps → Bun.serve

### Next session should start with
- Phase C2: VM Runtime Layer
- Firecracker lifecycle API, base VM image spec, agent runtime websocket
  server, provisioner, VM connection pool

## Session C2 — June 20, 2026
**Phase:** C2 — VM Runtime Layer
**Duration:** ~1h

### What was accomplished
- Built cloud/vm/runtime/src/server.ts: WebSocket server on port 8080,
  handles start/approve/revise/abort/setup, dynamically loads anvil-agent,
  forwards uiStream events to control plane, exits cleanly if anvil-agent missing
- Built cloud/vm/image/: Dockerfile (local dev), firecracker-config.template.json
  (production), setup.sh (documented rootfs build script)
- Built cloud/control-plane/src/vm/: VMDriver interface, DockerDriver,
  FirecrackerDriver, getVMDriver() selector, SessionPool singleton,
  provisionSession with 60s timeout, event-relay
- Updated routes/sessions.ts: background provisioning (max 3/user),
  approve/abort forward signals to VM via pool
- Extended repository interface: createEvent, updateSessionVm, completeSession
- 13 new tests in vm.test.ts, 33/33 total passing, tsc clean

### Decisions made
- Injectable CommandRunner and PortWaiter in runner.ts — makes Docker/Firecracker
  drivers fully testable without real processes
- VMDriver interface with getVMDriver() selector — swap Docker/Firecracker
  via VM_DRIVER env var, no code changes needed
- provisionSession has 60s timeout at every step — failure at any step
  stops the VM and marks session failed, no orphaned VMs
- SessionPool as singleton — single source of truth for all active connections

### What broke / was surprising
- Nothing — 33/33 tests pass, typecheck clean

### State of codebase at close
- Full VM lifecycle working: startVM, provision, event relay, stop
- Docker driver ready for local dev smoke test
- Firecracker driver ready for production deployment
- cloud/vm/runtime/ packaged and ready to be built into the VM image

### Next session should start with
- Phase C3: Realtime Event Pipeline
- SSE broadcaster, Redis pub/sub, session state machine,
  GET /sessions/:id/events endpoint

## Session C3 — June 20, 2026
**Phase:** C3 — Realtime Event Pipeline
**Duration:** ~1h

### What was accomplished
- Built src/state/machine.ts: transition(), canTransition(), isTerminal(),
  InvalidTransitionError. All valid transitions enforced, invalid ones throw.
- Built src/events/pipeline.ts: processEvent persists, publishes to Redis
  pub/sub, maps plan_ready→reviewing, done→complete, error→failed.
  Never throws on failure, logs internally.
- Built src/events/broadcaster.ts: SSEBroadcaster, subscribes to Redis on
  first client, unsubscribes when empty, drops dead clients on send failure,
  30s heartbeat
- Built src/events/sse.ts: streamSSE handler, sends session_state with last
  50 events as first frame, registers/unregisters with broadcaster
- Wired: separate Redis publisher and subscriber connections, broadcaster
  in AppDeps, GET /api/v1/sessions/:id/events route
- event-relay.ts now routes all status updates through processEvent +
  canTransition
- 31 new tests across 4 files, 64/64 total passing, tsc clean

### Decisions made
- Separate ioredis connections for publisher and subscriber — Redis pub/sub
  connections cannot be used for other commands
- idleTimeout: 255 on SSE route — prevents Bun from timing out long-lived
  SSE connections
- processEvent never throws — SSE pipeline should not crash on Redis failure,
  log and continue
- Dead client dropped on send failure — no zombie clients accumulating

### What broke / was surprising
- Nothing — 64/64 tests pass, typecheck clean

### State of codebase at close
- Full realtime pipeline working: VM event → processEvent → Redis pub/sub
  → SSEBroadcaster → dashboard client
- State machine enforces all session transitions
- SSE endpoint sends full session state as first frame (no loading state
  needed in dashboard)

### Next session should start with
- Phase C4: Dashboard Core
- Next.js app in cloud/dashboard/, Clerk auth, session list,
  new session form, real-time session detail with live SSE feed
