import OpenAI from 'openai';
import { resolve } from 'path';
import { toolDefinitions, executeTool } from '../tools/index.js';
import { runStreamingLoop } from './loop.js';
import type { Plan } from './planner.js';
import { uiStream } from '../ui/stream.js';

export interface ExecutorReport {
  success: boolean;
  escalations: string[];
}

const EXECUTOR_SYSTEM = `You are the Executor subagent for Anvil. You implement an approved implementation plan step by step. Do not deviate from the plan.

Execution rules:
- Follow the steps in the plan in order
- Use read_file to read the current file content before writing it
- Use write_file to apply changes; the shadow workspace validates TypeScript before committing
- If write_file returns TypeScript errors, fix them and retry (you have up to 3 attempts per file)
- If write_file returns an ESCALATION message, note it and continue to the next step
- Only read files that are listed in the plan's filesToModify or filesToCreate
- Use run_command to execute shell commands (e.g. build steps, linting) when the plan requires it
- Use run_tests to verify the test suite passes after your changes
- When all steps are complete, call done`;

// Executor tools: read_file, write_file, run_command, run_tests, done
const executorTools = ['read_file', 'write_file', 'run_command', 'run_tests', 'done']
  .map(name => toolDefinitions.find(t => t.function.name === name)!)
  .filter(Boolean);

export async function runExecutor(
  plan: Plan,
  workdir: string,
  sessionId: string,
  ignorePatterns?: string[],
  extraContext?: string,
  client?: OpenAI,
  modelId?: string,
): Promise<ExecutorReport> {
  const effectiveClient = client ?? new OpenAI({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: 'https://api.anthropic.com/v1',
  });
  const effectiveModelId = modelId ?? 'claude-sonnet-4-6';

  // Build the set of allowed absolute paths from the plan.
  // Empty set means no restriction (used for simple pass-through plans).
  const allowedPaths = [...plan.filesToModify, ...plan.filesToCreate].map(f =>
    resolve(workdir, f),
  );
  const allowedSet = new Set(allowedPaths);
  const hasRestriction = allowedSet.size > 0;

  const planText = JSON.stringify(plan, null, 2);
  const baseContent = `Working directory: ${workdir}\n\nApproved plan:\n${planText}`;
  const userContent = extraContext ? `${baseContent}\n\n${extraContext}` : baseContent;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: EXECUTOR_SYSTEM },
    { role: 'user', content: userContent },
  ];

  const escalations: string[] = [];

  await runStreamingLoop(effectiveClient, effectiveModelId, messages, executorTools, async (name, args) => {
    if (name === 'read_file' && hasRestriction) {
      const abs = resolve(workdir, args.path as string);
      if (!allowedSet.has(abs)) {
        return {
          result: `Access denied: "${args.path as string}" is not in the approved plan's file list. ` +
            `Allowed files: ${[...allowedSet].join(', ')}`,
        };
      }
    }

    const result = await executeTool(name, args, workdir, sessionId, ignorePatterns);

    if (result.startsWith('ESCALATION:')) {
      escalations.push(result);
    }

    return { result };
  }, 20, { suppressDoneEvent: !!extraContext });

  return { success: escalations.length === 0, escalations };
}
