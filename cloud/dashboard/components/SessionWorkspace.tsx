'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { abortSession, approveSession, rejectSession, reviseSession, openPullRequest, getSessionCheckpoint, resumeSession } from '@/lib/api';
import { ActivityEvent } from './ActivityEvent';
import { DiffReview } from './DiffReview';
import { PlanApproval } from './PlanApproval';
import { StatusBadge } from './StatusBadge';
import { isTerminal } from '@/lib/session-events';
import type { ConnectionState } from '@/lib/sse';
import type { Plan, SessionDetail, SessionStatus, UIEvent } from '@/lib/types';

interface Props {
  session: SessionDetail;
  status: SessionStatus;
  events: UIEvent[];
  connection: ConnectionState;
  connectionError?: string | null;
  onReconnect?: () => void;
  onRefresh?: () => void;
  onResumed?: (sessionId: string) => void;
  readOnly?: boolean;
}
const PHASES = ['Initialize', 'Explore', 'Plan', 'Approve', 'Branch', 'Execute', 'Verify', 'Fix', 'Commit', 'Complete'];
type Tab = 'activity' | 'changes' | 'plan';

export function SessionWorkspace({ session, status, events, connection, connectionError, onReconnect, onRefresh, onResumed, readOnly }: Props) {
  const [tab, setTab] = useState<Tab>('activity');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'tools' | 'checks'>('all');
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [prUrl, setPrUrl] = useState(session.prUrl);
  const [follow, setFollow] = useState(true);
  const activityRef = useRef<HTMLDivElement>(null);
  const latest = (type: string) => events.findLast(e => e.type === type);
  const phase = latest('phase_transition')?.payload as { index?: number; label?: string } | undefined;
  const phaseIndex = phase?.index ?? (status === 'reviewing' ? 4 : status === 'complete' ? 10 : 1);
  const planPayload = latest('plan_ready')?.payload as { plan?: Plan } | Plan | undefined;
  const plan = (planPayload && ('plan' in planPayload ? planPayload.plan : planPayload) || session.planJson) as Plan | null;
  const branch = (latest('branch_created')?.payload as { branchName?: string } | undefined)?.branchName;
  const verification = events.findLast(e => ['verification_pass', 'verification_fail', 'verification_skipped'].includes(e.type));
  const checkLabel = verification?.type === 'verification_pass' ? 'Checks passed' : verification?.type === 'verification_fail' ? 'Checks failed' : verification?.type === 'verification_skipped' ? 'Checks skipped' : 'Checks pending';
  const files = new Set(session.diffs.map(d => d.filepath));
  for (const event of events) {
    if (event.type === 'file_modified' || event.type === 'file_diff') {
      const p = event.payload as { path?: string; filepath?: string } | undefined;
      if (p?.path || p?.filepath) files.add((p.path ?? p.filepath)!.replace(/^\/workspace\/repo\//, ''));
    }
  }
  const { data: checkpoint } = useSWR(!readOnly && status === 'failed' ? `/sessions/${session.id}/checkpoint` : null, () => getSessionCheckpoint(session.id));
  const visibleEvents = events.filter(event => {
    if (['plan_ready', 'file_diff', 'usage_update'].includes(event.type)) return false;
    if (filter === 'tools' && !['tool_call', 'tool_result', 'command_output', 'command_complete', 'command_running'].includes(event.type)) return false;
    if (filter === 'checks' && !/verification|shadow|error|failed/.test(event.type)) return false;
    return !query || JSON.stringify(event).toLowerCase().includes(query.toLowerCase());
  });
  useEffect(() => {
    if (follow && activityRef.current) activityRef.current.scrollTop = activityRef.current.scrollHeight;
  }, [events.length, follow, tab]);

  async function action(run: () => Promise<unknown>) {
    if (pending || readOnly) return;
    setPending(true); setActionError(null);
    try { await run(); onRefresh?.(); }
    catch (err) { setActionError((err as Error).message); }
    finally { setPending(false); }
  }
  function exportLog() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ session, events, capturedAt: new Date().toISOString(), note: 'Visible activity window; older events may be omitted.' }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `anvil-${session.id.slice(0, 8)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const planCard = plan ? <PlanApproval key={JSON.stringify(plan)} plan={plan} readOnly={readOnly} pending={pending}
    error={actionError} resolved={status !== 'reviewing'} resolution={status === 'aborted' ? 'rejected' : status === 'running' || status === 'complete' ? 'approved' : null}
    onApprove={() => void action(() => approveSession(session.id))} onReject={() => void action(() => rejectSession(session.id))}
    onRevise={feedback => void action(() => reviseSession(session.id, feedback))} /> : null;

  return <main className="session-workspace">
    {readOnly && <div className="preview-banner"><span>INTERACTIVE PREVIEW</span> Sample session data. No agent is running and no services are connected.</div>}
    <div className="workspace-titlebar">
      <div className="min-w-0"><div className="workspace-breadcrumb"><Link href="/">Sessions</Link><span>/</span><span>{session.repoFullName}</span><span className="session-short-id">{session.id.slice(0, 8)}</span></div><h1>{session.request}</h1></div>
      <div className="workspace-title-actions"><StatusBadge status={status} size="md" /><button className="button-secondary" onClick={exportLog}>Export log</button>
        {!readOnly && !isTerminal(status) && <button className="button-danger" disabled={pending} onClick={() => setConfirmAbort(true)}>Stop</button>}
      </div>
    </div>
    <div className="mobile-current-phase">Phase {phaseIndex}/10 · {phase?.label ?? PHASES[phaseIndex - 1]}</div>
    <div className="workflow-track" aria-label={`Phase ${phaseIndex} of 10: ${phase?.label ?? PHASES[phaseIndex - 1]}`}>
      {PHASES.map((label, i) => <div key={label} className={`workflow-step ${i + 1 === phaseIndex ? 'current' : ''}`} aria-current={i + 1 === phaseIndex ? 'step' : undefined}><span>{String(i + 1).padStart(2, '0')}</span>{label}</div>)}
    </div>
    {confirmAbort && <div className="workspace-notice" role="alert"><p>Stop this session? The agent will stop working; existing changes remain available for review.</p><button className="button-secondary" onClick={() => setConfirmAbort(false)}>Keep running</button><button className="button-danger" disabled={pending} onClick={() => void action(async () => { await abortSession(session.id); setConfirmAbort(false); })}>Stop session</button></div>}
    {actionError && tab !== 'plan' && <div className="workspace-notice action-error" role="alert">{actionError}</div>}
    {connectionError && <div className="workspace-notice" role="status"><span>{connectionError}</span><button className="button-secondary" onClick={onReconnect}>Reconnect</button></div>}
    <div className="workspace-body">
      <aside className="session-sidebar">
        <div className="eyebrow">Workspace</div>
        <dl className="session-facts"><dt>Repository</dt><dd>{session.repoFullName}</dd><dt>Base branch</dt><dd>{session.branch}</dd><dt>Model</dt><dd>{session.model}</dd>{branch && <><dt>Session branch</dt><dd>{branch}</dd></>}</dl>
        <div className="sidebar-divider" />
        <div className="eyebrow">Validation</div><div className={`check-indicator ${verification?.type === 'verification_pass' ? 'passed' : ''}`}><span aria-hidden>◇</span>{checkLabel}</div>
        <p className="sidebar-note">Review the final changes before opening a pull request.</p>
        <div className="sidebar-divider" /><div className="eyebrow">Changed files <span>{files.size.toString().padStart(2, '0')}</span></div>
        {files.size ? <ul className="changed-files">{[...files].map(file => <li key={file}><button title={file} onClick={() => setTab('changes')}><span aria-hidden>~</span>{file}</button></li>)}</ul> : <p className="sidebar-note">Files appear here as edits land.</p>}
        {checkpoint && <p className="text-xs text-neutral-400 mt-3">Retry starts a fresh checkout in a new session. This session’s changes stay available here for review.</p>}
        {checkpoint && <button className="button-primary mt-6" disabled={pending} onClick={() => void action(async () => { const result = await resumeSession(session.id); onResumed?.(result.session.id); })}>Retry from branch</button>}
        {(prUrl || session.prUrl) && <a className="button-secondary mt-6 inline-block" href={prUrl ?? session.prUrl!} target="_blank" rel="noreferrer">View pull request ↗</a>}
      </aside>
      <section className="session-main">
        <div className="workspace-tabs" role="tablist" aria-label="Session views">{(['activity', 'changes', 'plan'] as Tab[]).map(name => <button key={name} role="tab" id={`tab-${name}`} aria-selected={tab === name} aria-controls={`panel-${name}`} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name === 'activity' ? 'Activity' : name === 'changes' ? 'Changes' : 'Plan'}<span>{name === 'changes' ? files.size : name === 'activity' ? events.length : plan ? '1' : '0'}</span></button>)}
          <div className={`connection-state ${connection === 'live' ? 'connected' : ''}`} role="status"><i />{readOnly ? 'Preview' : connection === 'live' ? 'Live' : connection === 'closed' ? 'Saved' : connection === 'error' ? 'Offline' : 'Connecting'}</div>
        </div>
        {tab === 'activity' && <div className="activity-panel" role="tabpanel" id="panel-activity" aria-labelledby="tab-activity">
          {status === 'reviewing' && planCard}
          <div className="activity-toolbar"><label className="activity-search"><span aria-hidden>⌕</span><input aria-label="Search activity" placeholder="Search activity…" value={query} onChange={e => setQuery(e.target.value)} /></label><select aria-label="Activity type" value={filter} onChange={e => setFilter(e.target.value as typeof filter)}><option value="all">All events</option><option value="tools">Tools & commands</option><option value="checks">Validation</option></select><button className={`follow-button ${follow ? 'active' : ''}`} aria-pressed={follow} onClick={() => setFollow(v => !v)}>{follow ? '↓ Following' : '↓ Follow'}</button></div>
          <div className="activity-feed" ref={activityRef} onScroll={() => { const el = activityRef.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 60) setFollow(false); }}>
            {visibleEvents.map((event, i) => <div className="activity-row" key={event.id ?? `${event.type}-${event.timestamp}-${i}`}><time>{event.timestamp ? new Date(event.timestamp).toLocaleTimeString([], { hour12: false }) : '··:··:··'}</time><ActivityEvent event={event} /></div>)}
            {!visibleEvents.length && <div className="workspace-empty"><span className="empty-mark" aria-hidden>⌁</span><h2>{query || filter !== 'all' ? 'No matching events' : 'Ready when you are'}</h2><p>{query || filter !== 'all' ? 'Try another search or event filter.' : 'Agent activity will appear here as the session progresses.'}</p></div>}
          </div>
        </div>}
        {tab === 'plan' && <div className="plan-panel" role="tabpanel" id="panel-plan" aria-labelledby="tab-plan">{planCard ?? <div className="workspace-empty">No plan has been produced yet.</div>}</div>}
        {tab === 'changes' && <div className="changes-panel" role="tabpanel" id="panel-changes" aria-labelledby="tab-changes"><DiffReview sessionId={session.id} initialDiffs={session.diffs} readOnly={readOnly} sessionComplete={status === 'complete'} prOpening={pending} prUrl={prUrl ?? session.prUrl} prError={actionError}
          onOpenPr={() => void action(async () => { const result = await openPullRequest(session.id); setPrUrl(result.prUrl); })} /></div>}
      </section>
    </div>
    <footer className="workspace-footer"><span><i />{readOnly ? 'Sample workspace' : session.repoFullName}</span><span>{files.size} files changed</span><span>ANVIL / {session.id.slice(0, 8)}</span></footer>
  </main>;
}
