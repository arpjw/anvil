import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { Plan } from '../agents/planner.js';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  sessionId: string;
  planJson?: Plan;
  filesModified?: string[];
}

export interface ConversationHistory {
  id: string;
  workdir: string;
  turns: ConversationTurn[];
  createdAt: Date;
  updatedAt: Date;
}

interface SerialisedTurn extends Omit<ConversationTurn, 'timestamp'> {
  timestamp: string;
}

interface SerialisedHistory extends Omit<ConversationHistory, 'turns' | 'createdAt' | 'updatedAt'> {
  turns: SerialisedTurn[];
  createdAt: string;
  updatedAt: string;
}

const HISTORY_CAP = 100; // hard ceiling on turns kept on disk
const SUMMARY_CAP = 10;   // how many turns are surfaced to the planner

function historyPath(workdir: string): string {
  return join(workdir, '.anvil', 'conversation.json');
}

export function loadConversation(workdir: string): ConversationHistory | null {
  const path = historyPath(workdir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as SerialisedHistory;
    return {
      id: parsed.id,
      workdir: parsed.workdir,
      createdAt: new Date(parsed.createdAt),
      updatedAt: new Date(parsed.updatedAt),
      turns: parsed.turns.map((t) => ({
        ...t,
        timestamp: new Date(t.timestamp),
      })),
    };
  } catch {
    return null;
  }
}

export function saveConversation(workdir: string, history: ConversationHistory): void {
  const path = historyPath(workdir);
  mkdirSync(dirname(path), { recursive: true });
  const serialised: SerialisedHistory = {
    id: history.id,
    workdir: history.workdir,
    createdAt: history.createdAt.toISOString(),
    updatedAt: history.updatedAt.toISOString(),
    turns: history.turns.map((t) => ({
      ...t,
      timestamp: t.timestamp.toISOString(),
    })),
  };
  writeFileSync(path, JSON.stringify(serialised, null, 2), 'utf-8');
}

export function appendTurn(
  workdir: string,
  turn: ConversationTurn,
): ConversationHistory {
  const now = new Date();
  let history = loadConversation(workdir);
  if (!history) {
    history = {
      id: turn.sessionId,
      workdir,
      turns: [],
      createdAt: now,
      updatedAt: now,
    };
  }
  history.turns.push(turn);
  history.updatedAt = now;
  // Cap the number of turns on disk so the file stays bounded.
  if (history.turns.length > HISTORY_CAP) {
    history.turns = history.turns.slice(-HISTORY_CAP);
  }
  saveConversation(workdir, history);
  return history;
}

// Formats the tail of the conversation for injection into the planner /
// orchestrator system prompt.
export function summarizeHistory(history: ConversationHistory): string {
  if (history.turns.length === 0) return '';
  const tail = history.turns.slice(-SUMMARY_CAP);
  const lines: string[] = ['Prior conversation:'];
  let n = 1;
  for (const turn of tail) {
    if (turn.role === 'user') {
      lines.push(`Turn ${n}: User asked: ${truncate(turn.content, 200)}`);
    } else {
      const files =
        turn.filesModified && turn.filesModified.length > 0
          ? ` Modified: ${turn.filesModified.join(', ')}.`
          : '';
      lines.push(`Turn ${n}: Assistant: ${truncate(turn.content, 300)}.${files}`);
    }
    n++;
  }
  return lines.join('\n');
}

export function turnCount(workdir: string): number {
  const history = loadConversation(workdir);
  return history?.turns.length ?? 0;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
