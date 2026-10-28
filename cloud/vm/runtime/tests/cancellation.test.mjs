import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';

test('startup reserves the session and retains an abort during library loading', { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-runtime-'));
  const child = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    rmSync(root, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/listening on :(\d+)/); if (match) resolve(Number(match[1])); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Runtime exited before listening: ${code}`)));
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  t.after(() => ws.terminate());
  const messages = [];
  const aborted = new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', raw => { const msg = JSON.parse(raw.toString()); messages.push(msg); if (msg.type === 'aborted') resolve(); });
  });
  await once(ws, 'open');
  // This nonexistent workspace also prevents any model request if cancellation regresses.
  const start = { type: 'start', payload: { request: 'Explain project', repoPath: join(root, 'missing'), model: 'claude-sonnet-4-6', apiKey: 'fixture', sessionId: randomUUID() } };
  ws._socket.cork();
  ws.send(JSON.stringify(start));
  ws.send(JSON.stringify(start));
  ws.send(JSON.stringify({ type: 'abort' }));
  ws._socket.uncork();
  await aborted;
  assert.ok(messages.some(msg => msg.type === 'error' && msg.payload.message.includes('already running')), JSON.stringify(messages));
  assert.equal(messages.filter(msg => msg.type === 'aborted').length, 1);
  assert.equal(messages.some(msg => msg.type === 'done'), false);
});
