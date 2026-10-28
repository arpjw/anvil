import OpenAI from 'openai';
import { simpleGit } from 'simple-git';
import { prepareWorkspace, changedWorkspaceFiles, commitWorkspace, type IsolatedWorkspace } from '../workspace/isolated.js';
import { lockWorkspace } from '../workspace/lock.js';
import { recoverTransaction } from '../workspace/transaction.js';
import { executionContext, withExecutionContext, type CommandPolicy } from '../execution/context.js';
import { shutdownLspClient } from '../lsp/client.js';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, relative, join } from 'path';
import { runPlanner, type Plan } from './planner.js';
import { runExecutor } from './executor.js';
import { uiStream, type UIEvent } from '../ui/stream.js';
import { getGitContext, createSessionBranch, commitFile, generatePRDescription } from '../git/client.js';
import { loadContext, buildContextSection, appendMemory } from '../context/index.js';
import { runVerification } from '../execution/verifier.js';
import { registerInterruptHandler, resetInterruptHandler } from '../execution/interrupt.js';
import type { ImageContentBlock } from '../context/image.js';
import { AVAILABLE_MODELS, buildClient, loadConfig } from '../setup/config.js';
import { appendTurn, loadConversation, summarizeHistory } from '../session/conversation.js';
import { clearSessionUsage, initSessionUsage, persistSessionUsage } from '../billing/usage.js';
import { persistSessionResult, type SessionResult } from '../session/result.js';
import { createWorkflowState, transition, phaseIndex, WORKFLOW_TOTAL, WorkflowPhase,
  PHASE_LABELS, checkpoint, clearCheckpoint, type WorkflowState } from './workflow.js';

function advance(state: WorkflowState, to: WorkflowPhase): WorkflowState {
  const next = checkpoint(transition(state, to), state.phase);
  uiStream.push({ type: 'phase_transition', from: state.phase, to, sessionId: state.sessionId,
    index: phaseIndex(to), total: WORKFLOW_TOTAL, label: PHASE_LABELS[to] });
  return next;
}

const MULTI_FILE_KEYWORDS = ['refactor', 'rename', 'move', 'across', 'throughout', 'everywhere',
  'all files', 'multiple files', 'each file', 'every file'];
function isComplex(request: string): boolean {
  return MULTI_FILE_KEYWORDS.some(kw => request.toLowerCase().includes(kw)) ||
    new Set(request.match(/\b[\w./][\w./]*\.(ts|js|py|json|md|css|html)\b/g) ?? []).size >= 2;
}

export interface OrchestratorOptions {
  noVerify?: boolean;
  headless?: boolean;
  image?: ImageContentBlock | null;
  systemPrompt?: string;
  client?: OpenAI;
  modelId?: string;
  modelLabel?: string;
  continueConversation?: boolean;
  budgetCapUSD?: number | null;
  noOpen?: boolean;
  autoBranch?: boolean;
  resumePlan?: Plan;
  isolation?: 'worktree' | 'none';
  commands?: CommandPolicy;
  signal?: AbortSignal;
}

let activeSession: string | null = null;

export async function runOrchestrator(
  request: string, workdir: string, sessionId: string, options: OrchestratorOptions = {},
): Promise<SessionResult> {
  return withExecutionContext({ root: resolve(workdir), commands: options.commands ?? (options.headless ? 'deny' : 'ask') },
    () => runSession(request, workdir, sessionId, options));
}

