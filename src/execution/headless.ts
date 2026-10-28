import type OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { runOrchestrator, type OrchestratorOptions } from '../agents/orchestrator.js';
import { resumeSession } from './resume.js';
import { uiStream, type UIEvent } from '../ui/stream.js';
import type { SessionResult } from '../session/result.js';

export interface HeadlessResult {
  sessionId: string;
  success: boolean;
  filesModified: string[];
  commitHashes: string[];
  branchName: string;
  prDescriptionPath: string;
  verificationPassed: boolean;
  verificationSkipped: boolean;
  remainingFailures: string[];
  status: 'complete' | 'failed' | 'aborted';
  summary: string;
  workdir?: string;
  sourceWorkdir?: string;
  isolation?: 'worktree' | 'none';
  commitHash?: string;
}

export interface HeadlessOptions extends OrchestratorOptions {
  streamJson?: boolean;
  resumeId?: string;
}

export async function runHeadless(request: string, workdir: string, noVerify?: boolean,
  client?: OpenAI, modelId?: string, options: HeadlessOptions = {},
): Promise<HeadlessResult> {
  const sessionId = options.resumeId ?? randomUUID();
  const result: HeadlessResult = { sessionId, success: false, filesModified: [], commitHashes: [],
    branchName: '', prDescriptionPath: '', verificationPassed: false, verificationSkipped: false,
    remainingFailures: [], status: 'failed', summary: '' };
  const handleEvent = (event: UIEvent): void => {
    if (options.streamJson) process.stdout.write(JSON.stringify({ type: 'event', sessionId, event }) + '\n');
    else if (event.type === 'phase_transition') console.error(`[anvil] ${event.index}/${event.total} ${event.label}`);
    else if (event.type === 'error' || event.type === 'session_failed') console.error(`[anvil] ${event.message}`);
    switch (event.type) {
      case 'workspace_ready': result.workdir = event.workdir; result.sourceWorkdir = event.sourceWorkdir; result.isolation = 'worktree'; break;
      case 'session_committed': result.commitHashes.push(event.commitHash); result.commitHash = event.commitHash; break;
      case 'file_modified': if (!result.filesModified.includes(event.path)) result.filesModified.push(event.path); break;
      case 'file_committed': result.commitHashes.push(event.commitHash); break;
      case 'branch_created': result.branchName = event.branchName; break;
      case 'pr_description_ready': result.prDescriptionPath = event.path; break;
      case 'approval_needed': uiStream.resolveApproval('y'); break;
      case 'diff_ready': uiStream.resolveDiff(new Set(event.diff.hunks.map((_, i) => i)), event.filepath, event.hunkCount); break;
    }
  };
  uiStream.on('event', handleEvent);
  try {
    const opts = { ...options, headless: true, noOpen: true, noVerify, client, modelId };
    const session: SessionResult = options.resumeId
      ? await resumeSession(options.resumeId, resolve(workdir), opts)
      : await runOrchestrator(request, resolve(workdir), sessionId, opts);
    result.workdir = session.workdir; result.sourceWorkdir = session.sourceWorkdir; result.isolation = session.isolation; result.commitHash = session.commitHash;
    result.filesModified = session.filesModified;
    result.status = session.status;
    result.success = session.status === 'complete';
    result.summary = session.summary;
    result.verificationPassed = session.verification === 'passed';
    result.verificationSkipped = session.verification === 'skipped';
    result.remainingFailures = session.failures;
  } catch (err) {
    result.summary = (err as Error).message;
    result.remainingFailures.push(result.summary);
  } finally {
    uiStream.off('event', handleEvent);
  }
  return result;
}
