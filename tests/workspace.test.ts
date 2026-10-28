import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { simpleGit } from 'simple-git';
import OpenAI from 'openai';
import { prepareWorkspace, commitWorkspace } from '../src/workspace/isolated.js';
import { lockWorkspace } from '../src/workspace/lock.js';
import { runOrchestrator } from '../src/agents/orchestrator.js';
import { withExecutionContext } from '../src/execution/context.js';
import { runCommand } from '../src/tools/run_command.js';
import { executeTool } from '../src/tools/index.js';
import { uiStream, type UIEvent } from '../src/ui/stream.js';
import { resumeSession } from '../src/execution/resume.js';
import { readSessionResults } from '../src/session/result.js';

async function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-isolate-')));
  const git = simpleGit(root);
  await git.init(); await git.addConfig('user.name', 'Test'); await git.addConfig('user.email', 'test@example.invalid');
  writeFileSync(join(root, 'a.txt'), 'original\n'); await git.add('.'); await git.commit('base');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, git, id: randomUUID() };
}

test('isolated worktrees preserve source HEAD, files, and index; a batch becomes one commit', async t => {
  const { root, git, id } = await fixture(t);
  const head = await git.revparse(['HEAD']); const branch = (await git.branch()).current;
  const workspace = await prepareWorkspace(root, id);
  writeFileSync(join(workspace.workdir, 'a.txt'), 'changed\n');
  writeFileSync(join(workspace.workdir, 'b.txt'), 'created\n');
  const hash = await commitWorkspace(workspace.workdir, id);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original\n');
  assert.equal(existsSync(join(root, 'b.txt')), false);
  assert.equal(await git.revparse(['HEAD']), head);
  assert.equal((await git.branch()).current, branch);
  assert.equal((await git.status()).isClean(), true);
  assert.deepEqual((await git.raw(['diff-tree', '--no-commit-id', '--name-only', '-r', hash])).trim().split('\n').sort(), ['a.txt', 'b.txt']);
  assert.equal((await git.raw(['rev-list', '--count', `${workspace.baseCommit}..${hash}`])).trim(), '1');
  assert.equal((await prepareWorkspace(root, id)).workdir, workspace.workdir);
});

test('dirty tracked source is rejected without changing its staged work', async t => {
  const { root, git, id } = await fixture(t);
  writeFileSync(join(root, 'a.txt'), 'user edit'); await git.add('a.txt');
  const index = await git.diff(['--cached']);
  await assert.rejects(prepareWorkspace(root, id), /Commit or stash/);
  assert.equal(await git.diff(['--cached']), index);
});

test('one session cannot claim the same execution workspace concurrently', async t => {
  const { root } = await fixture(t);
  const release = lockWorkspace(root, 'session');
  try { assert.throws(() => lockWorkspace(root, 'session'), /already active/); }
  finally { release(); }
  lockWorkspace(root, 'session')();
});

test('commands are denied by default policy and cannot override cwd outside the worktree', async t => {
  const { root } = await fixture(t); uiStream.resetSession();
  const result = await withExecutionContext({ root, commands: 'deny' }, () => runCommand('touch forbidden', root));
  assert.equal(result.exitCode, 126); assert.equal(existsSync(join(root, 'forbidden')), false);
  const escape = await withExecutionContext({ root, commands: 'allow' }, () => runCommand('pwd', tmpdir()));
  assert.equal(escape.exitCode, 126);
  assert.match(await executeTool('read_file', { path: '/etc/passwd' }, root, randomUUID()), /Access denied/);
});

test('command approval is scoped to one invocation and does not leak provider credentials', async t => {
  const { root } = await fixture(t); uiStream.resetSession();
  let approvals = 0;
  const listener = (event: UIEvent) => { if (event.type === 'command_approval_needed') { approvals++; uiStream.resolveCommand(event.id, approvals === 1); } };
  uiStream.on('event', listener); t.after(() => uiStream.off('event', listener));
  const previous = process.env.ANVIL_TEST_SECRET; process.env.ANVIL_TEST_SECRET = 'fixture-secret';
  try {
    const first = await withExecutionContext({ root, commands: 'ask' }, () => runCommand('node -e "console.log(process.env.ANVIL_TEST_SECRET || \'absent\')"', root));
    assert.equal(first.exitCode, 0); assert.equal(first.stdout.trim(), 'absent');
    const second = await withExecutionContext({ root, commands: 'ask' }, () => runCommand('touch forbidden', root));
    assert.equal(second.exitCode, 126); assert.equal(approvals, 2);
  } finally { if (previous === undefined) delete process.env.ANVIL_TEST_SECRET; else process.env.ANVIL_TEST_SECRET = previous; }
});

