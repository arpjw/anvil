import type { AppDeps } from '../lib/context';
import { logger } from '../lib/logger';
import { processEvent } from '../events/pipeline';
import { canTransition } from '../state/machine';
import type { SessionStatus } from '../db/schema';
import { sessionPool, type UIEvent } from './pool';

export interface EventRelaySocket {
  addEventListener(
    event: 'message',
    handler: (e: { data: string | ArrayBuffer | Uint8Array }) => void,
  ): void;
  addEventListener(event: 'close' | 'error', handler: () => void): void;
}

type VMMessage =
  | { type: 'event'; payload: UIEvent }
  | { type: 'done'; payload: { summary?: string | null } }
  | { type: 'error'; payload: { message: string; stack?: string } }
  | { type: 'aborted' }
  | { type: 'ready'; payload: { version: string } }
  | { type: 'setup_complete'; payload: { repoPath: string } };

function decode(data: string | ArrayBuffer | Uint8Array): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return new TextDecoder().decode(data);
}

export function startEventRelay(
  sessionId: string,
  ws: EventRelaySocket,
  deps: AppDeps,
): void {
  const startedAt = Date.now();

  ws.addEventListener('message', (event) => {
    void handleMessage(sessionId, deps, decode(event.data), startedAt);
  });

  ws.addEventListener('close', () => {
    sessionPool.remove(sessionId);
  });

  ws.addEventListener('error', () => {
    logger.warn({ sessionId }, 'vm websocket error');
  });
}

async function handleMessage(
  sessionId: string,
  deps: AppDeps,
  raw: string,
  startedAt: number,
): Promise<void> {
  let msg: VMMessage;
  try {
    msg = JSON.parse(raw) as VMMessage;
  } catch (err) {
    logger.warn({ sessionId, err }, 'invalid json from vm');
    return;
  }

  switch (msg.type) {
    case 'event': {
      const evt = msg.payload;
      await processEvent(deps.repo, deps.redis, sessionId, evt, { startedAt });
      sessionPool.broadcast(sessionId, evt);
      return;
    }
    case 'done': {
      await processEvent(
        deps.repo,
        deps.redis,
        sessionId,
        { type: 'done', payload: msg.payload },
        { startedAt, deps, autoOpenPr: true },
      );
      sessionPool.broadcast(sessionId, {
        type: 'session_complete',
        payload: msg.payload,
      });
      return;
    }
    case 'error': {
      await processEvent(
        deps.repo,
        deps.redis,
        sessionId,
        { type: 'error', payload: msg.payload },
        { startedAt, deps, autoOpenPr: true },
      );
      sessionPool.broadcast(sessionId, {
        type: 'session_error',
        payload: msg.payload,
      });
      return;
    }
    case 'aborted': {
      await processEvent(
        deps.repo,
        deps.redis,
        sessionId,
        { type: 'aborted', payload: null },
        { startedAt, deps, autoOpenPr: true },
      );
      try {
        const session = await deps.repo.findSessionById(sessionId);
        const current = session?.status as SessionStatus | undefined;
        if (current && canTransition(current, 'aborted')) {
          await deps.repo.updateSessionStatus(sessionId, 'aborted');
        }
      } catch (err) {
        logger.warn({ sessionId, err }, 'failed to mark session aborted');
      }
      return;
    }
    case 'ready':
    case 'setup_complete':
      return;
    default: {
      const exhaustive: never = msg;
      void exhaustive;
    }
  }
}
