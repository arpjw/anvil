import { runOrchestrator, type OrchestratorOptions } from './agents/orchestrator.js';
import type { SessionResult } from './session/result.js';

export async function runAgent(request: string, workdir: string, sessionId: string, options: OrchestratorOptions = {}): Promise<SessionResult> {
  return runOrchestrator(request, workdir, sessionId, options);
}
