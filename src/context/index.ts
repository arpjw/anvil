import { resolveMentions } from './mentions.js';
import { loadRules, loadMemory, loadIgnore } from './project.js';

export { appendMemory } from './project.js';
export type { ResolvedContext } from './mentions.js';

export interface AnvilContext {
  files: Array<{ path: string; content: string }>;
  symbols: Array<{ name: string; definition: string; references: string[] }>;
  docs: Array<{ url: string; content: string }>;
  web: Array<{ query: string; results: string[] }>;
  cleanRequest: string;
  rules: string | null;
  memory: string | null;
  ignorePatterns: string[];
}

export async function loadContext(request: string, workdir: string): Promise<AnvilContext> {
  const [mentions, rules, memory, ignorePatterns] = await Promise.all([
    resolveMentions(request, workdir),
    Promise.resolve(loadRules(workdir)),
    Promise.resolve(loadMemory(workdir)),
    Promise.resolve(loadIgnore(workdir)),
  ]);

  return { ...mentions, rules, memory, ignorePatterns };
}

export function buildContextSection(ctx: AnvilContext): string {
  const parts: string[] = [];

  for (const f of ctx.files) {
    parts.push(`The user explicitly referenced this file: ${f.path}\n${f.content}`);
  }

  for (const s of ctx.symbols) {
    parts.push(`Symbol context for @${s.name}:\n${s.definition}`);
  }

  for (const d of ctx.docs) {
    parts.push(`Documentation context from ${d.url}:\n${d.content}`);
  }

  for (const w of ctx.web) {
    const resultsText = w.results.map((r, i) => `[${i + 1}] ${r}`).join('\n\n');
    parts.push(`Web search results for '${w.query}':\n${resultsText}`);
  }

  return parts.join('\n\n---\n\n');
}
