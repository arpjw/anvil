import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);
const RECONNECT_DELAY_MS = 5_000;

type ControlMessage =
  | { type: 'start'; payload: StartPayload }
  | { type: 'approve' }
  | { type: 'reject' }
  | { type: 'revise'; payload: { feedback: string } }
  | { type: 'abort' }
  | { type: 'setup'; payload: SetupPayload };

interface StartPayload {
  request: string;
  repoPath: string;
  model: string;
  apiKey: string;
  sessionId: string;
}

interface SetupPayload {
  repoUrl: string;
  branch: string;
  githubToken: string;
  generatedRules?: string | null;
}

type AnvilAgent = typeof import('anvil-agent');

async function loadAnvilAgent(): Promise<AnvilAgent> {
  try {
    const mod = (await import('anvil-agent')) as unknown as AnvilAgent;
    if (!mod.uiStream || !mod.runOrchestrator) {
      throw new Error('anvil-agent package is missing required exports');
    }
    return mod;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[anvil-runtime] FATAL: could not load 'anvil-agent' package: ${message}`,
    );
    console.error(
      "[anvil-runtime] build the repository library before starting the VM runtime.",
    );
    process.exit(1);
  }
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

type RunState = {
  sessionId: string | null;
  forwardListener: ((event: unknown) => void) | null;
  agent: AnvilAgent | null;
};

async function handleStart(
  ws: WebSocket,
  state: RunState,
  payload: StartPayload,
): Promise<void> {
  if (state.sessionId) {
    send(ws, {
      type: 'error',
      payload: { message: 'a session is already running in this runtime' },
    });
    return;
  }

  const agent = await loadAnvilAgent();
  state.agent = agent;
  state.sessionId = payload.sessionId;

  const forward = (raw: unknown) => {
    const event = raw as import('anvil-agent').UIEvent;
    if (['done', 'session_failed', 'session_cancelled'].includes(event.type)) return;
    send(ws, { type: 'event', payload: event });
    // Cloud users approve the plan before execution and review final file diffs
    // before opening a PR. There is no terminal hunk picker in the VM.
    if (event.type === 'diff_ready') {
      agent.uiStream.resolveDiff(new Set(event.diff.hunks.map((_, i) => i)), event.filepath, event.hunkCount);
    }
  };
  state.forwardListener = forward;
  agent.uiStream.on('event', forward);

  try {
    const spec = agent.AVAILABLE_MODELS.find(m => m.id === payload.model);
    if (!spec) throw new Error(`Unsupported model: ${payload.model}`);
    const client = agent.buildClient(spec.id, spec.baseURL, payload.apiKey);
    const result = await agent.runOrchestrator(
      payload.request,
      payload.repoPath,
      payload.sessionId,
      { modelId: payload.model, client, headless: true, noOpen: true, autoBranch: false },
    );
    if (result.status === 'complete') send(ws, { type: 'done', payload: { summary: result.summary } });
    else if (result.status === 'aborted') send(ws, { type: 'aborted' });
    else send(ws, { type: 'error', payload: { message: result.summary } });
  } catch (err) {
    const e = err as Error;
    send(ws, {
      type: 'error',
      payload: { message: e.message, stack: e.stack },
    });
  } finally {
    if (state.forwardListener) {
      agent.uiStream.off('event', state.forwardListener);
      state.forwardListener = null;
    }
    state.sessionId = null;
  }
}

async function handleSetup(
  ws: WebSocket,
  payload: SetupPayload,
): Promise<void> {
  const target = join('/workspace', 'repo');
  mkdirSync(dirname(target), { recursive: true });

  // Keep credentials out of the clone URL, process arguments, and .git/config.
  const cloneEnv = { ...process.env };
  if (payload.githubToken) {
    cloneEnv.GIT_CONFIG_COUNT = '1';
    cloneEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    cloneEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${payload.githubToken}`).toString('base64')}`;
  }

  const args = [
    'clone',
    '--depth',
    '1',
    '--branch',
    payload.branch,
    payload.repoUrl,
    target,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('git', args, { stdio: 'inherit', env: cloneEnv });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone exited with code ${code}`));
    });
  });

  // Write .anvil/rules.md from the control-plane-generated content, if any.
  // If the repo already ships its own .anvil/rules.md, prepend ours as an
  // "auto-generated context" section so user-written rules take precedence.
  if (payload.generatedRules) {
    const rulesDir = join(target, '.anvil');
    const rulesPath = join(rulesDir, 'rules.md');
    mkdirSync(rulesDir, { recursive: true });
    if (existsSync(rulesPath)) {
      const existing = readFileSync(rulesPath, 'utf-8');
      const header = `# Auto-generated context below\n${payload.generatedRules}\n\n---\n\n# User rules (take precedence)\n`;
      writeFileSync(rulesPath, header + existing, 'utf-8');
    } else {
      writeFileSync(rulesPath, payload.generatedRules, 'utf-8');
    }
  }

  send(ws, { type: 'setup_complete', payload: { repoPath: target } });
}

function handleConnection(ws: WebSocket, state: RunState): void {
  console.log('[anvil-runtime] control plane connected');
  send(ws, { type: 'ready', payload: { version: '1.0.0' } });

  ws.on('message', async (raw) => {
    let message: ControlMessage;
    try {
      message = JSON.parse(raw.toString()) as ControlMessage;
    } catch (err) {
      send(ws, {
        type: 'error',
        payload: { message: 'invalid json from control plane' },
      });
      return;
    }

    try {
      switch (message.type) {
        case 'start':
          await handleStart(ws, state, message.payload);
          break;
        case 'setup':
          await handleSetup(ws, message.payload);
          break;
        case 'approve':
          state.agent?.uiStream.resolveApproval('y');
          break;
        case 'reject':
          state.agent?.uiStream.resolveApproval('n');
          break;
        case 'revise':
          state.agent?.uiStream.resolveApproval(
            'revise',
            message.payload.feedback,
          );
          break;
        case 'abort':
          send(ws, { type: 'aborted' });
          ws.close(1000, 'aborted by control plane');
          setTimeout(() => process.exit(0), 100);
          break;
        default: {
          const exhaustive: never = message;
          void exhaustive;
        }
      }
    } catch (err) {
      const e = err as Error;
      send(ws, {
        type: 'error',
        payload: { message: e.message, stack: e.stack },
      });
    }
  });

  ws.on('close', () => {
    console.log(
      `[anvil-runtime] control plane disconnected, waiting ${RECONNECT_DELAY_MS}ms for reconnect`,
    );
  });

  ws.on('error', (err) => {
    console.error('[anvil-runtime] websocket error:', err);
  });
}

function start(): void {
  const wss = new WebSocketServer({ port: PORT });
  const state: RunState = { sessionId: null, forwardListener: null, agent: null };
  let activeConnection: WebSocket | null = null;

  wss.on('connection', (ws) => {
    if (activeConnection && activeConnection.readyState === WebSocket.OPEN) {
      console.warn(
        '[anvil-runtime] rejecting extra connection; only one allowed',
      );
      ws.close(1008, 'only one connection allowed');
      return;
    }
    activeConnection = ws;
    handleConnection(ws, state);
    ws.on('close', () => {
      if (activeConnection === ws) activeConnection = null;
    });
  });

  wss.on('listening', () => {
    console.log(`[anvil-runtime] listening on :${PORT}`);
  });

  wss.on('error', (err) => {
    console.error('[anvil-runtime] server error:', err);
  });
}

start();
