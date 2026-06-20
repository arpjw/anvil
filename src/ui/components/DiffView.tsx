import { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { basename } from 'path';
import type { FileDiff } from '../../diff/engine.js';

interface Props {
  filepath: string;
  diff: FileDiff;
  onDone: (acceptedIndices: Set<number>) => void;
}

type HunkState = 'pending' | 'accepted' | 'rejected';

const HUNK_ICON: Record<HunkState, string> = {
  pending: '?',
  accepted: '✓',
  rejected: '✗',
};

const HUNK_COLOR: Record<HunkState, string> = {
  pending: 'yellow',
  accepted: 'green',
  rejected: 'red',
};

export function DiffView({ filepath, diff, onDone }: Props) {
  const [currentHunk, setCurrentHunk] = useState(0);
  const [hunkStates, setHunkStates] = useState<Map<number, HunkState>>(() => {
    const m = new Map<number, HunkState>();
    diff.hunks.forEach((_, i) => m.set(i, 'pending'));
    return m;
  });

  const setHunkState = useCallback((idx: number, state: HunkState) => {
    setHunkStates(prev => {
      const next = new Map(prev);
      next.set(idx, state);
      return next;
    });
  }, []);

  const finish = useCallback((states: Map<number, HunkState>) => {
    const accepted = new Set<number>();
    states.forEach((s, i) => {
      if (s === 'accepted') accepted.add(i);
    });
    onDone(accepted);
  }, [onDone]);

  useInput((input, key) => {
    const hunks = diff.hunks;
    if (hunks.length === 0) { onDone(new Set()); return; }

    if (input === 'j') {
      setCurrentHunk(prev => Math.min(prev + 1, hunks.length - 1));
    } else if (input === 'k') {
      setCurrentHunk(prev => Math.max(prev - 1, 0));
    } else if (input === 'a') {
      setHunkState(currentHunk, 'accepted');
    } else if (input === 'r') {
      setHunkState(currentHunk, 'rejected');
    } else if (input === 'A') {
      setHunkStates(prev => {
        const next = new Map(prev);
        hunks.forEach((_, i) => next.set(i, 'accepted'));
        return next;
      });
    } else if (input === 'R') {
      setHunkStates(prev => {
        const next = new Map(prev);
        hunks.forEach((_, i) => next.set(i, 'rejected'));
        return next;
      });
    } else if (input === 'q' || key.return) {
      finish(hunkStates);
    }
  });

  const hunks = diff.hunks;
  if (hunks.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text dimColor>No changes to review in {basename(filepath)}</Text>
      </Box>
    );
  }

  const hunk = hunks[currentHunk];
  const state = hunkStates.get(currentHunk) ?? 'pending';

  return (
    <Box flexDirection="column">
      {/* File header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">{basename(filepath)}</Text>
        <Text dimColor>  {diff.hunks.length} hunk{diff.hunks.length !== 1 ? 's' : ''}</Text>
      </Box>

      {/* Hunk status bar */}
      <Box gap={1} marginBottom={1} flexWrap="wrap">
        {hunks.map((_, i) => {
          const s = hunkStates.get(i) ?? 'pending';
          const isCurrent = i === currentHunk;
          return (
            <Box key={i}>
              <Text
                color={HUNK_COLOR[s] as never}
                bold={isCurrent}
                underline={isCurrent}
              >
                [{i + 1}:{HUNK_ICON[s]}]
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Current hunk header */}
      <Box marginBottom={1}>
        <Text dimColor>{hunk.header}</Text>
        <Text dimColor>  (hunk {currentHunk + 1}/{hunks.length} — </Text>
        <Text color={HUNK_COLOR[state] as never}>{state}</Text>
        <Text dimColor>)</Text>
      </Box>

      {/* Diff lines */}
      <Box flexDirection="column" marginBottom={1}>
        {hunk.lines.map((line, i) => {
          const prefix = line[0];
          const content = line.slice(1);
          if (prefix === '+') {
            return (
              <Box key={i}>
                <Text color="green">+{content}</Text>
              </Box>
            );
          } else if (prefix === '-') {
            return (
              <Box key={i}>
                <Text color="red">-{content}</Text>
              </Box>
            );
          } else {
            return (
              <Box key={i}>
                <Text dimColor> {content}</Text>
              </Box>
            );
          }
        })}
      </Box>

      {/* Key hint bar */}
      <Box gap={2} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text><Text color="green" bold>[a]</Text><Text dimColor>ccept</Text></Text>
        <Text><Text color="red" bold>[r]</Text><Text dimColor>eject</Text></Text>
        <Text><Text color="yellow" bold>[A]</Text><Text dimColor>ll</Text></Text>
        <Text><Text color="yellow" bold>[R]</Text><Text dimColor>eject all</Text></Text>
        <Text><Text dimColor>[j/k]</Text><Text dimColor> nav</Text></Text>
        <Text><Text bold>[q]</Text><Text dimColor>done</Text></Text>
      </Box>
    </Box>
  );
}
