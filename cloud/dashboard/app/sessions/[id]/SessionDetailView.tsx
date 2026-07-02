'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  abortSession,
  approveSession,
  getSession,
  getSessionCheckpoint,
  openPullRequest,
  rejectSession,
  resumeSession,
  type SessionCheckpoint,
} from '@/lib/api';
import { useSessionEvents } from '@/lib/sse';
import { ActivityEvent } from '@/components/ActivityEvent';
import { DiffReview } from '@/components/DiffReview';
import { PlanApproval } from '@/components/PlanApproval';
import { StatusBadge, statusColor, statusLabel } from '@/components/StatusBadge';
import { StreamingDiff } from '@/components/StreamingDiff';
import type { FileDiff as EngineFileDiff } from '@/lib/diff-engine';
import type {
  Plan,
  SessionDetail,
  SessionStatus,
  UIEvent,
} from '@/lib/types';

export function SessionDetailView({ sessionId }: { sessionId: string }) {
  const { data: initial, error, mutate: refetchSession } = useSWR<SessionDetail>(
    `/sessions/${sessionId}`,
    () => getSession(sessionId),
  );
  const { events, status: liveStatus, initialSession } = useSessionEvents(sessionId);

  const session = initialSession ?? initial ?? null;
  const status: SessionStatus =
    liveStatus ?? session?.status ?? 'queued';

  const { data: checkpoint } = useSWR<SessionCheckpoint | null>(
    status === 'failed' ? `/sessions/${sessionId}/checkpoint` : null,
    () => getSessionCheckpoint(sessionId),
  );

  if (error) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-20 text-sm" style={{ color: '#f87171' }}>
        Failed to load session.
      </div>
    );
  }
  if (!session) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-20 text-sm" style={{ color: '#6b7280' }}>
        Loading session…
      </div>
    );
  }

  return (
    <div className="fixed inset-x-0 top-[52px] bottom-[40px] flex">
      <LeftPanel
        session={session}
        status={status}
        events={events}
        checkpoint={checkpoint ?? null}
        sessionId={sessionId}
        onResumed={() => refetchSession()}
      />
      <RightPanel
        sessionId={sessionId}
        status={status}
        events={events}
        session={session}
      />
      <StatusBar session={session} status={status} />
    </div>
  );
}

interface ParsedFileDiff {
  filepath: string;
  diff: EngineFileDiff;
}

function parseFileDiffEvent(payload: unknown): ParsedFileDiff | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const filepath = typeof obj.filepath === 'string' ? obj.filepath : null;
  if (!filepath) return null;
  const rawDiff = obj.diff as { hunks?: unknown } | undefined;
  if (!rawDiff || !Array.isArray(rawDiff.hunks)) return null;
  return { filepath, diff: rawDiff as unknown as EngineFileDiff };
}

