'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { getRepos, getSessions } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';
import type { Repo, Session } from '@/lib/types';

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

function Onboarding() {
  return (
    <div
      className="rounded-md p-6 mb-4"
      style={{ backgroundColor: '#111111', border: '1px solid #1f1f1f' }}
    >
      <p
        className="text-[11px] uppercase font-mono tracking-wider mb-3"
        style={{ color: '#fbbf24' }}
      >
        Get started
      </p>
      <h2 className="text-lg font-medium mb-2">Welcome to Anvil</h2>
      <p className="text-sm mb-5" style={{ color: '#6b7280' }}>
        Three quick steps and you&apos;ll have your first PR:
      </p>
      <ol className="space-y-3 mb-5 text-sm">
        <OnboardingStep n={1}>
          <Link href="/settings/repos" className="underline" style={{ color: '#fbbf24' }}>
            Connect a GitHub repo
          </Link>{' '}
          — pick one from the import list.
        </OnboardingStep>
        <OnboardingStep n={2}>
          <Link href="/sessions/new" className="underline" style={{ color: '#fbbf24' }}>
            Start a session
          </Link>{' '}
          — describe what you want changed.
        </OnboardingStep>
        <OnboardingStep n={3}>
          Approve the plan, review the diff, and Anvil opens a PR.
        </OnboardingStep>
      </ol>
      <p className="text-xs" style={{ color: '#6b7280' }}>
        First 60 minutes / month are free.{' '}
        <Link href="/settings/billing" className="underline" style={{ color: '#6b7280' }}>
          See plans
        </Link>
        .
      </p>
    </div>
  );
}

function OnboardingStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        className="shrink-0 mt-0.5 w-6 h-6 rounded-full flex items-center justify-center text-xs font-mono"
        style={{
          backgroundColor: '#0d0d0d',
          border: '1px solid #1f1f1f',
          color: '#fbbf24',
        }}
      >
        {n}
      </span>
      <span style={{ color: '#f0f0f0' }}>{children}</span>
    </li>
  );
}

export function SessionList() {
  const { data: sessions, error, isLoading } = useSWR<Session[]>(
    '/sessions',
    getSessions,
    { refreshInterval: 10_000 },
  );
  const { data: repos } = useSWR<Repo[]>('/repos', getRepos);
  const needsOnboarding =
    repos !== undefined &&
    repos.length === 0 &&
    (sessions?.length ?? 0) === 0;

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

      {needsOnboarding && <Onboarding />}

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

      {sessions && sessions.length === 0 && !needsOnboarding && (
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
        <ul className="space-y-2 mt-6">
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
