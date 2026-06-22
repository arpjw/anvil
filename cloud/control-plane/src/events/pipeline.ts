import type { Repository } from '../db/repository';
import type { SessionStatus } from '../db/schema';
import { logger } from '../lib/logger';
import { canTransition, isTerminal, transition } from '../state/machine';

export interface RedisPublisher {
  publish(channel: string, message: string): Promise<number> | number;
}

export interface UIEvent {
  type: string;
  payload?: unknown;
}

export interface PublishedMessage {
  type: string;
  payload: unknown;
  timestamp: number;
}

export function channelFor(sessionId: string): string {
  return `anvil:session:${sessionId}`;
}

export async function publishToChannel(
  redis: RedisPublisher,
  sessionId: string,
  message: PublishedMessage,
): Promise<void> {
  try {
    await Promise.resolve(
      redis.publish(channelFor(sessionId), JSON.stringify(message)),
    );
  } catch (err) {
    logger.warn({ sessionId, err }, 'redis publish failed');
  }
}

function nextStatusFor(eventType: string): SessionStatus | null {
  switch (eventType) {
    case 'plan_ready':
      return 'reviewing';
    case 'done':
      return 'complete';
    case 'error':
      return 'failed';
    default:
      return null;
  }
}

export interface ProcessEventOptions {
  startedAt?: number;
}

export async function processEvent(
  repo: Repository,
  redis: RedisPublisher,
  sessionId: string,
  event: UIEvent,
  opts: ProcessEventOptions = {},
): Promise<void> {
  try {
    await repo.createEvent(sessionId, event.type, event.payload ?? null);
  } catch (err) {
    logger.warn({ sessionId, eventType: event.type, err }, 'failed to persist event');
  }

  await publishToChannel(redis, sessionId, {
    type: event.type,
    payload: event.payload ?? null,
    timestamp: Date.now(),
  });

  const next = nextStatusFor(event.type);
  if (!next) return;

  let current: SessionStatus | null = null;
  try {
    const session = await repo.findSessionById(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'session not found for status transition');
      return;
    }
    current = session.status as SessionStatus;
  } catch (err) {
    logger.warn({ sessionId, err }, 'failed to load session for transition');
    return;
  }

  if (isTerminal(current) && current === next) return;
  if (!canTransition(current, next)) {
    logger.warn(
      { sessionId, from: current, to: next, eventType: event.type },
      'invalid state transition, ignoring',
    );
    return;
  }

  try {
    transition(current, next);
    await repo.updateSessionStatus(sessionId, next);
    if (next === 'complete' && opts.startedAt) {
      const completedAt = new Date();
      const durationSeconds = Math.max(
        0,
        Math.round((completedAt.getTime() - opts.startedAt) / 1000),
      );
      await repo.completeSession(sessionId, { completedAt, durationSeconds });
    }
  } catch (err) {
    logger.warn(
      { sessionId, from: current, to: next, err },
      'failed to update session status',
    );
  }
}
