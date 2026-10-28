'use client';

import { useEffect, useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { approveAllDiffs, approveDiff, getDiffs, rejectDiff } from '@/lib/api';
import type { Diff, DiffStatus } from '@/lib/types';
import { generateDiff, statsForHunks, type FileDiff } from '@/lib/diff-engine';

export interface DiffReviewProps {
  sessionId: string;
  onOpenPr?: () => void;
  prOpening?: boolean;
  prUrl?: string | null;
  prError?: string | null;
  initialDiffs?: Diff[];
  readOnly?: boolean;
  sessionComplete?: boolean;
}

interface FileEntry {
  diff: Diff;
  file: FileDiff;
}

export function DiffReview({
  sessionId,
  onOpenPr,
  prOpening,
  prUrl,
  prError, initialDiffs, readOnly, sessionComplete,
}: DiffReviewProps) {
  const key = `/sessions/${sessionId}/diffs`;
  const { data: diffs, isLoading, error } = useSWR<Diff[]>(
    readOnly ? null : key,
    () => getDiffs(sessionId),
    { refreshInterval: readOnly || sessionComplete ? 0 : 5_000, fallbackData: initialDiffs },
  );
  const { mutate } = useSWRConfig();

  const entries: FileEntry[] = useMemo(() => {
    if (!diffs) return [];
    return diffs.map((d) => ({
      diff: d,
      file: generateDiff(
        d.originalContent ?? '',
        d.newContent ?? '',
        d.filepath,
      ),
    }));
  }, [diffs]);

  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);

  async function setStatus(diffId: string, status: DiffStatus) {
    setPending((p) => ({ ...p, [diffId]: true }));
    setActionError(null);
    try {
      if (status === 'approved') await approveDiff(sessionId, diffId);
      else await rejectDiff(sessionId, diffId);
      await mutate(key);
    } catch (err) { setActionError((err as Error).message); } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[diffId];
        return next;
      });
    }
  }

  async function approveEverything() {
    setApprovingAll(true);
    try {
      await approveAllDiffs(sessionId);
      await mutate(key);
    } catch (err) { setActionError((err as Error).message); } finally {
      setApprovingAll(false);
    }
  }

  const summary = useMemo(() => {
    let pending = 0;
    let approved = 0;
    let rejected = 0;
    for (const d of diffs ?? []) {
      if (d.status === 'pending') pending++;
      else if (d.status === 'approved') approved++;
      else rejected++;
    }
    return { pending, approved, rejected };
  }, [diffs]);

  const canOpenPr = !!sessionComplete && summary.approved > 0 && summary.pending === 0 && !prUrl;

  if (isLoading && !diffs) {
    return (
      <div className="px-5 py-6 text-sm" style={{ color: '#6b7280' }}>
        Loading diffs…
      </div>
    );
  }

  if (error && !diffs) return <div className="action-error p-5" role="alert">Failed to load changes. <button className="button-secondary" onClick={() => void mutate(key)}>Retry</button></div>;

  if (!diffs || diffs.length === 0) {
    return (
      <div className="px-5 py-6 text-sm" style={{ color: '#6b7280' }}>
        No file changes to review yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {actionError && <p className="action-error p-3" role="alert">{actionError}</p>}
      {!readOnly && <Toolbar
        summary={summary}
        onApproveAll={approveEverything}
        approvingAll={approvingAll}
        onOpenPr={onOpenPr}
        canOpenPr={canOpenPr}
        prOpening={prOpening}
        prUrl={prUrl}
        prError={prError}
      />}
      <div className="flex-1 overflow-y-auto">
        {entries.map((entry) => (
          <FileDiffCard
            key={entry.diff.id}
            entry={entry}
            pending={readOnly || pending[entry.diff.id] || false}
            onApprove={() => setStatus(entry.diff.id, 'approved')}
            onReject={() => setStatus(entry.diff.id, 'rejected')}
          />
        ))}
      </div>
    </div>
  );
}

