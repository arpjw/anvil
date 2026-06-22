import { createApp } from '../app';
import { pino } from 'pino';
import type { AppDeps, GithubClient, VerifyTokenFn } from '../lib/context';
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
        request: input.request!,
        model: input.model ?? 'claude-sonnet-4-6',
        planJson: input.planJson ?? null,
        vmIp: input.vmIp ?? null,
        vmPort: input.vmPort ?? null,
        prUrl: input.prUrl ?? null,
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
      sessionsById.set(id, next);
      return next;
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

export type StubbedGithub = {
  getResponses: Map<string, { defaultBranch: string } | { error: number }>;
  branchResponses: Map<string, Array<{ name: string; sha: string }>>;
};

export function createGithubStub(stub: StubbedGithub) {
  return (_token: string | null | undefined): GithubClient => ({
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
  });
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
  authedFetch: (
    path: string,
    init?: RequestInit & { token?: string },
  ) => Promise<Response>;
};

export async function readJson<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function createHarness(): Harness {
  const repo = createMemoryRepository();
  const tokens: TokenMap = new Map();
  const github: StubbedGithub = {
    getResponses: new Map(),
    branchResponses: new Map(),
  };

  const deps: AppDeps = {
    repo,
    verifyToken: createVerifyTokenStub(tokens),
    githubClient: createGithubStub(github),
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

  return { app, repo, tokens, github, deps, authedFetch };
}
