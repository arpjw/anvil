import { mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { getLspClient, type LspDiagnostic } from '../lsp/client.js';

export type { LspDiagnostic };

export interface ShadowResult {
  clean: boolean;
  diagnostics: LspDiagnostic[];
}

const SHADOW_BASE = '/tmp/anvil';

function shadowPath(sessionId: string, absFilePath: string): string {
  // Mirror the absolute path under the session shadow dir.
  // e.g. /home/user/proj/src/foo.ts → /tmp/anvil/<id>/shadow/home/user/proj/src/foo.ts
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

// Write proposed content to the shadow copy, run LSP diagnostics, and report
// the result. The real file on disk is never touched.
export async function shadowWrite(
  sessionId: string,
  absFilePath: string,
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

  // Only TypeScript errors block a commit; warnings are advisory.
  const errors = diagnostics.filter(d => d.severity === 'error');
  const clean = !lspError && errors.length === 0;

  appendLog(sessionId, {
    file: absFilePath,
    proposed: newContent.slice(0, 300) + (newContent.length > 300 ? '…' : ''),
    diagnostics: errors.slice(0, 10).map(d => `${d.line}:${d.character} ${d.message}`),
    outcome: lspError ? 'lsp-error' : clean ? 'committed' : 'rejected',
    ...(lspError ? { lspError } : {}),
  });

  return { clean, diagnostics: errors };
}

// Copy the shadow file to the real filesystem path.
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
