# Anvil Cloud — API Reference

All authenticated endpoints require a Clerk session token in `Authorization: Bearer <token>`.
Rate-limited endpoints return HTTP 429 with `{"error": {"code": "rate_limited", ...}}` after the limit is hit.

## Sessions

### `POST /api/v1/sessions` — create a session
- **Body**: `{ repoId: uuid, branch: string, request: string, model?: string }`
- **Rate limit**: 20 / hour / user (`session_create`).
- **Response**: `{ session }`
- **Notes**: kicks off VM provisioning in the background if `ANTHROPIC_API_KEY` is set.

### `GET /api/v1/sessions` — list your sessions
- **Query**: `?status=running` (optional).
- **Response**: `{ sessions: Session[] }`

### `GET /api/v1/sessions/:id` — session detail
- **Response**: `{ session: SessionDetail }` (includes events + diffs).

### `DELETE /api/v1/sessions/:id` — abort
- Sends `{ type: 'abort' }` to the VM and stops it.

### `POST /api/v1/sessions/:id/approve` / `POST /api/v1/sessions/:id/reject`
- Only valid in `reviewing` status.

### `GET /api/v1/sessions/:id/events`
- Server-Sent Events feed for a session. Initial frame is `session_state`
  followed by live `UIEvent`s.

### `POST /api/v1/sessions/:id/pr`
- Opens a PR from all approved diffs. Idempotent by `sessions.pr_url`.
- Creates a branch `anvil/session-<8-char-id>` from `sessions.branch`.

## Diffs

### `GET /api/v1/sessions/:id/diffs`
### `POST /api/v1/sessions/:id/diffs/:diffId/approve` / `.../reject`
### `POST /api/v1/sessions/:id/diffs/approve-all`

## Repos

### `GET /api/v1/repos`
### `POST /api/v1/repos` — connect an installed repo (owner/repo)
- **Rate limit**: 30 / hour / user (`repo_create`).
### `DELETE /api/v1/repos/:id`
### `GET /api/v1/repos/:id/branches` — proxied from GitHub

## GitHub

### `GET /api/v1/github/repos`
- Lists the authenticated user's GitHub repositories via `listForAuthenticatedUser`.

## Billing

Returns 503 with `billing_disabled` if Stripe env vars are not set.

### `GET /api/v1/billing/usage`
- `{ period: { start, end }, minutes, records, planTier, freeMinutesPerMonth }`

### `POST /api/v1/billing/checkout`
- **Body**: `{ plan: 'pro' | 'team' }`
- Returns `{ url }` — hosted Stripe Checkout.

### `POST /api/v1/billing/portal`
- Returns `{ url }` — Stripe Billing Portal.

## Waitlist (public, unauthenticated)

### `POST /api/v1/waitlist`
- **Body**: `{ email: string, source?: string }`
- **Rate limit**: 30 / hour / IP (`waitlist`).
- **Response**: `{ added: boolean, alreadyOnList: boolean }` — idempotent by email.

### `GET /api/v1/waitlist/count`

## Webhooks

### `POST /webhooks/github`
- Requires `X-Hub-Signature-256` (HMAC-SHA256 of raw body with `GITHUB_WEBHOOK_SECRET`).
- Handles `pull_request` events: updates `sessions.pr_state` on close / reopen / merge.

### `POST /webhooks/stripe`
- Requires `stripe-signature`. Handles `checkout.session.completed` (upgrade to `pro`)
  and `customer.subscription.deleted` (downgrade to `free`).

## Health

### `GET /health`
- `{ status: 'ok', version, timestamp }`. No auth.

## Errors

All error responses are shaped `{ "error": { "code": string, "message": string, "requestId": string, "details"?: unknown } }`.

| Status | Common codes |
|-------|-----|
| 400 | `invalid_body`, `bad_request` |
| 401 | `unauthorized`, `invalid_signature` |
| 404 | `not_found`, `repo_not_found`, `session_not_found` |
| 409 | `branch_exists` |
| 429 | `rate_limited` |
| 500 | `internal_error` |
| 502 | `stripe_error`, `pr_failed` |
| 503 | `billing_disabled` |


## Session lifecycle additions

- `POST /sessions/:id/revise`: body `{ "feedback": "..." }`, 1 to 4000 nonblank characters. Requires ownership, `reviewing` state, and a connected runtime. Returns the updated session.
- `POST /sessions/:id/approve`: now returns 409 if the runtime is disconnected; it does not silently advance the session.
- `POST /sessions/:id/reject`: cancels the pending plan and records `aborted`.
- `POST /sessions/:id/resume`: for a failed session with a phase checkpoint, creates a fresh session on the original source branch. Returns `{ session, retryOf, recovery: "fresh_checkout" }`. It does not restore the old VM filesystem. Clients should navigate to the returned session ID.
- `POST /sessions`: returns 503 when the selected provider key is unavailable and 429 when the process-local provisioning limit is reached.
- `POST /sessions/:id/pr`: requires a completed session; an existing PR is returned without creating another.

Persistent SSE events include stable `id` and millisecond `timestamp` fields. `error` is a recoverable activity event. `session_error` and `session_failed` are terminal failures; cancellation is `aborted`. Replay is bounded, and command output is ephemeral, so exported activity is not a complete audit log.
