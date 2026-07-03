import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const ANVIL_DIR = '.anvil';
const MAX_MEMORY_CHARS = 2000;
const SUMMARIZE_THRESHOLD = 50;
const KEEP_RECENT = 10;

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

  // If the file has grown past the threshold, kick off summarisation in the
  // background. Errors are swallowed — memory is best-effort.
  const entryCount = countEntries(workdir);
  if (entryCount >= SUMMARIZE_THRESHOLD) {
    void summarizeMemory(workdir).catch(() => { /* non-fatal */ });
  }
}

// Splits memory.md by the `---\n` separator into entries. Any leading "summary"
// block is treated as a single entry (it has one `---` at the end of the
// summarised paragraph and we don't want to re-summarise it).
function readEntries(workdir: string): {
  summaryBlock: string | null;
  entries: string[];
} {
  const memPath = join(workdir, ANVIL_DIR, 'memory.md');
  if (!existsSync(memPath)) return { summaryBlock: null, entries: [] };
  const raw = readFileSync(memPath, 'utf-8');
  const parts = raw
    .split(/\n---\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const summaryBlock =
    parts[0] && parts[0].startsWith('## Summarized memory') ? parts[0] : null;
  const entries = summaryBlock ? parts.slice(1) : parts;
  return { summaryBlock, entries };
}

function countEntries(workdir: string): number {
  return readEntries(workdir).entries.length;
}

// Rewrites memory.md so that entries older than the most recent KEEP_RECENT
// are collapsed into a summary paragraph. Uses Haiku 4.5 via the OpenAI SDK
// compatibility shim; if no ANTHROPIC_API_KEY is set, no-ops.
export async function summarizeMemory(workdir: string): Promise<void> {
  const { entries, summaryBlock } = readEntries(workdir);
  if (entries.length < SUMMARIZE_THRESHOLD) return;

  const olderEntries = entries.slice(0, entries.length - KEEP_RECENT);
  const recentEntries = entries.slice(entries.length - KEEP_RECENT);
  if (olderEntries.length === 0) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return; // silent no-op — summarisation is best-effort

  const prompt = [
    'Summarize these Anvil session memory entries into a compact paragraph',
    'capturing key facts, recurring patterns, and important decisions. Be',
    'specific and concrete. Max 200 words.',
    '',
    ...(summaryBlock ? ['Prior summary (extend, do not restate):', summaryBlock, ''] : []),
    'Entries:',
    olderEntries.map((e, i) => `--- Entry ${i + 1} ---\n${e}`).join('\n\n'),
  ].join('\n');

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.anthropic.com/v1',
  });

  const response = await client.chat.completions.create({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 800,
  });
  const summary = response.choices[0]?.message?.content?.trim();
  if (!summary) return;

  const date = new Date().toISOString().slice(0, 10);
  const header = `## Summarized memory (${olderEntries.length} sessions, summarized on ${date})`;
  const parts: string[] = [
    `${header}\n${summary}`,
    ...recentEntries,
  ];
  const rewritten = parts.join('\n---\n') + '\n---\n';

  writeFileSync(join(workdir, ANVIL_DIR, 'memory.md'), rewritten, 'utf-8');
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
