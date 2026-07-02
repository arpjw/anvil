import type { SessionStatus } from '@/lib/types';

const STATUS_META: Record<SessionStatus, { color: string; label: string; pulse: boolean }> = {
  queued: { color: '#6b7280', label: 'Queued', pulse: false },
  provisioning: { color: '#fbbf24', label: 'Provisioning', pulse: true },
  running: { color: '#60a5fa', label: 'Running', pulse: true },
  reviewing: { color: '#fbbf24', label: 'Reviewing', pulse: false },
  complete: { color: '#4ade80', label: 'Complete', pulse: false },
  failed: { color: '#f87171', label: 'Failed', pulse: false },
  aborted: { color: '#6b7280', label: 'Aborted', pulse: false },
};

export interface StatusBadgeProps {
  status: SessionStatus;
  size?: 'sm' | 'md';
  showLabel?: boolean;
}

export function StatusBadge({
  status,
  size = 'sm',
  showLabel = true,
}: StatusBadgeProps) {
  const meta = STATUS_META[status];
  const dotSize = size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2';
  const textSize = size === 'md' ? 'text-sm' : 'text-xs';
  return (
    <span className={`inline-flex items-center gap-2 ${textSize}`}>
      <span className="relative inline-flex">
        <span
          className={`${dotSize} rounded-full`}
          style={{ backgroundColor: meta.color }}
        />
        {meta.pulse && (
          <span
            className={`absolute inset-0 ${dotSize} rounded-full animate-ping opacity-60`}
            style={{ backgroundColor: meta.color }}
          />
        )}
      </span>
      {showLabel && (
        <span style={{ color: meta.color }}>{meta.label}</span>
      )}
    </span>
  );
}

export function statusColor(status: SessionStatus): string {
  return STATUS_META[status].color;
}

export function statusLabel(status: SessionStatus): string {
  return STATUS_META[status].label;
}
