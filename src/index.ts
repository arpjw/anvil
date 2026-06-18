#!/usr/bin/env node
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { runAgent } from './agent.js';

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

process.stderr.write(`Anvil — ${workdir}\n`);
process.stderr.write(`Session: ${sessionId}\n`);
process.stderr.write(`Request: ${request}\n\n`);

runAgent(request, workdir, sessionId).then(() => {
  process.exit(0);
}).catch(err => {
  process.stderr.write(`\nError: ${(err as Error).message}\n`);
  process.exit(1);
});
