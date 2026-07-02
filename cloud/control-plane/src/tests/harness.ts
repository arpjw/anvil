import { createApp } from '../app';
import { pino } from 'pino';
import type { AppDeps, GithubClient, VerifyTokenFn } from '../lib/context';
import { SSEBroadcaster } from '../events/broadcaster';
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
  PrState,
  Repo,
  Session,
  SessionStatus,
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
} {
  const usersById = new Map<string, User>();
  const reposById = new Map<string, Repo>();
  const sessionsById = new Map<string, Session>();
  const eventsById = new Map<string, Event>();
  const diffsById = new Map<string, Diff>();

  return {
    _users: usersById,
    _repos: reposById,
    _sessions: sessionsById,
    _events: eventsById,
    _diffs: diffsById,

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

  const deps: AppDeps = {
    repo,
    verifyToken: createVerifyTokenStub(tokens),
    githubClient: createGithubStub(github),
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

  return { app, repo, tokens, github, deps, redis, broadcaster, authedFetch };
}
