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
const isHeadless    = argv.includes('--headless');
const isDryRun      = argv.includes('--dry-run');
const noVerify      = argv.includes('--no-verify');
const isRollback    = argv[0] === '--rollback';
const isResume      = argv[0] === '--resume';
const showCommands  = argv.includes('--commands');
const showVersion   = argv.includes('--version') || argv[0] === '-V';
const continueConv  = argv.includes('--continue');
const noOpen        = argv.includes('--no-open');

// Extract --budget <dollars>
let budgetCapUSD: number | null = null;
const budgetIdx = argv.indexOf('--budget');
if (budgetIdx !== -1 && argv[budgetIdx + 1] && !argv[budgetIdx + 1].startsWith('--')) {
  const parsed = Number(argv[budgetIdx + 1]);
  if (Number.isFinite(parsed) && parsed > 0) budgetCapUSD = parsed;
}

// Extract --image <filepath>
let imagePath: string | null = null;
const imageIdx = argv.indexOf('--image');
if (imageIdx !== -1 && argv[imageIdx + 1] && !argv[imageIdx + 1].startsWith('--')) {
  imagePath = argv[imageIdx + 1];
}

// Extract --model <id>
let modelFlag: string | null = null;
const modelIdx = argv.indexOf('--model');
if (modelIdx !== -1 && argv[modelIdx + 1] && !argv[modelIdx + 1].startsWith('--')) {
  modelFlag = argv[modelIdx + 1];
}

