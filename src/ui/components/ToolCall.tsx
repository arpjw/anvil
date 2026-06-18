import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';

const AMBER = '#E8A020';
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text color="yellow">{FRAMES[frame]}</Text>;
}

interface Props {
  name: string;
  args: string;
  pending: boolean;
  result?: string;
}

export function ToolCall({ name, args, pending, result }: Props) {
  const truncArgs = args.length > 55 ? args.slice(0, 55) + '…' : args;
  const resultLine = result ? result.split('\n')[0].slice(0, 80) : undefined;

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {pending ? <Spinner /> : <Text color="yellow">▸</Text>}
        <Text>{chalk.hex(AMBER)(name)}</Text>
        <Text dimColor>{truncArgs}</Text>
      </Box>
      {resultLine && (
        <Box paddingLeft={3}>
          <Text dimColor>→ {resultLine}</Text>
        </Box>
      )}
    </Box>
  );
}
