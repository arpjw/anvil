import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { loadConversation, type ConversationTurn } from './conversation.js';

const SHADOW_BASE = '/tmp/anvil';

export type SessionStatus = 'complete' | 'failed' | 'aborted' | 'unknown';

export interface SessionRecord {
  sessionId: string;
  date: Date;
  request: string;
  filesModified: string[];
  turnCount: number;
  estimatedCost?: number;
  durationSeconds?: number;
  status: SessionStatus;
}

export interface SessionDetail extends SessionRecord {
  fullRequest: string;
  fileLineCounts: Array<{ path: string; lineCount: number | null }>;
  turns: ConversationTurn[];
  shadowEntries: ShadowEntry[];
  workflowPhase: string | null;
  prPath: string | null;
}

export interface ShadowEntry {
  timestamp: string;
  file: string;
  outcome: string;
  diagnostics: string[];
}

// ── Sources ──────────────────────────────────────────────────────────────────

function readMemoryEntries(workdir: string): Array<{
  sessionId: string;
  date: Date;
  summary: string;
}> {
  const memPath = join(workdir, '.anvil', 'memory.md');
  if (!existsSync(memPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(memPath, 'utf-8');
  } catch {
    return [];
  }
  const blocks = raw.split(/\n---\n/).map((b) => b.trim()).filter(Boolean);
  const out: Array<{ sessionId: string; date: Date; summary: string }> = [];
  const header = /^##\s+Session\s+([0-9a-f]{8})\s+—\s+(\d{4}-\d{2}-\d{2})/;
  for (const block of blocks) {
    const line = block.split('\n')[0]!;
    const m = header.exec(line);
    if (!m) continue;
    const summary = block.split('\n').slice(1).join('\n').trim();
    out.push({
      sessionId: m[1]!,
      date: new Date(m[2]!),
      summary,
    });
  }
  return out;
}

function readShadowLog(sessionId: string): ShadowEntry[] {
  const logPath = join(SHADOW_BASE, sessionId, 'shadow.log');
  if (!existsSync(logPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf-8');
  } catch {
    return [];
  }
  const out: ShadowEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      out.push({
        timestamp: String(parsed.ts ?? ''),
        file: String(parsed.file ?? ''),
        outcome: String(parsed.outcome ?? ''),
        diagnostics: Array.isArray(parsed.diagnostics)
          ? (parsed.diagnostics as string[])
          : [],
      });
    } catch { /* skip malformed line */ }
  }
  return out;
}

function readWorkflowPhase(sessionId: string): string | null {
  const wfPath = join(SHADOW_BASE, sessionId, 'workflow.json');
  if (!existsSync(wfPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(wfPath, 'utf-8')) as { phase?: string };
    return parsed.phase ?? null;
  } catch {
    return null;
  }
}

interface PersistedUsageOnDisk {
  sessionId?: string;
  estimatedCostUSD?: number;
  durationSeconds?: number;
  completedAt?: string;
}

// Reads .anvil/sessions/<sessionId>.json (matched by full id or 8-char prefix).
// Returns null if the file doesn't exist or is malformed.
function readPersistedUsage(
  workdir: string,
  sessionIdOrShort: string,
): { estimatedCost: number; durationSeconds: number; completedAt?: string } | null {
  const dir = join(workdir, '.anvil', 'sessions');
  if (!existsSync(dir)) return null;
  const short = sessionIdOrShort.slice(0, 8);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const match = entries.find(
    (e) =>
      (e.startsWith(sessionIdOrShort) || e.startsWith(short)) &&
      e.endsWith('.json'),
  );
  if (!match) return null;

  try {
    const raw = readFileSync(join(dir, match), 'utf-8');
    const parsed = JSON.parse(raw) as PersistedUsageOnDisk;
    if (
      parsed.estimatedCostUSD === undefined &&
      parsed.durationSeconds === undefined
    ) {
      return null;
    }
    return {
      estimatedCost: parsed.estimatedCostUSD ?? 0,
      durationSeconds: parsed.durationSeconds ?? 0,
      completedAt: parsed.completedAt,
    };
  } catch {
    return null;
  }
}

