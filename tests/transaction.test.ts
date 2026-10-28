import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { applyTransaction, recoverTransaction } from '../src/workspace/transaction.js';
import { workspaceStatePath } from '../src/workspace/lock.js';
import { uiStream, type UIEvent } from '../src/ui/stream.js';

function fixture(t: test.TestContext, approve = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-batch-'))); const id = randomUUID();
  uiStream.resetSession();
  const events: UIEvent[] = [];
  const listener = (event: UIEvent) => {
    events.push(event);
    if (approve && event.type === 'diff_ready') uiStream.resolveDiff(new Set(event.diff.hunks.map((_, i) => i)), event.filepath, event.hunkCount);
  };
  uiStream.on('event', listener);
  t.after(() => { uiStream.off('event', listener); uiStream.resetSession(); rmSync(root, { recursive: true, force: true }); rmSync(join('/tmp/anvil', id), { recursive: true, force: true }); });
  return { root, id, events };
}

test('a cross-file rename validates as a whole although either first edit is invalid', async t => {
  const { root, id, events } = fixture(t);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true }, include: ['*.ts'] }));
  writeFileSync(join(root, 'a.ts'), 'export const before = 1;\n');
  writeFileSync(join(root, 'b.ts'), 'import { before } from "./a"; export const value = before;\n');
  await assert.rejects(applyTransaction(root, id, [{ path: 'a.ts', content: 'export const after = 1;\n' }]), /Batch validation failed/);
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'export const before = 1;\n');
  const result = await applyTransaction(root, id, [{ path: 'a.ts', content: 'export const after = 1;\n' }, { path: 'b.ts', content: 'import { after } from "./a"; export const value = after;\n' }]);
  assert.equal(result.status, 'applied'); assert.equal(result.paths.length, 2);
  assert.equal(events.filter(e => e.type === 'transaction_applied').length, 1);
});

test('invalid JSON in any file prevents every edit', async t => {
  const { root, id, events } = fixture(t);
  writeFileSync(join(root, 'a.txt'), 'before');
  await assert.rejects(applyTransaction(root, id, [{ path: 'a.txt', content: 'after' }, { path: 'bad.json', content: '{' }]), /validation failed/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'before'); assert.equal(existsSync(join(root, 'bad.json')), false);
  assert.equal(events.some(e => e.type === 'file_modified'), false);
});

test('new and deleted modules participate in project-wide validation', async t => {
  const { root, id } = fixture(t);
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"skipLibCheck":true},"include":["*.ts"]}');
  writeFileSync(join(root, 'old.ts'), 'export const value = 1;');
  writeFileSync(join(root, 'use.ts'), 'import {value} from "./old"; export {value};');
  await applyTransaction(root, id, [{ path: 'old.ts', content: null }, { path: 'new.ts', content: 'export const value = 1;' }, { path: 'use.ts', content: 'import {value} from "./new"; export {value};' }]);
  assert.equal(existsSync(join(root, 'old.ts')), false); assert.equal(existsSync(join(root, 'new.ts')), true);
});

test('rejection of one file rejects the complete transaction', async t => {
  const { root, id } = fixture(t, false);
  writeFileSync(join(root, 'a.txt'), 'a'); writeFileSync(join(root, 'b.txt'), 'b');
  const listener = (e: UIEvent) => { if (e.type === 'diff_ready') uiStream.resolveDiff(e.filepath.endsWith('a.txt') ? new Set([0]) : new Set(), e.filepath, e.hunkCount); };
  uiStream.on('event', listener); t.after(() => uiStream.off('event', listener));
  const result = await applyTransaction(root, id, [{ path: 'a.txt', content: 'A' }, { path: 'b.txt', content: 'B' }]);
  assert.equal(result.status, 'rejected'); assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'a');
});

test('partially selected hunks are revalidated together before application', async t => {
  const { root, id } = fixture(t, false);
  const pad = '\n'.repeat(12);
  writeFileSync(join(root, 'a.ts'), 'export const n: number = 1;' + pad + 'export const result: number = n;');
  const listener = (e: UIEvent) => { if (e.type === 'diff_ready') uiStream.resolveDiff(new Set([0]), e.filepath, e.hunkCount); };
  uiStream.on('event', listener); t.after(() => uiStream.off('event', listener));
  await assert.rejects(applyTransaction(root, id, [{ path: 'a.ts', content: 'export const n: string = "x";' + pad + 'export const result: string = n;' }]), /Selected batch validation failed/);
  assert.match(readFileSync(join(root, 'a.ts'), 'utf8'), /n: number/);
});

