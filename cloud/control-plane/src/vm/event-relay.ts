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

interface FileDiffEventShape {
  type: 'file_diff';
  filepath: string;
  originalContent?: string | null;
  newContent?: string | null;
}

function asFileDiffEvent(evt: UIEvent): FileDiffEventShape | null {
  if (!evt || typeof evt !== 'object') return null;
  const record = evt as Record<string, unknown>;
  if (record.type !== 'file_diff') return null;
  if (typeof record.filepath !== 'string') return null;
  return {
    type: 'file_diff',
    filepath: record.filepath,
    originalContent:
      typeof record.originalContent === 'string' ? record.originalContent : null,
    newContent:
      typeof record.newContent === 'string' ? record.newContent : null,
  };
}

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
      const fileDiff = asFileDiffEvent(evt);
      if (fileDiff) {
        try {
          await deps.repo.createDiff({
            sessionId,
            filepath: fileDiff.filepath,
            originalContent: fileDiff.originalContent ?? null,
            newContent: fileDiff.newContent ?? null,
          });
        } catch (err) {
          logger.warn(
            { sessionId, filepath: fileDiff.filepath, err },
            'failed to persist streaming file_diff',
          );
        }
      }
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
