import type { AppDeps } from '../lib/context';
import { logger } from '../lib/logger';
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
    // close listener will follow; logger noise only
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
      try {
        await deps.repo.createEvent(sessionId, evt.type, evt.payload ?? null);
      } catch (err) {
        logger.warn({ sessionId, err }, 'failed to persist event');
      }
      sessionPool.broadcast(sessionId, evt);
      return;
    }
    case 'done': {
      const completedAt = new Date();
      const durationSeconds = Math.max(
        0,
        Math.round((completedAt.getTime() - startedAt) / 1000),
      );
      try {
        await deps.repo.updateSessionStatus(sessionId, 'complete');
        await deps.repo.completeSession(sessionId, {
          completedAt,
          durationSeconds,
        });
      } catch (err) {
        logger.warn({ sessionId, err }, 'failed to mark session complete');
      }
      sessionPool.broadcast(sessionId, {
        type: 'session_complete',
        payload: msg.payload,
      });
      return;
    }
    case 'error': {
      try {
        await deps.repo.updateSessionStatus(sessionId, 'failed');
      } catch (err) {
        logger.warn({ sessionId, err }, 'failed to mark session failed');
      }
      sessionPool.broadcast(sessionId, {
        type: 'session_error',
        payload: msg.payload,
      });
      return;
    }
    case 'aborted': {
      try {
        await deps.repo.updateSessionStatus(sessionId, 'aborted');
      } catch (err) {
        logger.warn({ sessionId, err }, 'failed to mark session aborted');
      }
      return;
    }
    case 'ready':
    case 'setup_complete':
      // handled by provisioner during bring-up; ignore once relay is running
      return;
    default: {
      const exhaustive: never = msg;
      void exhaustive;
    }
  }
}
