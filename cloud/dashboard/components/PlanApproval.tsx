'use client';

import type { Plan } from '@/lib/types';

export interface PlanApprovalProps {
  plan: Plan;
  onApprove: () => void;
  onReject: () => void;
  resolved: boolean;
  resolution: 'approved' | 'rejected' | null;
  pending?: boolean;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div
        className="text-[11px] uppercase tracking-wider mb-1 font-mono"
        style={{ color: '#6b7280' }}
      >
        {title}
      </div>
      <div className="text-sm" style={{ color: '#f0f0f0' }}>
        {children}
      </div>
    </div>
  );
}

function FileList({ files }: { files: string[] | undefined }) {
  if (!files || files.length === 0) {
    return <span style={{ color: '#6b7280' }}>(none)</span>;
  }
  return (
    <ul className="space-y-0.5 font-mono text-[13px]">
      {files.map((f) => (
        <li key={f} style={{ color: '#f0f0f0' }}>
          {f}
        </li>
      ))}
    </ul>
  );
}

function RiskList({ risks }: { risks: string[] | undefined }) {
  if (!risks || risks.length === 0) {
    return <span style={{ color: '#6b7280' }}>(none)</span>;
  }
  return (
    <ul className="space-y-1">
      {risks.map((r, i) => (
        <li key={i} className="text-sm">
          {r}
        </li>
      ))}
    </ul>
  );
}

export function PlanApproval({
  plan,
  onApprove,
  onReject,
  resolved,
  resolution,
  pending,
}: PlanApprovalProps) {
  return (
    <div
      className="my-3 mx-3 rounded-md"
      style={{
        backgroundColor: '#111111',
        border: resolved
          ? '1px solid #1f1f1f'
          : '1px solid rgba(251, 191, 36, 0.5)',
        boxShadow: resolved ? 'none' : '0 0 0 1px rgba(251, 191, 36, 0.1)',
      }}
    >
      <div
        className="px-4 py-2 border-b text-[12px] uppercase tracking-wider font-mono"
        style={{
          borderColor: '#1f1f1f',
          color: resolved ? '#6b7280' : '#fbbf24',
        }}
      >
        Plan ready
      </div>
      <div className="px-4 py-3 max-h-[420px] overflow-y-auto">
        {plan.intent && (
          <Section title="Intent">
            <p className="text-sm">{plan.intent}</p>
          </Section>
        )}
        {plan.approach && (
          <Section title="Approach">
            <p className="text-sm whitespace-pre-wrap">{plan.approach}</p>
          </Section>
        )}
        <Section title="Files to read">
          <FileList files={plan.filesToRead} />
        </Section>
        <Section title="Files to modify">
          <FileList files={plan.filesToModify} />
        </Section>
        <Section title="Files to create">
          <FileList files={plan.filesToCreate} />
        </Section>
        {plan.testPlan && (
          <Section title="Test plan">
            <p className="text-sm whitespace-pre-wrap">{plan.testPlan}</p>
          </Section>
        )}
        <Section title="Risks">
          <RiskList risks={plan.risks} />
        </Section>
      </div>
      <div
        className="px-4 py-2 border-t flex items-center justify-end gap-2"
        style={{ borderColor: '#1f1f1f' }}
      >
        {resolved ? (
          <span
            className="text-sm font-mono"
            style={{
              color: resolution === 'approved' ? '#4ade80' : '#f87171',
            }}
          >
            {resolution === 'approved' ? 'Plan approved' : 'Plan rejected'}
          </span>
        ) : (
          <>
            <button
              onClick={onReject}
              disabled={pending}
              className="px-3 py-1.5 text-sm rounded-md font-medium transition-opacity disabled:opacity-50"
              style={{
                backgroundColor: 'transparent',
                color: '#f87171',
                border: '1px solid rgba(248, 113, 113, 0.4)',
              }}
            >
              Reject
            </button>
            <button
              onClick={onApprove}
              disabled={pending}
              className="px-3 py-1.5 text-sm rounded-md font-medium transition-opacity disabled:opacity-50"
              style={{
                backgroundColor: '#4ade80',
                color: '#0a0a0a',
                border: '1px solid #4ade80',
              }}
            >
              Approve
            </button>
          </>
        )}
      </div>
    </div>
  );
}
