import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, extname, join, relative, resolve } from 'path';
import { listFilesWalk } from './walker.js';
import { parseFile, queryNodes, type AstNode } from '../../treesitter/index.js';

const EMBEDDING_STORAGE_BASE = '/tmp/anvil/embeddings';

// ── Public types ──────────────────────────────────────────────────────────────

export interface Chunk {
  text: string;
  filepath: string;
  startLine: number;
  endLine: number;
}

export interface EmbeddedChunk extends Chunk {
  vector: SparseVector | number[];
}

export interface QueryResult extends Chunk {
  score: number;
}

export interface SearchResult {
  text: string;
  score: number;
  index: number;
}

export interface EmbeddingServiceOptions {
  modelId: string;
  apiKey?: string | null;
}

// A sparse vector for the TF-IDF fallback path
type SparseVector = Map<string, number>;

interface SessionIndex {
  chunks: EmbeddedChunk[];
  vocabulary?: Map<string, number>; // token → idf, only used in TF-IDF mode
  mode: 'voyage' | 'tfidf';
  fileMtimes: Record<string, number>; // relative filepath → mtime ms
  repoId?: string;
}

export interface EnsureIndexedOptions {
  ignorePatterns?: string[];
  repoId?: string;
}

interface PersistedIndex {
  version: string;
  mode: 'voyage' | 'tfidf';
  chunks: SerialisedChunk[];
  fileMtimes: Record<string, number>;
  vocabulary?: Array<[string, number]>;
  indexedAt: string;
}

interface SerialisedChunk {
  filepath: string;
  startLine: number;
  endLine: number;
  text: string;
  vector: number[] | Array<[string, number]>; // dense or sparse
  sparse: boolean;
}

export interface LoadResult {
  hit: boolean;
  staleFiles: string[];
}

// ── Service ──────────────────────────────────────────────────────────────────

export class EmbeddingService {
  private readonly modelId: string;
  private readonly apiKey: string | null;
  private readonly sessions = new Map<string, SessionIndex>();
  private readonly indexingPromises = new Map<string, Promise<void>>();
  private running = false;

  constructor(options: EmbeddingServiceOptions) {
    this.modelId = options.modelId;
    this.apiKey = options.apiKey ?? process.env.VOYAGE_API_KEY ?? null;
  }

  get mode(): 'voyage' | 'tfidf' {
    return this.apiKey ? 'voyage' : 'tfidf';
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.sessions.clear();
    this.indexingPromises.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.indexingPromises.delete(sessionId);
  }

  // Idempotent: only walks + indexes the first time it's called for a session.
  // If repoId is provided, first tries to load a persisted index and only
  // re-indexes files whose mtime has changed since the last write.
  ensureIndexed(
    sessionId: string,
    workdir: string,
    opts?: EnsureIndexedOptions,
  ): Promise<void> {
    const existing = this.indexingPromises.get(sessionId);
    if (existing) return existing;
    if (this.sessions.has(sessionId)) return Promise.resolve();
    const promise = this.doIndexWorkdir(sessionId, workdir, opts);
    this.indexingPromises.set(sessionId, promise);
    return promise;
  }

  async index(
    sessionId: string,
    chunks: Chunk[],
    opts?: { fileMtimes?: Record<string, number>; repoId?: string },
  ): Promise<{ indexed: number }> {
    if (chunks.length === 0) {
      this.sessions.set(sessionId, {
        chunks: [],
        mode: this.mode,
        fileMtimes: opts?.fileMtimes ?? {},
        repoId: opts?.repoId,
      });
      return { indexed: 0 };
    }
    const embedded = await this.embedChunks(chunks);
    const session: SessionIndex = {
      chunks: embedded.chunks,
      vocabulary: embedded.vocabulary,
      mode: this.mode,
      fileMtimes: opts?.fileMtimes ?? {},
      repoId: opts?.repoId,
    };
    this.sessions.set(sessionId, session);
    return { indexed: chunks.length };
  }

