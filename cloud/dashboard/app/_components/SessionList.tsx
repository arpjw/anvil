'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { getSessions } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';
import type { Session } from '@/lib/types';

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function elapsedOrDuration(s: Session): string {
  if (s.durationSeconds != null) {
    const mins = Math.floor(s.durationSeconds / 60);
    const secs = s.durationSeconds % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }
  if (s.startedAt) {
    const elapsed = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }
  return '';
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

export function SessionList() {
  const { data: sessions, error, isLoading } = useSWR<Session[]>(
    '/sessions',
    getSessions,
    { refreshInterval: 10_000 },
  );

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-medium">Sessions</h1>
        <Link
          href="/sessions/new"
          className="px-3 py-1.5 text-sm rounded-md font-medium transition-opacity hover:opacity-90"
          style={{
            backgroundColor: '#fbbf24',
            color: '#0a0a0a',
          }}
        >
          New session
        </Link>
      </div>

      {error && (
        <div
          className="rounded-md p-4 text-sm"
          style={{
            backgroundColor: '#111111',
            border: '1px solid rgba(248, 113, 113, 0.4)',
            color: '#f87171',
          }}
        >
          Failed to load sessions.
        </div>
      )}

      {isLoading && !sessions && (
        <div className="text-sm" style={{ color: '#6b7280' }}>
          Loading…
        </div>
      )}

      {sessions && sessions.length === 0 && (
        <div
          className="rounded-md p-10 text-center"
          style={{
            backgroundColor: '#111111',
            border: '1px solid #1f1f1f',
          }}
        >
          <p className="text-sm mb-3" style={{ color: '#f0f0f0' }}>
            No sessions yet.
          </p>
          <Link
            href="/sessions/new"
            className="text-sm underline"
            style={{ color: '#fbbf24' }}
          >
            Start your first session
          </Link>
        </div>
      )}

      {sessions && sessions.length > 0 && (
        <ul className="space-y-2">
          {sessions.map((s) => (
            <li key={s.id}>
              <Link
                href={`/sessions/${s.id}`}
                className="block rounded-md p-4 transition-colors hover:bg-[#161616]"
                style={{
                  backgroundColor: '#111111',
                  border: '1px solid #1f1f1f',
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3 mb-1">
                      <span
                        className="font-mono text-sm truncate"
                        style={{ color: '#f0f0f0' }}
                      >
                        {s.repoFullName ?? 'unknown'}
                      </span>
                      <span
                        className="text-xs font-mono"
                        style={{ color: '#6b7280' }}
                      >
                        {s.branch}
                      </span>
                    </div>
                    <p
                      className="text-sm truncate"
                      style={{ color: '#6b7280' }}
                    >
                      {truncate(s.request, 80)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <StatusBadge status={s.status} />
                    <div className="flex items-center gap-2 text-xs" style={{ color: '#6b7280' }}>
                      <span>{timeAgo(s.createdAt)}</span>
                      {elapsedOrDuration(s) && (
                        <>
                          <span>·</span>
                          <span>{elapsedOrDuration(s)}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
