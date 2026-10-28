'use client';
import { useState } from 'react';
import type { Plan } from '@/lib/types';

export interface PlanApprovalProps {
  plan: Plan;
  onApprove: () => void;
  onReject: () => void;
  onRevise?: (feedback: string) => void;
  resolved: boolean;
  resolution: 'approved' | 'rejected' | null;
  pending?: boolean;
  readOnly?: boolean;
  error?: string | null;
}

export function PlanApproval({ plan, onApprove, onReject, onRevise, resolved, resolution, pending, readOnly, error }: PlanApprovalProps) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState('');
  const title = plan.goal ?? plan.intent ?? 'Implementation plan';
  return (
    <article className="plan-card">
      <div className="plan-heading"><span className="eyebrow">{resolved ? 'Implementation plan' : 'Your review is needed'}</span><span className="mini-label">PLAN</span></div>
      <h2>{title}</h2>
      {(plan.context || plan.approach) && <p className="plan-context">{plan.context ?? plan.approach}</p>}
      {!!plan.steps?.length && <ol className="plan-steps">{plan.steps.map((step, i) => <li key={i}><span>{String(i + 1).padStart(2, '0')}</span><p>{step}</p></li>)}</ol>}
      <div className="plan-files">
        <FileList label="Modify" files={plan.filesToModify} />
        <FileList label="Create" files={plan.filesToCreate} />
      </div>
      {!!plan.verificationCriteria?.length && <div className="plan-checks"><h3>Verification</h3>{plan.verificationCriteria.map((check, i) => <p key={i}><span aria-hidden>✓</span> {check}</p>)}</div>}
      {plan.testPlan && <p className="plan-context">{plan.testPlan}</p>}
      {!!plan.risks?.length && <details className="plan-risks"><summary>{plan.risks.length} consideration{plan.risks.length === 1 ? '' : 's'}</summary><ul>{plan.risks.map((risk, i) => <li key={i}>{risk}</li>)}</ul></details>}
      {error && <p className="action-error" role="alert">{error}</p>}
      {readOnly ? <p className="demo-note">Sample plan. Live session controls are disabled in this preview.</p> : resolved ? <div className="plan-resolution">{resolution === 'approved' ? '✓ Plan approved' : resolution === 'rejected' ? 'Plan rejected' : 'Plan recorded'}</div> : (
        <div className="plan-actions">
          {revising && <form className="revision-form" onSubmit={e => { e.preventDefault(); if (feedback.trim()) onRevise?.(feedback.trim()); }}>
            <label htmlFor="revision-feedback">What should change?</label>
            <textarea id="revision-feedback" maxLength={4000} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Keep the public API unchanged and add a regression test…" rows={3} disabled={pending} />
            <div className="flex gap-2 justify-end"><button type="button" className="button-secondary" onClick={() => setRevising(false)}>Cancel</button><button className="button-primary" disabled={pending || !feedback.trim()}>Send revision</button></div>
          </form>}
          {!revising && <div className="flex flex-wrap gap-2 justify-end w-full">
            <button className="button-danger" disabled={pending} onClick={onReject}>Reject</button>
            {onRevise && <button className="button-secondary" disabled={pending} onClick={() => setRevising(true)}>Request changes</button>}
            <button className="button-primary" disabled={pending} onClick={onApprove}>{pending ? 'Saving…' : 'Approve & run'}<span aria-hidden> ↗</span></button>
          </div>}
        </div>
      )}
    </article>
  );
}

function FileList({ label, files }: { label: string; files?: string[] }) {
  if (!files?.length) return null;
  return <div><h3>{label} <span>{files.length}</span></h3>{files.map(file => <p key={file} title={file}><span aria-hidden>{label === 'Create' ? '+' : '~'}</span> {file}</p>)}</div>;
}
