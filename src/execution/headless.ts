import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { runOrchestrator } from '../agents/orchestrator.js';
import { uiStream, type UIEvent } from '../ui/stream.js';

export interface HeadlessResult {
  sessionId: string;
  success: boolean;
  filesModified: string[];
  commitHashes: string[];
  branchName: string;
  prDescriptionPath: string;
  verificationPassed: boolean;
  remainingFailures: string[];
}

export async function runHeadless(
  request: string,
  workdir: string,
  noVerify = false,
): Promise<HeadlessResult> {
  const sessionId = randomUUID();
  const absWorkdir = resolve(workdir);

  const filesModified: string[] = [];
  const commitHashes: string[] = [];
  let branchName = '';
  let prDescriptionPath = '';
  // If noVerify, treat verification as passed by default
  let verificationPassed = noVerify;
  let remainingFailures: string[] = [];
  let success = false;

  const handleEvent = (event: UIEvent): void => {
    switch (event.type) {
      case 'phase':
        console.log(`[anvil] phase: ${event.phase}`);
        break;

      case 'tool_call':
        console.log(`[anvil] ${event.name}: ${event.args.slice(0, 80)}`);
        break;

      case 'command_running':
        console.log(`[anvil] ▶ ${event.command}`);
        break;

      case 'command_complete':
        console.log(`[anvil] exit ${event.exitCode}: ${event.command.slice(0, 60)}`);
        break;

      case 'verification_start':
        console.log('[anvil] verification: running type check + tests…');
        break;

      case 'verification_pass':
        verificationPassed = true;
        remainingFailures = [];
        console.log(`[anvil] verification: passed${event.rounds > 0 ? ` after ${event.rounds} fix round(s)` : ''}`);
        break;

      case 'verification_fail':
        verificationPassed = false;
        remainingFailures = event.failures;
        console.error('[anvil] verification: FAILED');
        for (const f of event.failures) console.error(`  ${f}`);
        break;

      case 'file_modified':
        if (!filesModified.includes(event.path)) filesModified.push(event.path);
        break;

      case 'file_committed':
        commitHashes.push(event.commitHash);
        break;

      case 'branch_created':
        branchName = event.branchName;
        console.log(`[anvil] branch: ${event.branchName}`);
        break;

      case 'pr_description_ready':
        prDescriptionPath = event.path;
        break;

      case 'done':
        success = true;
        console.log(`[anvil] done: ${event.summary}`);
        break;

      case 'error':
        console.error(`[anvil] error: ${event.message}`);
        break;

      case 'approval_needed':
        // Auto-approve plan in headless mode
        setTimeout(() => uiStream.resolveApproval('y'), 0);
        break;

      case 'diff_ready':
        // Auto-accept all hunks in headless mode (no human present)
        setTimeout(() => {
          const allIndices = new Set(Array.from({ length: event.hunkCount }, (_, i) => i));
          uiStream.resolveDiff(allIndices, event.filepath, event.hunkCount);
        }, 0);
        break;
    }
  };

  uiStream.on('event', handleEvent);

  try {
    await runOrchestrator(request, absWorkdir, sessionId, { noVerify });
  } finally {
    uiStream.off('event', handleEvent);
  }

  return {
    sessionId,
    success,
    filesModified,
    commitHashes,
    branchName,
    prDescriptionPath,
    verificationPassed,
    remainingFailures,
  };
}
