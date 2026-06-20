import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { Plan } from '../agents/planner.js';

const LARGE_EDIT_TOKEN_THRESHOLD = 50_000;
const CHARS_PER_TOKEN = 4;
const ESTIMATED_CHARS_PER_NEW_FILE = 2_000;

export function estimateEditSize(plan: Plan, workdir: string): number {
  let totalChars = 0;

  for (const f of plan.filesToModify) {
    try {
      const abs = resolve(workdir, f);
      if (existsSync(abs)) {
        totalChars += readFileSync(abs, 'utf-8').length;
      }
    } catch { /* skip unreadable files */ }
  }

  totalChars += plan.filesToCreate.length * ESTIMATED_CHARS_PER_NEW_FILE;

  return Math.round(totalChars / CHARS_PER_TOKEN);
}

export interface GuardResult {
  tokenEstimate: number;
  fileCount: number;
  isLarge: boolean;
}

export function checkEditSize(plan: Plan, workdir: string): GuardResult {
  const tokenEstimate = estimateEditSize(plan, workdir);
  const fileCount = plan.filesToModify.length + plan.filesToCreate.length;
  const isLarge = tokenEstimate > LARGE_EDIT_TOKEN_THRESHOLD;
  return { tokenEstimate, fileCount, isLarge };
}
