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

export function StatusBar({ phase, startTime }: { phase: Phase; startTime: number }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text dimColor>claude-sonnet-4-6</Text>
      <Text color={PHASE_COLORS[phase]} bold>{phase.toUpperCase()}</Text>
      <Text dimColor>{elapsed(now - startTime)}</Text>
    </Box>
  );
}
