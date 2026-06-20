import { mkdirSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { shadowWrite, commitContent, formatDiagnostics } from '../shadow/workspace.js';
import { uiStream } from '../ui/stream.js';

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

  uiStream.push({ type: 'shadow_attempt', file: fullPath, attempt, maxAttempts: MAX_RETRIES });

  // Read original content before writing (empty string for new files).
  let originalContent = '';
  try {
    if (existsSync(fullPath)) originalContent = readFileSync(fullPath, 'utf-8');
  } catch { /* treat as empty */ }

  let result;
  try {
    mkdirSync(dirname(fullPath), { recursive: true });
    result = await shadowWrite(sessionId, fullPath, originalContent, content, workdir);
  } catch (err) {
    return `Error writing ${path}: ${(err as Error).message}`;
  }

  if (result.clean) {
    retryCounters.delete(retryKey);

    if (result.allRejected) {
      uiStream.push({ type: 'shadow_result', file: fullPath, errorCount: 0, outcome: 'committed' });
      return `User rejected all changes to ${path} — file unchanged.`;
    }

    commitContent(fullPath, result.finalContent);
    uiStream.push({ type: 'shadow_result', file: fullPath, errorCount: 0, outcome: 'committed' });
    uiStream.push({ type: 'file_modified', path: fullPath });
    const tag = attempt > 1 ? ` (self-corrected on attempt ${attempt})` : '';
    return `Wrote ${fullPath}${tag}`;
  }

  if (attempt >= MAX_RETRIES) {
    retryCounters.delete(retryKey);
    uiStream.push({ type: 'shadow_result', file: fullPath, errorCount: result.diagnostics.length, outcome: 'escalated' });
    return (
      `ESCALATION: ${path} still has TypeScript errors after ${MAX_RETRIES} attempts. ` +
      `Manual intervention required.\n\nErrors:\n${formatDiagnostics(result.diagnostics)}`
    );
  }

  uiStream.push({ type: 'shadow_result', file: fullPath, errorCount: result.diagnostics.length, outcome: 'retry' });
  return (
    `TypeScript errors in ${path} (attempt ${attempt}/${MAX_RETRIES}). ` +
    `Fix the errors below and call write_file again with the corrected content:\n\n` +
    formatDiagnostics(result.diagnostics)
  );
}
