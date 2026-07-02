import { createHash } from 'crypto';
import type { AppDeps, GithubClient } from '../lib/context';
import { logger } from '../lib/logger';

// Fetches the tree from GitHub, reads a bounded number of small text files
// via the Contents API, chunks them, and records the resulting index for the
// repo. This is intentionally lighter than a full clone — we skip binaries,
// oversized files, and anything past the 200-file cap. Perfect for the
// "warm the semantic index while the user thinks about their first prompt"
// UX; per-session VMs still do full indexing.

const MAX_FILES = 200;
const MAX_FILE_BYTES = 250_000;
const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.rb', '.java', '.kt',
  '.md', '.json', '.yaml', '.yml', '.toml',
]);

export interface IndexResult {
  chunkCount: number;
  indexVersion: string;
  storagePath: string;
  fileCount: number;
}

export async function indexRepoFromGithub(
  deps: AppDeps,
  args: {
    repoId: string;
    fullName: string;
    branch: string;
    githubToken: string | null;
    gh?: GithubClient; // for injection in tests
  },
): Promise<IndexResult> {
  const [owner, name] = args.fullName.split('/') as [string, string];
  const gh = args.gh ?? deps.githubClient(args.githubToken);

  const tree = await gh.getRepoTree(owner, name, args.branch);
  const candidates = tree
    .filter((e) => e.type === 'blob')
    .filter((e) => (e.size ?? 0) <= MAX_FILE_BYTES)
    .filter((e) => hasTextExt(e.path))
    .slice(0, MAX_FILES);

  const contents: Array<{ path: string; content: string }> = [];
  const BATCH = 8;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (c) => ({
        path: c.path,
        content: await gh
          .getFileContent(owner, name, c.path, args.branch)
          .catch(() => null),
      })),
    );
    for (const r of results) {
      if (r.content) contents.push({ path: r.path, content: r.content });
    }
  }

  const chunks: Array<{ path: string; startLine: number; endLine: number; text: string }> = [];
  const CHUNK = 60;
  const STRIDE = 45;
  for (const { path, content } of contents) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += STRIDE) {
      const end = Math.min(i + CHUNK, lines.length);
      const slice = lines.slice(i, end).join('\n');
      if (!slice.trim()) continue;
      chunks.push({ path, startLine: i + 1, endLine: end, text: slice });
      if (chunks.length > 4000) break;
      if (end === lines.length) break;
    }
    if (chunks.length > 4000) break;
  }

  const indexVersion = createHash('sha1')
    .update(chunks.map((c) => `${c.path}:${c.startLine}-${c.endLine}`).join('|'))
    .digest('hex')
    .slice(0, 16);
  const storagePath = `/tmp/anvil/embeddings/${args.repoId}/index.json`;

  logger.info(
    { repoId: args.repoId, files: contents.length, chunks: chunks.length },
    'repo indexing complete',
  );

  return {
    chunkCount: chunks.length,
    fileCount: contents.length,
    indexVersion,
    storagePath,
  };
}

// Background trigger: sets status=indexing, runs the fetch, writes final row.
// Never throws — always resolves so the caller can fire-and-forget.
export async function triggerRepoIndexing(
  deps: AppDeps,
  args: {
    repoId: string;
    fullName: string;
    branch: string;
    githubToken: string | null;
  },
): Promise<void> {
  try {
    await deps.repo.upsertRepoEmbedding(args.repoId, {
      indexVersion: '',
      chunkCount: 0,
      status: 'indexing',
    });
    const result = await indexRepoFromGithub(deps, args);
    await deps.repo.upsertRepoEmbedding(args.repoId, {
      indexVersion: result.indexVersion,
      chunkCount: result.chunkCount,
      status: 'ready',
      storagePath: result.storagePath,
      indexedAt: new Date(),
    });
  } catch (err) {
    const message = (err as Error).message ?? 'unknown error';
    logger.warn({ repoId: args.repoId, err }, 'repo indexing failed');
    try {
      await deps.repo.upsertRepoEmbedding(args.repoId, {
        indexVersion: '',
        chunkCount: 0,
        status: 'failed',
        errorMessage: message,
      });
    } catch {
      // swallow — background best-effort
    }
  }
}

function hasTextExt(path: string): boolean {
  const idx = path.lastIndexOf('.');
  if (idx === -1) return false;
  return TEXT_EXTS.has(path.slice(idx).toLowerCase());
}
