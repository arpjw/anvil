# Anvil Cloud

The hosted version of Anvil. This directory contains three services:

- `control-plane/` — Bun + Hono API server, Postgres via Drizzle, Redis pub/sub for SSE, Clerk for auth, Stripe metered billing, Octokit for GitHub.
- `vm/` — VM runtime bits: `image/` (Docker + Firecracker templates + `setup.sh`) and `runtime/` (in-VM agent that streams `UIEvent`s back over websocket).
- `dashboard/` — Next.js 16 + Tailwind v4 + Clerk 6. Talks to the control plane exclusively through `/api/proxy/[...path]`, which forwards the caller's Clerk token.

## Local development

You need Postgres + Redis running locally. The control plane assumes them at the standard defaults unless you set `DATABASE_URL` and `REDIS_URL`.

```bash
# Terminal 1: control plane
cd control-plane
bun install
cp .env.example .env  # then fill in CLERK_SECRET_KEY at minimum
bun run db:generate   # only if you changed schema.ts
bun run dev           # http://localhost:3001

# Terminal 2: dashboard
cd dashboard
npm install
cp .env.example .env.local
npm run dev           # http://localhost:3000
```

## Environment variables

**Required (control plane)**
- `CLERK_SECRET_KEY` — Clerk backend key for verifying session tokens.
- `DATABASE_URL` — Postgres connection string.
- `REDIS_URL` — Redis connection string.

**Optional (control plane)**
- `DASHBOARD_ORIGIN` — allowed CORS origin (default `http://localhost:3000`).
- `PORT` — HTTP port (default `3001`).
- `ANTHROPIC_API_KEY` — used to hand off to the VM agent.
- `GITHUB_WEBHOOK_SECRET` — turns on `POST /webhooks/github`. Also required for PR merge tracking.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM` — turns on billing routes and the `/webhooks/stripe` handler. When these are unset, the billing routes return 503 (`billing_disabled`) and no usage is reported to Stripe.
- `FREE_MINUTES_PER_MONTH` — default `60`.
- `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, `STRIPE_PORTAL_RETURN_URL` — override the Checkout/portal return URLs.

**Required (dashboard)**
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` — Clerk keys.
- `NEXT_PUBLIC_CONTROL_PLANE_URL` — where `/api/proxy/*` forwards to (default `http://localhost:3001`).

## Migrations

Drizzle-generated SQL lives in `control-plane/drizzle/`. Each schema change:

```bash
cd control-plane
bun run db:generate     # writes a new NNNN_*.sql
bun run db:migrate      # applies it against DATABASE_URL
```

The server also runs `migrate()` on boot, so a redeploy applies pending migrations automatically.

## Deployment sketch

1. Provision Postgres (Neon / RDS) and Redis (Upstash / ElastiCache).
2. Set env vars in your host (Fly, Railway, Render). Bun starts the process with `bun run src/index.ts`.
3. Point the Next.js dashboard at the control plane via `NEXT_PUBLIC_CONTROL_PLANE_URL`.
4. Configure the GitHub webhook to `https://<control-plane>/webhooks/github` with the `pull_request` event and set `X-Hub-Signature-256` (Stripe webhook similarly at `/webhooks/stripe`).

## Where to look

- API reference: [`docs/api.md`](docs/api.md)
- State machine: `control-plane/src/state/machine.ts`
- Event pipeline: `control-plane/src/events/pipeline.ts`