test('cancellation kills the running shell process group', async t => {
  const { root } = await fixture(t); uiStream.resetSession();
  const pending = withExecutionContext({ root, commands: 'allow' }, () => runCommand('(sleep 1; touch escaped) & wait', root, 10));
  setTimeout(() => uiStream.cancelSession(), 80);
  const result = await pending; assert.notEqual(result.exitCode, 0);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(existsSync(join(root, 'escaped')), false); uiStream.resetSession();
});

function clientFor(calls: Array<{ name: string; arguments: string }>) {
  let turn = 0;
  return new OpenAI({ apiKey: 'fixture', fetch: async () => {
    const fn = calls[turn++]; if (!fn) throw new Error('Unexpected model request');
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${turn}`, function: fn }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
}

test('orchestrator edits in a worktree, verifies there, and persists its review location', async t => {
  const { root, git, id } = await fixture(t);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: "node -e \"if(require('fs').readFileSync('a.txt','utf8') !== 'updated') process.exit(1)\"" } }));
  await git.add('package.json'); await git.commit('verification fixture');
  const listener = (event: UIEvent) => { if (event.type === 'diff_ready') uiStream.resolveDiff(new Set(event.diff.hunks.map((_, i) => i)), event.filepath, event.hunkCount); };
  uiStream.on('event', listener); t.after(() => uiStream.off('event', listener));
  const result = await runOrchestrator('Update a.txt', root, id, { headless: true, commands: 'allow', client: clientFor([
    { name: 'write_files', arguments: JSON.stringify({ edits: [{ path: 'a.txt', content: 'updated' }, { path: 'new.txt', content: 'hello' }] }) },
    { name: 'done', arguments: '{"summary":"Updated files"}' },
  ]) });
  assert.equal(result.status, 'complete'); assert.equal(result.verification, 'passed');
  assert.equal(result.isolation, 'worktree'); assert.ok(result.commitHash);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original\n');
  assert.equal(readSessionResults(root)[0]!.workdir, result.workdir);
  assert.equal(readFileSync(join(result.workdir, 'new.txt'), 'utf8'), 'hello');
  const resumed = await resumeSession(id, root, { headless: true, noVerify: true, client: clientFor([{ name: 'done', arguments: '{"summary":"Already complete"}' }]) });
  assert.equal(resumed.status, 'complete'); assert.equal(resumed.workdir, result.workdir);
  assert.equal(resumed.branchName, result.branchName);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original\n');
});

test('cancellation during a pending model response persists aborted status', async t => {
  const { root, id } = await fixture(t);
  const controller = new AbortController();
  const client = new OpenAI({ apiKey: 'fixture', fetch: async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    controller.abort();
  }) });
  const result = await runOrchestrator('Explain project', root, id, { client, headless: true, signal: controller.signal });
  assert.equal(result.status, 'aborted');
  assert.equal(readSessionResults(root)[0]!.status, 'aborted');
  assert.equal(uiStream.listenerCount('_approval'), 0);
});

test('timeouts kill shell descendants before they can modify files', async t => {
  const { root } = await fixture(t); uiStream.resetSession();
  const result = await withExecutionContext({ root, commands: 'allow' }, () => runCommand('(sleep 1; touch escaped) & wait', root, 0.1));
  assert.equal(result.timedOut, true); assert.notEqual(result.exitCode, 0);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(existsSync(join(root, 'escaped')), false);
});

test('automatic Git worktree and commit operations do not execute repository hooks', async t => {
  const { root, id } = await fixture(t);
  const { chmodSync } = await import('node:fs');
  for (const name of ['post-checkout', 'pre-commit']) {
    const path = join(root, '.git', 'hooks', name);
    writeFileSync(path, '#!/bin/sh\ntouch "' + join(root, 'hook-ran') + '"\n'); chmodSync(path, 0o755);
  }
  const workspace = await prepareWorkspace(root, id);
  writeFileSync(join(workspace.workdir, 'a.txt'), 'updated');
  await commitWorkspace(workspace.workdir, id);
  assert.equal(existsSync(join(root, 'hook-ran')), false);
});

test('headless verification without command authorization fails without a model repair', async t => {
  const { root, git, id } = await fixture(t);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'touch must-not-run' } }));
  await git.add('package.json'); await git.commit('fixture');
  const result = await runOrchestrator('Explain project', root, id, { headless: true, client: clientFor([{ name: 'done', arguments: '{"summary":"Explained"}' }]) });
  assert.equal(result.status, 'failed');
  assert.match(result.failures.join('\n'), /not approved/);
  assert.equal(existsSync(join(result.workdir, 'must-not-run')), false);
});