function findPrPath(sessionId: string): string | null {
  const dir = join(SHADOW_BASE, sessionId);
  if (!existsSync(dir)) return null;
  try {
    const entries = readdirSync(dir);
    const match = entries.find((e) => e.startsWith('pr-') && e.endsWith('.md'));
    return match ? join(dir, match) : null;
  } catch {
    return null;
  }
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function statusFromTurns(turns: ConversationTurn[]): SessionStatus {
  const assistant = turns.find((t) => t.role === 'assistant');
  if (!assistant) return 'unknown';
  const c = assistant.content.toLowerCase();
  if (c.includes('rejected by user')) return 'aborted';
  if (c.includes('verification failed') || c.includes('failed')) return 'failed';
  return 'complete';
}

// ── Public API ───────────────────────────────────────────────────────────────

export function listHistory(workdir: string): SessionRecord[] {
  // Group conversation turns by sessionId.
  const conv = loadConversation(workdir);
  const bySession = new Map<string, ConversationTurn[]>();
  if (conv) {
    for (const turn of conv.turns) {
      const short = shortId(turn.sessionId);
      const list = bySession.get(short) ?? [];
      list.push(turn);
      bySession.set(short, list);
    }
  }

  // Add memory entries as a secondary source.
  const memEntries = readMemoryEntries(workdir);
  const memBySession = new Map(memEntries.map((m) => [m.sessionId, m]));

  const knownIds = new Set<string>([
    ...bySession.keys(),
    ...memBySession.keys(),
  ]);

  const records: SessionRecord[] = [];
  for (const sid of knownIds) {
    const turns = bySession.get(sid) ?? [];
    const mem = memBySession.get(sid);
    const firstUser = turns.find((t) => t.role === 'user');
    const assistant = turns.find((t) => t.role === 'assistant');

    // Pick a date: earliest turn, else memory date, else /tmp mtime.
    let date: Date;
    if (turns.length > 0) {
      date = turns
        .map((t) => t.timestamp.getTime())
        .reduce((a, b) => Math.min(a, b), Number.MAX_SAFE_INTEGER)
        === Number.MAX_SAFE_INTEGER
        ? new Date()
        : new Date(Math.min(...turns.map((t) => t.timestamp.getTime())));
    } else if (mem) {
      date = mem.date;
    } else {
      try {
        date = statSync(join(SHADOW_BASE, sid)).mtime;
      } catch {
        date = new Date(0);
      }
    }

    const request = firstUser?.content
      ?? mem?.summary.split('\n')[0]
      ?? '(no request recorded)';

    const filesModified = Array.from(new Set(assistant?.filesModified ?? []));

    // Prefer the full session UUID from turns (so persisted-usage lookup
    // matches by full id), fall back to the 8-char key.
    const fullId = turns[0]?.sessionId ?? sid;
    const persisted = readPersistedUsage(workdir, fullId);

    records.push({
      sessionId: sid,
      date,
      request,
      filesModified,
      turnCount: turns.length,
      estimatedCost: persisted?.estimatedCost,
      durationSeconds: persisted?.durationSeconds,
      status: statusFromTurns(turns),
    });
  }

  records.sort((a, b) => b.date.getTime() - a.date.getTime());
  return records;
}

// ── Formatting ───────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= n) return oneLine.padEnd(n);
  return oneLine.slice(0, n - 1) + '…';
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'complete': return chalk.green('complete');
    case 'failed':   return chalk.red('failed  ');
    case 'aborted':  return chalk.yellow('aborted ');
    case 'unknown':  return chalk.dim('unknown ');
  }
}

export function formatHistory(records: SessionRecord[]): string {
  if (records.length === 0) return '';

  const lines: string[] = [];
  const header = [
    chalk.bold('DATE'.padEnd(10)),
    chalk.bold('REQUEST'.padEnd(40)),
    chalk.bold('FILES'.padStart(5)),
    chalk.bold('COST'.padStart(7)),
    chalk.bold('STATUS'),
  ].join('  ');
  lines.push(header);
  lines.push(chalk.dim('─'.repeat(80)));

  for (const r of records) {
    const dateStr = r.date.toISOString().slice(0, 10);
    const req = truncate(r.request, 40);
    const files = String(r.filesModified.length).padStart(5);
    const cost = r.estimatedCost !== undefined
      ? ('$' + r.estimatedCost.toFixed(2)).padStart(7)
      : chalk.dim('   -- ');
    lines.push([
      dateStr,
      req,
      files,
      cost,
      statusLabel(r.status),
    ].join('  '));
  }

  return lines.join('\n');
}

// ── Detail ───────────────────────────────────────────────────────────────────

function countLines(absPath: string): number | null {
  try {
    return readFileSync(absPath, 'utf-8').split('\n').length;
  } catch {
    return null;
  }
}