async function runSession(request: string, workdir: string, sessionId: string, options: OrchestratorOptions): Promise<SessionResult> {
  if (activeSession) throw new Error(`Session ${activeSession} is already active in this process.`);
  activeSession = sessionId;
  uiStream.resetSession();
  const cancel = () => uiStream.cancelSession('Session cancelled. Changes retained in the workspace.');
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  registerInterruptHandler();
  workdir = resolve(workdir);
  const sourceWorkdir = resolve(workdir);
  let isolated: IsolatedWorkspace | undefined;
  let unlock: (() => void) | undefined;
  let commitHash = '';
  const config = loadConfig();
  const modelId = options.modelId ?? config.model;
  const spec = AVAILABLE_MODELS.find(m => m.id === modelId);
  const budget = options.budgetCapUSD !== undefined ? options.budgetCapUSD : config.budgetCapUSD;
  const noVerify = options.noVerify ?? !config.autoVerify;
  const files = new Set<string>();
  let workflow = createWorkflowState(sessionId);
  let branchName = '';
  let summary = '';
  const startedAt = new Date().toISOString();
  let result: SessionResult | undefined;
  const capture = (event: UIEvent): void => {
    if (event.type === 'file_modified') files.add(event.path);
  };
  uiStream.on('event', capture);
  try {
    if (!spec && !options.client) throw new Error(`Unknown model: ${modelId}`);
    const apiKey = spec ? process.env[spec.envKey] ?? (spec.envKey === 'ANTHROPIC_API_KEY' ? config.apiKey : null) : null;
    if (!options.client && !apiKey) throw new Error(`${spec?.envKey ?? 'API key'} is not set for ${modelId}.`);
    const client = options.client ?? buildClient(modelId, spec!.baseURL, apiKey!);
    uiStream.push({ type: 'usage_update', usage: initSessionUsage(sessionId, modelId) });
    uiStream.throwIfCancelled();
    if (options.isolation !== 'none') {
      isolated = await prepareWorkspace(sourceWorkdir, sessionId);
      workdir = isolated.workdir;
      branchName = isolated.branchName;
      executionContext()!.root = workdir;
      uiStream.push({ type: 'workspace_ready', sourceWorkdir, workdir, branchName });
      uiStream.push({ type: 'branch_created', branchName });
    }
    unlock = lockWorkspace(workdir, 'session');
    recoverTransaction(workdir);
    const ctx = await loadContext(request, workdir);
    const contextSection = [options.systemPrompt, buildContextSection(ctx),
      options.continueConversation ? summarizeHistory(loadConversation(sourceWorkdir) ?? { id: '', workdir, turns: [], createdAt: new Date(), updatedAt: new Date() }) : '',
    ].filter(Boolean).join('\n\n');
    const cleanRequest = ctx.cleanRequest || request;
    uiStream.push({ type: 'context_loaded', filesResolved: ctx.files.length, symbolsResolved: ctx.symbols.length,
      docsResolved: ctx.docs.length, webResolved: ctx.web.length, rulesLoaded: ctx.rules !== null, memoryLoaded: ctx.memory !== null });

    let plan: Plan;
    if (options.resumePlan) {
      plan = options.resumePlan;
      workflow = advance(workflow, WorkflowPhase.PLANNING);
      uiStream.push({ type: 'session_resumed', sessionId, plan });
    } else if (isComplex(cleanRequest) || options.image) {
      const gitCtx = await getGitContext(workdir).catch(() => null);
      workflow = advance(workflow, WorkflowPhase.EXPLORING);
      let feedback: string | undefined;
      for (;;) {
        const path = await runPlanner(cleanRequest, workdir, sessionId, feedback, gitCtx, {
          contextSection, rules: ctx.rules, memory: ctx.memory, ignorePatterns: ctx.ignorePatterns, image: options.image,
        }, client, modelId, budget);
        plan = JSON.parse(readFileSync(path, 'utf-8')) as Plan;
        workflow = advance(workflow, WorkflowPhase.PLANNING);
        uiStream.push({ type: 'plan_ready', plan });
        workflow = advance(workflow, WorkflowPhase.AWAITING_APPROVAL);
        const approval = await uiStream.waitForApproval();
        if (approval.answer === 'y') break;
        if (approval.answer === 'n') {
          result = makeResult('aborted', 'Plan rejected by user.', 'skipped', []);
          uiStream.push({ type: 'session_cancelled', summary: result.summary });
          return result;
        }
        feedback = approval.feedback;
        workflow = advance(workflow, WorkflowPhase.EXPLORING);
      }
    } else {
      workflow = advance(workflow, WorkflowPhase.PLANNING);
      plan = { goal: cleanRequest, context: 'Single-file request, planner skipped.', filesToModify: [],
        filesToCreate: [], steps: [cleanRequest], verificationCriteria: [], risks: [] };
    }

    // Keep a workspace-bound plan for every path, including single-file tasks.
    const sessionDir = join('/tmp/anvil', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'plan.json'), JSON.stringify(plan, null, 2));
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ sessionId, workdir: sourceWorkdir, executionWorkdir: workdir, isolation: options.isolation ?? 'worktree', request, modelId }, null, 2));
    if (!isolated && (options.autoBranch ?? config.autoBranch) && await simpleGit(workdir).checkIsRepo()) {
      workflow = advance(workflow, WorkflowPhase.BRANCHING);
      // Fail before execution if an isolated branch cannot be prepared.
      branchName = await createSessionBranch(workdir, sessionId);
      uiStream.push({ type: 'branch_created', branchName });
    }
    workflow = advance(workflow, WorkflowPhase.EXECUTING);
    uiStream.push({ type: 'phase', phase: 'executing' });
    const extraContext = [contextSection, options.resumePlan
      ? 'This is a resumed session. Read current files and complete the original plan. Preserve changes already applied; do not repeat completed edits.' : '',
    ].filter(Boolean).join('\n\n');
    const report = await runExecutor(plan, workdir, sessionId, ctx.ignorePatterns, extraContext || undefined, client, modelId, budget);
    summary = report.summary;
    if (!report.success) throw new Error(report.escalations.join('\n') || 'Executor did not finish the task.');

    let verification: SessionResult['verification'] = 'skipped';
    if (noVerify) uiStream.push({ type: 'verification_skipped' });
    if (!noVerify) {
      workflow = advance(workflow, WorkflowPhase.VERIFYING);
      const verified = await runVerification(workdir, sessionId, plan, ctx.ignorePatterns, client, modelId, budget);
      verification = verified.skipped ? 'skipped' : verified.passed ? 'passed' : 'failed';
      if (!verified.passed) {
        result = makeResult('failed', 'Verification failed. Changes are available for review and recovery.', verification, verified.remainingFailures);
        uiStream.push({ type: 'session_failed', message: result.summary });
        return result;
      }
    }

    uiStream.throwIfCancelled();
    if (isolated) for (const path of await changedWorkspaceFiles(workdir)) files.add(join(workdir, path));
    // Commit after all fix rounds so the branch contains the exact verified files.
    workflow = advance(workflow, WorkflowPhase.COMMITTING);
    if (isolated && (options.autoBranch ?? config.autoBranch)) {
      commitHash = await commitWorkspace(workdir, sessionId);
      if (commitHash) uiStream.push({ type: 'session_committed', commitHash, paths: [...files] });
    } else if (!isolated && branchName) {
      for (const filepath of files) {
        const message = `feat: update ${relative(workdir, filepath)}`;
        const commitHash = await commitFile(workdir, filepath, message);
        if (commitHash) uiStream.push({ type: 'file_committed', filepath, message, commitHash });
      }
    }
    if (verification === 'passed' && summary) {
      appendMemory(workdir, sessionId, summary);
      uiStream.push({ type: 'memory_written', path: join(workdir, '.anvil', 'memory.md') });
      if (branchName) {
        const path = await generatePRDescription(sessionId, workdir);
        uiStream.push({ type: 'pr_description_ready', path });
      }
    }
    workflow = advance(workflow, WorkflowPhase.COMPLETE);
    clearCheckpoint(sessionId);
    result = makeResult('complete', summary || 'All steps completed.', verification, []);
    uiStream.ensureDone(result.summary);
    if (!options.headless && !options.noOpen && config.autoOpen && process.env.EDITOR && files.size) {
      const { execa } = await import('execa');
      const [command, ...args] = process.env.EDITOR.split(/\s+/);
      const child = execa(command!, [...args, ...files], { cwd: workdir, detached: true, stdio: 'ignore' });
      child.unref();
      void child.catch(() => {});
    }
    return result;
  } catch (err) {
    const message = (err as Error).message;
    if (uiStream.signal.aborted) {
      result = makeResult('aborted', message, 'skipped', []);
      uiStream.push({ type: 'session_cancelled', summary: result.summary });
      return result;
    }
    result = makeResult('failed', message, 'skipped', [message]);
    uiStream.push({ type: 'session_failed', message });
    throw err;
  } finally {
    uiStream.off('event', capture);
    await shutdownLspClient().catch(() => {});
    resetInterruptHandler();
    options.signal?.removeEventListener('abort', cancel);
    if (isolated && result) {
      try { for (const path of await changedWorkspaceFiles(workdir)) files.add(join(workdir, path)); } catch { /* retain captured changes if Git is unavailable */ }
      result.filesModified = [...files];
    }
    unlock?.();
    try {
      if (result) {
        persistSessionResult(sourceWorkdir, result);
        appendTurn(sourceWorkdir, { role: 'user', content: request, timestamp: new Date(), sessionId });
        appendTurn(sourceWorkdir, { role: 'assistant', content: result.summary, timestamp: new Date(), sessionId, filesModified: [...files] });
      }
      persistSessionUsage(sourceWorkdir, sessionId);
    } finally {
      clearSessionUsage(sessionId);
      activeSession = null;
    }
  }

  function makeResult(status: SessionResult['status'], text: string, verification: SessionResult['verification'], failures: string[]): SessionResult {
    return { sessionId, workdir, sourceWorkdir, isolation: isolated ? 'worktree' : 'none', baseCommit: isolated?.baseCommit, commitHash, request, modelId, status, summary: text, verification, failures,
      filesModified: [...files], branchName, startedAt, completedAt: new Date().toISOString() };
  }
}

