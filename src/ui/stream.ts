import { EventEmitter } from 'events';
import type { Plan } from '../agents/planner.js';
import type { FileDiff } from '../diff/engine.js';
import type { WorkflowPhase } from '../agents/workflow.js';
import type { SessionUsage } from '../billing/usage.js';

export type Phase = 'idle' | 'planning' | 'executing' | 'done' | 'error';

export type UIEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'tool_call'; name: string; args: string }
  | { type: 'tool_result'; name: string; preview: string }
  | { type: 'model_text'; text: string }
  | { type: 'shadow_attempt'; file: string; attempt: number; maxAttempts: number }
  | { type: 'shadow_result'; file: string; errorCount: number; outcome: 'committed' | 'rejected' | 'retry' | 'escalated' }
  | { type: 'plan_ready'; plan: Plan }
  | { type: 'approval_needed' }
  | { type: 'session_committed'; commitHash: string; paths: string[] }
  | { type: 'workspace_ready'; sourceWorkdir: string; workdir: string; branchName: string }
  | { type: 'transaction_applied'; transactionId: string; paths: string[] }
  | { type: 'command_approval_needed'; id: string; command: string; workdir: string }
  | { type: 'file_modified'; path: string }
  | { type: 'done'; summary: string }
  | { type: 'session_failed'; message: string }
  | { type: 'session_cancelled'; summary: string }
  | { type: 'error'; message: string }
  | { type: 'branch_created'; branchName: string }
  | { type: 'file_committed'; filepath: string; message: string; commitHash: string }
  | { type: 'pr_description_ready'; path: string }
  | { type: 'rollback_complete'; filesRestored: string[] }
  | {
      type: 'context_loaded';
      filesResolved: number;
      symbolsResolved: number;
      docsResolved: number;
      webResolved: number;
      rulesLoaded: boolean;
      memoryLoaded: boolean;
    }
  | { type: 'memory_written'; path: string }
  | { type: 'command_running'; command: string; workdir: string }
  | { type: 'command_complete'; command: string; exitCode: number; stdoutPreview: string }
  | { type: 'verification_start' }
  | { type: 'verification_skipped' }
  | { type: 'verification_pass'; rounds: number }
  | { type: 'verification_fail'; failures: string[] }
  | { type: 'diff_ready'; filepath: string; diff: FileDiff; hunkCount: number }
  | { type: 'diff_resolved'; filepath: string; acceptedHunks: number; rejectedHunks: number }
  | {
      type: 'file_diff';
      filepath: string;
      originalContent: string | null;
      newContent: string | null;
      diff: FileDiff;
      sessionId: string;
    }
  | { type: 'interrupt_requested' }
  | { type: 'interrupt_resolved'; action: 'continue' | 'stop' | 'rollback' }
  | { type: 'session_resumed'; sessionId: string; plan: Plan }
  | { type: 'conversation_loaded'; priorTurns: number; conversationId: string }
  | { type: 'usage_update'; usage: SessionUsage }
  | { type: 'budget_exceeded'; capUSD: number; usage: SessionUsage }
  | {
      type: 'command_output';
      command: string;
      line: string;
      stream: 'stdout' | 'stderr';
    }
  | {
      type: 'phase_transition';
      from: WorkflowPhase | null;
      to: WorkflowPhase;
      sessionId: string;
      index: number;
      total: number;
      label: string;
    };

class UIStream extends EventEmitter {
  private _done = false;

  push(event: UIEvent): void {
    if (event.type === 'done') this._done = true;
    this.emit('event', event);
  }

  private controller = new AbortController();
  get signal(): AbortSignal { return this.controller.signal; }
  throwIfCancelled(): void { this.signal.throwIfAborted(); }
  cancelSession(reason = 'Stopped by user.'): void { this.controller.abort(new Error(reason)); }

  private waitFor<T>(name: string, announce?: () => void): Promise<T> {
    this.throwIfCancelled();
    return new Promise((resolve, reject) => {
      const signal = this.signal;
      const cleanup = () => { this.off(name, accept); signal.removeEventListener('abort', abort); };
      const accept = (value: T) => { cleanup(); resolve(value); };
      const abort = () => { cleanup(); reject(signal.reason); };
      this.once(name, accept); signal.addEventListener('abort', abort, { once: true });
      announce?.();
    });
  }

  waitForApproval(): Promise<{ answer: 'y' | 'n' | 'revise'; feedback?: string }> {
    return this.waitFor('_approval', () => this.push({ type: 'approval_needed' }));
  }

  waitForCommandApproval(id: string, command: string, workdir: string): Promise<boolean> {
    return this.waitFor(`_command:${id}`, () => this.push({ type: 'command_approval_needed', id, command, workdir }));
  }
  resolveCommand(id: string, allow: boolean): void { this.emit(`_command:${id}`, allow); }

  // Called by App.tsx when the user makes a decision.
  resolveApproval(answer: 'y' | 'n' | 'revise', feedback?: string): void {
    this.emit('_approval', { answer, feedback });
  }

  // Called by shadow/workspace.ts after LSP clean — blocks until user resolves hunks.
  waitForDiffResolution(filepath: string, diff: FileDiff): Promise<Set<number>> {
    return this.waitFor(`_diff_resolved:${filepath}`, () => this.push({ type: 'diff_ready', filepath, diff, hunkCount: diff.hunks.length }));
  }

  // Called by DiffView (or headless handler) with the set of accepted hunk indices.
  resolveDiff(acceptedHunkIndices: Set<number>, filepath: string, totalHunks: number): void {
    const accepted = acceptedHunkIndices.size;
    const rejected = totalHunks - accepted;
    this.push({ type: 'diff_resolved', filepath, acceptedHunks: accepted, rejectedHunks: rejected });
    this.emit(`_diff_resolved:${filepath}`, acceptedHunkIndices);
  }

  // Called by interrupt.ts — blocks until user picks c/s/r.
  waitForInterruptResolution(): Promise<'continue' | 'stop' | 'rollback'> {
    return new Promise(resolve => {
      this.once('_interrupt_resolved', resolve);
    });
  }

  // Called by App.tsx when user responds to the interrupt prompt.
  resolveInterrupt(action: 'continue' | 'stop' | 'rollback'): void {
    this.push({ type: 'interrupt_resolved', action });
    this.emit('_interrupt_resolved', action);
  }

  // Emit successful completion at most once, after orchestrator verification.
  ensureDone(summary = 'Completed.'): void {
    if (!this._done) this.push({ type: 'done', summary });
  }

  resetSession(): void { this._done = false; this.controller = new AbortController(); }
}

export const uiStream = new UIStream();
