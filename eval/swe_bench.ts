import { existsSync, mkdirSync, createWriteStream } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';

/**
 * A single SWE-bench Verified task.
 * All strings are the same shape you'd get from the upstream dataset.
 */
export interface SWETask {
  instanceId: string;         // e.g. "django__django-11099"
  repoUrl: string;            // e.g. "https://github.com/django/django"
  baseCommit: string;         // commit hash to check out before applying anything
  problemStatement: string;   // the issue description shown to the agent
  patch: string;              // gold patch — never shown to the agent, kept for reference
  testPatch: string;          // test-file changes that verify the fix
  failToPass: string[];       // tests that must go from failing to passing
  passToPass: string[];       // tests that must stay passing
}

const HF_PARQUET_URL =
  'https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified/resolve/main/data/test-00000-of-00001.parquet';
const HF_ROWS_URL =
  'https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified&config=default&split=test';

const CACHE_DIR = '/tmp/anvil-eval/cache';

/**
 * Fetches the first `limit` SWE-bench Verified tasks.
 *
 * Tries two paths in order:
 *   1. Download the parquet file and parse it with `parquetjs-lite`.
 *      Note: parquetjs-lite doesn't support SNAPPY compression, which is
 *      how the upstream file is compressed, so this path fails today for
 *      the real dataset. Kept because the spec asked for it, and it'll
 *      work if you swap the reader for `hyparquet` or a decompressed copy.
 *   2. Fall back to HuggingFace's datasets-server REST API, which serves
 *      the same records as JSON without any compression handling.
 */
export async function downloadTasks(limit: number): Promise<SWETask[]> {
  try {
    const rows = await fetchViaParquet(limit);
    return rows.slice(0, limit);
  } catch (parquetErr) {
    console.warn(
      `[swe_bench] parquet path failed (${(parquetErr as Error).message.slice(0, 100)}), ` +
        `falling back to datasets-server JSON API.`,
    );
    return fetchViaJsonApi(limit);
  }
}

// ── Parquet path ─────────────────────────────────────────────────────────────

async function fetchViaParquet(limit: number): Promise<SWETask[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, 'swe_bench_verified.parquet');

  if (!existsSync(cachePath)) {
    console.log(`[swe_bench] downloading parquet → ${cachePath}`);
    const res = await fetch(HF_PARQUET_URL);
    if (!res.ok || !res.body) {
      throw new Error(`parquet download failed: HTTP ${res.status}`);
    }
    await pipeline(
      res.body as unknown as NodeJS.ReadableStream,
      createWriteStream(cachePath),
    );
  }

  // parquetjs-lite is CommonJS + untyped, so hop through the dynamic import boundary.
  // @ts-expect-error — no upstream types
  const parquetMod = (await import('parquetjs-lite')) as unknown as {
    ParquetReader: {
      openFile: (path: string) => Promise<{
        getCursor: () => { next: () => Promise<Record<string, unknown> | null> };
        close: () => Promise<void>;
      }>;
    };
  };
  const reader = await parquetMod.ParquetReader.openFile(cachePath);
  const cursor = reader.getCursor();
  const tasks: SWETask[] = [];
  let record: Record<string, unknown> | null;
  while ((record = await cursor.next()) !== null) {
    tasks.push(rowToTask(record));
    if (tasks.length >= limit) break;
  }
  await reader.close();
  return tasks;
}

// ── JSON API path ───────────────────────────────────────────────────────────

async function fetchViaJsonApi(limit: number): Promise<SWETask[]> {
  const tasks: SWETask[] = [];
  const PAGE = 100;
  for (let offset = 0; offset < limit; offset += PAGE) {
    const url = `${HF_ROWS_URL}&offset=${offset}&length=${Math.min(PAGE, limit - offset)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`datasets-server responded ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const parsed = (await res.json()) as {
      rows: Array<{ row: Record<string, unknown> }>;
    };
    if (!parsed.rows) throw new Error('datasets-server response missing "rows"');
    for (const item of parsed.rows) {
      tasks.push(rowToTask(item.row));
      if (tasks.length >= limit) return tasks;
    }
    if (parsed.rows.length === 0) break;
  }
  return tasks;
}

// ── Row normalisation ────────────────────────────────────────────────────────

function rowToTask(row: Record<string, unknown>): SWETask {
  const s = (k: string): string => {
    const v = row[k];
    if (typeof v !== 'string') return '';
    return v;
  };
  const parseTestList = (raw: unknown): string[] => {
    // Upstream may hand these back as a JSON-string, an already-parsed array,
    // or a null/undefined. Handle all of them.
    if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.filter((x): x is string => typeof x === 'string');
        }
      } catch { /* not JSON */ }
    }
    return [];
  };

  const repoSlug = s('repo'); // "django/django"
  return {
    instanceId: s('instance_id'),
    repoUrl: repoSlug ? `https://github.com/${repoSlug}` : '',
    baseCommit: s('base_commit'),
    problemStatement: s('problem_statement'),
    patch: s('patch'),
    testPatch: s('test_patch'),
    failToPass: parseTestList(row.FAIL_TO_PASS),
    passToPass: parseTestList(row.PASS_TO_PASS),
  };
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

export async function clearCache(): Promise<void> {
  if (!existsSync(CACHE_DIR)) return;
  await fs.rm(CACHE_DIR, { recursive: true, force: true });
}
