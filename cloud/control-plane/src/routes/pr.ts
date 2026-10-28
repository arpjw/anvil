import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { AppDeps, AppEnv } from '../lib/context';
import type { Session, Diff } from '../db/schema';

export interface OpenPrParams {
  session: Session & { repoFullName: string };
  approvedDiffs: Diff[];
  githubToken: string | null;
  deps: AppDeps;
}

export interface OpenPrResult {
  prUrl: string;
  session: Session;
}

export async function openPr({
  session,
  approvedDiffs,
  githubToken,
  deps,
}: OpenPrParams): Promise<OpenPrResult> {
  if (session.status !== 'complete') throw new HttpError(409, 'session_incomplete', 'Finish execution and verification before opening a PR.');
  if (session.prUrl) return { prUrl: session.prUrl, session };
  if (approvedDiffs.length === 0) {
    throw new HttpError(
      400,
      'no_approved_diffs',
      'no approved diffs to open a PR from',
    );
  }
  if (!session.repoFullName.includes('/')) {
    throw new HttpError(500, 'bad_repo', 'session has no repo');
  }
  const [owner, repoName] = session.repoFullName.split('/') as [string, string];
  const gh = deps.githubClient(githubToken);

  const baseSha = await gh.getBranchSha(owner, repoName, session.branch);
  const headBranch = `anvil/session-${session.id.slice(0, 8)}`;

  try {
    await gh.createBranch(owner, repoName, headBranch, baseSha);
  } catch (err) {
    if (err instanceof HttpError && err.code === 'branch_exists') {
      // idempotent: reuse existing branch
    } else {
      throw err;
    }
  }

  for (const diff of approvedDiffs) {
    const existingSha = await gh.getFileSha(
      owner,
      repoName,
      diff.filepath,
      headBranch,
    );
    await gh.putFile(owner, repoName, {
      path: diff.filepath,
      branch: headBranch,
      message: `anvil: ${diff.filepath}`,
      content: diff.newContent ?? '',
      sha: existingSha,
    });
  }

  const title = `anvil: ${session.request.slice(0, 60)}${
    session.request.length > 60 ? '…' : ''
  }`;
  const body = renderPrBody(session, approvedDiffs);

  const { url } = await gh.createPullRequest(owner, repoName, {
    title,
    body,
    head: headBranch,
    base: session.branch,
  });

  const updated = await deps.repo.updateSessionPrUrl(session.id, url);
  return { prUrl: url, session: updated };
}

function renderPrBody(session: Session, diffs: Diff[]): string {
  const filesList = diffs.map((d) => `- \`${d.filepath}\``).join('\n');
  return [
    '### Request',
    session.request,
    '',
    '### Files changed',
    filesList,
    '',
    `_Opened by Anvil session \`${session.id.slice(0, 8)}\`._`,
  ].join('\n');
}

export function prRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth());

  r.post('/sessions/:id/pr', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const sessionId = c.req.param('id');
    const session = await deps.repo.findSessionById(sessionId);
    if (!session || session.userId !== user.id) {
      throw new HttpError(404, 'not_found', 'session not found');
    }
    const approvedDiffs = (
      await deps.repo.listDiffsBySession(session.id)
    ).filter((d) => d.status === 'approved');

    try {
      const result = await openPr({
        session,
        approvedDiffs,
        githubToken: user.githubAccessToken,
        deps,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      logger.error(
        { sessionId, err: { message: (err as Error).message } },
        'failed to open PR',
      );
      throw new HttpError(502, 'pr_failed', (err as Error).message);
    }
  });

  return r;
}
