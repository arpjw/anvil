import { EventEmitter } from 'events';
import type { Plan } from '../agents/planner.js';
import type { FileDiff } from '../diff/engine.js';

export type Phase = 'idle' | 'planning' | 'executing' | 'done' | 'error';

export type UIEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'tool_call'; name: string; args: string }
  | { type: 'tool_result'; name: string; preview: string }
  | { type: 'model_text'; text: string }
  | { type: 'shadow_attempt'; file: string; attempt: number; maxAttempts: number }
  | { type: 'shadow_result'; file: string; errorCount: number; outcome: 'committed' | 'retry' | 'escalated' }
  | { type: 'plan_ready'; plan: Plan }
  | { type: 'approval_needed' }
  | { type: 'file_modified'; path: string }
  | { type: 'done'; summary: string }
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
  | { type: 'verification_pass'; rounds: number }
  | { type: 'verification_fail'; failures: string[] }
  | { type: 'diff_ready'; filepath: string; diff: FileDiff; hunkCount: number }
  | { type: 'diff_resolved'; filepath: string; acceptedHunks: number; rejectedHunks: number }
  | { type: 'interrupt_requested' }
  | { type: 'interrupt_resolved'; action: 'continue' | 'stop' | 'rollback' }
  | { type: 'session_resumed'; sessionId: string; plan: Plan };

class UIStream extends EventEmitter {
  private _done = false;

  push(event: UIEvent): void {
    if (event.type === 'done') this._done = true;
    this.emit('event', event);
  }

  // Called by orchestrator — blocks until the user responds via the UI.
  waitForApproval(): Promise<{ answer: 'y' | 'n' | 'revise'; feedback?: string }> {
    this.push({ type: 'approval_needed' });
    return new Promise(resolve => {
      this.once('_approval', resolve);
    });
  }

  // Called by App.tsx when the user makes a decision.
  resolveApproval(answer: 'y' | 'n' | 'revise', feedback?: string): void {
    this.emit('_approval', { answer, feedback });
  }

  // Called by shadow/workspace.ts after LSP clean — blocks until user resolves hunks.
  waitForDiffResolution(filepath: string, diff: FileDiff): Promise<Set<number>> {
    this.push({ type: 'diff_ready', filepath, diff, hunkCount: diff.hunks.length });
    return new Promise(resolve => {
      this.once('_diff_resolved', resolve);
    });
  }

  // Called by DiffView (or headless handler) with the set of accepted hunk indices.
  resolveDiff(acceptedHunkIndices: Set<number>, filepath: string, totalHunks: number): void {
    const accepted = acceptedHunkIndices.size;
    const rejected = totalHunks - accepted;
    this.push({ type: 'diff_resolved', filepath, acceptedHunks: accepted, rejectedHunks: rejected });
    this.emit('_diff_resolved', acceptedHunkIndices);
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

  // Ensures a done event fires exactly once (handles cases where the executor
  // exits without calling the done tool, e.g. max iterations).
  ensureDone(summary = 'Completed.'): void {
    if (!this._done) this.push({ type: 'done', summary });
  }
}

export const uiStream = new UIStream();
