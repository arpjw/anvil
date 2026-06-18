import { Box, Text } from 'ink';
import { basename } from 'path';

interface Props {
  file: string;
  attempt: number;
  maxAttempts: number;
  outcome?: 'committed' | 'retry' | 'escalated';
  errorCount?: number;
}

export function ShadowCycle({ file, attempt, maxAttempts, outcome, errorCount }: Props) {
  const name = basename(file);

  return (
    <Box gap={1}>
      <Text dimColor>shadow[{attempt}/{maxAttempts}]</Text>
      <Text color="cyan">{name}</Text>
      {!outcome && <Text dimColor>validating…</Text>}
      {outcome === 'committed' && <Text color="green">✓ committed</Text>}
      {outcome === 'retry' && (
        <Box gap={1}>
          <Text color="red">✖ {errorCount} error{errorCount !== 1 ? 's' : ''}</Text>
          <Text dimColor>→ retrying</Text>
        </Box>
      )}
      {outcome === 'escalated' && (
        <Text color="red">✖ escalated after {maxAttempts} attempt{maxAttempts !== 1 ? 's' : ''}</Text>
      )}
    </Box>
  );
}
