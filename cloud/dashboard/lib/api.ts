import type { Diff, Repo, Session, SessionDetail } from './types';

const PROXY_BASE = '/api/proxy';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(`${PROXY_BASE}${path}`, init);
  if (!res.ok) {
    let code = 'http_error';
    let message = res.statusText;
    try {
      const data = (await res.json()) as { error?: { code: string; message: string } };
      if (data.error) {
        code = data.error.code;
        message = data.error.message;
      }
    } catch {
      // ignore parse failures
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface CreateSessionInput {
  repoId: string;
  branch: string;
  request: string;
  model: string;
}

export async function getSessions(): Promise<Session[]> {
  const data = await request<{ sessions: Session[] }>('GET', '/sessions');
  return data.sessions;
}

export async function getSession(id: string): Promise<SessionDetail> {
  const data = await request<{ session: SessionDetail }>('GET', `/sessions/${id}`);
  return data.session;
}

export async function createSession(body: CreateSessionInput): Promise<Session> {
  const data = await request<{ session: Session }>('POST', '/sessions', body);
  return data.session;
}

export async function approveSession(id: string): Promise<Session> {
  const data = await request<{ session: Session }>('POST', `/sessions/${id}/approve`);
  return data.session;
}

export async function rejectSession(id: string): Promise<Session> {
  const data = await request<{ session: Session }>('POST', `/sessions/${id}/reject`);
  return data.session;
}

export async function abortSession(id: string): Promise<Session> {
  const data = await request<{ session: Session }>('DELETE', `/sessions/${id}`);
  return data.session;
}

export async function getRepos(): Promise<Repo[]> {
  const data = await request<{ repos: Repo[] }>('GET', '/repos');
  return data.repos;
}

export async function connectRepo(
  fullName: string,
  defaultBranch: string,
): Promise<Repo> {
  const data = await request<{ repo: Repo }>('POST', '/repos', {
    fullName,
    defaultBranch,
  });
  return data.repo;
}

export async function deleteRepo(id: string): Promise<void> {
  await request<void>('DELETE', `/repos/${id}`);
}

export interface GithubRepoSummary {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export async function listGithubRepos(): Promise<GithubRepoSummary[]> {
  const data = await request<{ repos: GithubRepoSummary[] }>(
    'GET',
    '/github/repos',
  );
  return data.repos;
}

export async function getRepoBranches(id: string): Promise<string[]> {
  const data = await request<{ branches: Array<{ name: string }> | string[] }>(
    'GET',
    `/repos/${id}/branches`,
  );
  const branches = data.branches;
  if (branches.length === 0) return [];
  if (typeof branches[0] === 'string') return branches as string[];
  return (branches as Array<{ name: string }>).map((b) => b.name);
}

export async function getDiffs(sessionId: string): Promise<Diff[]> {
  const data = await request<{ diffs: Diff[] }>(
    'GET',
    `/sessions/${sessionId}/diffs`,
  );
  return data.diffs;
}

export async function approveDiff(
  sessionId: string,
  diffId: string,
): Promise<Diff> {
  const data = await request<{ diff: Diff }>(
    'POST',
    `/sessions/${sessionId}/diffs/${diffId}/approve`,
  );
  return data.diff;
}

export async function rejectDiff(
  sessionId: string,
  diffId: string,
): Promise<Diff> {
  const data = await request<{ diff: Diff }>(
    'POST',
    `/sessions/${sessionId}/diffs/${diffId}/reject`,
  );
  return data.diff;
}

export async function approveAllDiffs(
  sessionId: string,
): Promise<{ count: number }> {
  return request<{ count: number }>(
    'POST',
    `/sessions/${sessionId}/diffs/approve-all`,
  );
}

export interface OpenPrResult {
  prUrl: string;
  session: Session;
}

export async function openPullRequest(
  sessionId: string,
): Promise<OpenPrResult> {
  return request<OpenPrResult>('POST', `/sessions/${sessionId}/pr`);
}

export interface UsageResponse {
  period: { start: string; end: string | null };
  minutes: number;
  records: Array<{
    id: string;
    sessionId: string;
    minutes: number;
    createdAt: string;
    reportedAt: string | null;
  }>;
  planTier: 'free' | 'pro' | 'team';
  freeMinutesPerMonth: number;
}

export async function getUsage(): Promise<UsageResponse> {
  return request<UsageResponse>('GET', '/billing/usage');
}

export async function startCheckout(
  plan: 'pro' | 'team',
): Promise<{ url: string }> {
  return request<{ url: string }>('POST', '/billing/checkout', { plan });
}

export async function openBillingPortal(): Promise<{ url: string }> {
  return request<{ url: string }>('POST', '/billing/portal');
}

export type { Diff, Repo, Session, SessionDetail } from './types';
export type { UIEvent } from './types';
