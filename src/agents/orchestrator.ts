import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { resolve, relative, join } from 'path';
import { runPlanner, type Plan } from './planner.js';
import { runExecutor } from './executor.js';
import { uiStream, type UIEvent } from '../ui/stream.js';
import {
  getGitContext,
  createSessionBranch,
  commitFile,
  generatePRDescription,
} from '../git/client.js';
import { loadContext, buildContextSection, appendMemory } from '../context/index.js';
import { runVerification } from '../execution/verifier.js';
import { checkEditSize } from '../execution/guard.js';
import { registerInterruptHandler } from '../execution/interrupt.js';
import type { ImageContentBlock } from '../context/image.js';
import { AVAILABLE_MODELS, loadConfig } from '../setup/config.js';
import {
  appendTurn,
  loadConversation,
  summarizeHistory,
  turnCount,
} from '../session/conversation.js';
import {
  BudgetExceededError,
  clearSessionUsage,
  initSessionUsage,
  persistSessionUsage,
} from '../billing/usage.js';
import {
  createWorkflowState,
  transition,
  formatPhase,
  phaseIndex,
  WORKFLOW_TOTAL,
  WorkflowPhase,
  PHASE_LABELS,
  checkpoint as checkpointWorkflow,
  loadCheckpoint,
  clearCheckpoint,
  hasProgressBeyondInit,
  type WorkflowState,
} from './workflow.js';

function advance(state: WorkflowState, to: WorkflowPhase): WorkflowState {
  const from = state.phase;
  const next = transition(state, to);
  const withCheckpoint = checkpointWorkflow(next, from);
  uiStream.push({
    type: 'phase_transition',
    from,
    to,
    sessionId: state.sessionId,
    index: phaseIndex(to),
    total: WORKFLOW_TOTAL,
    label: PHASE_LABELS[to],
  });
  return withCheckpoint;
}

// ── Complexity heuristic ──────────────────────────────────────────────────────

const MULTI_FILE_KEYWORDS = [
  'refactor', 'rename', 'move', 'across', 'throughout', 'everywhere',
  'all files', 'multiple files', 'each file', 'every file',
];

