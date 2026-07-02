import { createApp } from '../app';
import { pino } from 'pino';
import type { AppDeps, GithubClient, VerifyTokenFn } from '../lib/context';
import { SSEBroadcaster } from '../events/broadcaster';
import { makeMemoryStore } from '../middleware/rate-limit';
import type {
  Repository,
  SessionDetail,
  SessionWithRepoName,
} from '../db/repository';
import type {
  Diff,
  DiffStatus,
  Event,
  NewSession,
  PlanTier,
  PrState,
  Repo,
  Session,
  SessionStatus,
  UsageRecord,
  User,
} from '../db/schema';

const silentLogger = pino({ enabled: false });

function uuid(): string {
  return crypto.randomUUID();
}

export function createMemoryRepository(): Repository & {
  _users: Map<string, User>;
  _repos: Map<string, Repo>;
  _sessions: Map<string, Session>;
  _events: Map<string, Event>;
  _diffs: Map<string, Diff>;
  _usage: Map<string, UsageRecord>;
} {
  const usersById = new Map<string, User>();
  const reposById = new Map<string, Repo>();
  const sessionsById = new Map<string, Session>();
  const eventsById = new Map<string, Event>();
  const diffsById = new Map<string, Diff>();
  const usageById = new Map<string, UsageRecord>();
  const waitlistSignups = new Map<
    string,
    { id: string; email: string; source: string | null; createdAt: Date }
  >();

  return {
    _users: usersById,
    _repos: reposById,
    _sessions: sessionsById,
    _events: eventsById,
    _diffs: diffsById,
    _usage: usageById,

    async findUserByClerkId(clerkId) {
      for (const user of usersById.values()) {
        if (user.clerkId === clerkId) return user;
      }
      return null;
    },

    async findUserById(id) {
      return usersById.get(id) ?? null;
    },

    async createUser({ clerkId }) {
      const user: User = {
        id: uuid(),
        clerkId,
        githubLogin: null,
        githubAccessToken: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        planTier: 'free',
        freeMinutesUsed: 0,
        createdAt: new Date(),
      };
      usersById.set(user.id, user);
      return user;
    },

    async setUserGithub(userId, fields) {
      const existing = usersById.get(userId);
      if (!existing) throw new Error('user not found');
      const next: User = {
        ...existing,
        githubLogin: fields.githubLogin,
        githubAccessToken: fields.githubAccessToken,
      };
      usersById.set(userId, next);
      return next;
    },

    async countReposByUser(userId) {
      let n = 0;
      for (const repo of reposById.values()) {
        if (repo.userId === userId) n++;
      }
      return n;
    },

    async listReposByUser(userId) {
      const out: Repo[] = [];
      for (const repo of reposById.values()) {
        if (repo.userId === userId) out.push(repo);
      }
      return out.sort(
        (a, b) => b.installedAt.getTime() - a.installedAt.getTime(),
      );
    },

    async findRepoById(id) {
      return reposById.get(id) ?? null;
    },

    async createRepo(input) {
      const repo: Repo = {
        id: uuid(),
        userId: input.userId,
        fullName: input.fullName,
        defaultBranch: input.defaultBranch,
        installedAt: new Date(),
      };
      reposById.set(repo.id, repo);
      return repo;
    },

    async deleteRepo(id) {
      reposById.delete(id);
    },

    async listSessionsByUser(userId, opts) {
      const out: SessionWithRepoName[] = [];
      for (const session of sessionsById.values()) {
        if (session.userId !== userId) continue;
        if (opts?.status && session.status !== opts.status) continue;
        const repo = reposById.get(session.repoId);
        out.push({
          ...session,
          repoFullName: repo?.fullName ?? '',
        });
      }
      return out.sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
    },

    async findSessionById(id) {
      const session = sessionsById.get(id);
      if (!session) return null;
      const repo = reposById.get(session.repoId);
      const sessionEvents: Event[] = [];
      for (const e of eventsById.values()) {
        if (e.sessionId === id) sessionEvents.push(e);
      }
      sessionEvents.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      const sessionDiffs: Diff[] = [];
      for (const d of diffsById.values()) {
        if (d.sessionId === id) sessionDiffs.push(d);
      }
      sessionDiffs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      const detail: SessionDetail = {
        ...session,
        repoFullName: repo?.fullName ?? '',
        events: sessionEvents.slice(0, 100),
        diffs: sessionDiffs,
      };
      return detail;
    },

    async createSession(input: NewSession) {
      const session: Session = {
        id: uuid(),
        userId: input.userId!,
        repoId: input.repoId!,
        status: (input.status as SessionStatus) ?? 'queued',
        branch: input.branch ?? 'main',
        request: input.request!,
        model: input.model ?? 'claude-sonnet-4-6',
        planJson: input.planJson ?? null,
        vmIp: input.vmIp ?? null,
        vmPort: input.vmPort ?? null,
        prUrl: input.prUrl ?? null,
        prState: input.prState ?? null,
        startedAt: input.startedAt ?? null,
        completedAt: input.completedAt ?? null,
        durationSeconds: input.durationSeconds ?? null,
        createdAt: new Date(),
      };
      sessionsById.set(session.id, session);
      return session;
    },

    async updateSessionStatus(id, status) {
      const existing = sessionsById.get(id);
      if (!existing) throw new Error('session not found');
      const next: Session = { ...existing, status };
      if (status === 'running' && existing.startedAt === null) {
        next.startedAt = new Date();
      }
      sessionsById.set(id, next);
      return next;
    },

    async updateSessionVm(id, fields) {
      const existing = sessionsById.get(id);
      if (!existing) throw new Error('session not found');
      const next: Session = {
        ...existing,
        vmIp: fields.vmIp,
        vmPort: fields.vmPort,
      };
      sessionsById.set(id, next);
      return next;
    },

    async updateSessionPrUrl(id, prUrl) {
      const existing = sessionsById.get(id);
      if (!existing) throw new Error('session not found');
      const next: Session = { ...existing, prUrl, prState: 'open' };
      sessionsById.set(id, next);
      return next;
    },

    async updateSessionPrState(id, prState: PrState) {
      const existing = sessionsById.get(id);
      if (!existing) throw new Error('session not found');
      const next: Session = { ...existing, prState };
      sessionsById.set(id, next);
      return next;
    },

    async findSessionByPrUrl(prUrl) {
      for (const session of sessionsById.values()) {
        if (session.prUrl === prUrl) return session;
      }
      return null;
    },

    async completeSession(id, fields) {
      const existing = sessionsById.get(id);
      if (!existing) throw new Error('session not found');
      const next: Session = {
        ...existing,
        completedAt: fields.completedAt,
        durationSeconds: fields.durationSeconds,
      };
      sessionsById.set(id, next);
      return next;
    },

    async createEvent(sessionId, type, payload) {
      const event: Event = {
        id: uuid(),
        sessionId,
        type,
        payload: payload as Event['payload'],
        createdAt: new Date(),
      };
      eventsById.set(event.id, event);
      return event;
    },

    async getRecentEvents(sessionId, limit) {
      const out: Event[] = [];
      for (const e of eventsById.values()) {
        if (e.sessionId === sessionId) out.push(e);
      }
      return out
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    },

    async setUserStripeCustomer(userId, customerId) {
      const existing = usersById.get(userId);
      if (!existing) throw new Error('user not found');
      const next: User = { ...existing, stripeCustomerId: customerId };
      usersById.set(userId, next);
      return next;
    },

    async setUserSubscription(userId, fields) {
      const existing = usersById.get(userId);
      if (!existing) throw new Error('user not found');
      const next: User = {
        ...existing,
        stripeSubscriptionId: fields.subscriptionId,
        planTier: fields.planTier,
      };
      usersById.set(userId, next);
      return next;
    },

    async createUsageRecord(input) {
      const rec: UsageRecord = {
        id: uuid(),
        userId: input.userId,
        sessionId: input.sessionId,
        minutes: input.minutes,
        reportedAt: null,
        createdAt: new Date(),
      };
      usageById.set(rec.id, rec);
      return rec;
    },

    async markUsageReported(id) {
      const existing = usageById.get(id);
      if (!existing) throw new Error('usage record not found');
      const next: UsageRecord = { ...existing, reportedAt: new Date() };
      usageById.set(id, next);
      return next;
    },

    async listUnreportedUsage(userId) {
      const out: UsageRecord[] = [];
      for (const r of usageById.values()) {
        if (r.userId === userId && r.reportedAt === null) out.push(r);
      }
      return out;
    },

    async listUsageBySince(userId, since) {
      const out: UsageRecord[] = [];
      for (const r of usageById.values()) {
        if (r.userId === userId && r.createdAt >= since) out.push(r);
      }
      return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async addWaitlistSignup(email, source) {
      for (const s of waitlistSignups.values()) {
        if (s.email === email) return false;
      }
      const rec = {
        id: uuid(),
        email,
        source,
        createdAt: new Date(),
      };
      waitlistSignups.set(rec.id, rec);
      return true;
    },

    async countWaitlistSignups() {
      return waitlistSignups.size;
    },

    async listDiffsBySession(sessionId) {
      const out: Diff[] = [];
      for (const d of diffsById.values()) {
        if (d.sessionId === sessionId) out.push(d);
      }
      return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async findDiffById(id) {
      return diffsById.get(id) ?? null;
    },

    async updateDiffStatus(id, status: DiffStatus) {
      const existing = diffsById.get(id);
      if (!existing) throw new Error('diff not found');
      const next: Diff = { ...existing, status };
      diffsById.set(id, next);
      return next;
    },

    async approveAllPendingDiffs(sessionId) {
      let count = 0;
      for (const [id, diff] of diffsById) {
        if (diff.sessionId === sessionId && diff.status === 'pending') {
          diffsById.set(id, { ...diff, status: 'approved' });
          count++;
        }
      }
      return count;
    },
  };
}

export interface StripeStub {
  createdCustomers: Array<{ email?: string; metadata?: Record<string, string>; id: string }>;
  reportedUsage: Array<{ subscriptionItemId: string; quantity: number; idempotencyKey: string }>;
  checkoutSessions: Array<{ customerId: string; priceId: string; url: string }>;
  portalSessions: Array<{ customerId: string; url: string }>;
  nextCustomerId: number;
  nextCheckoutUrl: string;
  nextPortalUrl: string;
  webhookEvents: Array<{ type: string; data: Record<string, unknown> }>;
}

export interface StripeStubHandle {
  stub: StripeStub;
  client: import('../lib/context').StripeClient;
}

export function createStripeStub(): StripeStubHandle {
  const stub: StripeStub = {
    createdCustomers: [],
    reportedUsage: [],
    checkoutSessions: [],
    portalSessions: [],
    nextCustomerId: 1,
    nextCheckoutUrl: 'https://stripe.example/checkout',
    nextPortalUrl: 'https://stripe.example/portal',
    webhookEvents: [],
  };
  return {
    stub,
    client: {
      async createCustomer(input) {
        const id = `cus_${stub.nextCustomerId++}`;
        stub.createdCustomers.push({ ...input, id });
        return { id };
      },
      async reportUsage(input) {
        stub.reportedUsage.push(input);
      },
      async createCheckoutSession({ customerId, priceId }) {
        stub.checkoutSessions.push({ customerId, priceId, url: stub.nextCheckoutUrl });
        return { url: stub.nextCheckoutUrl };
      },
      async createPortalSession({ customerId }) {
        stub.portalSessions.push({ customerId, url: stub.nextPortalUrl });
        return { url: stub.nextPortalUrl };
      },
      async parseWebhook(rawBody) {
        try {
          const parsed = JSON.parse(rawBody) as { type: string; data: Record<string, unknown> };
          stub.webhookEvents.push(parsed);
          return parsed;
        } catch {
          const { HttpError } = await import('../lib/errors');
          throw new HttpError(400, 'bad_body', 'invalid json');
        }
      },
    },
  };
}

export interface StubbedPutFileCall {
  owner: string;
  repo: string;
  path: string;
  branch: string;
  message: string;
  content: string;
  sha?: string | null;
}

export interface StubbedPrCall {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

export type StubbedGithub = {
  getResponses: Map<string, { defaultBranch: string } | { error: number }>;
  branchResponses: Map<string, Array<{ name: string; sha: string }>>;
  branchShas: Map<string, string>;
  createdBranches: Array<{ owner: string; repo: string; branch: string; fromSha: string }>;
  existingBranches: Set<string>;
  fileShas: Map<string, string>;
  putFileCalls: StubbedPutFileCall[];
  prCalls: StubbedPrCall[];
  prResponses: Map<string, { url: string; number: number }>;
  userRepos: Array<{ fullName: string; defaultBranch: string; private: boolean }>;
  lastToken: string | null | undefined;
};

export function createGithubStub(stub: StubbedGithub) {
  return (token: string | null | undefined): GithubClient => {
    stub.lastToken = token;
    return {
      async reposGet(owner, repo) {
        const key = `${owner}/${repo}`;
        const response = stub.getResponses.get(key);
        if (!response) {
          const { HttpError } = await import('../lib/errors');
          throw new HttpError(404, 'repo_not_found', 'repo not accessible');
        }
        if ('error' in response) {
          const { HttpError } = await import('../lib/errors');
          throw new HttpError(404, 'repo_not_found', 'repo not accessible');
        }
        return response;
      },
      async reposListBranches(owner, repo) {
        const key = `${owner}/${repo}`;
        const branches = stub.branchResponses.get(key) ?? [];
        return branches.map((b) => ({ name: b.name, commit: { sha: b.sha } }));
      },
      async getBranchSha(owner, repo, branch) {
        const key = `${owner}/${repo}/${branch}`;
        const sha = stub.branchShas.get(key);
        if (!sha) {
          const { HttpError } = await import('../lib/errors');
          throw new HttpError(404, 'repo_not_found', 'branch not found');
        }
        return sha;
      },
      async createBranch(owner, repo, branch, fromSha) {
        const key = `${owner}/${repo}/${branch}`;
        if (stub.existingBranches.has(key)) {
          const { HttpError } = await import('../lib/errors');
          throw new HttpError(
            409,
            'branch_exists',
            `branch ${branch} already exists`,
          );
        }
        stub.existingBranches.add(key);
        stub.branchShas.set(key, fromSha);
        stub.createdBranches.push({ owner, repo, branch, fromSha });
      },
      async getFileSha(owner, repo, path, branch) {
        return stub.fileShas.get(`${owner}/${repo}/${branch}/${path}`) ?? null;
      },
      async putFile(owner, repo, args) {
        stub.putFileCalls.push({ owner, repo, ...args });
        stub.fileShas.set(
          `${owner}/${repo}/${args.branch}/${args.path}`,
          `sha-${stub.putFileCalls.length}`,
        );
      },
      async createPullRequest(owner, repo, args) {
        stub.prCalls.push({ owner, repo, ...args });
        const key = `${owner}/${repo}`;
        const response = stub.prResponses.get(key);
        if (response) return response;
        return {
          url: `https://github.com/${owner}/${repo}/pull/${
            stub.prCalls.length
          }`,
          number: stub.prCalls.length,
        };
      },
      async listUserRepos() {
        return stub.userRepos;
      },
    };
  };
}

export type TokenMap = Map<string, { clerkId: string }>;

export function createVerifyTokenStub(tokens: TokenMap): VerifyTokenFn {
  return async (token: string) => {
    const match = tokens.get(token);
    if (!match) {
      const { HttpError } = await import('../lib/errors');
      throw new HttpError(401, 'unauthorized', 'invalid token');
    }
    return match;
  };
}

export type Harness = {
  app: ReturnType<typeof createApp>;
  repo: ReturnType<typeof createMemoryRepository>;
  tokens: TokenMap;
  github: StubbedGithub;
  stripe: StripeStub;
  deps: AppDeps;
  redis: FakeRedis;
  broadcaster: SSEBroadcaster;
  authedFetch: (
    path: string,
    init?: RequestInit & { token?: string },
  ) => Promise<Response>;
};

export class FakeRedis {
  readonly published: Array<{ channel: string; message: string }> = [];
  readonly subscribed = new Set<string>();
  private listeners = new Set<(channel: string, message: string) => void>();

  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    for (const listener of this.listeners) listener(channel, message);
    return 1;
  }

  async subscribe(channel: string): Promise<number> {
    this.subscribed.add(channel);
    return this.subscribed.size;
  }

  async unsubscribe(channel: string): Promise<number> {
    this.subscribed.delete(channel);
    return this.subscribed.size;
  }

  on(_event: 'message', listener: (channel: string, message: string) => void): this {
    this.listeners.add(listener);
    return this;
  }

  off(_event: 'message', listener: (channel: string, message: string) => void): this {
    this.listeners.delete(listener);
    return this;
  }

  emit(channel: string, message: string): void {
    for (const listener of this.listeners) listener(channel, message);
  }
}

export async function readJson<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function createHarness(): Harness {
  const repo = createMemoryRepository();
  const tokens: TokenMap = new Map();
  const github: StubbedGithub = {
    getResponses: new Map(),
    branchResponses: new Map(),
    branchShas: new Map(),
    createdBranches: [],
    existingBranches: new Set(),
    fileShas: new Map(),
    putFileCalls: [],
    prCalls: [],
    prResponses: new Map(),
    userRepos: [],
    lastToken: undefined,
  };
  const redis = new FakeRedis();
  const broadcaster = new SSEBroadcaster(redis);

  const stripe = createStripeStub();
  const deps: AppDeps = {
    repo,
    verifyToken: createVerifyTokenStub(tokens),
    githubClient: createGithubStub(github),
    stripe: stripe.client,
    billing: {
      freeMinutesPerMonth: 60,
      usageSubscriptionItemPerUser: new Map(),
      priceIds: { pro: 'price_pro', team: 'price_team' },
      successUrl: 'https://app.local/billing/success',
      cancelUrl: 'https://app.local/billing/cancel',
      portalReturnUrl: 'https://app.local/settings/billing',
    },
    rateLimit: makeMemoryStore(),
    redis,
    broadcaster,
  };

  const app = createApp({
    deps,
    dashboardOrigin: 'http://localhost:3000',
    logger: silentLogger,
  });

  const authedFetch = async (
    path: string,
    init: RequestInit & { token?: string } = {},
  ) => {
    const { token, headers, ...rest } = init;
    const finalHeaders = new Headers(headers);
    if (token) finalHeaders.set('authorization', `Bearer ${token}`);
    if (!finalHeaders.has('content-type') && init.body) {
      finalHeaders.set('content-type', 'application/json');
    }
    return app.fetch(
      new Request(`http://test.local${path}`, {
        ...rest,
        headers: finalHeaders,
      }),
    );
  };

  return {
    app,
    repo,
    tokens,
    github,
    stripe: stripe.stub,
    deps,
    redis,
    broadcaster,
    authedFetch,
  };
}