// Strip flags (and their values) to leave clean positional args
const positional = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  if (i > 0 && argv[i - 1] === '--image') return false;
  if (i > 0 && argv[i - 1] === '--model') return false;
  if (i > 0 && argv[i - 1] === '--budget') return false;
  return true;
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {

  // ── --version ────────────────────────────────────────────────────────────────
  if (showVersion) {
    const { getPackageVersion } = await import('./setup/version.js');
    console.log(getPackageVersion());
    return;
  }

  // ── anvil init ───────────────────────────────────────────────────────────────
  if (positional[0] === 'init') {
    const workdir = resolve(positional[1] ?? process.cwd());
    const yes = argv.includes('--yes') || argv.includes('-y');
    const { initProject } = await import('./setup/init.js');
    await initProject(workdir, yes);
    return;
  }

  // ── anvil doctor ─────────────────────────────────────────────────────────────
  if (positional[0] === 'doctor') {
    const workdir = resolve(positional[1] ?? process.cwd());
    const { runDoctor } = await import('./setup/doctor.js');
    const exitCode = await runDoctor(workdir);
    process.exit(exitCode);
  }

  // ── anvilai history [workdir]  |  anvilai history <sessionId> [workdir] ────
  if (positional[0] === 'history') {
    const { listHistory, formatHistory, getSession, formatSessionDetail, looksLikeSessionId } =
      await import('./session/history.js');

    if (positional[1] && looksLikeSessionId(positional[1])) {
      const sessionId = positional[1];
      const workdir = resolve(positional[2] ?? process.cwd());
      const detail = getSession(workdir, sessionId);
      if (!detail) {
        console.error(`Session ${sessionId.slice(0, 8)} not found in ${workdir}`);
        process.exit(1);
      }
      console.log(formatSessionDetail(detail));
      return;
    }

    const workdir = resolve(positional[1] ?? process.cwd());
    const records = listHistory(workdir);
    if (records.length === 0) {
      console.log(`No sessions found in ${workdir}`);
      return;
    }
    console.log(formatHistory(records));
    return;
  }

  // ── anvilai memory summarize [workdir] ──────────────────────────────────────
  if (positional[0] === 'memory' && positional[1] === 'summarize') {
    const workdir = resolve(positional[2] ?? process.cwd());
    const { summarizeMemory } = await import('./context/project.js');
    try {
      await summarizeMemory(workdir);
      console.log(`✓ Summarised memory in ${workdir}/.anvil/memory.md`);
    } catch (err) {
      console.error(`✗ Summarisation failed: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // ── anvilai undo <filepath> [workdir] ────────────────────────────────────────
  if (positional[0] === 'undo') {
    const filepath = positional[1];
    const workdir = resolve(positional[2] ?? process.cwd());
    if (!filepath) {
      console.error('Usage: anvilai undo <filepath> [workdir]');
      process.exit(1);
    }
    const { undoFile, undoableFiles } = await import('./git/undo.js');
    const { simpleGit } = await import('simple-git');
    const git = simpleGit(workdir);
    // Find the most recent session branch to derive the session id from.
    const branches = await git.branch(['--list', 'anvil/session-*']);
    const sessionBranch = Object.keys(branches.branches)
      .filter((b) => b.startsWith('anvil/session-'))
      .sort()
      .pop();
    if (!sessionBranch) {
      console.error('No anvil session branch found in this repo.');
      process.exit(1);
    }
    const match = /anvil\/session-([0-9a-f]{8})-/.exec(sessionBranch);
    if (!match) {
      console.error(`Could not parse session id from branch ${sessionBranch}`);
      process.exit(1);
    }
    const sessionShort = match[1]!;
    const undoable = await undoableFiles(workdir, sessionShort);
    const rel = filepath.replace(/^\.\//, '');
    if (!undoable.includes(rel) && !undoable.some((f) => f.endsWith('/' + rel))) {
      console.error(`${rel} was not modified by session ${sessionShort}.`);
      console.error(`Files this session touched:`);
      for (const f of undoable) console.error(`  ${f}`);
      process.exit(1);
    }
    try {
      const { deleted, commitHash } = await undoFile(workdir, rel, sessionShort);
      const verb = deleted ? 'Deleted' : 'Restored';
      console.log(`✓ ${verb} ${rel} to pre-session state (commit ${commitHash.slice(0, 7)})`);
    } catch (err) {
      console.error(`✗ Undo failed: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // ── First-run wizard ─────────────────────────────────────────────────────────
  // Skip on meta-commands (--version, init, doctor, config), on --headless
  // (CI shouldn't get interactive prompts), and on --dry-run.
  const isMetaCommand =
    positional[0] === 'init' ||
    positional[0] === 'doctor' ||
    positional[0] === 'config' ||
    positional[0] === 'undo' ||
    positional[0] === 'memory' ||
    positional[0] === 'history';
  if (
    !isHeadless &&
    !isDryRun &&
    !isMetaCommand &&
    !showVersion &&
    !showCommands &&
    !isRollback &&
    !isResume
  ) {
    const { isFirstRun, runFirstRun } = await import('./setup/firstrun.js');
    if (isFirstRun()) {
      const firstRunWorkdir = resolve(positional[1] ?? process.cwd());
      await runFirstRun(firstRunWorkdir);
    }
  }

  // ── anvil config ─────────────────────────────────────────────────────────────
  if (positional[0] === 'config') {
    const sub = positional[1];
    const { runConfigSet, runConfigGet, runConfigList } = await import('./setup/config.js');
    if (sub === 'set') {
      const key = positional[2];
      const val = positional[3];
      if (!key || !val) {
        console.error('Usage: anvil config set <key> <value>');
        process.exit(1);
      }
      runConfigSet(key, val);
      return;
    }
    if (sub === 'get') {
      const key = positional[2];
      if (!key) {
        console.error('Usage: anvil config get <key>');
        process.exit(1);
      }
      runConfigGet(key);
      return;
    }
    if (sub === 'list' || !sub) {
      runConfigList();
      return;
    }
    console.error(`Unknown config subcommand "${sub}". Use set, get, or list.`);
    process.exit(1);
  }

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

  // ── --commands flag ──────────────────────────────────────────────────────────
  if (showCommands) {
    const workdir = resolve(positional[0] ?? process.cwd());
    const { loadCommands, printCommands } = await import('./setup/commands.js');
    const commands = await loadCommands(workdir);
    printCommands(commands);
    return;
  }

  // ── Help ─────────────────────────────────────────────────────────────────────
  const request = positional[0];

  if (!request || request === '--help' || request === '-h') {
    console.error('Usage: anvil "<request>" [workdir] [flags]');
    console.error('       workdir defaults to the current directory');
    console.error('\nExample: anvil "add error handling to main.ts"');
    console.error('\nCommands:');
    console.error('  anvil init                   Interactive project setup');
    console.error('  anvil doctor                 Verify Anvil setup');
    console.error('  anvil config list            Show all config values');
    console.error('  anvil config set <key> <v>   Set a config value');
    console.error('  anvil config get <key>       Get a config value');
    console.error('  anvil history [workdir]      List past sessions in a workdir');
    console.error('  anvil history <id> [workdir] Show full detail for one session');
    console.error('  anvil undo <file> [workdir]  Revert one file from the latest session');
    console.error('  anvil memory summarize [wd]  Collapse memory.md older entries');
    console.error('\nFlags:');
    console.error('  --model <id>             Select model (skips picker)');
    console.error('  --rollback <sessionId>   Revert all changes from a session');
    console.error('  --resume <sessionId>     Resume a previously interrupted session');
    console.error('  --image <filepath>       Attach an image as context (PNG/JPG/WebP/GIF)');
    console.error('  --headless               No TUI — output JSON result to stdout');
    console.error('  --dry-run                Plan only — print plan, do not execute');
    console.error('  --no-verify              Skip post-execution verification pass');
    console.error('  --commands               List available slash commands');
    console.error('  --continue               Continue the prior conversation in this workdir');
    console.error('  --budget <dollars>       Abort the session if estimated cost exceeds this');
    console.error('  --no-open                Do not spawn $EDITOR after the session completes');
    console.error('  --version                Print the installed anvil-agent version');
    console.error('\nEnv: API key for the selected model must be set');
    process.exit(1);
  }

  const workdirArg = positional[1];
  const workdir    = resolve(workdirArg ?? process.cwd());

  // ── Slash command resolution ─────────────────────────────────────────────────
  let resolvedRequest = request;
  let systemPrompt: string | undefined;

  if (request.startsWith('/')) {
    const { loadCommands, resolveSlashCommand } = await import('./setup/commands.js');
    const commands = await loadCommands(workdir);
    const resolved = resolveSlashCommand(request, commands);
    if (resolved) {
      resolvedRequest = resolved.request;
      systemPrompt = resolved.systemPrompt;
    } else {
      const name = request.split(/\s+/)[0].slice(1);
      console.error(`Unknown slash command "/${name}". Run "anvil --commands" to list available commands.`);
      process.exit(1);
    }
  }

  // ── LSP auto-install ─────────────────────────────────────────────────────────
  if (!isDryRun && !isHeadless) {
    const { promptAndInstall } = await import('./setup/lsp.js');
    await promptAndInstall(workdir);
  }

  // ── Model selection ───────────────────────────────────────────────────────────
  const { AVAILABLE_MODELS, selectModel, buildClient } = await import('./setup/config.js');

  let modelId: string;
  let modelLabel: string;
  let apiKey: string;
  let baseURL: string | null;

  if (modelFlag) {
    // --model flag provided: skip picker, validate immediately
    const spec = AVAILABLE_MODELS.find(m => m.id === modelFlag);
    if (!spec) {
      const ids = AVAILABLE_MODELS.map(m => m.id).join(', ');
      console.error(`Unknown model "${modelFlag}". Available: ${ids}`);
      process.exit(1);
    }
    apiKey = process.env[spec.envKey] ?? '';
    if (!apiKey) {
      console.error(`${spec.envKey} is not set. Required for model ${spec.id}.`);
      process.exit(1);
    }
    modelId = spec.id;
    modelLabel = spec.label;
    baseURL = spec.baseURL;
  } else if (isHeadless || isDryRun) {
    // Non-interactive modes: use config default, no picker
    const { loadConfig } = await import('./setup/config.js');
    const cfg = loadConfig();
    const spec = AVAILABLE_MODELS.find(m => m.id === cfg.model) ?? AVAILABLE_MODELS[0];
    apiKey = process.env[spec.envKey] ?? process.env.ANTHROPIC_API_KEY ?? '';
    modelId = spec.id;
    modelLabel = spec.label;
    baseURL = spec.baseURL;
  } else {
    // TUI mode: interactive picker
    const result = await selectModel();
    modelId = result.modelId;
    modelLabel = result.modelLabel;
    apiKey = result.apiKey;
    baseURL = result.baseURL;
  }

  const client = buildClient(modelId, baseURL, apiKey);

  const sessionId = randomUUID();

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
      const result = await runHeadless(resolvedRequest, workdir, noVerify, client, modelId);
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
      const plan = await runDryRun(resolvedRequest, workdir, sessionId);
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
    React.createElement(App, { request: resolvedRequest, workdir, sessionId, modelLabel }),
  );

  try {
    await runAgent(resolvedRequest, workdir, sessionId, {
      noVerify,
      image: imageBlock,
      systemPrompt,
      client,
      modelId,
      modelLabel,
      continueConversation: continueConv,
      budgetCapUSD,
      noOpen,
    });
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
