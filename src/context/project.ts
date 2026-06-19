import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const ANVIL_DIR = '.anvil';
const MAX_MEMORY_CHARS = 2000;

export function loadRules(workdir: string): string | null {
  const rulesPath = join(workdir, ANVIL_DIR, 'rules.md');
  if (!existsSync(rulesPath)) return null;
  try {
    return readFileSync(rulesPath, 'utf-8');
  } catch {
    return null;
  }
}

export function loadMemory(workdir: string): string | null {
  const memPath = join(workdir, ANVIL_DIR, 'memory.md');
  if (!existsSync(memPath)) return null;
  try {
    const content = readFileSync(memPath, 'utf-8');
    if (content.length <= MAX_MEMORY_CHARS) return content;
    // Return only the last MAX_MEMORY_CHARS — most recent entries are at the end
    return content.slice(content.length - MAX_MEMORY_CHARS);
  } catch {
    return null;
  }
}

export function appendMemory(workdir: string, sessionId: string, summary: string): void {
  const anvilDir = join(workdir, ANVIL_DIR);
  const memPath = join(anvilDir, 'memory.md');

  mkdirSync(anvilDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const entry = `## Session ${sessionId.slice(0, 8)} — ${date}\n${summary}\n---\n`;

  if (existsSync(memPath)) {
    const existing = readFileSync(memPath, 'utf-8');
    const sep = existing.endsWith('\n') ? '' : '\n';
    writeFileSync(memPath, existing + sep + entry, 'utf-8');
  } else {
    writeFileSync(memPath, entry, 'utf-8');
  }
}

export function loadIgnore(workdir: string): string[] {
  const ignorePath = join(workdir, ANVIL_DIR, 'ignore');
  if (!existsSync(ignorePath)) return [];
  try {
    const content = readFileSync(ignorePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}
