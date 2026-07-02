import type { UIEvent } from '@/lib/types';

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

function summarizeArgs(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const obj = payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).slice(0, 3)) {
    const val = obj[key];
    if (typeof val === 'string') parts.push(`${key}=${val}`);
    else if (typeof val === 'number' || typeof val === 'boolean')
      parts.push(`${key}=${String(val)}`);
  }
  return parts.join(' ');
}

function getStr(payload: unknown, key: string): string {
  if (payload && typeof payload === 'object') {
    const val = (payload as Record<string, unknown>)[key];
    if (typeof val === 'string') return val;
  }
  return '';
}

function getNum(payload: unknown, key: string): number | null {
  if (payload && typeof payload === 'object') {
    const val = (payload as Record<string, unknown>)[key];
    if (typeof val === 'number') return val;
  }
  return null;
}

export interface ActivityEventProps {
  event: UIEvent;
}

export function ActivityEvent({ event }: ActivityEventProps) {
  const base =
    'min-h-[28px] py-1 px-3 text-[13px] font-mono leading-relaxed flex items-center gap-2';

  switch (event.type) {
    case 'tool_call': {
      const name = getStr(event.payload, 'name') || getStr(event.payload, 'tool');
      const args = summarizeArgs(event.payload);
      return (
        <div className={base}>
          <span style={{ color: '#fbbf24' }}>{name || 'tool'}</span>
          {args && (
            <span style={{ color: '#6b7280' }}>{truncate(args, 60)}</span>
          )}
        </div>
      );
    }
    case 'tool_result': {
      const preview = getStr(event.payload, 'result') || getStr(event.payload, 'output');
      return (
        <div className={`${base} pl-8`} style={{ color: '#6b7280' }}>
          → {truncate(preview, 80)}
        </div>
      );
    }
    case 'shadow_attempt': {
      const attempt = getNum(event.payload, 'attempt') ?? 1;
      const max = getNum(event.payload, 'maxAttempts') ?? 3;
      const file = getStr(event.payload, 'file');
      return (
        <div className={base} style={{ color: '#6b7280' }}>
          shadow[{attempt}/{max}] {truncate(file, 50)}
        </div>
      );
    }
    case 'shadow_result': {
      const outcome = getStr(event.payload, 'outcome');
      const errors = getNum(event.payload, 'errorCount') ?? 0;
      if (outcome === 'committed') {
        return (
          <div className={base} style={{ color: '#4ade80' }}>
            committed
          </div>
        );
      }
      return (
        <div className={base} style={{ color: '#f87171' }}>
          {errors} errors, retrying
        </div>
      );
    }
    case 'branch_created': {
      const branch = getStr(event.payload, 'branch') || getStr(event.payload, 'name');
      return (
        <div className={base} style={{ color: '#60a5fa' }}>
          branch created: {branch}
        </div>
      );
    }
    case 'file_committed':
    case 'file_modified': {
      const path = getStr(event.payload, 'path') || getStr(event.payload, 'file');
      return (
        <div className={base} style={{ color: '#4ade80' }}>
          committed: {truncate(path, 80)}
        </div>
      );
    }
    case 'phase': {
      const phase = getStr(event.payload, 'phase');
      return (
        <div className={base} style={{ color: '#6b7280' }}>
          phase: {phase}
        </div>
      );
    }
    case 'context_loaded': {
      return (
        <div className={base} style={{ color: '#6b7280' }}>
          context loaded
        </div>
      );
    }
    case 'plan_ready': {
      return null;
    }
    case 'done':
    case 'session_complete': {
      const summary = getStr(event.payload, 'summary') || 'session complete';
      return (
        <div className={base}>
          <span className="font-semibold" style={{ color: '#4ade80' }}>
            done
          </span>
          <span style={{ color: '#f0f0f0' }}>{truncate(summary, 100)}</span>
        </div>
      );
    }
    case 'error':
    case 'session_error': {
      const msg = getStr(event.payload, 'message') || 'unknown error';
      return (
        <div className={base} style={{ color: '#f87171' }}>
          error: {truncate(msg, 100)}
        </div>
      );
    }
    case 'pr_description_ready': {
      return (
        <div className={base} style={{ color: '#60a5fa' }}>
          PR description ready
        </div>
      );
    }
    default: {
      const summary = summarizeArgs(event.payload);
      return (
        <div className={base} style={{ color: '#6b7280' }}>
          {event.type} {summary && truncate(summary, 60)}
        </div>
      );
    }
  }
}