function fmtTimeAgo(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function useLiveElapsed(startedAt: string | null, durationSeconds: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (durationSeconds != null || !startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt, durationSeconds]);
  if (durationSeconds != null) {
    const m = Math.floor(durationSeconds / 60);
    const s = durationSeconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
  if (!startedAt) return '—';
  const elapsed = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function LeftPanel({
  session,
  status,
  events,
  checkpoint,
  sessionId,
  onResumed,
}: {
  session: SessionDetail;
  status: SessionStatus;
  events: UIEvent[];
  checkpoint: SessionCheckpoint | null;
  sessionId: string;
  onResumed: () => void;
}) {
  const elapsed = useLiveElapsed(session.startedAt, session.durationSeconds);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  async function onResume() {
    setResuming(true);
    setResumeError(null);
    try {
      await resumeSession(sessionId);
      onResumed();
    } catch (err) {
      setResumeError((err as Error).message);
    } finally {
      setResuming(false);
    }
  }

  const filesModified = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of events) {
      if (e.type !== 'file_committed' && e.type !== 'file_modified') continue;
      const p = (e.payload as { path?: string; file?: string } | undefined);
      const path = p?.path ?? p?.file;
      if (path && !seen.has(path)) {
        seen.add(path);
        out.push(path);
      }
    }
    return out;
  }, [events]);

  const branchName = useMemo(() => {
    for (const e of events) {
      if (e.type === 'branch_created') {
        const p = e.payload as { branch?: string; name?: string } | undefined;
        return p?.branch ?? p?.name ?? null;
      }
    }
    return null;
  }, [events]);

  const commitCount = useMemo(
    () => events.filter((e) => e.type === 'file_committed').length,
    [events],
  );

  const prUrl = useMemo(() => {
    for (const e of events) {
      if (e.type === 'pr_description_ready') {
        const p = e.payload as { url?: string; prUrl?: string } | undefined;
        return p?.url ?? p?.prUrl ?? null;
      }
    }
    return session.prUrl ?? null;
  }, [events, session.prUrl]);

  return (
    <aside
      className="w-[320px] shrink-0 h-full overflow-y-auto p-5"
      style={{
        backgroundColor: '#0d0d0d',
        borderRight: '1px solid #1f1f1f',
      }}
    >
      <Section title="Session">
        <Row label="Repo" value={session.repoFullName} mono />
        <Row label="Base" value={session.branch} mono />
        <Row label="Model" value={session.model} mono />
        <Row label="Started" value={fmtTimeAgo(session.startedAt ?? session.createdAt)} />
        <Row label="Duration" value={elapsed} />
      </Section>

      <Section title="Status">
        <StatusBadge status={status} size="md" />
        {status === 'provisioning' && (
          <StatusHint color="#fbbf24">Starting VM…</StatusHint>
        )}
        {status === 'reviewing' && (
          <StatusHint color="#fbbf24">Plan ready for your approval</StatusHint>
        )}
        {status === 'running' && (
          <StatusHint color="#60a5fa">Agent is working…</StatusHint>
        )}
        {status === 'failed' && checkpoint && (
          <div className="mt-3">
            <div className="text-xs mb-2" style={{ color: '#6b7280' }}>
              Checkpointed at{' '}
              <span style={{ color: '#fbbf24' }}>{checkpoint.phase}</span>
            </div>
            <button
              onClick={onResume}
              disabled={resuming}
              className="w-full text-xs px-3 py-1.5 rounded font-medium disabled:opacity-40"
              style={{ backgroundColor: '#fbbf24', color: '#0a0a0a' }}
            >
              {resuming ? 'Resuming…' : `Resume from ${checkpoint.phase}`}
            </button>
            {resumeError && (
              <p className="text-xs mt-2" style={{ color: '#f87171' }}>
                {resumeError}
              </p>
            )}
          </div>
        )}
      </Section>

      {filesModified.length > 0 && (
        <Section title="Files modified">
          <ul className="space-y-1">
            {filesModified.map((f) => (
              <li key={f} className="flex items-start gap-2 text-[13px] font-mono">
                <span style={{ color: '#4ade80' }}>✓</span>
                <span style={{ color: '#f0f0f0' }} className="truncate">{f}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(branchName || commitCount > 0 || prUrl) && (
        <Section title="Git">
          {branchName && <Row label="Branch" value={branchName} mono />}
          {commitCount > 0 && <Row label="Commits" value={String(commitCount)} />}
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm underline flex items-center gap-2"
              style={{ color: '#60a5fa' }}
            >
              <span>View pull request</span>
              {session.prState && <PrStateBadge state={session.prState} />}
            </a>
          )}
        </Section>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <div
        className="text-[11px] uppercase tracking-wider mb-2 font-mono"
        style={{ color: '#6b7280' }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 text-[13px] mb-1">
      <span className="w-20 shrink-0" style={{ color: '#6b7280' }}>
        {label}
      </span>
      <span
        className={`flex-1 truncate ${mono ? 'font-mono' : ''}`}
        style={{ color: '#f0f0f0' }}
      >
        {value}
      </span>
    </div>
  );
}

function PrStateBadge({ state }: { state: 'open' | 'merged' | 'closed' }) {
  const map = {
    open: { color: '#60a5fa', label: 'open' },
    merged: { color: '#a78bfa', label: 'merged' },
    closed: { color: '#6b7280', label: 'closed' },
  } as const;
  const m = map[state];
  return (
    <span
      className="px-1.5 py-0 text-[10px] uppercase tracking-wider rounded font-mono"
      style={{ color: m.color, border: `1px solid ${m.color}` }}
    >
      {m.label}
    </span>
  );
}

function StatusHint({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 flex items-center gap-2 text-xs" style={{ color }}>
      <span
        className="inline-block h-1.5 w-1.5 rounded-full animate-pulse"
        style={{ backgroundColor: color }}
      />
      {children}
    </div>
  );
}

type Tab = 'activity' | 'diffs';

function RightPanel({
  sessionId,
  status,
  events,
  session,
}: {
  sessionId: string;
  status: SessionStatus;
  events: UIEvent[];
  session: SessionDetail;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [tab, setTab] = useState<Tab>('activity');
  const [prOpening, setPrOpening] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(session.prUrl);
  const [prError, setPrError] = useState<string | null>(null);

  useEffect(() => {
    if (session.prUrl) setPrUrl(session.prUrl);
  }, [session.prUrl]);

  const hasDiffs = events.some((e) => e.type === 'diff_ready');

  useEffect(() => {
    if (hasDiffs && tab === 'activity' && status === 'reviewing') {
      setTab('diffs');
    }
  }, [hasDiffs, status, tab]);

  async function openPr() {
    setPrOpening(true);
    setPrError(null);
    try {
      const res = await openPullRequest(sessionId);
      setPrUrl(res.prUrl);
    } catch (err) {
      setPrError((err as Error).message);
    } finally {
      setPrOpening(false);
    }
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events.length]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScrollRef.current = distFromBottom < 40;
  }

  const [planResolved, setPlanResolved] = useState(false);
  const [planResolution, setPlanResolution] = useState<'approved' | 'rejected' | null>(null);
  const [planPending, setPlanPending] = useState(false);

  useEffect(() => {
    if (status === 'running' && planResolution === 'approved') return;
    if (status === 'reviewing') {
      setPlanResolved(false);
      setPlanResolution(null);
    }
  }, [status, planResolution]);

  async function approvePlan() {
    setPlanPending(true);
    try {
      await approveSession(sessionId);
      setPlanResolved(true);
      setPlanResolution('approved');
    } finally {
      setPlanPending(false);
    }
  }
  async function rejectPlan() {
    setPlanPending(true);
    try {
      await rejectSession(sessionId);
      setPlanResolved(true);
      setPlanResolution('rejected');
    } finally {
      setPlanPending(false);
    }
  }
  async function abort() {
    if (!confirm('Abort this session?')) return;
    try {
      await abortSession(sessionId);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  const planEvent = useMemo(
    () => [...events].reverse().find((e) => e.type === 'plan_ready') ?? null,
    [events],
  );
  const plan: Plan | null = planEvent
    ? ((planEvent.payload as { plan?: Plan })?.plan ??
       (planEvent.payload as Plan))
    : null;

  const canAbort =
    status === 'queued' || status === 'provisioning' || status === 'running';

  return (
    <section className="flex-1 h-full flex flex-col">
      <div
        className="flex items-center justify-between px-5 h-11 shrink-0"
        style={{ borderBottom: '1px solid #1f1f1f', backgroundColor: '#0a0a0a' }}
      >
        <div className="flex items-baseline gap-4">
          <TabButton
            active={tab === 'activity'}
            onClick={() => setTab('activity')}
          >
            Activity
            <span className="ml-2 text-xs font-mono" style={{ color: '#6b7280' }}>
              {events.length}
            </span>
          </TabButton>
          {hasDiffs && (
            <TabButton
              active={tab === 'diffs'}
              onClick={() => setTab('diffs')}
            >
              Diffs
            </TabButton>
          )}
        </div>
        {canAbort && (
          <button
            onClick={abort}
            className="text-xs px-2.5 py-1 rounded"
            style={{
              color: '#f87171',
              border: '1px solid rgba(248, 113, 113, 0.3)',
            }}
          >
            Abort
          </button>
        )}
      </div>
      {tab === 'activity' && (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto"
        >
          {events.map((e, idx) => {
            if (e.type === 'plan_ready' && plan) {
              return (
                <PlanApproval
                  key={`plan-${idx}`}
                  plan={plan}
                  onApprove={approvePlan}
                  onReject={rejectPlan}
                  resolved={planResolved || status !== 'reviewing'}
                  resolution={
                    planResolved
                      ? planResolution
                      : status === 'running'
                        ? 'approved'
                        : status === 'failed' || status === 'aborted'
                          ? 'rejected'
                          : null
                  }
                  pending={planPending}
                />
              );
            }
            if (e.type === 'file_diff') {
              const parsed = parseFileDiffEvent(e.payload);
              if (parsed) {
                // Diffs freeze once the session has finished streaming lines.
                const isStreaming =
                  status === 'running' || status === 'provisioning';
                return (
                  <StreamingDiff
                    key={`filediff-${idx}`}
                    filepath={parsed.filepath}
                    diff={parsed.diff}
                    isStreaming={isStreaming}
                  />
                );
              }
            }
            return <ActivityEvent key={idx} event={e} />;
          })}
          {events.length === 0 && (
            <div className="px-5 py-6 text-sm" style={{ color: '#6b7280' }}>
              Waiting for the first event…
            </div>
          )}
        </div>
      )}
      {tab === 'diffs' && (
        <DiffReview
          sessionId={sessionId}
          onOpenPr={openPr}
          prOpening={prOpening}
          prUrl={prUrl}
          prError={prError}
        />
      )}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="text-sm font-medium h-11 -mb-px border-b-2 transition-colors flex items-center"
      style={{
        color: active ? '#f0f0f0' : '#6b7280',
        borderColor: active ? '#fbbf24' : 'transparent',
      }}
    >
      {children}
    </button>
  );
}

function StatusBar({ session, status }: { session: SessionDetail; status: SessionStatus }) {
  const elapsed = useLiveElapsed(session.startedAt, session.durationSeconds);
  return (
    <footer
      className="fixed bottom-0 inset-x-0 h-10 flex items-center justify-between px-5 text-xs font-mono"
      style={{
        backgroundColor: '#0a0a0a',
        borderTop: '1px solid #1f1f1f',
      }}
    >
      <div style={{ color: '#6b7280' }}>{session.model}</div>
      <div style={{ color: statusColor(status) }}>{statusLabel(status)}</div>
      <div style={{ color: '#6b7280' }}>{elapsed}</div>
    </footer>
  );
}
