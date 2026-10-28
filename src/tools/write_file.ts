import { readFileSync, existsSync } from 'fs';
import { workspacePath } from './workspace_path.js';
import { shadowWrite, commitContent, recordCommitted, formatDiagnostics } from '../shadow/workspace.js';
import { generateDiff } from '../diff/engine.js';
import { uiStream } from '../ui/stream.js';

const retryCounters = new Map<string, number>();
const MAX_RETRIES = 3;

export async function writeFile(
  path: string,
  content: string,
  workdir: string,
  sessionId: string,
): Promise<string> {
  let fullPath: string;
  try { fullPath = workspacePath(workdir, path); }
  catch (err) { return `Error writing ${path}: ${(err as Error).message}`; }
  const retryKey = `${sessionId}:${fullPath}`;

  const attempt = (retryCounters.get(retryKey) ?? 0) + 1;
  retryCounters.set(retryKey, attempt);

  uiStream.push({ type: 'shadow_attempt', file: fullPath, attempt, maxAttempts: MAX_RETRIES });

  // Read original content before writing (empty string for new files).
  const originalExists = existsSync(fullPath);
  let originalContent = '';
  try {
    if (existsSync(fullPath)) originalContent = readFileSync(fullPath, 'utf-8');
  } catch (err) { return `Error reading ${path}: ${(err as Error).message}`; }

  let result;
  try {
    result = await shadowWrite(sessionId, fullPath, originalContent, content, workdir);
  } catch (err) {
    return `Error writing ${path}: ${(err as Error).message}`;
  }

  if (result.clean) {
    retryCounters.delete(retryKey);

    if (result.allRejected) {
      uiStream.push({ type: 'shadow_result', file: fullPath, errorCount: 0, outcome: 'rejected' });
      return `User rejected all changes to ${path} — file unchanged.`;
    }

    if (originalExists && result.finalContent === originalContent) {
      return `Wrote ${fullPath} (unchanged)`;
    }
    try {
      workspacePath(workdir, path);
      commitContent(fullPath, result.finalContent, { content: originalContent, exists: originalExists });
      recordCommitted(sessionId, fullPath, result.finalContent);
    } catch (err) {
      return `Error writing ${path}: ${(err as Error).message}`;
    }
    uiStream.push({ type: 'shadow_result', file: fullPath, errorCount: 0, outcome: 'committed' });
    uiStream.push({ type: 'file_modified', path: fullPath });

    // Stream the committed diff so downstream consumers (TUI, dashboard, cloud
    // event pipeline) can render it immediately without waiting for session end.
    if (result.finalContent !== originalContent) {
      const diff = generateDiff(originalContent, result.finalContent, fullPath);
      if (diff.hunks.length > 0) {
        uiStream.push({
          type: 'file_diff',
          filepath: fullPath,
          originalContent,
          newContent: result.finalContent,
          diff,
          sessionId,
        });
      }
    }

    const tag = attempt > 1 ? ` (self-corrected on attempt ${attempt})` : '';
    return `Wrote ${fullPath}${tag}`;
  }

  if (attempt >= MAX_RETRIES) {
    retryCounters.delete(retryKey);
    uiStream.push({ type: 'shadow_result', file: fullPath, errorCount: result.diagnostics.length, outcome: 'escalated' });
    return (
      `ESCALATION: ${path} could not be validated after ${MAX_RETRIES} attempts. ` +
      `Manual intervention required.\n\nErrors:\n${(result.validationError ?? formatDiagnostics(result.diagnostics))}`
    );
  }

  uiStream.push({ type: 'shadow_result', file: fullPath, errorCount: result.diagnostics.length, outcome: 'retry' });
  return (
    `Validation failed for ${path} (attempt ${attempt}/${MAX_RETRIES}). ` +
    `Fix the errors below and call write_file again with the corrected content:\n\n` +
    (result.validationError ?? formatDiagnostics(result.diagnostics))
  );
}