export function getSession(
  workdir: string,
  sessionId: string,
): SessionDetail | null {
  const short = sessionId.slice(0, 8);
  const conv = loadConversation(workdir);
  const turns = conv?.turns.filter((t) => shortId(t.sessionId) === short) ?? [];
  const mem = readMemoryEntries(workdir).find((m) => m.sessionId === short);

  if (turns.length === 0 && !mem) return null;

  const firstUser = turns.find((t) => t.role === 'user');
  const assistant = turns.find((t) => t.role === 'assistant');
  const filesModified = Array.from(new Set(assistant?.filesModified ?? []));

  const fileLineCounts = filesModified.map((f) => ({
    path: f,
    lineCount: countLines(f),
  }));

  // Try to find a fuller sessionId under /tmp so shadow.log lookup can use it.
  let fullId = short;
  try {
    const entries = readdirSync(SHADOW_BASE);
    const match = entries.find((e) => e.startsWith(short));
    if (match) fullId = match;
  } catch { /* /tmp/anvil may not exist */ }

  const shadowEntries = readShadowLog(fullId);
  const workflowPhase = readWorkflowPhase(fullId);
  const prPath = findPrPath(fullId);

  let date: Date;
  if (turns.length > 0) {
    date = new Date(Math.min(...turns.map((t) => t.timestamp.getTime())));
  } else if (mem) {
    date = mem.date;
  } else {
    date = new Date();
  }

  const persisted = readPersistedUsage(workdir, fullId);

  return {
    sessionId: fullId,
    date,
    request: firstUser?.content ?? mem?.summary.split('\n')[0] ?? '(unknown)',
    fullRequest: firstUser?.content ?? mem?.summary ?? '(unknown)',
    filesModified,
    fileLineCounts,
    turnCount: turns.length,
    turns,
    shadowEntries,
    workflowPhase,
    prPath,
    estimatedCost: persisted?.estimatedCost,
    durationSeconds: persisted?.durationSeconds,
    status: statusFromTurns(turns),
  };
}

// Terminal-formatted detail view used by the `history <id>` subcommand.
export function formatSessionDetail(detail: SessionDetail): string {
  const lines: string[] = [];
  lines.push(chalk.bold(`Session ${detail.sessionId.slice(0, 8)}`) +
    chalk.dim(` · ${detail.date.toISOString().slice(0, 10)}`));
  lines.push(chalk.dim('─'.repeat(60)));
  lines.push('');
  lines.push(chalk.bold('Request'));
  lines.push(`  ${detail.fullRequest}`);
  lines.push('');

  lines.push(chalk.bold('Status'));
  lines.push(`  ${statusLabel(detail.status).trim()}` +
    (detail.workflowPhase ? chalk.dim(`  (checkpoint at ${detail.workflowPhase})`) : ''));
  if (detail.estimatedCost !== undefined || detail.durationSeconds !== undefined) {
    const parts: string[] = [];
    if (detail.estimatedCost !== undefined) {
      parts.push(`~$${detail.estimatedCost.toFixed(2)}`);
    }
    if (detail.durationSeconds !== undefined) {
      const s = detail.durationSeconds;
      parts.push(s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
    }
    lines.push(`  ${chalk.dim(parts.join('  ·  '))}`);
  }
  lines.push('');

  if (detail.filesModified.length > 0) {
    lines.push(chalk.bold('Files modified'));
    for (const fc of detail.fileLineCounts) {
      const line =
        fc.lineCount !== null
          ? `  ${chalk.green('+')} ${fc.path}  ${chalk.dim(`(${fc.lineCount} lines now)`)}`
          : `  ${chalk.green('+')} ${fc.path}  ${chalk.dim('(no longer on disk)')}`;
      lines.push(line);
    }
    lines.push('');
  }

  if (detail.turns.length > 0) {
    lines.push(chalk.bold(`Conversation (${detail.turns.length} turns)`));
    for (let i = 0; i < detail.turns.length; i++) {
      const t = detail.turns[i]!;
      const role = t.role === 'user' ? chalk.cyan('user') : chalk.magenta('assistant');
      lines.push(`  ${chalk.dim(`#${i + 1}`)} ${role} ${chalk.dim(t.timestamp.toISOString())}`);
      for (const contentLine of t.content.split('\n').slice(0, 8)) {
        lines.push(`      ${contentLine}`);
      }
      if (t.content.split('\n').length > 8) {
        lines.push(chalk.dim(`      … (${t.content.split('\n').length - 8} more lines)`));
      }
    }
    lines.push('');
  }

  if (detail.shadowEntries.length > 0) {
    const shown = detail.shadowEntries.slice(-10);
    lines.push(chalk.bold(`Shadow log (last ${shown.length}/${detail.shadowEntries.length})`));
    for (const e of shown) {
      const color =
        e.outcome === 'committed' ? chalk.green :
        e.outcome === 'rejected' ? chalk.yellow :
        e.outcome === 'lsp-error' ? chalk.red :
        chalk.dim;
      lines.push(`  ${color(e.outcome.padEnd(10))} ${e.file}`);
      if (e.diagnostics.length > 0) {
        for (const d of e.diagnostics.slice(0, 3)) {
          lines.push(chalk.dim(`      ${d}`));
        }
      }
    }
    lines.push('');
  }

  if (detail.prPath) {
    lines.push(chalk.bold('PR description'));
    lines.push(`  ${detail.prPath}`);
  }

  return lines.join('\n');
}

// Best-effort detection of whether a positional arg looks like a session id.
export function looksLikeSessionId(s: string): boolean {
  if (s.includes('/') || s.startsWith('.') || s.startsWith('~')) return false;
  return /^[0-9a-f]{8}([0-9a-f-]{0,28})?$/.test(s);
}
