import type { Repo, Session, User } from '../db/schema';
import type { AppDeps } from '../lib/context';
import { logger } from '../lib/logger';
import { getVMDriver } from './index';
import { vmPoolManager, VMPoolManager } from './pool-manager';
import type { VMDriver, VMHandle } from './types';

export class ProvisionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ProvisionerSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  addEventListener(
    event: 'message',
    handler: (e: { data: string | ArrayBuffer | Uint8Array }) => void,
  ): void;
  addEventListener(event: 'open' | 'close' | 'error', handler: () => void): void;
  removeEventListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export type WebSocketFactory = (url: string) => ProvisionerSocket;

export interface ProvisionResult {
  vmHandle: VMHandle;
  wsConnection: ProvisionerSocket;
}

export interface ProvisionDeps {
  driver?: VMDriver;
  wsFactory?: WebSocketFactory;
  appDeps: AppDeps;
  timeoutMs?: number;
  pool?: VMPoolManager;
}

export interface ProvisionInput {
  session: Session;
  repo: Repo;
  user: User;
  apiKey: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function defaultWsFactory(url: string): ProvisionerSocket {
  return new WebSocket(url) as unknown as ProvisionerSocket;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProvisionError('timeout', message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function waitForOpen(ws: ProvisionerSocket): Promise<void> {
  if (ws.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new ProvisionError('ws_error', 'websocket failed to open'));
    };
    const cleanup = () => {
      ws.removeEventListener?.('open', onOpen);
      ws.removeEventListener?.('error', onError);
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
  });
}

function waitForMessage<T = unknown>(
  ws: ProvisionerSocket,
  predicate: (msg: { type: string } & Record<string, unknown>) => boolean,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: { data: string | ArrayBuffer | Uint8Array }) => {
      const raw =
        typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data);
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && predicate(parsed)) {
          cleanup();
          resolve(parsed as T);
        }
      } catch {
        // ignore unparseable
      }
    };
    const onClose = () => {
      cleanup();
      reject(new ProvisionError('ws_closed', 'websocket closed before message'));
    };
    const cleanup = () => {
      ws.removeEventListener?.('message', onMessage as never);
      ws.removeEventListener?.('close', onClose);
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
  });
}

export async function provisionSession(
  input: ProvisionInput,
  pdeps: ProvisionDeps,
): Promise<ProvisionResult> {
  const driver = pdeps.driver ?? getVMDriver();
  const wsFactory = pdeps.wsFactory ?? defaultWsFactory;
  const timeoutMs = pdeps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // If the caller passed an explicit driver but no pool, use a driver-scoped
  // pool so the injected driver is respected end-to-end. Otherwise fall through
  // to the shared singleton, which is the production path.
  const effectivePool =
    pdeps.pool ??
    (pdeps.driver
      ? new VMPoolManager({ targetSize: 0, driver: pdeps.driver })
      : vmPoolManager);

  const { session, repo, user } = input;

  let vmHandle: VMHandle | null = null;
  let wsConnection: ProvisionerSocket | null = null;

  const cleanup = async () => {
    if (wsConnection) {
      try {
        wsConnection.close();
      } catch {
        // ignore
      }
    }
    if (vmHandle) {
      try {
        await effectivePool.release(session.id);
      } catch (err) {
        logger.warn({ sessionId: session.id, err }, 'failed to release vm during cleanup');
      }
    }
    try {
      await pdeps.appDeps.repo.updateSessionStatus(session.id, 'failed');
    } catch (err) {
      logger.warn({ sessionId: session.id, err }, 'failed to mark session failed');
    }
  };

  try {
    vmHandle = await withTimeout(
      effectivePool.acquire(session.id),
      timeoutMs,
      'timed out starting vm',
    );

    wsConnection = wsFactory(`ws://${vmHandle.ip}:${vmHandle.port}`);
    await withTimeout(waitForOpen(wsConnection), timeoutMs, 'timed out opening websocket');

    await withTimeout(
      waitForMessage(wsConnection, (m) => m.type === 'ready'),
      timeoutMs,
      'timed out waiting for ready',
    );

    wsConnection.send(
      JSON.stringify({
        type: 'setup',
        payload: {
          repoUrl: `https://github.com/${repo.fullName}.git`,
          branch: session.branch,
          githubToken: user.githubAccessToken ?? '',
          generatedRules: repo.generatedRules ?? null,
        },
      }),
    );

    await withTimeout(
      waitForMessage(wsConnection, (m) => m.type === 'setup_complete'),
      timeoutMs,
      'timed out waiting for setup_complete',
    );

    await pdeps.appDeps.repo.updateSessionVm(session.id, {
      vmIp: vmHandle.ip,
      vmPort: vmHandle.port,
    });
    await pdeps.appDeps.repo.updateSessionStatus(session.id, 'provisioning');

    return { vmHandle, wsConnection };
  } catch (err) {
    await cleanup();
    if (err instanceof ProvisionError) throw err;
    const e = err as Error;
    throw new ProvisionError('provision_failed', e.message);
  }
}
