import { runOrchestrator } from './agents/orchestrator.js';

export async function runAgent(request: string, workdir: string, sessionId: string): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }
  await runOrchestrator(request, workdir, sessionId);
}
