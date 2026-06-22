import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Repository } from '../db/repository';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { SSEBroadcaster } from './broadcaster';

const INITIAL_EVENT_LIMIT = 50;

export interface SSEHandlerDeps {
  repo: Repository;
  broadcaster: SSEBroadcaster;
}

export async function buildInitialFrame(
  repo: Repository,
  sessionId: string,
  userId: string,
): Promise<string> {
  const session = await repo.findSessionById(sessionId);
  if (!session || session.userId !== userId) {
    throw new HttpError(404, 'not_found', 'session not found');
  }
  const recentEvents = await repo.getRecentEvents(sessionId, INITIAL_EVENT_LIMIT);
  return JSON.stringify({
    type: 'session_state',
    payload: { session, recentEvents },
  });
}

export async function sseHandler(
  c: Context,
  sessionId: string,
  userId: string,
  deps: SSEHandlerDeps,
): Promise<Response> {
  const initialPayload = await buildInitialFrame(deps.repo, sessionId, userId);

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return streamSSE(c, async (stream) => {
    const clientId = crypto.randomUUID();
    let closed = false;

    await stream.writeSSE({ data: initialPayload });

    const unregister = deps.broadcaster.registerClient(
      sessionId,
      clientId,
      (frame) => {
        if (closed) return;
        void stream.write(frame).catch((err) => {
          logger.warn({ sessionId, clientId, err }, 'sse write failed');
        });
      },
    );

    stream.onAbort(() => {
      closed = true;
      unregister();
    });

    // Hold the stream open until the client disconnects.
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        closed = true;
        unregister();
        resolve();
      });
    });
  });
}
