import { EventEmitter } from 'events';
import type { Plan } from '../agents/planner.js';

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
  | { type: 'rollback_complete'; filesRestored: string[] };

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

  // Ensures a done event fires exactly once (handles cases where the executor
  // exits without calling the done tool, e.g. max iterations).
  ensureDone(summary = 'Completed.'): void {
    if (!this._done) this.push({ type: 'done', summary });
  }
}

export const uiStream = new UIStream();
