import { HttpError } from '../lib/errors';
import type { SessionStatus } from '../db/schema';

const TRANSITIONS: Record<SessionStatus, ReadonlySet<SessionStatus>> = {
  queued: new Set<SessionStatus>(['provisioning', 'failed', 'aborted']),
  provisioning: new Set<SessionStatus>(['running', 'failed', 'aborted']),
  running: new Set<SessionStatus>(['reviewing', 'complete', 'failed', 'aborted']),
  reviewing: new Set<SessionStatus>(['running', 'failed', 'aborted']),
  complete: new Set<SessionStatus>(['complete']),
  failed: new Set<SessionStatus>(['failed', 'provisioning']),
  aborted: new Set<SessionStatus>(['aborted']),
};

const TERMINAL: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'complete',
  'failed',
  'aborted',
]);

export class InvalidTransitionError extends HttpError {
  readonly from: SessionStatus;
  readonly to: SessionStatus;
  constructor(from: SessionStatus, to: SessionStatus) {
    super(
      400,
      'invalid_transition',
      `Invalid transition from ${from} to ${to}`,
    );
    this.from = from;
    this.to = to;
  }
}

export function transition(
  currentStatus: SessionStatus,
  nextStatus: SessionStatus,
): SessionStatus {
  const allowed = TRANSITIONS[currentStatus];
  if (!allowed || !allowed.has(nextStatus)) {
    throw new InvalidTransitionError(currentStatus, nextStatus);
  }
  return nextStatus;
}

export function canTransition(
  currentStatus: SessionStatus,
  nextStatus: SessionStatus,
): boolean {
  return TRANSITIONS[currentStatus]?.has(nextStatus) ?? false;
}

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL.has(status);
}
