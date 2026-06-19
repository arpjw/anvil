#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { runAgent } from './agent.js';
import { App } from './ui/App.js';
import { uiStream } from './ui/stream.js';

const [, , request, workdirArg] = process.argv;

// ── Rollback mode ─────────────────────────────────────────────────────────────

if (request === '--rollback') {
  const sessionId = workdirArg;
  if (!sessionId) {
    console.error('Usage: anvil --rollback <sessionId>');
    process.exit(1);
  }

  const workdir = resolve(process.argv[4] ?? process.cwd());

  import('./git/client.js').then(async ({ rollbackSession }) => {
    try {
      const filesRestored = await rollbackSession(workdir, sessionId);
      console.log(`✓ Rolled back session ${sessionId.slice(0, 8)}`);
      console.log(`  Restored ${filesRestored.length} file(s)${filesRestored.length ? ':' : '.'}`);
      for (const f of filesRestored) console.log(`  - ${f}`);
    } catch (err) {
      console.error(`✗ Rollback failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

  process.exit(0);
}

// ── Normal mode ───────────────────────────────────────────────────────────────

if (!request || request === '--help' || request === '-h') {
  console.error('Usage: anvil "<request>" [workdir]');
  console.error('       workdir defaults to the current directory');
  console.error('\nExample: anvil "add error handling to main.ts"');
  console.error('\nFlags:');
  console.error('  --rollback <sessionId>  Revert all changes from a session and delete its branch');
  console.error('\nEnv: ANTHROPIC_API_KEY must be set');
  process.exit(1);
}

const workdir = resolve(workdirArg ?? process.cwd());
const sessionId = randomUUID();

const { unmount } = render(
  React.createElement(App, { request, workdir, sessionId }),
);

runAgent(request, workdir, sessionId)
  .then(() => {
    uiStream.ensureDone();
    setTimeout(() => { unmount(); process.exit(0); }, 500);
  })
  .catch((err: Error) => {
    uiStream.push({ type: 'error', message: err.message });
    setTimeout(() => { unmount(); process.exit(1); }, 500);
  });
