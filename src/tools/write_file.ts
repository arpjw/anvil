import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { shadowWrite, commitToReal, formatDiagnostics } from '../shadow/workspace.js';

// Per-session, per-file retry counter. Tracks how many times write_file has
// been called for a given file without clean diagnostics, so we can escalate
// after MAX_RETRIES failed attempts.
const retryCounters = new Map<string, number>();
const MAX_RETRIES = 3;

export async function writeFile(
  path: string,
  content: string,
  workdir: string,
  sessionId: string,
): Promise<string> {
  const fullPath = resolve(workdir, path);
  const retryKey = `${sessionId}:${fullPath}`;

  const attempt = (retryCounters.get(retryKey) ?? 0) + 1;
  retryCounters.set(retryKey, attempt);

  let result;
  try {
    mkdirSync(dirname(fullPath), { recursive: true });
    result = await shadowWrite(sessionId, fullPath, content, workdir);
  } catch (err) {
    return `Error writing ${path}: ${(err as Error).message}`;
  }

  if (result.clean) {
    retryCounters.delete(retryKey);
    await commitToReal(sessionId, fullPath);
    const tag = attempt > 1 ? ` (self-corrected on attempt ${attempt})` : '';
    return `Wrote ${fullPath}${tag}`;
  }

  if (attempt >= MAX_RETRIES) {
    retryCounters.delete(retryKey);
    return (
      `ESCALATION: ${path} still has TypeScript errors after ${MAX_RETRIES} attempts. ` +
      `Manual intervention required.\n\nErrors:\n${formatDiagnostics(result.diagnostics)}`
    );
  }

  return (
    `TypeScript errors in ${path} (attempt ${attempt}/${MAX_RETRIES}). ` +
    `Fix the errors below and call write_file again with the corrected content:\n\n` +
    formatDiagnostics(result.diagnostics)
  );
}