export async function runDryRun(request: string, workdir: string, sessionId: string, options: OrchestratorOptions = {}): Promise<Plan> {
  if (activeSession) throw new Error(`Session ${activeSession} is already active in this process.`);
  activeSession = sessionId;
  uiStream.resetSession();
  const config = loadConfig();
  const modelId = options.modelId ?? config.model;
  const spec = AVAILABLE_MODELS.find(m => m.id === modelId);
  try {
    if (!spec && !options.client) throw new Error(`Unknown model: ${modelId}`);
    const key = spec ? process.env[spec.envKey] ?? (spec.envKey === 'ANTHROPIC_API_KEY' ? config.apiKey : null) : null;
    if (!options.client && !key) throw new Error(`${spec?.envKey ?? 'API key'} is not set for ${modelId}.`);
    const client = options.client ?? buildClient(modelId, spec!.baseURL, key!);
    initSessionUsage(sessionId, modelId);
    const ctx = await loadContext(request, workdir);
    const gitCtx = await getGitContext(workdir).catch(() => null);
    const path = await runPlanner(ctx.cleanRequest || request, workdir, sessionId, undefined, gitCtx, {
      contextSection: [options.systemPrompt, buildContextSection(ctx)].filter(Boolean).join('\n\n'),
      rules: ctx.rules, memory: ctx.memory, ignorePatterns: ctx.ignorePatterns, image: options.image,
    }, client, modelId, options.budgetCapUSD !== undefined ? options.budgetCapUSD : config.budgetCapUSD);
    return JSON.parse(readFileSync(path, 'utf-8')) as Plan;
  } finally {
    await shutdownLspClient().catch(() => {});
    clearSessionUsage(sessionId);
    activeSession = null;
  }
}
