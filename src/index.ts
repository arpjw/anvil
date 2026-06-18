#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { runAgent } from './agent.js';
import { App } from './ui/App.js';
import { uiStream } from './ui/stream.js';

const [, , request, workdirArg] = process.argv;

if (!request || request === '--help' || request === '-h') {
  console.error('Usage: anvil "<request>" [workdir]');
  console.error('       workdir defaults to the current directory');
  console.error('\nExample: anvil "add error handling to main.ts"');
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
    // Small delay so the UI can render the final done state before exit.
    setTimeout(() => { unmount(); process.exit(0); }, 500);
  })
  .catch((err: Error) => {
    uiStream.push({ type: 'error', message: err.message });
    setTimeout(() => { unmount(); process.exit(1); }, 500);
  });