test('apply failure rolls back modifications, deletions, and newly created directories', async t => {
  const { root, id, events } = fixture(t);
  writeFileSync(join(root, 'a.txt'), 'original\r\n'); writeFileSync(join(root, 'delete.txt'), 'keep');
  await assert.rejects(applyTransaction(root, id, [{ path: 'a.txt', content: 'changed' }, { path: 'delete.txt', content: null }, { path: 'new/deep/b.txt', content: 'new' }, { path: 'last.txt', content: 'last' }], {
    beforeApply: i => { if (i === 3) throw new Error('injected disk failure'); },
  }), /injected disk failure/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original\r\n');
  assert.equal(readFileSync(join(root, 'delete.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(join(root, 'new')), false);
  assert.equal(events.some(e => e.type === 'file_modified'), false);
});

test('workspace changes during approval are preserved and the proposal is rejected', async t => {
  const { root, id } = fixture(t, false);
  writeFileSync(join(root, 'a.txt'), 'before');
  const listener = (e: UIEvent) => { if (e.type === 'diff_ready') { writeFileSync(join(root, 'other.txt'), 'external'); uiStream.resolveDiff(new Set([0]), e.filepath, e.hunkCount); } };
  uiStream.on('event', listener); t.after(() => uiStream.off('event', listener));
  await assert.rejects(applyTransaction(root, id, [{ path: 'a.txt', content: 'after' }]), /Workspace changed/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'before'); assert.equal(readFileSync(join(root, 'other.txt'), 'utf8'), 'external');
});

test('paths, duplicate files, and symlink aliases are rejected before writes', async t => {
  const { root, id } = fixture(t);
  writeFileSync(join(root, 'a.txt'), 'before'); symlinkSync('a.txt', join(root, 'alias'));
  for (const edits of [[{ path: '../outside', content: 'x' }], [{ path: '.git/config', content: 'x' }], [{ path: 'alias', content: 'x' }], [{ path: 'a.txt', content: 'a' }, { path: './a.txt', content: 'b' }]]) {
    await assert.rejects(applyTransaction(root, id, edits));
  }
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'before');
});

test('cancellation during review leaves no modifications or approval listeners', async t => {
  const { root, id } = fixture(t, false); writeFileSync(join(root, 'a.txt'), 'before');
  const listener = (e: UIEvent) => { if (e.type === 'diff_ready') uiStream.cancelSession(); };
  uiStream.on('event', listener); t.after(() => uiStream.off('event', listener));
  await assert.rejects(applyTransaction(root, id, [{ path: 'a.txt', content: 'after' }]));
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'before');
  assert.equal(uiStream.listenerCount(`_diff_resolved:${join(root, 'a.txt')}`), 0);
});

test('an interrupted apply is recovered from its journal on the next invocation', t => {
  const { root, id } = fixture(t); writeFileSync(join(root, 'a.txt'), 'a'); writeFileSync(join(root, 'b.txt'), 'b');
  const code = `import {applyTransaction} from ${JSON.stringify(resolve('src/workspace/transaction.ts'))}; import {uiStream} from ${JSON.stringify(resolve('src/ui/stream.ts'))}; uiStream.on('event', e => {if(e.type === 'diff_ready') uiStream.resolveDiff(new Set([0]),e.filepath,e.hunkCount)}); await applyTransaction(${JSON.stringify(root)},${JSON.stringify(id)},[{path:'a.txt',content:'A'},{path:'b.txt',content:'B'}],{beforeApply:i=>{if(i===1)process.exit(42)}});`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 42, child.stderr);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'A');
  assert.equal(existsSync(workspaceStatePath(root, 'transaction.json')), true);
  recoverTransaction(root);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'a'); assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'b');
  assert.equal(existsSync(workspaceStatePath(root, 'transaction.json')), false);
});

test('empty-file creation and deletion still require explicit review', async t => {
  const { root, id, events } = fixture(t, false);
  writeFileSync(join(root, 'empty.txt'), '');
  const listener = (e: UIEvent) => { if (e.type === 'diff_ready') uiStream.resolveDiff(new Set(), e.filepath, e.hunkCount); };
  uiStream.on('event', listener); t.after(() => uiStream.off('event', listener));
  assert.equal((await applyTransaction(root, id, [{ path: 'empty.txt', content: null }])).status, 'rejected');
  assert.equal((await applyTransaction(root, id, [{ path: 'new.txt', content: '' }])).status, 'rejected');
  assert.equal(existsSync(join(root, 'empty.txt')), true); assert.equal(existsSync(join(root, 'new.txt')), false);
  assert.equal(events.filter(e => e.type === 'diff_ready').length, 2);
});

test('validation refuses absolute source imports that bypass the staged project', async t => {
  const { root, id } = fixture(t);
  writeFileSync(join(root, 'a.ts'), 'export const before = 1;');
  writeFileSync(join(root, 'b.ts'), `import {before} from ${JSON.stringify(join(root, 'a'))}; export {before};`);
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"skipLibCheck":true},"include":["*.ts"]}');
  await assert.rejects(applyTransaction(root, id, [{ path: 'a.ts', content: 'export const after = 1;' }]), /outside the staged project/);
  assert.match(readFileSync(join(root, 'a.ts'), 'utf8'), /before/);
});

test('binary and invalid Unicode proposals are rejected before any writes', async t => {
  const { root, id } = fixture(t); writeFileSync(join(root, 'a.txt'), 'original');
  for (const content of ['bad\0text', '\ud800']) {
    await assert.rejects(applyTransaction(root, id, [{ path: 'a.txt', content: 'changed' }, { path: 'bad.txt', content }]), /UTF-8/);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original');
    assert.equal(existsSync(join(root, 'bad.txt')), false);
  }
});
