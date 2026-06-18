import { spawn, type ChildProcess } from 'child_process';
import { pathToFileURL, fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LspLocation {
  uri: string;
  range: { start: LspPosition; end: LspPosition };
}

export interface LspPosition {
  line: number;      // 0-indexed
  character: number; // 0-indexed
}

// ---------------------------------------------------------------------------
// LspClient
// ---------------------------------------------------------------------------

export class LspClient {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private openedDocs = new Set<string>();
  private _workdir = '';
  private _ready = false;

  get ready(): boolean { return this._ready && this.proc !== null; }
  get workdir(): string { return this._workdir; }

  async start(workdir: string): Promise<void> {
    this._workdir = workdir;
    const serverBin = findServerBin(workdir);
    if (!serverBin) {
      throw new Error(
        'typescript-language-server not found. ' +
        'Run: npm install -D typescript-language-server typescript'
      );
    }

    this.proc = spawn(serverBin, ['--stdio'], {
      cwd: workdir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      this.flush();
    });

    this.proc.on('exit', () => {
      this._ready = false;
      this.proc = null;
    });

    await this.doInitialize(workdir);
    this._ready = true;
  }

  // -------------------------------------------------------------------------
  // Public document operations
  // -------------------------------------------------------------------------

  openDocument(filePath: string): void {
    if (!this.proc) return;
    const uri = pathToFileURL(filePath).toString();
    if (this.openedDocs.has(uri)) return;

    let text = '';
    try { text = readFileSync(filePath, 'utf-8'); } catch { return; }

    const ext = filePath.split('.').pop() ?? '';
    const languageId =
      ext === 'py' ? 'python' :
      (ext === 'ts' || ext === 'tsx') ? 'typescript' :
      'javascript';

    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.openedDocs.add(uri);
  }

  async getDefinition(filePath: string, line: number, char: number): Promise<LspLocation[]> {
    const uri = pathToFileURL(filePath).toString();
    const result = await this.request('textDocument/definition', {
      textDocument: { uri },
      position: { line, character: char },
    });
    return normalizeLocations(result);
  }

  async getReferences(filePath: string, line: number, char: number): Promise<LspLocation[]> {
    const uri = pathToFileURL(filePath).toString();
    const result = await this.request('textDocument/references', {
      textDocument: { uri },
      position: { line, character: char },
      context: { includeDeclaration: true },
    });
    return normalizeLocations(result);
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return;
    try {
      await Promise.race([
        this.request('shutdown', null),
        new Promise(r => setTimeout(r, 2000)),
      ]);
      this.notify('exit', null);
    } catch { /* ignore */ }
    this.proc.kill('SIGTERM');
    this.proc = null;
    this._ready = false;
  }

  // -------------------------------------------------------------------------
  // LSP initialize handshake
  // -------------------------------------------------------------------------

  private async doInitialize(workdir: string): Promise<void> {
    const rootUri = pathToFileURL(workdir).toString();
    await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'anvil', version: '0.1.0' },
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didOpen: true },
          definition: { dynamicRegistration: false, linkSupport: false },
          references: { dynamicRegistration: false },
        },
        workspace: { workspaceFolders: true },
      },
      workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
    });
    this.notify('initialized', {});
  }

  // -------------------------------------------------------------------------
  // JSON-RPC transport
  // -------------------------------------------------------------------------

  private flush(): void {
    while (true) {
      const sep = this.buffer.indexOf('\r\n\r\n');
      if (sep === -1) break;

      const header = this.buffer.slice(0, sep);
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buffer = this.buffer.slice(sep + 4); continue; }

      const len = parseInt(m[1], 10);
      const bodyStart = sep + 4;
      if (this.buffer.length < bodyStart + len) break;

      const body = this.buffer.slice(bodyStart, bodyStart + len);
      this.buffer = this.buffer.slice(bodyStart + len);

      try {
        const msg = JSON.parse(body) as JsonRpcMessage;
        if (msg.id != null) this.dispatch(msg);
        // Notifications (no id) are silently ignored
      } catch { /* malformed — drop */ }
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    const pending = this.pending.get(msg.id as number);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id as number);
    if (msg.error) {
      pending.reject(new Error(`LSP ${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private send(msg: Omit<JsonRpcMessage, 'jsonrpc'>): void {
    if (!this.proc?.stdin?.writable) return;
    const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;
    this.proc.stdin.write(header + body, 'utf-8');
  }

  private request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeLocations(raw: unknown): LspLocation[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as LspLocation[];
  return [raw as LspLocation];
}

function findServerBin(workdir: string): string | null {
  // 1. project-local node_modules/.bin (works without global install)
  const local = join(workdir, 'node_modules', '.bin', 'typescript-language-server');
  if (existsSync(local)) return local;

  // 2. Walk up — monorepo scenario
  let dir = dirname(workdir);
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'node_modules', '.bin', 'typescript-language-server');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 3. PATH (global install)
  // Resolve via shell — execa is async so we avoid it here; return null and
  // let the caller suggest npm install -g
  return null;
}

// ---------------------------------------------------------------------------
// Module-level singleton (one per workdir)
// ---------------------------------------------------------------------------

let _singleton: LspClient | null = null;

export async function getLspClient(workdir: string): Promise<LspClient> {
  if (_singleton?.ready && _singleton.workdir === resolve(workdir)) {
    return _singleton;
  }
  if (_singleton?.ready) await _singleton.shutdown().catch(() => {});

  const client = new LspClient();
  await client.start(resolve(workdir));
  _singleton = client;
  return client;
}

export function formatLocation(loc: LspLocation, workdir: string): string {
  const filePath = fileURLToPath(loc.uri);
  const rel = filePath.startsWith(workdir + '/') ? filePath.slice(workdir.length + 1) : filePath;
  return `${rel}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
}
