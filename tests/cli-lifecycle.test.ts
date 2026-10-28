import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import OpenAI from 'openai';
import { parseCli } from '../src/setup/cli.js';
import { runOrchestrator } from '../src/agents/orchestrator.js';
import { uiStream, type UIEvent } from '../src/ui/stream.js';
import { readSessionResults } from '../src/session/result.js';
import { clearSession } from '../src/shadow/workspace.js';
import { parseFile, queryNodes } from '../src/treesitter/index.js';

for (const args of [['--budget', 'NaN'], ['--budget', '-1'], ['--budget'], ['--model'], ['--mdoel', 'x'], ['--resume', 'a', '--rollback', 'b']]) {
  test(`CLI rejects ${args.join(' ')}`, () => assert.throws(() => parseCli(args)));
}
test('CLI permits flags before positional arguments and literal requests after --', () => {
  assert.equal(parseCli(['--model', 'x', 'task', '.']).positionals[0], 'task');
  assert.equal(parseCli(['--', '--literal']).positionals[0], '--literal');
});
test('help is usable without credentials, setup prompts, or native tools', () => {
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.match(output, /verify/); assert.match(output, /stream-json/);
});
test('verify outputs parseable JSON without model credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/index.ts', 'verify', root, '--json'], { encoding: 'utf8', timeout: 10_000 });
  const report = JSON.parse(output); assert.equal(report.checks.length, 4);
});

function mockClient(completed: boolean) {
  return new OpenAI({ apiKey: 'local-test', fetch: async () => {
    const choice = completed ? { delta: { tool_calls: [{ index: 0, id: 'done-1', function: { name: 'done', arguments: '{"summary":"Implemented fixture"}' } }] }, finish_reason: 'tool_calls' }
      : { delta: { content: 'incomplete response' }, finish_reason: 'stop' };
    return new Response(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
}

test('completion happens after verification, persists status, and cleans up listeners', async t => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-run-')); const id = randomUUID();
  t.after(() => { rmSync(root, { recursive: true, force: true }); clearSession(id); });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e \"process.exit(0)\"' } }));
  const events: UIEvent[] = []; const listener = (e: UIEvent) => events.push(e);
  const baseline = uiStream.listenerCount('event'); uiStream.on('event', listener);
  t.after(() => uiStream.off('event', listener));
  const result = await runOrchestrator('Explain this project', root, id, { client: mockClient(true), autoBranch: false, headless: true });
  assert.equal(result.status, 'complete');
  assert.ok(events.findIndex(e => e.type === 'verification_pass') < events.findIndex(e => e.type === 'done'));
  assert.equal(readSessionResults(root)[0]!.status, 'complete');
  assert.equal(uiStream.listenerCount('event'), baseline + 1);
});

test('incomplete executor output is a failure with a recoverable plan', async t => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-fail-')); const id = randomUUID();
  t.after(() => { rmSync(root, { recursive: true, force: true }); clearSession(id); });
  const events: UIEvent[] = []; const listener = (e: UIEvent) => events.push(e); uiStream.on('event', listener);
  t.after(() => uiStream.off('event', listener));
  await assert.rejects(runOrchestrator('Explain this project', root, id, { client: mockClient(false), autoBranch: false, headless: true }), /before confirming completion/);
  assert.equal(events.some(e => e.type === 'done'), false);
  assert.equal(readSessionResults(root)[0]!.status, 'failed');
  assert.equal(existsSync(join('/tmp/anvil', id, 'plan.json')), true);
});

test('first AST query works without priming native grammar state', t => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-ast-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'a.ts'); writeFileSync(file, 'export function greet() { return "hello"; }');
  const parsed = parseFile(file); assert.ok(parsed);
  assert.equal(queryNodes(parsed.tree, 'functions')[0]!.name, 'greet');
});

test('library entrypoint imports without launching CLI', () => {
  const proc = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(resolve('dist/api.js'))}); console.log(typeof m.runOrchestrator)`], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(proc.status, 0, proc.stderr); assert.equal(proc.stdout.trim(), 'function');
});

test('executor cannot report success after a denied write', async t => {
  const { runExecutor } = await import('../src/agents/executor.js');
  const root = mkdtempSync(join(tmpdir(), 'anvil-denied-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let turn = 0;
  const client = new OpenAI({ apiKey: 'test', fetch: async () => {
    const fn = turn++ === 0 ? { name: 'write_file', arguments: JSON.stringify({ path: '../escape.txt', content: 'bad' }) } : { name: 'done', arguments: '{"summary":"finished"}' };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${turn}`, function: fn }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const result = await runExecutor({ goal: 'task', context: '', filesToModify: ['ok.txt'], filesToCreate: [], steps: ['edit'], verificationCriteria: [], risks: [] }, root, randomUUID(), undefined, undefined, client);
  assert.equal(result.success, false);
  assert.match(result.escalations.join(' '), /Access denied/);
});
