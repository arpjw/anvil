import { spawn, type ChildProcess } from 'child_process';
import { pathToFileURL, fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { resolve, join, dirname, delimiter, extname } from 'path';
import { createRequire } from 'module';

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

export interface LspDiagnostic {
  file: string;       // absolute path
  line: number;       // 1-indexed
  character: number;  // 1-indexed
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
}

interface RawLspDiagnostic {
  range: { start: LspPosition; end: LspPosition };
  severity?: number; // 1=Error 2=Warning 3=Info 4=Hint
  message: string;
}

// ---------------------------------------------------------------------------
// LspClient
// ---------------------------------------------------------------------------

export class LspClient {
  private proc: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private openedDocs = new Set<string>();
  private _workdir = '';
  private _ready = false;
  private diagnosticsMap = new Map<string, LspDiagnostic[]>();
  private diagnosticsListeners = new Map<string, Array<(diags: LspDiagnostic[], version?: number) => void>>();
  private diagnosticFailures = new Set<(err: Error) => void>();
  private docVersions = new Map<string, number>();

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
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    });

    const fail = (err: Error): void => {
      this._ready = false;
      this.proc = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
      for (const reject of [...this.diagnosticFailures]) reject(err);
      this.openedDocs.clear();
      this.docVersions.clear();
    };
    this.proc.on('error', fail);
    this.proc.on('exit', (code, signal) => {
      fail(new Error(`Language server exited (${signal ?? code ?? 'unknown'}).`));
    });

    try {
      await this.doInitialize(workdir);
      this._ready = true;
    } catch (err) {
      this.proc?.kill();
      throw err;
    }
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

    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: languageId(filePath), version: 1, text },
    });
    this.openedDocs.add(uri);
    this.docVersions.set(uri, 1);
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
    this.proc?.kill('SIGTERM');
    this.proc = null;
    this._ready = false;
  }

  // Send proposed content to the LSP and collect the resulting diagnostics.
  // Does NOT write to disk. Returns only error-severity items by default.
  async checkContent(filePath: string, newContent: string, timeoutMs = 8000): Promise<LspDiagnostic[]> {
    if (!this.ready) throw new Error('Language server is not ready; edit was not validated.');
    const uri = pathToFileURL(filePath).toString();
    const version = (this.docVersions.get(uri) ?? 0) + 1;
    // Subscribe before sending: a fast server may publish diagnostics immediately.
    const diagnostics = this.waitForDiagnosticsSettle(uri, version, timeoutMs);
    this.docVersions.set(uri, version);
    if (!this.openedDocs.has(uri)) {
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: languageId(filePath), version, text: newContent },
      });
      this.openedDocs.add(uri);
    } else {
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: newContent }],
      });
    }
    return diagnostics;
  }

  // Reset the LSP's in-memory view of a file back to what is on disk.
  async revertContent(filePath: string): Promise<void> {
    if (!this.ready) return;
    const uri = pathToFileURL(filePath).toString();
    if (!this.openedDocs.has(uri)) return;
    let text = '';
    try { text = readFileSync(filePath, 'utf-8'); } catch {
      this.notify('textDocument/didClose', { textDocument: { uri } });
      this.openedDocs.delete(uri);
      this.docVersions.delete(uri);
      return;
    }
    const version = (this.docVersions.get(uri) ?? 1) + 1;
    this.docVersions.set(uri, version);
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  // -------------------------------------------------------------------------
  // Diagnostics settle helper
  // -------------------------------------------------------------------------

  private waitForDiagnosticsSettle(uri: string, version: number, timeoutMs: number): Promise<LspDiagnostic[]> {
    return new Promise((resolve, reject) => {
      let latest: LspDiagnostic[] = [];
      let settleTimer: ReturnType<typeof setTimeout> | null = null;

      const globalTimer = setTimeout(() => {
        cleanup();
        reject(new Error(`No settled diagnostics for ${fileURLToPath(uri)} after ${timeoutMs}ms; edit was not validated.`));
      }, timeoutMs);

      const settle = () => {
        clearTimeout(globalTimer);
        cleanup();
        resolve(latest);
      };

      const handler = (diags: LspDiagnostic[], publishedVersion?: number) => {
        if (publishedVersion !== undefined && publishedVersion !== version) return;
        latest = diags;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(settle, 400);
      };

      const cleanup = () => {
        clearTimeout(globalTimer);
        if (settleTimer) clearTimeout(settleTimer);
        this.diagnosticFailures.delete(fail);
        const ls = this.diagnosticsListeners.get(uri) ?? [];
        const idx = ls.indexOf(handler);
        if (idx >= 0) ls.splice(idx, 1);
      };

      const fail = (err: Error): void => { cleanup(); reject(err); };
      this.diagnosticFailures.add(fail);

      const ls = this.diagnosticsListeners.get(uri) ?? [];
      ls.push(handler);
      this.diagnosticsListeners.set(uri, ls);
    });
  }

  private handleNotification(msg: JsonRpcMessage): void {
    if (msg.method !== 'textDocument/publishDiagnostics') return;
    const p = msg.params as { uri: string; version?: number; diagnostics: RawLspDiagnostic[] };
    const diags = (p.diagnostics ?? []).map(d => this.normalizeDiagnostic(d, p.uri));
    this.diagnosticsMap.set(p.uri, diags);
    const ls = this.diagnosticsListeners.get(p.uri);
    if (ls) for (const fn of [...ls]) fn(diags, p.version);
  }

  private normalizeDiagnostic(raw: RawLspDiagnostic, uri: string): LspDiagnostic {
    const sev = raw.severity ?? 1;
    return {
      file: fileURLToPath(uri),
      line: raw.range.start.line + 1,
      character: raw.range.start.character + 1,
      message: raw.message,
      severity: sev === 1 ? 'error' : sev === 2 ? 'warning' : sev === 3 ? 'info' : 'hint',
    };
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
          synchronization: {
            dynamicRegistration: false,
            didOpen: true,
            didChange: 1, // TextDocumentSyncKind.Full
          },
          publishDiagnostics: {
            relatedInformation: true,
            tagSupport: { valueSet: [1, 2] },
            versionSupport: true,
            codeDescriptionSupport: true,
          },
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

      const header = this.buffer.subarray(0, sep).toString('ascii');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buffer = this.buffer.slice(sep + 4); continue; }

      const len = parseInt(m[1], 10);
      const bodyStart = sep + 4;
      if (this.buffer.length < bodyStart + len) break;

      const body = this.buffer.subarray(bodyStart, bodyStart + len).toString('utf-8');
      this.buffer = this.buffer.slice(bodyStart + len);

      try {
        const msg = JSON.parse(body) as JsonRpcMessage;
        if (msg.id != null && msg.method) {
          // Server-initiated requests must receive a response to avoid deadlock.
          const params = msg.params as { items?: unknown[] } | undefined;
          this.send({ id: msg.id, result: msg.method === 'workspace/configuration'
            ? (params?.items ?? []).map(() => ({})) : null });
        } else if (msg.id != null) this.dispatch(msg);
        else this.handleNotification(msg);
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
    if (!this.proc?.stdin?.writable) return Promise.reject(new Error('Language server is disconnected.'));
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

export function findServerBin(workdir: string): string | null {
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

  // 3. Anvil's own runtime dependency (including global npm installations).
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('typescript-language-server/package.json');
    const bin = join(dirname(pkg), 'lib', 'cli.mjs');
    if (existsSync(bin)) return bin;
  } catch { /* fall back to PATH */ }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'typescript-language-server');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function languageId(filePath: string): string {
  const ext = extname(filePath);
  if (ext === '.tsx') return 'typescriptreact';
  if (ext === '.jsx') return 'javascriptreact';
  return ['.ts', '.mts', '.cts'].includes(ext) ? 'typescript' : 'javascript';
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

export async function shutdownLspClient(): Promise<void> {
  const client = _singleton;
  _singleton = null;
  await client?.shutdown();
}
