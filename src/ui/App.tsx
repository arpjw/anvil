import { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import chalk from 'chalk';
import figlet from 'figlet';
import { basename } from 'path';
import { uiStream, type UIEvent, type Phase } from './stream.js';
import { ToolCall } from './components/ToolCall.js';
import { ShadowCycle } from './components/ShadowCycle.js';
import { PlanDisplay } from './components/PlanDisplay.js';
import { StatusBar, type VerificationState } from './components/StatusBar.js';
import { DiffView } from './components/DiffView.js';
import type { Plan } from '../agents/planner.js';
import type { FileDiff } from '../diff/engine.js';

const HEADER = figlet.textSync('ANVIL', { font: 'Small' }) as string;

// ── Display items ─────────────────────────────────────────────────────────────

let _uid = 0;
const uid = () => ++_uid;

type ToolItem    = { kind: 'tool';    id: number; name: string; args: string; result?: string };
type ShadowItem  = { kind: 'shadow';  id: number; file: string; attempt: number; maxAttempts: number; outcome?: 'committed' | 'retry' | 'escalated'; errorCount?: number };
type TextItem    = { kind: 'text';    id: number; text: string; color?: string };
type PhaseItem   = { kind: 'phase';   id: number; label: string };
type CommandItem = { kind: 'command'; id: number; command: string; exitCode?: number };
type DisplayItem = ToolItem | ShadowItem | TextItem | PhaseItem | CommandItem;

// ── Approval state ────────────────────────────────────────────────────────────

interface ApprovalState {
  feedbackMode: boolean;
  text: string;
}

// ── Diff state ────────────────────────────────────────────────────────────────

interface DiffState {
  filepath: string;
  diff: FileDiff;
  hunkCount: number;
}

// ── Left panel ────────────────────────────────────────────────────────────────

const PHASE_LABELS: Record<Phase, string> = {
  idle: '○ idle', planning: '◈ planning', executing: '▷ executing', done: '✓ done', error: '✗ error',
};
const PHASE_COLORS: Record<Phase, string> = {
  idle: 'gray', planning: 'yellow', executing: 'cyan', done: 'green', error: 'red',
};

interface ContextSources {
  filesResolved: number;
  symbolsResolved: number;
  docsResolved: number;
  webResolved: number;
  rulesLoaded: boolean;
  memoryLoaded: boolean;
}

function LeftPanel({
  phase, filesModified, request, plan, gitBranch, commitCount, prPath,
  contextSources, memoryWritten,
}: {
  phase: Phase; filesModified: string[]; request: string; plan: Plan | null;
  gitBranch: string | null; commitCount: number; prPath: string | null;
  contextSources: ContextSources | null; memoryWritten: boolean;
}) {
  const truncReq = request.length > 65 ? request.slice(0, 65) + '…' : request;

  const ctxParts: string[] = [];
  if (contextSources) {
    if (contextSources.filesResolved > 0) ctxParts.push(`@file x${contextSources.filesResolved}`);
    if (contextSources.symbolsResolved > 0) ctxParts.push(`@sym x${contextSources.symbolsResolved}`);
    if (contextSources.docsResolved > 0) ctxParts.push(`@docs x${contextSources.docsResolved}`);
    if (contextSources.webResolved > 0) ctxParts.push(`@web x${contextSources.webResolved}`);
    if (contextSources.rulesLoaded) ctxParts.push('rules ✓');
    if (contextSources.memoryLoaded) ctxParts.push('memory ✓');
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text dimColor>phase</Text>
        <Text color={PHASE_COLORS[phase]} bold>{PHASE_LABELS[phase]}</Text>
      </Box>

      {contextSources && (
        <Box flexDirection="column">
          <Text dimColor>context</Text>
          <Text dimColor>{ctxParts.length > 0 ? ctxParts.join('  ') : 'none'}</Text>
        </Box>
      )}

      {gitBranch && (
        <Box flexDirection="column">
          <Text dimColor>branch</Text>
          <Text color="cyan">{gitBranch}</Text>
          {commitCount > 0 && (
            <Text dimColor>commits this session: {commitCount}</Text>
          )}
        </Box>
      )}

      <Box flexDirection="column">
        <Text dimColor>request</Text>
        <Text wrap="wrap">{truncReq}</Text>
      </Box>

      {plan && (
        <Box flexDirection="column">
          <Text dimColor>plan goal</Text>
          <Text dimColor wrap="wrap">{plan.goal.slice(0, 80)}</Text>
        </Box>
      )}

      {filesModified.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>modified</Text>
          {filesModified.map((f, i) => (
            <Text key={i} color="green">+ {basename(f)}</Text>
          ))}
        </Box>
      )}

      {prPath && (
        <Box flexDirection="column">
          <Text dimColor>PR description</Text>
          <Text color="magenta">{basename(prPath)}</Text>
        </Box>
      )}

      {memoryWritten && (
        <Box flexDirection="column">
          <Text color="cyan">✎ memory written</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Item renderer ─────────────────────────────────────────────────────────────

function renderItem(item: DisplayItem): JSX.Element {
  switch (item.kind) {
    case 'tool':
      return (
        <ToolCall
          name={item.name}
          args={item.args}
          pending={!item.result}
          result={item.result}
        />
      );
    case 'shadow':
      return (
        <ShadowCycle
          file={item.file}
          attempt={item.attempt}
          maxAttempts={item.maxAttempts}
          outcome={item.outcome}
          errorCount={item.errorCount}
        />
      );
    case 'phase':
      return (
        <Box marginY={1}>
          <Text dimColor>── {item.label} ──</Text>
        </Box>
      );
    case 'text':
      return (
        <Box>
          <Text color={item.color as never}>{item.text}</Text>
        </Box>
      );
    case 'command': {
      const icon = item.exitCode === undefined ? '▶' :
        item.exitCode === 0 ? '✓' : '✖';
      const iconColor = item.exitCode === undefined ? 'yellow' :
        item.exitCode === 0 ? 'green' : 'red';
      const label = item.command.length > 52 ? item.command.slice(0, 52) + '…' : item.command;
      return (
        <Box gap={1}>
          <Text color={iconColor as never}>{icon}</Text>
          <Text dimColor>{label}</Text>
          {item.exitCode !== undefined && (
            <Text dimColor>exit {item.exitCode}</Text>
          )}
        </Box>
      );
    }
  }
}

// ── Root component ────────────────────────────────────────────────────────────

export interface AppProps {
  request: string;
  workdir: string;
  sessionId: string;
  modelLabel?: string;
}

export function App({ request, workdir, sessionId, modelLabel }: AppProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [filesModified, setFilesModified] = useState<string[]>([]);
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const [interruptActive, setInterruptActive] = useState(false);
  const [startTime] = useState(() => Date.now());
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [commitCount, setCommitCount] = useState(0);
  const [prPath, setPrPath] = useState<string | null>(null);
  const [contextSources, setContextSources] = useState<ContextSources | null>(null);
  const [memoryWritten, setMemoryWritten] = useState(false);
  const [verification, setVerification] = useState<VerificationState | undefined>(undefined);

  const handleDiffDone = useCallback((acceptedIndices: Set<number>) => {
    if (!diffState) return;
    const total = diffState.hunkCount;
    const accepted = acceptedIndices.size;
    const rejected = total - accepted;
    uiStream.resolveDiff(acceptedIndices, diffState.filepath, total);
    setDiffState(null);

    if (accepted === 0) {
      setItems(prev => [...prev, {
        kind: 'text', id: uid(),
        text: `${basename(diffState.filepath)}: skipped by user`,
        color: 'yellow',
      }]);
    } else {
      setItems(prev => [...prev, {
        kind: 'text', id: uid(),
        text: `${basename(diffState.filepath)}: ${accepted} hunk${accepted !== 1 ? 's' : ''} accepted, ${rejected} rejected`,
        color: 'green',
      }]);
    }
  }, [diffState]);

  const handleEvent = useCallback((event: UIEvent) => {
    switch (event.type) {
      case 'phase':
        setPhase(event.phase);
        setItems(prev => [...prev, { kind: 'phase', id: uid(), label: event.phase }]);
        break;

      case 'tool_call':
        setItems(prev => [...prev, { kind: 'tool', id: uid(), name: event.name, args: event.args }]);
        break;

      case 'tool_result':
        setItems(prev => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const it = next[i];
            if (it.kind === 'tool' && !it.result) {
              next[i] = { ...it, result: event.preview };
              break;
            }
          }
          return next;
        });
        break;

      case 'shadow_attempt':
        setItems(prev => [...prev, {
          kind: 'shadow', id: uid(),
          file: event.file, attempt: event.attempt, maxAttempts: event.maxAttempts,
        }]);
        break;

      case 'shadow_result':
        setItems(prev => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const it = next[i];
            if (it.kind === 'shadow' && it.file === event.file && !it.outcome) {
              next[i] = { ...it, outcome: event.outcome, errorCount: event.errorCount };
              break;
            }
          }
          return next;
        });
        break;

      case 'command_running':
        setItems(prev => [...prev, { kind: 'command', id: uid(), command: event.command }]);
        break;

      case 'command_complete':
        setItems(prev => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const it = next[i];
            if (it.kind === 'command' && it.command === event.command && it.exitCode === undefined) {
              next[i] = { ...it, exitCode: event.exitCode };
              break;
            }
          }
          return next;
        });
        break;

      case 'verification_start':
        setItems(prev => [...prev, {
          kind: 'text', id: uid(),
          text: '⟳ verification: type check + tests…',
          color: 'yellow',
        }]);
        break;

      case 'verification_pass': {
        const label = event.rounds === 0
          ? '✓ verified'
          : `✓ verified after ${event.rounds} auto-fix round${event.rounds > 1 ? 's' : ''}`;
        setVerification({ passed: true, rounds: event.rounds, failures: [] });
        setItems(prev => [...prev, { kind: 'text', id: uid(), text: label, color: 'green' }]);
        break;
      }

      case 'verification_fail':
        setVerification({ passed: false, rounds: 2, failures: event.failures });
        setItems(prev => [
          ...prev,
          { kind: 'text', id: uid(), text: `✖ verification failed — ${event.failures.length} issue(s)`, color: 'red' },
          ...event.failures.slice(0, 5).map(f => ({
            kind: 'text' as const, id: uid(), text: `  ${f.slice(0, 80)}`, color: 'red',
          })),
        ]);
        break;

      case 'plan_ready':
        setPlan(event.plan);
        break;

      case 'approval_needed':
        setApproval({ feedbackMode: false, text: '' });
        break;

      case 'file_modified':
        setFilesModified(prev => prev.includes(event.path) ? prev : [...prev, event.path]);
        break;

      case 'done':
        setPhase('done');
        setItems(prev => [...prev, { kind: 'text', id: uid(), text: `✓ ${event.summary}`, color: 'green' }]);
        break;

      case 'error':
        setPhase('error');
        setItems(prev => [...prev, { kind: 'text', id: uid(), text: `✗ ${event.message}`, color: 'red' }]);
        break;

      case 'model_text':
        break;

      case 'branch_created':
        setGitBranch(event.branchName);
        setItems(prev => [...prev, { kind: 'text', id: uid(), text: `⎇ ${event.branchName}`, color: 'cyan' }]);
        break;

      case 'file_committed':
        setCommitCount(prev => prev + 1);
        setItems(prev => [...prev, {
          kind: 'text', id: uid(),
          text: `✔ committed ${basename(event.filepath)} [${event.commitHash.slice(0, 7)}]`,
          color: 'green',
        }]);
        break;

      case 'pr_description_ready':
        setPrPath(event.path);
        setItems(prev => [...prev, { kind: 'text', id: uid(), text: `📄 PR → ${event.path}`, color: 'magenta' }]);
        break;

      case 'rollback_complete':
        setItems(prev => [...prev, {
          kind: 'text', id: uid(),
          text: `↩ rollback complete — ${event.filesRestored.length} file(s) restored`,
          color: 'yellow',
        }]);
        break;

      case 'context_loaded':
        setContextSources({
          filesResolved: event.filesResolved,
          symbolsResolved: event.symbolsResolved,
          docsResolved: event.docsResolved,
          webResolved: event.webResolved,
          rulesLoaded: event.rulesLoaded,
          memoryLoaded: event.memoryLoaded,
        });
        break;

      case 'memory_written':
        setMemoryWritten(true);
        setItems(prev => [...prev, {
          kind: 'text', id: uid(),
          text: `✎ memory written → ${basename(event.path)}`,
          color: 'cyan',
        }]);
        break;

      case 'diff_ready':
        setDiffState({ filepath: event.filepath, diff: event.diff, hunkCount: event.hunkCount });
        break;

      case 'interrupt_requested':
        setInterruptActive(true);
        break;

      case 'interrupt_resolved':
        setInterruptActive(false);
        setItems(prev => [...prev, {
          kind: 'text', id: uid(),
          text: `↯ interrupt: ${event.action}`,
          color: event.action === 'continue' ? 'green' : event.action === 'stop' ? 'yellow' : 'red',
        }]);
        break;

      case 'session_resumed':
        setItems(prev => [...prev, {
          kind: 'text', id: uid(),
          text: `↺ resumed session ${event.sessionId.slice(0, 8)}`,
          color: 'cyan',
        }]);
        break;

      case 'diff_resolved':
        break; // handled inline in handleDiffDone
    }
  }, []);

  useEffect(() => {
    uiStream.on('event', handleEvent);
    return () => { uiStream.off('event', handleEvent); };
  }, [handleEvent]);

  const { isRawModeSupported } = useStdin();

  useInput((input, key) => {
    // DiffView handles its own input when active
    if (diffState) return;

    // Interrupt prompt
    if (interruptActive) {
      if (input === 'c') { uiStream.resolveInterrupt('continue'); setInterruptActive(false); }
      else if (input === 's') { uiStream.resolveInterrupt('stop'); setInterruptActive(false); }
      else if (input === 'r') { uiStream.resolveInterrupt('rollback'); setInterruptActive(false); }
      return;
    }

    if (!approval) return;

    if (approval.feedbackMode) {
      if (key.return) {
        if (approval.text.trim()) {
          uiStream.resolveApproval('revise', approval.text.trim());
          setApproval(null);
        }
      } else if (key.backspace || key.delete) {
        setApproval(prev => prev ? { ...prev, text: prev.text.slice(0, -1) } : null);
      } else if (input && !key.ctrl && !key.meta) {
        setApproval(prev => prev ? { ...prev, text: prev.text + input } : null);
      }
    } else {
      const lower = input.toLowerCase();
      if (lower === 'y') { uiStream.resolveApproval('y'); setApproval(null); }
      else if (lower === 'n') { uiStream.resolveApproval('n'); setApproval(null); }
      else if (lower === 'r') { setApproval({ feedbackMode: true, text: '' }); }
    }
  }, { isActive: isRawModeSupported ?? false });

  const recentItems = items.slice(-18);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Text color="yellow">{HEADER}</Text>
        <Text dimColor>session {sessionId.slice(0, 8)} · {basename(workdir)}</Text>
      </Box>

      {/* Two-panel layout */}
      <Box flexDirection="row" gap={1}>
        {/* Left panel — session info */}
        <Box
          width="28%"
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          <LeftPanel
            phase={phase}
            filesModified={filesModified}
            request={request}
            plan={plan}
            gitBranch={gitBranch}
            commitCount={commitCount}
            prPath={prPath}
            contextSources={contextSources}
            memoryWritten={memoryWritten}
          />
        </Box>

        {/* Right panel — live activity log or diff view */}
        <Box
          flexGrow={1}
          flexDirection="column"
          borderStyle="single"
          borderColor={diffState ? 'cyan' : 'gray'}
          paddingX={1}
        >
          {diffState
            ? <DiffView
                filepath={diffState.filepath}
                diff={diffState.diff}
                onDone={handleDiffDone}
              />
            : recentItems.length === 0
              ? <Text dimColor>Waiting to start…</Text>
              : recentItems.map(item => <Box key={item.id}>{renderItem(item)}</Box>)
          }
        </Box>
      </Box>

      {/* Plan + approval gate */}
      {plan && approval && !diffState && (
        <Box flexDirection="column" paddingX={1}>
          <PlanDisplay plan={plan} />
          <Box paddingX={1} paddingY={1}>
            {approval.feedbackMode ? (
              <Box gap={1}>
                <Text color="yellow">Feedback ›</Text>
                <Text>{approval.text}</Text>
                <Text color="yellow">█</Text>
              </Box>
            ) : (
              <Box gap={2}>
                <Text>{chalk.hex('#E8A020')('Approve plan?')}</Text>
                <Text><Text color="green" bold>[y]</Text> yes</Text>
                <Text><Text color="red" bold>[n]</Text> no</Text>
                <Text><Text color="yellow">[r]</Text> revise</Text>
              </Box>
            )}
          </Box>
        </Box>
      )}

      {/* Interrupt prompt */}
      {interruptActive && !diffState && (
        <Box paddingX={1} paddingY={1} gap={2}>
          <Text color="yellow">↯ Interrupt received.</Text>
          <Text><Text color="green" bold>[c]</Text> continue</Text>
          <Text><Text color="yellow" bold>[s]</Text> stop</Text>
          <Text><Text color="red" bold>[r]</Text> rollback</Text>
        </Box>
      )}

      <StatusBar phase={phase} startTime={startTime} verification={verification} modelLabel={modelLabel} />
    </Box>
  );
}
