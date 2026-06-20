import { mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { getLspClient, type LspDiagnostic } from '../lsp/client.js';
import { generateDiff, applySelectedHunks } from '../diff/engine.js';
import { uiStream } from '../ui/stream.js';

export type { LspDiagnostic };

export interface ShadowResult {
  clean: boolean;
  diagnostics: LspDiagnostic[];
  finalContent: string;
  allRejected: boolean;
}

const SHADOW_BASE = '/tmp/anvil';

function shadowPath(sessionId: string, absFilePath: string): string {
  const stripped = absFilePath.startsWith('/') ? absFilePath.slice(1) : absFilePath;
  return join(SHADOW_BASE, sessionId, 'shadow', stripped);
}

function logPath(sessionId: string): string {
  return join(SHADOW_BASE, sessionId, 'shadow.log');
}

function appendLog(sessionId: string, entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  const lp = logPath(sessionId);
  mkdirSync(dirname(lp), { recursive: true });
  appendFileSync(lp, line, 'utf-8');
}

export async function shadowWrite(
  sessionId: string,
  absFilePath: string,
  originalContent: string,
  newContent: string,
  workdir: string,
): Promise<ShadowResult> {
  const sp = shadowPath(sessionId, absFilePath);
  mkdirSync(dirname(sp), { recursive: true });
  writeFileSync(sp, newContent, 'utf-8');

  let diagnostics: LspDiagnostic[] = [];
  let lspError: string | undefined;

  try {
    const lsp = await getLspClient(workdir);
    diagnostics = await lsp.checkContent(absFilePath, newContent);
  } catch (err) {
    lspError = (err as Error).message;
  }

  const errors = diagnostics.filter(d => d.severity === 'error');
  const clean = !lspError && errors.length === 0;

  appendLog(sessionId, {
    file: absFilePath,
    proposed: newContent.slice(0, 300) + (newContent.length > 300 ? '…' : ''),
    diagnostics: errors.slice(0, 10).map(d => `${d.line}:${d.character} ${d.message}`),
    outcome: lspError ? 'lsp-error' : clean ? 'committed' : 'rejected',
    ...(lspError ? { lspError } : {}),
  });

  if (!clean) {
    return { clean: false, diagnostics: errors, finalContent: originalContent, allRejected: false };
  }

  // Show diff and wait for user's hunk selection (skipped in headless — auto-resolved externally).
  const diff = generateDiff(originalContent, newContent, absFilePath);

  let finalContent = newContent;
  let allRejected = false;

  if (diff.hunks.length > 0) {
    const acceptedIndices = await uiStream.waitForDiffResolution(absFilePath, diff);
    allRejected = acceptedIndices.size === 0;
    finalContent = applySelectedHunks(originalContent, diff.hunks, acceptedIndices);
  }

  // Write the final content (possibly partial) back to the shadow for record-keeping.
  writeFileSync(sp, finalContent, 'utf-8');

  return { clean: true, diagnostics: [], finalContent, allRejected };
}

// Write content directly to the real filesystem path.
export function commitContent(absFilePath: string, content: string): void {
  mkdirSync(dirname(absFilePath), { recursive: true });
  writeFileSync(absFilePath, content, 'utf-8');
}

// Copy the shadow file to the real filesystem path (legacy, kept for compatibility).
export async function commitToReal(sessionId: string, absFilePath: string): Promise<void> {
  const sp = shadowPath(sessionId, absFilePath);
  mkdirSync(dirname(absFilePath), { recursive: true });
  copyFileSync(sp, absFilePath);
}

// Remove all shadow and log files for a session.
export function clearSession(sessionId: string): void {
  const dir = join(SHADOW_BASE, sessionId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export function formatDiagnostics(diags: LspDiagnostic[]): string {
  if (diags.length === 0) return '(no errors)';
  return diags
    .map(d => `  ${d.file}:${d.line}:${d.character} — ${d.message}`)
    .join('\n');
}
