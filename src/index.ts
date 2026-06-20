#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { runAgent } from './agent.js';
import { App } from './ui/App.js';
import { uiStream } from './ui/stream.js';

// ── Argument parsing ───────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const isHeadless = argv.includes('--headless');
const isDryRun   = argv.includes('--dry-run');
const noVerify   = argv.includes('--no-verify');
const isRollback = argv[0] === '--rollback';
const isResume   = argv[0] === '--resume';

// Extract --image <filepath>
let imagePath: string | null = null;
const imageIdx = argv.indexOf('--image');
if (imageIdx !== -1 && argv[imageIdx + 1] && !argv[imageIdx + 1].startsWith('--')) {
  imagePath = argv[imageIdx + 1];
}

// Strip flags (and image path) to leave clean positional args
const positional = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  if (i > 0 && argv[i - 1] === '--image') return false;
  return true;
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {

  // ── Rollback mode ────────────────────────────────────────────────────────────
  if (isRollback) {
    const sessionId = positional[0];
    if (!sessionId) {
      console.error('Usage: anvil --rollback <sessionId> [workdir]');
      process.exit(1);
    }
    const workdir = resolve(positional[1] ?? process.cwd());
    const { rollbackSession } = await import('./git/client.js');
    try {
      const filesRestored = await rollbackSession(workdir, sessionId);
      console.log(`✓ Rolled back session ${sessionId.slice(0, 8)}`);
      console.log(`  Restored ${filesRestored.length} file(s)${filesRestored.length ? ':' : '.'}`);
      for (const f of filesRestored) console.log(`  - ${f}`);
    } catch (err) {
      console.error(`✗ Rollback failed: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // ── Resume mode ──────────────────────────────────────────────────────────────
  if (isResume) {
    const sessionId = positional[0];
    if (!sessionId) {
      console.error('Usage: anvil --resume <sessionId> [workdir]');
      process.exit(1);
    }
    const workdir = resolve(positional[1] ?? process.cwd());

    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('Error: ANTHROPIC_API_KEY environment variable is not set');
      process.exit(1);
    }

    const { unmount } = render(
      React.createElement(App, {
        request: `Resuming session ${sessionId.slice(0, 8)}`,
        workdir,
        sessionId,
      }),
    );

    const { resumeSession } = await import('./execution/resume.js');
    try {
      await resumeSession(sessionId, workdir);
      uiStream.ensureDone('Session resumed and completed.');
      await new Promise(r => setTimeout(r, 500));
      unmount();
    } catch (err) {
      uiStream.push({ type: 'error', message: (err as Error).message });
      await new Promise(r => setTimeout(r, 500));
      unmount();
      process.exit(1);
    }
    return;
  }

  // ── Help ─────────────────────────────────────────────────────────────────────
  const request = positional[0];

  if (!request || request === '--help' || request === '-h') {
    console.error('Usage: anvil "<request>" [workdir] [flags]');
    console.error('       workdir defaults to the current directory');
    console.error('\nExample: anvil "add error handling to main.ts"');
    console.error('\nFlags:');
    console.error('  --rollback <sessionId>   Revert all changes from a session');
    console.error('  --resume <sessionId>     Resume a previously interrupted session');
    console.error('  --image <filepath>       Attach an image as context (PNG/JPG/WebP/GIF)');
    console.error('  --headless               No TUI — output JSON result to stdout');
    console.error('  --dry-run                Plan only — print plan, do not execute');
    console.error('  --no-verify              Skip post-execution verification pass');
    console.error('\nEnv: ANTHROPIC_API_KEY must be set');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is not set');
    process.exit(1);
  }

  const workdirArg = positional[1];
  const workdir    = resolve(workdirArg ?? process.cwd());
  const sessionId  = randomUUID();

  // Load image if provided
  let imageBlock = null;
  if (imagePath) {
    const { loadImage } = await import('./context/image.js');
    try {
      imageBlock = loadImage(resolve(imagePath));
    } catch (err) {
      console.error(`Error loading image: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // ── Headless mode ─────────────────────────────────────────────────────────────
  if (isHeadless) {
    const { runHeadless } = await import('./execution/headless.js');
    try {
      const result = await runHeadless(request, workdir, noVerify);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(result.success && result.verificationPassed ? 0 : 1);
    } catch (err) {
      const msg = (err as Error).message;
      process.stdout.write(JSON.stringify({ success: false, error: msg }, null, 2) + '\n');
      process.exit(1);
    }
    return;
  }

  // ── Dry-run mode ──────────────────────────────────────────────────────────────
  if (isDryRun) {
    const { runDryRun } = await import('./agents/orchestrator.js');
    const { checkEditSize } = await import('./execution/guard.js');
    try {
      const plan = await runDryRun(request, workdir, sessionId);
      console.log('=== DRY RUN — NO FILES TOUCHED ===\n');
      console.log(`Goal: ${plan.goal}`);
      if (plan.context) console.log(`\nContext:\n  ${plan.context}`);
      if (plan.filesToModify.length > 0) {
        console.log('\nFiles to modify:');
        plan.filesToModify.forEach(f => console.log(`  - ${f}`));
      }
      if (plan.filesToCreate.length > 0) {
        console.log('\nFiles to create:');
        plan.filesToCreate.forEach(f => console.log(`  - ${f}`));
      }
      const guard = checkEditSize(plan, workdir);
      console.log(`\nEstimated size: ~${guard.tokenEstimate} tokens across ${guard.fileCount} files`);
      if (guard.isLarge) console.log('  ⚠ Large edit (>50k tokens)');
      console.log('\nSteps:');
      plan.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
      if (plan.verificationCriteria.length > 0) {
        console.log('\nVerification criteria:');
        plan.verificationCriteria.forEach(c => console.log(`  - ${c}`));
      }
      if (plan.risks.length > 0) {
        console.log('\nRisks:');
        plan.risks.forEach(r => console.log(`  - ${r}`));
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // ── Normal TUI mode ───────────────────────────────────────────────────────────
  const { unmount } = render(
    React.createElement(App, { request, workdir, sessionId }),
  );

  try {
    await runAgent(request, workdir, sessionId, { noVerify, image: imageBlock });
    uiStream.ensureDone();
    await new Promise(r => setTimeout(r, 500));
    unmount();
    process.exit(0);
  } catch (err: unknown) {
    uiStream.push({ type: 'error', message: (err as Error).message });
    await new Promise(r => setTimeout(r, 500));
    unmount();
    process.exit(1);
  }
}

main().catch(err => {
  console.error((err as Error).message);
  process.exit(1);
});
