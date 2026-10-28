import type { Session, SessionStatus, UIEvent } from './types';

export type SessionFrame = { type: 'session_state'; payload: { session: Session; recentEvents: Array<{ id?: string; type: string; payload: unknown; createdAt: string }> } };
export const isTerminal = (status: SessionStatus | null) => status === 'complete' || status === 'failed' || status === 'aborted';

export function parseFrame(data: string): SessionFrame | UIEvent | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') return null;
    const record = value as Record<string, unknown>;
    if (record.type === 'session_state') {
      const payload = record.payload as SessionFrame['payload'] | undefined;
      if (!payload?.session?.id || !Array.isArray(payload.recentEvents)) return null;
      return value as SessionFrame;
    }
    return value as UIEvent;
  } catch { return null; }
}

export function deriveStatus(event: UIEvent): SessionStatus | null {
  switch (event.type) {
    case 'plan_ready': return 'reviewing';
    case 'plan_approved': case 'plan_revision_requested': return 'running';
    case 'done': case 'session_complete': return 'complete';
    case 'session_error': case 'session_failed': return 'failed';
    case 'aborted': case 'session_cancelled': return 'aborted';
    case 'phase_transition': {
      const to = (event.payload as { to?: string } | undefined)?.to;
      return ['EXECUTING', 'VERIFYING', 'FIXING', 'COMMITTING', 'EXPLORING'].includes(to ?? '') ? 'running' : null;
    }
    default: return null; // Tool warnings are not terminal session failures.
  }
}

export function mergeEvents(previous: UIEvent[], incoming: UIEvent[], limit = 400): UIEvent[] {
  const seen = new Set<string>();
  const merged = [...previous, ...incoming].filter(event => {
    const key = event.id ?? JSON.stringify([event.type, event.timestamp, event.payload]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return merged.slice(-limit);
}