function isComplex(request: string): boolean {
  const lower = request.toLowerCase();
  if (MULTI_FILE_KEYWORDS.some(kw => lower.includes(kw))) return true;
  const fileMentions = request.match(/\b[\w./][\w./]*\.(ts|js|py|json|md|css|html)\b/g) ?? [];
  return new Set(fileMentions).size >= 2;
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
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function runOrchestrator(
  request: string,
  workdir: string,
  sessionId: string,
  options: OrchestratorOptions = {},
): Promise<void> {
  const {
    noVerify = false,
    headless = false,
    image = null,
    systemPrompt,
    client,
    modelId,
    continueConversation = false,
    budgetCapUSD: budgetCapFromOpts,
    noOpen = false,
  } = options;

  const effectiveBudgetCap =
    budgetCapFromOpts !== undefined ? budgetCapFromOpts : loadConfig().budgetCapUSD;

  // Resolve effective client and model — fall back to config if not provided by caller.
  const effectiveModelId = modelId ?? loadConfig().model;
  const effectiveSpec = AVAILABLE_MODELS.find(m => m.id === effectiveModelId) ?? AVAILABLE_MODELS[0];
  const effectiveApiKey = process.env[effectiveSpec.envKey] ?? process.env.ANTHROPIC_API_KEY ?? '';
  const effectiveBaseURL = effectiveSpec.baseURL ?? 'https://api.anthropic.com/v1';
  const effectiveClient = client ?? new OpenAI({ apiKey: effectiveApiKey, baseURL: effectiveBaseURL });

  // Initialise per-session usage tracking. The loop reads and updates this
  // through addUsage(); the TUI subscribes to usage_update events.
  const initialUsage = initSessionUsage(sessionId, effectiveModelId);
  uiStream.push({ type: 'usage_update', usage: initialUsage });

  // 10-phase workflow (light: emits phase_transition events, does not enforce control flow).
  let workflow = createWorkflowState(sessionId);
  const priorCheckpoint = loadCheckpoint(sessionId);
  if (priorCheckpoint && hasProgressBeyondInit(priorCheckpoint)) {
    workflow = priorCheckpoint;
    const summary = `Resuming session ${sessionId.slice(0, 8)} from ${formatPhase(priorCheckpoint.phase)} (checkpoints: ${priorCheckpoint.checkpoints
      .map((p) => PHASE_LABELS[p])
      .join(', ')})`;
    uiStream.push({ type: 'session_resumed', sessionId, plan: {
      goal: summary,
      context: '',
      filesToModify: [],
      filesToCreate: [],
      steps: [],
      verificationCriteria: [],
      risks: [],
    } });
  }
  uiStream.push({
    type: 'phase_transition',
    from: null,
    to: workflow.phase,
    sessionId,
    index: phaseIndex(workflow.phase),
    total: WORKFLOW_TOTAL,
    label: PHASE_LABELS[workflow.phase],
  });

  // ── Step 1: Load all context before anything else ────────────────────────────
  const ctx = await loadContext(request, workdir);

  uiStream.push({
    type: 'context_loaded',
    filesResolved: ctx.files.length,
    symbolsResolved: ctx.symbols.length,
    docsResolved: ctx.docs.length,
    webResolved: ctx.web.length,
    rulesLoaded: ctx.rules !== null,
    memoryLoaded: ctx.memory !== null,
  });

  // Load prior conversation if --continue was requested.
  let conversationSection = '';
  if (continueConversation) {
    const history = loadConversation(workdir);
    if (history && history.turns.length > 0) {
      conversationSection = summarizeHistory(history);
      uiStream.push({
        type: 'conversation_loaded',
        priorTurns: history.turns.length,
        conversationId: history.id,
      });
    }
  }

  const baseContext = buildContextSection(ctx);
  const contextSection = [
    systemPrompt ? `## Slash Command Instructions\n\n${systemPrompt}` : '',
    conversationSection ? `## ${conversationSection}` : '',
    baseContext || '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const { ignorePatterns } = ctx;

  // Use cleanRequest (mentions stripped) for everything downstream
  const cleanRequest = ctx.cleanRequest || request;

  // ── Step 2: Fetch git context ────────────────────────────────────────────────
  const gitCtx = await getGitContext(workdir).catch(() => null);

  // ── Helper: capture done summary for memory ──────────────────────────────────
  let doneSummary = '';
  const captureDone = (ev: UIEvent): void => {
    if (ev.type === 'done') doneSummary = ev.summary;
  };

  // ── Helper: track modified files for conversation turn + editor auto-open ───
  const filesModifiedSet = new Set<string>();
  const captureFilesModified = (ev: UIEvent): void => {
    if (ev.type === 'file_modified') filesModifiedSet.add(ev.path);
  };
  uiStream.on('event', captureFilesModified);

  // ── Open changed files in $EDITOR (Feature 5). detached + stdio:'ignore'
  //    means the parent exits without waiting; ideal for GUI editors like
  //    cursor/code/subl. Terminal editors (vim/nvim) won't render properly —
  //    users can disable with --no-open or `anvilai config set autoOpen false`.
  const maybeOpenEditor = async (): Promise<void> => {
    if (noOpen || headless) return;
    if (!loadConfig().autoOpen) return;
    const editor = process.env.EDITOR;
    const files = Array.from(filesModifiedSet);
    if (files.length === 0) return;
    if (!editor) {
      uiStream.push({
        type: 'error',
        message: 'Tip: set EDITOR=cursor (or code, subl) to auto-open changed files.',
      });
      return;
    }
    try {
      const { execa } = await import('execa');
      const parts = editor.split(/\s+/).filter(Boolean);
      const [cmd, ...editorArgs] = parts;
      if (!cmd) return;
      execa(cmd, [...editorArgs, ...files], {
        cwd: workdir,
        detached: true,
        stdio: 'ignore',
      }).catch(() => { /* editor may exit non-zero; not our problem */ });
      uiStream.push({
        type: 'error',
        message: `Opening ${files.length} file${files.length === 1 ? '' : 's'} in ${cmd}`,
      });
    } catch {
      /* execa spawn failure — non-fatal */
    }
  };

  // ── Persist the two conversation turns (user request + assistant summary) ──
  const persistConversationTurns = (): void => {
    try {
      appendTurn(workdir, {
        role: 'user',
        content: request,
        timestamp: new Date(),
        sessionId,
      });
      if (doneSummary) {
        appendTurn(workdir, {
          role: 'assistant',
          content: doneSummary,
          timestamp: new Date(),
          sessionId,
          filesModified: Array.from(filesModifiedSet),
        });
      }
    } catch { /* non-fatal */ }
  };

  // ── Simple path ──────────────────────────────────────────────────────────────
  if (!isComplex(cleanRequest)) {
    workflow = advance(workflow, WorkflowPhase.PLANNING);
    const plan: Plan = {
      goal: cleanRequest,
      context: 'Single-file request, planner skipped.',
      filesToModify: [],
      filesToCreate: [],
      steps: [cleanRequest],
      verificationCriteria: [],
      risks: [],
    };

    uiStream.on('event', captureDone);
    workflow = advance(workflow, WorkflowPhase.EXECUTING);
    uiStream.push({ type: 'phase', phase: 'executing' });
    const report = await runExecutor(plan, workdir, sessionId, ignorePatterns, undefined, effectiveClient, effectiveModelId, effectiveBudgetCap);
    uiStream.off('event', captureDone);

    reportEscalations(report.escalations);

    if (!noVerify) {
      workflow = advance(workflow, WorkflowPhase.VERIFYING);
      const verResult = await runVerification(workdir, sessionId, plan, ignorePatterns, effectiveClient, effectiveModelId);
      if (verResult.passed) {
        await maybeAppendMemory(workdir, sessionId, doneSummary, ctx);
      } else {
        reportVerificationFailure(verResult.rounds, verResult.remainingFailures);
      }
    } else {
      await maybeAppendMemory(workdir, sessionId, doneSummary, ctx);
    }

    workflow = advance(workflow, WorkflowPhase.COMPLETE);
    clearCheckpoint(sessionId);
    persistConversationTurns();
    await maybeOpenEditor();
    uiStream.off('event', captureFilesModified);
    persistSessionUsage(workdir, sessionId);
    clearSessionUsage(sessionId);
    uiStream.ensureDone('All steps completed successfully.');
    return;
  }

  // ── Complex path: planner → approval gate → branch → executor ────────────────
  let feedback: string | undefined;
  let plan: Plan;

  workflow = advance(workflow, WorkflowPhase.EXPLORING);

  for (;;) {
    const [planPath] = await Promise.all([
      runPlanner(cleanRequest, workdir, sessionId, feedback, gitCtx, {
        contextSection: contextSection || undefined,
        rules: ctx.rules,
        memory: ctx.memory,
        ignorePatterns,
        image,
      }, effectiveClient, effectiveModelId, effectiveBudgetCap),
    ]);

    workflow = advance(workflow, WorkflowPhase.PLANNING);
    plan = JSON.parse(readFileSync(planPath, 'utf-8')) as Plan;
    uiStream.push({ type: 'plan_ready', plan });

    workflow = advance(workflow, WorkflowPhase.AWAITING_APPROVAL);
    const response = await uiStream.waitForApproval();

    if (response.answer === 'y') break;

    if (response.answer === 'n') {
      workflow = advance(workflow, WorkflowPhase.COMPLETE);
      clearCheckpoint(sessionId);
      doneSummary = doneSummary || 'Plan rejected by user.';
      persistConversationTurns();
      uiStream.off('event', captureFilesModified);
      persistSessionUsage(workdir, sessionId);
      clearSessionUsage(sessionId);
      uiStream.push({ type: 'done', summary: 'Plan rejected by user.' });
      return;
    }

    feedback = response.feedback;
    workflow = advance(workflow, WorkflowPhase.EXPLORING);
    uiStream.push({ type: 'phase', phase: 'planning' });
  }

  // Guard: warn if the edit is very large.
  const guard = checkEditSize(plan!, workdir);
  if (guard.isLarge) {
    if (headless) {
      console.warn(`[anvil] Large edit detected: ~${guard.tokenEstimate} tokens across ${guard.fileCount} files. Proceeding automatically.`);
    } else {
      // In TUI mode, surface the warning in the activity log — user already approved the plan.
      uiStream.push({
        type: 'error',
        message: `Large edit: ~${guard.tokenEstimate} tokens across ${guard.fileCount} files. Proceeding as approved.`,
      });
    }
  }

  // Register interrupt handler for TUI sessions.
  if (!headless) {
    registerInterruptHandler(sessionId, workdir);
  }

  // Create session branch before the executor touches any files.
  workflow = advance(workflow, WorkflowPhase.BRANCHING);
  let branchName: string | null = null;
  try {
    branchName = await createSessionBranch(workdir, sessionId);
    uiStream.push({ type: 'branch_created', branchName });
  } catch (err) {
    uiStream.push({ type: 'error', message: `Branch creation failed: ${(err as Error).message}` });
  }

  // Per-file git commit listener, serialized via a promise chain.
  let commitQueue = Promise.resolve();
  const planRef = plan!;

  const handleFileModified = (event: UIEvent): void => {
    if (event.type !== 'file_modified') return;
    const filepath = event.path;

    commitQueue = commitQueue.then(async () => {
      try {
        const rel = relative(workdir, filepath);
        const isNew = planRef.filesToCreate.some(f => resolve(workdir, f) === filepath);
        const message = `feat: ${isNew ? 'add' : 'update'} ${rel}`;
        const hash = await commitFile(workdir, filepath, message);
        uiStream.push({ type: 'file_committed', filepath, message, commitHash: hash });
      } catch (err) {
        uiStream.push({ type: 'error', message: `git commit failed: ${(err as Error).message}` });
      }
    });
  };

  uiStream.on('event', handleFileModified);
  uiStream.on('event', captureDone);

  workflow = advance(workflow, WorkflowPhase.EXECUTING);
  uiStream.push({ type: 'phase', phase: 'executing' });
  const report = await runExecutor(planRef, workdir, sessionId, ignorePatterns, undefined, effectiveClient, effectiveModelId, effectiveBudgetCap);

  // Drain the commit queue before post-session steps.
  await commitQueue;
  uiStream.off('event', handleFileModified);
  uiStream.off('event', captureDone);

  reportEscalations(report.escalations);

  // ── Verification ─────────────────────────────────────────────────────────────
  let verificationPassed = true;
  if (!noVerify) {
    workflow = advance(workflow, WorkflowPhase.VERIFYING);
    const verResult = await runVerification(workdir, sessionId, planRef, ignorePatterns, effectiveClient, effectiveModelId);
    verificationPassed = verResult.passed;
    if (!verResult.passed) {
      // verifier ran its own executor fix rounds; flag FIXING happened
      workflow = advance(workflow, WorkflowPhase.FIXING);
      reportVerificationFailure(verResult.rounds, verResult.remainingFailures);
    }
  }

  if (verificationPassed) {
    workflow = advance(workflow, WorkflowPhase.COMMITTING);
    await maybeAppendMemory(workdir, sessionId, doneSummary, ctx);
    if (report.success && branchName) {
      try {
        const prPath = await generatePRDescription(sessionId, workdir);
        uiStream.push({ type: 'pr_description_ready', path: prPath });
      } catch { /* non-fatal */ }
    }
  }
  // If verification failed, skip memory and PR — session is incomplete.

  workflow = advance(workflow, WorkflowPhase.COMPLETE);
  clearCheckpoint(sessionId);
  persistConversationTurns();
  await maybeOpenEditor();
  uiStream.off('event', captureFilesModified);
  clearSessionUsage(sessionId);
  uiStream.ensureDone('All steps completed.');
}

// ── Dry-run mode ──────────────────────────────────────────────────────────────

export async function runDryRun(
  request: string,
  workdir: string,
  sessionId: string,
): Promise<Plan> {
  const ctx = await loadContext(request, workdir);
  const cleanRequest = ctx.cleanRequest || request;
  const { ignorePatterns } = ctx;

  if (!isComplex(cleanRequest)) {
    return {
      goal: cleanRequest,
      context: 'Single-file request — planner skipped (simple path).',
      filesToModify: [],
      filesToCreate: [],
      steps: [cleanRequest],
      verificationCriteria: [],
      risks: [],
    };
  }

  const gitCtx = await getGitContext(workdir).catch(() => null);

  const planPath = await runPlanner(cleanRequest, workdir, sessionId, undefined, gitCtx, {
    contextSection: buildContextSection(ctx) || undefined,
    rules: ctx.rules,
    memory: ctx.memory,
    ignorePatterns,
  });

  return JSON.parse(readFileSync(planPath, 'utf-8')) as Plan;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function maybeAppendMemory(
  workdir: string,
  sessionId: string,
  summary: string,
  ctx: { rules: string | null; memory: string | null },
): Promise<void> {
  if (!summary) return;
  try {
    appendMemory(workdir, sessionId, summary);
    uiStream.push({
      type: 'memory_written',
      path: join(workdir, '.anvil', 'memory.md'),
    });
  } catch { /* non-fatal */ }
}

function reportEscalations(escalations: string[]): void {
  for (const e of escalations) {
    uiStream.push({ type: 'error', message: e });
  }
}

function reportVerificationFailure(rounds: number, remainingFailures: string[]): void {
  const roundLabel = rounds === 1 ? '1 fix round' : `${rounds} fix rounds`;
  const issueCount = remainingFailures.length;
  const issueLabel = issueCount === 1 ? '1 issue' : `${issueCount} issues`;
  uiStream.push({
    type: 'error',
    message: `Verification failed after ${roundLabel}: ${issueLabel} remain. Session not saved to memory.`,
  });
}
