import OpenAI from 'openai';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { toolDefinitions, executeTool } from '../tools/index.js';
import { runStreamingLoop } from './loop.js';
import { uiStream } from '../ui/stream.js';
import type { GitContext } from '../git/client.js';

export interface Plan {
  goal: string;
  context: string;
  filesToModify: string[];
  filesToCreate: string[];
  steps: string[];
  verificationCriteria: string[];
  risks: string[];
}

export interface PlannerAnvilCtx {
  contextSection?: string;
  rules?: string | null;
  memory?: string | null;
  ignorePatterns?: string[];
}

const SHADOW_BASE = '/tmp/anvil';

const WRITE_PLAN_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'write_plan',
    description:
      'Finalize your exploration and write the structured implementation plan. ' +
      'Call this once you have gathered enough information to describe every change needed. ' +
      'This is your terminal action — the loop ends after you call it.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'One sentence summary of what will be accomplished' },
        context: {
          type: 'string',
          description: 'What you learned about the codebase that shapes this plan',
        },
        filesToModify: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths (relative to workdir) of existing files that will be edited',
        },
        filesToCreate: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths (relative to workdir) of new files that will be created',
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered implementation steps the executor must follow',
        },
        verificationCriteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'How to verify the implementation is correct once done',
        },
        risks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Potential risks, edge cases, or complications',
        },
      },
      required: [
        'goal', 'context', 'filesToModify', 'filesToCreate',
        'steps', 'verificationCriteria', 'risks',
      ],
    },
  },
};

const BASE_PLANNER_SYSTEM = `You are the Planner subagent for Anvil. Your sole job is to explore the codebase and produce a structured implementation plan. You do NOT write any code.

Exploration workflow:
1. Start with list_files to understand the project layout
2. Use ast_search to find relevant functions, classes, types, and imports — without reading whole files
3. Use find_symbol to trace where key symbols are defined and every place they are referenced
4. Use text_search for patterns, string literals, or config values that are not structural
5. Use read_file only for specific line ranges you have confirmed are relevant

When you have a complete picture of what needs to change and why, call write_plan with all 7 fields fully populated. Be specific: list every file that will be touched, every step the executor must take, and every risk.`;

// Planner gets all read-only tools plus the write_plan terminal tool.
const PLANNER_READONLY = new Set(['write_file']);
const plannerTools = [
  ...toolDefinitions.filter(t => !PLANNER_READONLY.has(t.function.name)),
  WRITE_PLAN_TOOL,
];

export async function runPlanner(
  goal: string,
  workdir: string,
  sessionId: string,
  feedback?: string,
  gitCtx?: GitContext | null,
  anvilCtx?: PlannerAnvilCtx,
): Promise<string> {
  const client = new OpenAI({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: 'https://api.anthropic.com/v1',
  });

  // Build dynamic system prompt: base + project rules if present
  let systemPrompt = BASE_PLANNER_SYSTEM;
  if (anvilCtx?.rules) {
    systemPrompt += `\n\nProject rules (must be followed):\n${anvilCtx.rules}`;
  }

  const gitSection = gitCtx
    ? `\n\nGit context:\n- Current branch: ${gitCtx.branch}\n- Recent commits:\n${gitCtx.recentCommits.map(c => `  ${c.hash} ${c.date} ${c.message}`).join('\n')}` +
      (gitCtx.unstagedDiff ? `\n- Unstaged changes (first 600 chars):\n${gitCtx.unstagedDiff.slice(0, 600)}` : '')
    : '';

  const contextParts: string[] = [`Working directory: ${workdir}\n\nGoal: ${goal}`];

  if (anvilCtx?.contextSection) {
    contextParts.push(`\n\n[Context pre-loaded by Anvil]\n${anvilCtx.contextSection}`);
  }

  if (anvilCtx?.memory) {
    contextParts.push(`\n\nMemory from previous sessions:\n${anvilCtx.memory}`);
  }

  if (gitSection) contextParts.push(gitSection);

  if (feedback) {
    contextParts.push(`\n\nRevision feedback from user: ${feedback}\n\nPlease revise your plan to address this feedback.`);
  }

  const userContent = contextParts.join('');

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const planDir = join(SHADOW_BASE, sessionId);
  const planPath = join(planDir, 'plan.json');
  let planWritten = false;

  uiStream.push({ type: 'phase', phase: 'planning' });

  const ignorePatterns = anvilCtx?.ignorePatterns;

  await runStreamingLoop(client, messages, plannerTools, async (name, args) => {
    if (name === 'write_plan') {
      mkdirSync(planDir, { recursive: true });
      writeFileSync(planPath, JSON.stringify(args, null, 2), 'utf-8');
      planWritten = true;
      return { result: `Plan written to ${planPath}`, done: true };
    }
    const result = await executeTool(name, args, workdir, sessionId, ignorePatterns);
    return { result };
  });

  if (!planWritten) {
    throw new Error('[Planner] write_plan was never called — no plan was produced');
  }

  return planPath;
}