function Toolbar({
  summary,
  onApproveAll,
  approvingAll,
  onOpenPr,
  canOpenPr,
  prOpening,
  prUrl,
  prError,
}: {
  summary: { pending: number; approved: number; rejected: number };
  onApproveAll: () => void;
  approvingAll: boolean;
  onOpenPr?: () => void;
  canOpenPr: boolean;
  prOpening?: boolean;
  prUrl?: string | null;
  prError?: string | null;
}) {
  return (
    <div
      className="flex flex-wrap gap-3 items-center justify-between px-5 py-3 shrink-0"
      style={{ borderBottom: '1px solid #1f1f1f', backgroundColor: '#0a0a0a' }}
    >
      <div className="flex items-baseline gap-3 text-xs font-mono">
        <span style={{ color: '#fbbf24' }}>{summary.pending} pending</span>
        <span style={{ color: '#4ade80' }}>{summary.approved} approved</span>
        <span style={{ color: '#f87171' }}>{summary.rejected} rejected</span>
      </div>
      <div className="flex items-center gap-2">
        {prError && (
          <span className="text-xs" style={{ color: '#f87171' }}>
            {prError}
          </span>
        )}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs underline"
            style={{ color: '#60a5fa' }}
          >
            View PR
          </a>
        )}
        {summary.pending > 0 && (
          <button
            onClick={onApproveAll}
            disabled={approvingAll}
            className="text-xs px-2.5 py-1 rounded disabled:opacity-40"
            style={{
              color: '#4ade80',
              border: '1px solid rgba(74, 222, 128, 0.3)',
            }}
          >
            {approvingAll ? 'Approving…' : 'Approve all'}
          </button>
        )}
        {onOpenPr && (
          <button
            onClick={onOpenPr}
            disabled={!canOpenPr || prOpening}
            className="text-xs px-2.5 py-1 rounded font-medium disabled:opacity-40"
            style={{ backgroundColor: '#fbbf24', color: '#0a0a0a' }}
          >
            {prOpening ? 'Opening PR…' : prUrl ? 'PR opened' : 'Open PR'}
          </button>
        )}
      </div>
    </div>
  );
}

function FileDiffCard({
  entry,
  pending,
  onApprove,
  onReject,
}: {
  entry: FileEntry;
  pending: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { diff, file } = entry;
  const stats = useMemo(() => statsForHunks(file.hunks), [file.hunks]);
  const [expanded, setExpanded] = useState(true);

  return (
    <div
      className="mx-3 my-3 rounded-md overflow-hidden"
      style={{
        backgroundColor: '#0d0d0d',
        border: '1px solid #1f1f1f',
      }}
    >
      <div
        className="flex flex-wrap items-center gap-3 px-3 py-2"
        style={{
          borderBottom: '1px solid #1f1f1f',
          backgroundColor: '#111111',
        }}
      >
        <button
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${diff.filepath}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          className="text-xs font-mono"
          style={{ color: '#6b7280' }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span
          className="font-mono text-sm truncate flex-1"
          style={{ color: '#f0f0f0' }}
        >
          {diff.filepath}
        </span>
        <span className="text-xs font-mono" style={{ color: '#4ade80' }}>
          +{stats.additions}
        </span>
        <span className="text-xs font-mono" style={{ color: '#f87171' }}>
          −{stats.deletions}
        </span>
        <StatusPill status={diff.status} />
        {diff.status === 'pending' && (
          <div className="flex items-center gap-1">
            <button
              onClick={onReject}
              disabled={pending}
              title="Reject file"
              className="text-xs px-2 py-0.5 rounded disabled:opacity-40"
              style={{
                color: '#f87171',
                border: '1px solid rgba(248, 113, 113, 0.3)',
              }}
            >
              Reject
            </button>
            <button
              onClick={onApprove}
              disabled={pending}
              title="Approve file"
              className="text-xs px-2 py-0.5 rounded font-medium disabled:opacity-40"
              style={{ backgroundColor: '#4ade80', color: '#0a0a0a' }}
            >
              Approve
            </button>
          </div>
        )}
      </div>
      {expanded && (
        <div className="text-[12px] font-mono overflow-x-auto">
          {file.hunks.length === 0 ? (
            <div className="px-3 py-2" style={{ color: '#6b7280' }}>
              No content changes.
            </div>
          ) : (
            file.hunks.map((hunk, i) => <HunkView key={i} hunk={hunk} />)
          )}
        </div>
      )}
    </div>
  );
}

function HunkView({ hunk }: { hunk: import('@/lib/diff-engine').DiffHunk }) {
  return (
    <div>
      <div
        className="px-3 py-0.5 text-[11px]"
        style={{ color: '#6b7280', backgroundColor: '#0a0a0a' }}
      >
        {hunk.header}
      </div>
      {hunk.lines.map((line, i) => {
        let color = '#f0f0f0';
        let bg = 'transparent';
        if (line[0] === '+') {
          color = '#4ade80';
          bg = 'rgba(74, 222, 128, 0.06)';
        } else if (line[0] === '-') {
          color = '#f87171';
          bg = 'rgba(248, 113, 113, 0.06)';
        } else {
          color = '#6b7280';
        }
        return (
          <div
            key={i}
            className="px-3 whitespace-pre"
            style={{ color, backgroundColor: bg }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
}

function StatusPill({ status }: { status: DiffStatus }) {
  const meta: Record<DiffStatus, { color: string; label: string }> = {
    pending: { color: '#fbbf24', label: 'pending' },
    approved: { color: '#4ade80', label: 'approved' },
    rejected: { color: '#f87171', label: 'rejected' },
  };
  const m = meta[status];
  return (
    <span
      className="px-2 py-0.5 text-[10px] uppercase tracking-wider rounded font-mono"
      style={{ color: m.color, border: `1px solid ${m.color}` }}
    >
      {m.label}
    </span>
  );
}
