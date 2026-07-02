import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';

// Ten-phase workflow model for an Anvil session.
//
// The orchestrator does not enforce these transitions — it just emits
// `phase_transition` events at existing checkpoints so the TUI (and any
// downstream consumer, like the cloud VM runtime) can display progress
// as "N/10 Phase Name" without restructuring control flow.

export enum WorkflowPhase {
  INITIALIZING = 'INITIALIZING',
  EXPLORING = 'EXPLORING',
  PLANNING = 'PLANNING',
  AWAITING_APPROVAL = 'AWAITING_APPROVAL',
  BRANCHING = 'BRANCHING',
  EXECUTING = 'EXECUTING',
  VERIFYING = 'VERIFYING',
  FIXING = 'FIXING',
  COMMITTING = 'COMMITTING',
  COMPLETE = 'COMPLETE',
}

export const WORKFLOW_ORDER: WorkflowPhase[] = [
  WorkflowPhase.INITIALIZING,
  WorkflowPhase.EXPLORING,
  WorkflowPhase.PLANNING,
  WorkflowPhase.AWAITING_APPROVAL,
  WorkflowPhase.BRANCHING,
  WorkflowPhase.EXECUTING,
  WorkflowPhase.VERIFYING,
  WorkflowPhase.FIXING,
  WorkflowPhase.COMMITTING,
  WorkflowPhase.COMPLETE,
];

export const WORKFLOW_TOTAL = WORKFLOW_ORDER.length;

export const PHASE_LABELS: Record<WorkflowPhase, string> = {
  [WorkflowPhase.INITIALIZING]: 'Initializing',
  [WorkflowPhase.EXPLORING]: 'Exploring',
  [WorkflowPhase.PLANNING]: 'Planning',
  [WorkflowPhase.AWAITING_APPROVAL]: 'Awaiting approval',
  [WorkflowPhase.BRANCHING]: 'Branching',
  [WorkflowPhase.EXECUTING]: 'Executing',
  [WorkflowPhase.VERIFYING]: 'Verifying',
  [WorkflowPhase.FIXING]: 'Fixing',
  [WorkflowPhase.COMMITTING]: 'Committing',
  [WorkflowPhase.COMPLETE]: 'Complete',
};

const ALLOWED_TRANSITIONS: Record<WorkflowPhase, ReadonlySet<WorkflowPhase>> = {
  [WorkflowPhase.INITIALIZING]: new Set([
    WorkflowPhase.EXPLORING,
    WorkflowPhase.PLANNING,
    WorkflowPhase.COMPLETE,
  ]),
  [WorkflowPhase.EXPLORING]: new Set([
    WorkflowPhase.PLANNING,
    WorkflowPhase.COMPLETE,
  ]),
  [WorkflowPhase.PLANNING]: new Set([
    WorkflowPhase.AWAITING_APPROVAL,
    WorkflowPhase.BRANCHING,
    WorkflowPhase.EXECUTING,
    WorkflowPhase.COMPLETE,
  ]),
  [WorkflowPhase.AWAITING_APPROVAL]: new Set([
    WorkflowPhase.BRANCHING,
    WorkflowPhase.EXPLORING,
    WorkflowPhase.PLANNING,
    WorkflowPhase.COMPLETE,
  ]),
  [WorkflowPhase.BRANCHING]: new Set([
    WorkflowPhase.EXECUTING,
    WorkflowPhase.COMPLETE,
  ]),
  [WorkflowPhase.EXECUTING]: new Set([
    WorkflowPhase.VERIFYING,
    WorkflowPhase.COMMITTING,
    WorkflowPhase.COMPLETE,
  ]),
  [WorkflowPhase.VERIFYING]: new Set([
    WorkflowPhase.FIXING,
    WorkflowPhase.COMMITTING,
    WorkflowPhase.COMPLETE,
  ]),
  [WorkflowPhase.FIXING]: new Set([
    WorkflowPhase.VERIFYING,
    WorkflowPhase.COMMITTING,
    WorkflowPhase.COMPLETE,
  ]),
  [WorkflowPhase.COMMITTING]: new Set([
    WorkflowPhase.COMPLETE,
  ]),
  [WorkflowPhase.COMPLETE]: new Set(),
};

