import { Box, Text } from 'ink';
import type { Plan } from '../../agents/planner.js';

function Section({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="white" bold>{label}</Text>
      {items.map((item, i) => (
        <Box key={i} paddingLeft={1}>
          <Text dimColor>• </Text>
          <Text wrap="wrap">{item}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function PlanDisplay({ plan }: { plan: Plan }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginTop={1}
    >
      <Box marginBottom={1}>
        <Text color="yellow" bold>PLAN</Text>
      </Box>
      <Box marginBottom={1}>
        <Text bold wrap="wrap">{plan.goal}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor wrap="wrap">{plan.context}</Text>
      </Box>
      <Section label="Files to modify" items={plan.filesToModify} />
      <Section label="Files to create" items={plan.filesToCreate} />
      <Section label="Steps" items={plan.steps.map((s, i) => `${i + 1}. ${s}`)} />
      <Section label="Verification" items={plan.verificationCriteria.map(v => `✓ ${v}`)} />
      <Section label="Risks" items={plan.risks.map(r => `⚠ ${r}`)} />
    </Box>
  );
}
