import type { Repository } from '../db/repository';
import type { SessionStatus } from '../db/schema';
import type { AppDeps } from '../lib/context';
import { logger } from '../lib/logger';
import { openPr } from '../routes/pr';
import { canTransition, isTerminal, transition } from '../state/machine';

export interface RedisPublisher {
  publish(channel: string, message: string): Promise<number> | number;
}

export interface UIEvent {
  type: string;
  payload?: unknown;
}

export interface PublishedMessage {
  id?: string;
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
    case 'session_failed':
    case 'session_error':
      return 'failed';
    case 'session_cancelled':
    case 'aborted':
      return 'aborted';
    case 'plan_approved':
    case 'plan_revision_requested':
      return 'running';
    default:
      return null;
  }
}

export interface ProcessEventOptions {
  startedAt?: number;
  deps?: AppDeps;
  autoOpenPr?: boolean;
}

export async function processEvent(
  repo: Repository,
  redis: RedisPublisher,
  sessionId: string,
  event: UIEvent,
  opts: ProcessEventOptions = {},
): Promise<void> {
  // The CLI's UIEvent union has flat top-level properties (e.g. phase_transition
  // carries {from, to, index, ...} directly). When such an event arrives without
  // a `payload` field, gather the extras into one so downstream consumers (Redis,
  // SSE, dashboard) see a consistent `{type, payload}` shape.
  const asRecord = event as unknown as Record<string, unknown>;
  let normalizedPayload: unknown = event.payload ?? null;
  if (event.payload === undefined) {
    const extras: Record<string, unknown> = {};
    for (const key of Object.keys(asRecord)) {
      if (key === 'type' || key === 'payload') continue;
      extras[key] = asRecord[key];
    }
    if (Object.keys(extras).length > 0) normalizedPayload = extras;
  }

  // Ephemeral event types are broadcast to SSE clients but not persisted to
  // the events table — a long test run can emit thousands of command_output
  // lines and none of them are worth an audit-trail row.
  let persistedId: string | undefined;
  let timestamp = Date.now();
  const EPHEMERAL_TYPES = new Set(['command_output', 'usage_update']);
  if (!EPHEMERAL_TYPES.has(event.type)) {
    try {
      const persisted = await repo.createEvent(sessionId, event.type, normalizedPayload);
      persistedId = persisted.id;
      timestamp = persisted.createdAt.getTime();
    } catch (err) {
      logger.warn({ sessionId, eventType: event.type, err }, 'failed to persist event');
    }
  }

  if (event.type === 'plan_ready' && normalizedPayload && typeof normalizedPayload === 'object') {
    const plan = (normalizedPayload as { plan?: unknown }).plan ?? normalizedPayload;
    await repo.updateSessionPlan(sessionId, plan);
  }

  // Session-level checkpoint: mirror phase_transition into sessions.checkpoint_*
  // for progress inspection. This is not a VM filesystem recovery snapshot.
  if (event.type === 'phase_transition' && normalizedPayload && typeof normalizedPayload === 'object') {
    const phaseTo = (normalizedPayload as { to?: unknown }).to;
    if (typeof phaseTo === 'string') {
      try {
        await repo.checkpointSession(sessionId, {
          phase: phaseTo,
          state: normalizedPayload,
        });
      } catch (err) {
        logger.warn({ sessionId, err }, 'failed to persist workflow checkpoint');
      }
    }
  }

  await publishToChannel(redis, sessionId, {
    id: persistedId,
    type: event.type,
    payload: normalizedPayload,
    timestamp,
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
      if (opts.deps) {
        await recordUsage(sessionId, durationSeconds, opts.deps);
      }
    }
    if (next === 'complete' && opts.autoOpenPr && opts.deps) {
      await maybeOpenPr(sessionId, opts.deps);
    }
  } catch (err) {
    logger.warn(
      { sessionId, from: current, to: next, err },
      'failed to update session status',
    );
  }
}

async function recordUsage(
  sessionId: string,
  durationSeconds: number,
  deps: AppDeps,
): Promise<void> {
  try {
    const session = await deps.repo.findSessionById(sessionId);
    if (!session) return;
    const minutes = Math.max(1, Math.ceil(durationSeconds / 60));
    const record = await deps.repo.createUsageRecord({
      userId: session.userId,
      sessionId,
      minutes,
    });
    if (!deps.stripe) return;
    const subscriptionItemId = deps.billing.usageSubscriptionItemPerUser.get(
      session.userId,
    );
    if (!subscriptionItemId) return;
    await deps.stripe.reportUsage({
      subscriptionItemId,
      quantity: minutes,
      idempotencyKey: `usage-${record.id}`,
    });
    await deps.repo.markUsageReported(record.id);
  } catch (err) {
    logger.warn({ sessionId, err }, 'usage record / report failed');
  }
}

async function maybeOpenPr(sessionId: string, deps: AppDeps): Promise<void> {
  try {
    const session = await deps.repo.findSessionById(sessionId);
    if (!session || session.prUrl) return;
    const approvedDiffs = (
      await deps.repo.listDiffsBySession(sessionId)
    ).filter((d) => d.status === 'approved');
    if (approvedDiffs.length === 0) return;
    const owner = await deps.repo.findUserById(session.userId);
    if (!owner) return;
    await openPr({
      session,
      approvedDiffs,
      githubToken: owner.githubAccessToken,
      deps,
    });
  } catch (err) {
    logger.warn({ sessionId, err }, 'auto-open PR failed');
  }
}
