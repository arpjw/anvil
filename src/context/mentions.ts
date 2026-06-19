import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join, basename, relative } from 'path';
import { textSearch } from '../tools/text_search.js';
import { findSymbol } from '../tools/find_symbol.js';

export interface ResolvedContext {
  files: Array<{ path: string; content: string }>;
  symbols: Array<{ name: string; definition: string; references: string[] }>;
  docs: Array<{ url: string; content: string }>;
  web: Array<{ query: string; results: string[] }>;
  cleanRequest: string;
}

const MAX_FILE_CHARS = 40_000;
const MAX_DOC_CHARS = 8_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', 'build']);

type MentionKind = 'url' | 'web' | 'symbol' | 'file';

function classifyMention(token: string): MentionKind {
  if (token.startsWith('http://') || token.startsWith('https://')) return 'url';
  if (token.startsWith('web:')) return 'web';
  // PascalCase / UpperCamelCase with no path separators → symbol
  if (/^[A-Z][a-zA-Z0-9]*$/.test(token)) return 'symbol';
  return 'file';
}

function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?)]+$/, '');
}

function findFileInWorkdir(nameOrPath: string, workdir: string): string | null {
  const exact = resolve(workdir, nameOrPath);
  if (existsSync(exact)) return exact;

  const target = basename(nameOrPath);

  function walk(dir: string): string | null {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.name === target) {
        return full;
      }
    }
    return null;
  }

  return walk(workdir);
}

async function resolveFileMention(
  token: string,
  workdir: string,
): Promise<{ path: string; content: string } | null> {
  const fullPath = findFileInWorkdir(token, workdir);
  if (!fullPath) return null;
  try {
    let content = readFileSync(fullPath, 'utf-8');
    if (content.length > MAX_FILE_CHARS) {
      content = content.slice(0, MAX_FILE_CHARS) + '\n... (truncated)';
    }
    return { path: fullPath, content };
  } catch {
    return null;
  }
}

async function resolveSymbolMention(
  name: string,
  workdir: string,
): Promise<{ name: string; definition: string; references: string[] } | null> {
  try {
    const searchResult = await textSearch(`\\b${name}\\b`, '.', workdir, { maxResults: 3 });
    if (!searchResult || searchResult.startsWith('No matches') || searchResult.startsWith('Error')) {
      return null;
    }
    // Result format: "filepath:line:content"
    const firstLine = searchResult.split('\n')[0];
    const colonIdx = firstLine.indexOf(':');
    if (colonIdx === -1) return null;
    const filePath = firstLine.slice(0, colonIdx);

    const definition = await findSymbol(name, filePath, workdir);
    return { name, definition, references: [] };
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  let text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

async function resolveDocsMention(url: string): Promise<{ url: string; content: string } | null> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AnvilBot/1.0)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    let text = stripHtml(html);
    if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS) + '...';
    return { url, content: text };
  } catch {
    return null;
  }
}

async function resolveWebMention(
  query: string,
): Promise<{ query: string; results: string[] } | null> {
  const apiKey = process.env.TAVILY_API_KEY;

  if (apiKey) {
    try {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query, max_results: 3 }),
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.ok) {
        const data = await resp.json() as {
          results?: Array<{ title?: string; url?: string; content?: string }>;
        };
        const results = (data.results ?? []).map(r =>
          [r.title, r.url, r.content].filter(Boolean).join('\n'),
        );
        if (results.length > 0) return { query, results };
      }
    } catch { /* fall through to DuckDuckGo */ }
  }

  // DuckDuckGo fallback
  try {
    const resp = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AnvilBot/1.0)' },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!resp.ok) return null;
    const html = await resp.text();
    const snippetRe = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const titleRe = /<a class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
    const titles: string[] = [];
    const snippets: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = titleRe.exec(html)) !== null && titles.length < 3) {
      titles.push(stripHtml(m[1]));
    }
    while ((m = snippetRe.exec(html)) !== null && snippets.length < 3) {
      snippets.push(stripHtml(m[1]));
    }
    const results = titles
      .map((t, i) => `${t}\n${snippets[i] ?? ''}`.trim())
      .filter(Boolean);
    if (results.length === 0) return null;
    return { query, results };
  } catch {
    return null;
  }
}

export async function resolveMentions(
  request: string,
  workdir: string,
): Promise<ResolvedContext> {
  type Token = { raw: string; token: string; kind: MentionKind };
  const tokens: Token[] = [];

  // Allow . inside tokens (for file extensions and paths); strip trailing punctuation after capture.
  const mentionRe = /@(https?:\/\/\S+|web:\S+|[^\s@,;:!?()\[\]{}'"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = mentionRe.exec(request)) !== null) {
    const raw = m[0];
    const token = stripTrailingPunct(m[1]);
    const kind = classifyMention(token);
    tokens.push({ raw, token, kind });
  }

  const cleanRequest = request.replace(/@(https?:\/\/\S+|web:\S+|[^\s@,;:!?()\[\]{}'"]+)/g, '').replace(/\s+/g, ' ').trim();

  const fileTokens = tokens.filter(t => t.kind === 'file');
  const symbolTokens = tokens.filter(t => t.kind === 'symbol');
  const docsTokens = tokens.filter(t => t.kind === 'url');
  const webTokens = tokens.filter(t => t.kind === 'web');

  const [fileResults, symbolResults, docsResults, webResults] = await Promise.all([
    Promise.all(fileTokens.map(t => resolveFileMention(t.token, workdir))),
    Promise.all(symbolTokens.map(t => resolveSymbolMention(t.token, workdir))),
    Promise.all(docsTokens.map(t => resolveDocsMention(t.token))),
    Promise.all(webTokens.map(t => resolveWebMention(t.token.slice('web:'.length)))),
  ]);

  return {
    files: fileResults.filter((r): r is NonNullable<typeof r> => r !== null),
    symbols: symbolResults.filter((r): r is NonNullable<typeof r> => r !== null),
    docs: docsResults.filter((r): r is NonNullable<typeof r> => r !== null),
    web: webResults.filter((r): r is NonNullable<typeof r> => r !== null),
    cleanRequest,
  };
}
