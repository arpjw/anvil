import { runOrchestrator, type OrchestratorOptions } from './agents/orchestrator.js';
import {
  BudgetExceededError,
  clearSessionUsage,
  persistSessionUsage,
} from './billing/usage.js';
import { uiStream } from './ui/stream.js';

export async function runAgent(
  request: string,
  workdir: string,
  sessionId: string,
  options: OrchestratorOptions = {},
): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }
  try {
    await runOrchestrator(request, workdir, sessionId, options);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      // Clean exit — the budget_exceeded event was already emitted from the loop.
      // Persist the final usage so `anvilai history` shows the aborted cost.
      persistSessionUsage(workdir, sessionId);
      clearSessionUsage(sessionId);
      uiStream.ensureDone(err.message);
      return;
    }
    throw err;
  }
}