export interface WorkflowState {
  phase: WorkflowPhase;
  sessionId: string;
  startedAt: Date;
  phaseStartedAt: Date;
  completedPhases: WorkflowPhase[];
  checkpoints: WorkflowPhase[];
}

export function createWorkflowState(sessionId: string): WorkflowState {
  const now = new Date();
  return {
    phase: WorkflowPhase.INITIALIZING,
    sessionId,
    startedAt: now,
    phaseStartedAt: now,
    completedPhases: [],
    checkpoints: [],
  };
}

export function isTerminal(phase: WorkflowPhase): boolean {
  return phase === WorkflowPhase.COMPLETE;
}

export class InvalidTransitionError extends Error {
  constructor(readonly from: WorkflowPhase, readonly to: WorkflowPhase) {
    super(`Invalid workflow transition ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function transition(state: WorkflowState, next: WorkflowPhase): WorkflowState {
  if (state.phase === next) return state;
  const allowed = ALLOWED_TRANSITIONS[state.phase];
  if (!allowed.has(next)) {
    throw new InvalidTransitionError(state.phase, next);
  }
  return {
    ...state,
    phase: next,
    phaseStartedAt: new Date(),
    completedPhases: [...state.completedPhases, state.phase],
  };
}

// ── Checkpointing ────────────────────────────────────────────────────────────

const SHADOW_BASE = '/tmp/anvil';

function checkpointPath(sessionId: string): string {
  return join(SHADOW_BASE, sessionId, 'workflow.json');
}

interface SerializedWorkflow {
  phase: WorkflowPhase;
  sessionId: string;
  startedAt: string;
  phaseStartedAt: string;
  completedPhases: WorkflowPhase[];
  checkpoints: WorkflowPhase[];
}

// Synchronous write so the next crash actually contains this checkpoint.
export function checkpoint(state: WorkflowState, phase: WorkflowPhase): WorkflowState {
  const next: WorkflowState = {
    ...state,
    checkpoints: state.checkpoints.includes(phase)
      ? state.checkpoints
      : [...state.checkpoints, phase],
  };
  try {
    const path = checkpointPath(state.sessionId);
    mkdirSync(dirname(path), { recursive: true });
    const serialised: SerializedWorkflow = {
      phase: next.phase,
      sessionId: next.sessionId,
      startedAt: next.startedAt.toISOString(),
      phaseStartedAt: next.phaseStartedAt.toISOString(),
      completedPhases: next.completedPhases,
      checkpoints: next.checkpoints,
    };
    writeFileSync(path, JSON.stringify(serialised, null, 2), 'utf-8');
  } catch {
    // Non-fatal: checkpoint is best-effort.
  }
  return next;
}

export function loadCheckpoint(sessionId: string): WorkflowState | null {
  try {
    const path = checkpointPath(sessionId);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as SerializedWorkflow;
    return {
      phase: parsed.phase,
      sessionId: parsed.sessionId,
      startedAt: new Date(parsed.startedAt),
      phaseStartedAt: new Date(parsed.phaseStartedAt),
      completedPhases: parsed.completedPhases,
      checkpoints: parsed.checkpoints ?? [],
    };
  } catch {
    return null;
  }
}

export function clearCheckpoint(sessionId: string): void {
  try {
    const path = checkpointPath(sessionId);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Non-fatal.
  }
}

// True when the checkpoint contains a strictly greater phase index than INITIALIZING.
export function hasProgressBeyondInit(state: WorkflowState): boolean {
  if (state.checkpoints.length === 0) return false;
  return state.checkpoints.some((p) => phaseIndex(p) > phaseIndex(WorkflowPhase.INITIALIZING));
}

export function phaseIndex(phase: WorkflowPhase): number {
  return WORKFLOW_ORDER.indexOf(phase) + 1; // 1-based for display
}

export function formatPhase(phase: WorkflowPhase): string {
  return `${phaseIndex(phase)}/${WORKFLOW_TOTAL} ${PHASE_LABELS[phase]}`;
}
