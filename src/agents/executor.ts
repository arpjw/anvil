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
- When all steps are complete, stop`;

// Executor gets read_file, write_file, and done.
const readFileDef = toolDefinitions.find(t => t.function.name === 'read_file')!;
const writeFileDef = toolDefinitions.find(t => t.function.name === 'write_file')!;
const doneDef = toolDefinitions.find(t => t.function.name === 'done')!;
const executorTools = [readFileDef, writeFileDef, doneDef];

export async function runExecutor(
  plan: Plan,
  workdir: string,
  sessionId: string,
): Promise<ExecutorReport> {
  const client = new OpenAI({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: 'https://api.anthropic.com/v1',
  });

  // Build the set of allowed absolute paths from the plan.
  // Empty set means no restriction (used for simple pass-through plans).
  const allowedPaths = [...plan.filesToModify, ...plan.filesToCreate].map(f =>
    resolve(workdir, f),
  );
  const allowedSet = new Set(allowedPaths);
  const hasRestriction = allowedSet.size > 0;

  const planText = JSON.stringify(plan, null, 2);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: EXECUTOR_SYSTEM },
    { role: 'user', content: `Working directory: ${workdir}\n\nApproved plan:\n${planText}` },
  ];

  const escalations: string[] = [];

  await runStreamingLoop(client, messages, executorTools, async (name, args) => {
    if (name === 'read_file' && hasRestriction) {
      const abs = resolve(workdir, args.path as string);
      if (!allowedSet.has(abs)) {
        return {
          result: `Access denied: "${args.path as string}" is not in the approved plan's file list. ` +
            `Allowed files: ${[...allowedSet].join(', ')}`,
        };
      }
    }

    const result = await executeTool(name, args, workdir, sessionId);

    if (result.startsWith('ESCALATION:')) {
      escalations.push(result);
    }

    return { result };
  });

  return { success: escalations.length === 0, escalations };
}
