import { embeddingService } from '../services/embedding/index.js';
import { textSearch } from './text_search.js';

export interface SemanticSearchOptions {
  topK?: number;
}

const MAX_PREVIEW = 400;

// Session-scoped semantic search over the workdir's code chunks.
// Falls back to text_search if the embedding service has no index for this
// session (e.g. running without VOYAGE_API_KEY and indexing hasn't happened yet).
export async function semanticSearch(
  query: string,
  sessionId: string,
  workdir: string,
  options: SemanticSearchOptions = {},
): Promise<string> {
  const topK = options.topK ?? 5;

  if (!embeddingService.hasSession(sessionId)) {
    // Fall back to ripgrep so the planner still gets useful signal
    const fallback = await textSearch(query, '.', workdir, { maxResults: topK }).catch(
      () => 'No matches (fallback text_search failed).',
    );
    return `[semantic index not ready — falling back to text_search]\n${fallback}`;
  }

  const results = await embeddingService.query(sessionId, query, topK);
  if (results.length === 0) return 'No matches found.';

  const lines: string[] = [];
  for (const r of results) {
    const preview = r.text.length > MAX_PREVIEW
      ? r.text.slice(0, MAX_PREVIEW) + '\n… (truncated)'
      : r.text;
    lines.push(
      `${r.filepath}:${r.startLine}-${r.endLine}  score=${r.score.toFixed(3)}`,
      preview,
      '',
    );
  }
  return lines.join('\n').trimEnd();
}