  async query(sessionId: string, query: string, topK = 5): Promise<QueryResult[]> {
    const session = this.sessions.get(sessionId);
    if (!session || session.chunks.length === 0) return [];

    const queryVec = session.mode === 'voyage'
      ? await this.embedVoyage([query]).then(vs => vs[0]!)
      : this.tfidfVector(tokenize(query), session.vocabulary ?? new Map());

    const results = session.chunks
      .map((chunk, idx) => {
        const score = session.mode === 'voyage'
          ? cosineDense(queryVec as number[], chunk.vector as number[])
          : cosineSparse(queryVec as SparseVector, chunk.vector as SparseVector);
        return { chunk, score, idx };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return results.map(({ chunk, score }) => ({
      text: chunk.text,
      filepath: chunk.filepath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score,
    }));
  }

  // Ad-hoc search: build an ephemeral index just for this call. Useful for
  // callers who have a corpus in hand without wanting to persist it.
  async search(query: string, corpus: string[], topK = 5): Promise<SearchResult[]> {
    if (corpus.length === 0) return [];

    if (this.mode === 'voyage') {
      const all = await this.embedVoyage([query, ...corpus]);
      const [q, ...docs] = all;
      return docs
        .map((v, i) => ({ text: corpus[i]!, score: cosineDense(q!, v), index: i }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    }

    const tokenizedCorpus = corpus.map(tokenize);
    const vocab = buildIdfVocabulary(tokenizedCorpus);
    const corpusVecs = tokenizedCorpus.map(t => this.tfidfVector(t, vocab));
    const queryVec = this.tfidfVector(tokenize(query), vocab);
    return corpusVecs
      .map((v, i) => ({ text: corpus[i]!, score: cosineSparse(queryVec, v), index: i }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.mode === 'voyage') return this.embedVoyage(texts);
    // Deterministic TF-IDF: build an ephemeral vocabulary over the input
    const tokenized = texts.map(tokenize);
    const vocab = buildIdfVocabulary(tokenized);
    return tokenized.map(t => sparseToDense(this.tfidfVector(t, vocab), vocab));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async doIndexWorkdir(
    sessionId: string,
    workdir: string,
    opts?: EnsureIndexedOptions,
  ): Promise<void> {
    try {
      const repoId = opts?.repoId;

      // Cache-first: try to load a persisted index and only re-embed changed files.
      if (repoId) {
        const loaded = await this.loadPersistedIndex(repoId, sessionId, workdir);
        if (loaded.hit) {
          if (loaded.staleFiles.length > 0) {
            await this.incrementalUpdate(repoId, sessionId, workdir, loaded.staleFiles);
          }
          return;
        }
      }

      const { chunks, mtimes } = collectChunks(workdir, opts?.ignorePatterns);
      await this.index(sessionId, chunks, { fileMtimes: mtimes, repoId });
      if (repoId) await this.persistIndex(repoId, sessionId);
    } finally {
      this.indexingPromises.delete(sessionId);
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  async persistIndex(repoId: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const path = persistPath(repoId);
    mkdirSync(dirname(path), { recursive: true });

    const chunks: SerialisedChunk[] = session.chunks.map((c) => {
      const isSparse = c.vector instanceof Map;
      const vector = isSparse
        ? Array.from((c.vector as SparseVector).entries())
        : (c.vector as number[]);
      return {
        filepath: c.filepath,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        vector,
        sparse: isSparse,
      };
    });

    const persisted: PersistedIndex = {
      version: computeIndexVersion(session.fileMtimes),
      mode: session.mode,
      chunks,
      fileMtimes: session.fileMtimes,
      vocabulary: session.vocabulary
        ? Array.from(session.vocabulary.entries())
        : undefined,
      indexedAt: new Date().toISOString(),
    };

    writeFileSync(path, JSON.stringify(persisted), 'utf-8');
  }

  async loadPersistedIndex(
    repoId: string,
    sessionId: string,
    workdir: string,
  ): Promise<LoadResult> {
    const path = persistPath(repoId);
    if (!existsSync(path)) return { hit: false, staleFiles: [] };

    let parsed: PersistedIndex;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as PersistedIndex;
    } catch {
      return { hit: false, staleFiles: [] };
    }

    // If the persisted index is in a different embedding mode than the current
    // service, treat as miss — vectors are incompatible.
    if (parsed.mode !== this.mode) return { hit: false, staleFiles: [] };

    const chunks: EmbeddedChunk[] = parsed.chunks.map((c) => ({
      text: c.text,
      filepath: c.filepath,
      startLine: c.startLine,
      endLine: c.endLine,
      vector: c.sparse
        ? (new Map(c.vector as Array<[string, number]>) as SparseVector)
        : (c.vector as number[]),
    }));

    const vocabulary = parsed.vocabulary
      ? new Map<string, number>(parsed.vocabulary)
      : undefined;

    this.sessions.set(sessionId, {
      chunks,
      vocabulary,
      mode: parsed.mode,
      fileMtimes: parsed.fileMtimes,
      repoId,
    });

    // Check which persisted files are now stale.
    const staleFiles: string[] = [];
    for (const [relPath, mtime] of Object.entries(parsed.fileMtimes)) {
      const abs = resolve(workdir, relPath);
      let current: number;
      try {
        current = statSync(abs).mtimeMs;
      } catch {
        // File removed since indexing — mark stale so we drop its chunks.
        staleFiles.push(relPath);
        continue;
      }
      if (Math.floor(current) !== Math.floor(mtime)) staleFiles.push(relPath);
    }

    return { hit: true, staleFiles };
  }

  async incrementalUpdate(
    repoId: string,
    sessionId: string,
    workdir: string,
    changedFiles: string[],
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const stale = new Set(changedFiles);
    // Drop existing chunks for stale files.
    session.chunks = session.chunks.filter((c) => !stale.has(c.filepath));

    // Re-collect chunks for the changed files.
    const newChunks: Chunk[] = [];
    const updatedMtimes: Record<string, number> = { ...session.fileMtimes };
    for (const rel of changedFiles) {
      const abs = resolve(workdir, rel);
      try {
        const s = statSync(abs);
        if (!s.isFile()) {
          delete updatedMtimes[rel];
          continue;
        }
        if (s.size > 250_000) continue;
        const parsed = parseFile(abs);
        if (parsed) {
          newChunks.push(...chunkByAst(abs, parsed.content, workdir));
        } else if (isProbablyText(abs)) {
          const content = readFileSync(abs, 'utf-8');
          newChunks.push(...chunkByLines(abs, content, workdir));
        }
        updatedMtimes[rel] = s.mtimeMs;
      } catch {
        delete updatedMtimes[rel];
      }
    }

    if (newChunks.length > 0) {
      const embedded = await this.embedChunks(newChunks);
      session.chunks.push(...embedded.chunks);
      // TF-IDF mode: vocabulary would drift as chunks change. For MVP, keep the
      // vocabulary from the initial full index — new chunks still get scored
      // against it. Voyage vectors are self-contained per chunk.
    }

    session.fileMtimes = updatedMtimes;
    await this.persistIndex(repoId, sessionId);
  }

  private async embedChunks(chunks: Chunk[]): Promise<{
    chunks: EmbeddedChunk[];
    vocabulary?: Map<string, number>;
  }> {
    if (this.mode === 'voyage') {
      const vecs = await this.embedVoyage(chunks.map(c => c.text));
      return {
        chunks: chunks.map((c, i) => ({ ...c, vector: vecs[i]! })),
      };
    }
    const tokenized = chunks.map(c => tokenize(c.text));
    const vocab = buildIdfVocabulary(tokenized);
    const vectors = tokenized.map(t => this.tfidfVector(t, vocab));
    return {
      chunks: chunks.map((c, i) => ({ ...c, vector: vectors[i]! })),
      vocabulary: vocab,
    };
  }

  private async embedVoyage(texts: string[]): Promise<number[][]> {
    // Voyage caps batch size at 128 inputs; chunk defensively.
    const BATCH = 128;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH);
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ input: slice, model: this.modelId }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`voyage embeddings failed: ${res.status} ${body.slice(0, 200)}`);
      }
      const parsed = (await res.json()) as { data?: Array<{ embedding: number[] }> };
      const data = parsed.data ?? [];
      for (const d of data) out.push(d.embedding);
    }
    return out;
  }

  private tfidfVector(tokens: string[], vocab: Map<string, number>): SparseVector {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec: SparseVector = new Map();
    for (const [term, count] of tf) {
      const idf = vocab.get(term);
      if (idf === undefined) continue;
      vec.set(term, count * idf);
    }
    return vec;
  }
}

// ── Persistence helpers ──────────────────────────────────────────────────────

function persistPath(repoId: string): string {
  return join(EMBEDDING_STORAGE_BASE, repoId, 'index.json');
}

export function persistedIndexPath(repoId: string): string {
  return persistPath(repoId);
}

function computeIndexVersion(mtimes: Record<string, number>): string {
  const keys = Object.keys(mtimes).sort();
  const parts = keys.map((k) => `${k}:${Math.floor(mtimes[k] ?? 0)}`);
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function collectChunks(
  workdir: string,
  ignorePatterns?: string[],
): { chunks: Chunk[]; mtimes: Record<string, number> } {
  const files = listFilesWalk(workdir, ignorePatterns);
  const chunks: Chunk[] = [];
  const mtimes: Record<string, number> = {};
  for (const abs of files) {
    try {
      const s = statSync(abs);
      if (s.size > 250_000) continue;
      const rel = relative(workdir, abs) || abs;
      const parsed = parseFile(abs);
      if (parsed) {
        chunks.push(...chunkByAst(abs, parsed.content, workdir));
      } else if (isProbablyText(abs)) {
        const content = readFileSync(abs, 'utf-8');
        chunks.push(...chunkByLines(abs, content, workdir));
      } else {
        continue;
      }
      mtimes[rel] = s.mtimeMs;
      if (chunks.length > 4000) break;
    } catch {
      // skip unreadable
    }
  }
  return { chunks, mtimes };
}

// ── Chunking ─────────────────────────────────────────────────────────────────

function chunkByAst(filepath: string, content: string, workdir: string): Chunk[] {
  const lines = content.split('\n');
  const rel = relative(workdir, filepath) || filepath;
  const out: Chunk[] = [];

  const collected: AstNode[] = [];
  const parsed = parseFile(filepath);
  if (!parsed) return chunkByLines(filepath, content, workdir);
  for (const kind of ['functions', 'classes', 'interfaces', 'types'] as const) {
    for (const node of queryNodes(parsed.tree, kind)) collected.push(node);
  }

  // Deduplicate by line range (some nodes overlap)
  const seen = new Set<string>();
  for (const node of collected) {
    const key = `${node.startLine}-${node.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const slice = lines.slice(node.startLine - 1, node.endLine).join('\n');
    if (!slice.trim()) continue;
    out.push({
      text: `// ${rel}:${node.startLine}-${node.endLine} (${node.kind} ${node.name})\n${slice}`,
      filepath: rel,
      startLine: node.startLine,
      endLine: node.endLine,
    });
  }

  // Fall back to whole-file chunking if we found no structural nodes
  if (out.length === 0) return chunkByLines(filepath, content, workdir);
  return out;
}

function chunkByLines(filepath: string, content: string, workdir: string): Chunk[] {
  const rel = relative(workdir, filepath) || filepath;
  const lines = content.split('\n');
  const CHUNK = 60;
  const STRIDE = 45;
  const out: Chunk[] = [];
  for (let i = 0; i < lines.length; i += STRIDE) {
    const end = Math.min(i + CHUNK, lines.length);
    const slice = lines.slice(i, end).join('\n');
    if (!slice.trim()) continue;
    out.push({
      text: `// ${rel}:${i + 1}-${end}\n${slice}`,
      filepath: rel,
      startLine: i + 1,
      endLine: end,
    });
    if (end === lines.length) break;
  }
  return out;
}

const TEXT_EXTS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.rs', '.go', '.rb',
  '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.sh',
  '.css', '.scss', '.html',
]);
function isProbablyText(path: string): boolean {
  return TEXT_EXTS.has(extname(path).toLowerCase());
}

// ── Math helpers ─────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length >= 2 && t.length <= 40);
}

function buildIdfVocabulary(corpus: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of corpus) {
    const seen = new Set(doc);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = Math.max(1, corpus.length);
  const idf = new Map<string, number>();
  for (const [term, docFreq] of df) {
    idf.set(term, Math.log(1 + N / (1 + docFreq)));
  }
  return idf;
}

function sparseToDense(vec: SparseVector, vocab: Map<string, number>): number[] {
  const dense: number[] = [];
  for (const term of vocab.keys()) dense.push(vec.get(term) ?? 0);
  return dense;
}

function cosineSparse(a: SparseVector, b: SparseVector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [term, va] of small) {
    const vb = big.get(term);
    if (vb !== undefined) dot += va * vb;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function cosineDense(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── Singleton ────────────────────────────────────────────────────────────────

export const embeddingService = new EmbeddingService({
  modelId: process.env.EMBEDDING_MODEL ?? 'voyage-3',
});

// re-export the internal type so tools/tests can talk about it
export type { Chunk as EmbeddingChunk };
