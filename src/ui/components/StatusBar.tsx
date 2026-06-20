import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { Phase } from '../stream.js';

const PHASE_COLORS: Record<Phase, string> = {
  idle: 'gray',
  planning: 'yellow',
  executing: 'cyan',
  done: 'green',
  error: 'red',
};

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export interface VerificationState {
  passed: boolean;
  rounds: number;
  failures: string[];
}

export function StatusBar({
  phase,
  startTime,
  verification,
  modelLabel = 'claude-sonnet-4-6',
}: {
  phase: Phase;
  startTime: number;
  verification?: VerificationState;
  modelLabel?: string;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  let verLabel: string | null = null;
  let verColor: string | null = null;
  if (verification) {
    if (verification.passed) {
      verLabel = verification.rounds === 0 ? '✓ verified' : `✓ verified (${verification.rounds}x fix)`;
      verColor = 'green';
    } else {
      verLabel = `✖ ${verification.failures.length} failure${verification.failures.length !== 1 ? 's' : ''}`;
      verColor = 'red';
    }
  }

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text dimColor>{modelLabel}</Text>
      <Text color={PHASE_COLORS[phase]} bold>{phase.toUpperCase()}</Text>
      {verLabel && verColor && (
        <Text color={verColor as never} bold>{verLabel}</Text>
      )}
      <Text dimColor>{elapsed(now - startTime)}</Text>
    </Box>
  );
}
