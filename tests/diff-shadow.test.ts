import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applySelectedHunks, generateDiff } from '../src/diff/engine.js';
import { shadowWrite, commitContent, clearSession } from '../src/shadow/workspace.js';
import { workspacePath } from '../src/tools/workspace_path.js';
import { uiStream, type UIEvent } from '../src/ui/stream.js';

for (const [before, after] of [['', 'new'], ['', 'new\n'], ['old', 'new'], ['old\n', 'new'], ['a\r\nb\r\n', 'a\r\nc\r\n'], ['last', ''], ['a\n', 'a\nb\n']]) {
  test(`diff round trip ${JSON.stringify(before)} -> ${JSON.stringify(after)}`, () => {
    const diff = generateDiff(before!, after!, 'file');
    assert.equal(applySelectedHunks(before!, diff.hunks, new Set(diff.hunks.map((_, i) => i))), after);
    assert.equal(applySelectedHunks(before!, diff.hunks, new Set()), before);
  });
}

test('partial approval revalidates the selected content and restores LSP state', async t => {
  const id = randomUUID(); t.after(() => clearSession(id));
  const before = 'const a: number = 1;\n' + '\n'.repeat(12) + 'const b = a;\n';
  const after = 'const a: string = "one";\n' + '\n'.repeat(12) + 'const b = a.length;\n';
  const checked: string[] = []; let reverted = false;
  const handler = (event: UIEvent) => {
    if (event.type === 'diff_ready') uiStream.resolveDiff(new Set([1]), event.filepath, event.hunkCount);
  };
  uiStream.on('event', handler); t.after(() => uiStream.off('event', handler));
  const result = await shadowWrite(id, '/fixture/a.ts', before, after, '/fixture', {
    async checkContent(_path, content) {
      checked.push(content);
      return content.includes('number') && content.includes('a.length')
        ? [{ file: 'a.ts', line: 14, character: 1, severity: 'error', message: 'Property length does not exist on number' }] : [];
    },
    async revertContent() { reverted = true; },
  });
  assert.equal(checked.length, 2);
  assert.equal(result.clean, false);
  assert.equal(result.finalContent, before);
  assert.equal(reverted, true);
});

test('validation failures preserve an actionable error', async t => {
  const id = randomUUID(); t.after(() => clearSession(id));
  const result = await shadowWrite(id, '/fixture/a.ts', 'original', 'new', '/fixture', {
    async checkContent() { throw new Error('diagnostics timed out'); }, async revertContent() {},
  });
  assert.equal(result.clean, false);
  assert.match(result.validationError!, /timed out/);
});

test('atomic writes refuse edits made while a diff was open', t => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-write-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'a.txt'); writeFileSync(path, 'user edit');
  assert.throws(() => commitContent(path, 'agent edit', { content: 'old', exists: true }), /changed while/);
  assert.equal(readFileSync(path, 'utf8'), 'user edit');
  commitContent(path, 'approved', { content: 'user edit', exists: true });
  assert.equal(readFileSync(path, 'utf8'), 'approved');
});

test('workspace path rejects escapes, symlinks to other directories, and Git internals', t => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-path-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src')); symlinkSync(tmpdir(), join(root, 'outside'));
  assert.throws(() => workspacePath(root, '../x'), /inside/);
  assert.throws(() => workspacePath(root, '.git/config'), /Git metadata/);
  assert.throws(() => workspacePath(root, 'outside/secret'), /Symlink/);
  assert.equal(workspacePath(root, 'src/new.ts').endsWith('/src/new.ts'), true);
});

test('synchronous approval is not lost and diff approvals are scoped to file', async t => {
  const handler = (event: UIEvent) => { if (event.type === 'approval_needed') uiStream.resolveApproval('y'); };
  uiStream.on('event', handler); t.after(() => uiStream.off('event', handler));
  assert.deepEqual(await uiStream.waitForApproval(), { answer: 'y', feedback: undefined });
  const a = uiStream.waitForDiffResolution('a', generateDiff('old', 'new', 'a'));
  const b = uiStream.waitForDiffResolution('b', generateDiff('old', 'new', 'b'));
  uiStream.resolveDiff(new Set(), 'b', 1); uiStream.resolveDiff(new Set([0]), 'a', 1);
  assert.deepEqual(await a, new Set([0])); assert.deepEqual(await b, new Set());
});
