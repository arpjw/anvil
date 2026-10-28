import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { simpleGit } from 'simple-git';
import { createSessionBranch, commitFile, rollbackSession } from '../src/git/client.js';
import { undoFile } from '../src/git/undo.js';

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'anvil-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = simpleGit(root); await git.init(); await git.addConfig('user.name', 'Anvil Test'); await git.addConfig('user.email', 'test@example.invalid');
  writeFileSync(join(root, 'a.txt'), 'before\n'); writeFileSync(join(root, 'b.txt'), 'before\n');
  await git.add('.'); await git.commit('fixture'); await git.checkoutLocalBranch('feature/base');
  return { root, git, id: randomUUID() };
}

test('file commits preserve unrelated staged changes', async t => {
  const { root, git } = await fixture(t);
  writeFileSync(join(root, 'b.txt'), 'user staging\n'); await git.add('b.txt');
  writeFileSync(join(root, 'a.txt'), 'agent change\n'); await commitFile(root, 'a.txt', 'update a');
  assert.equal(await git.show(['HEAD:b.txt']), 'before\n');
  assert.match(await git.diff(['--cached']), /user staging/);
});

test('rollback refuses dirty changes and preserves the session branch after clean rollback', async t => {
  const { root, git, id } = await fixture(t); const branch = await createSessionBranch(root, id);
  writeFileSync(join(root, 'a.txt'), 'agent\n'); await commitFile(root, 'a.txt', 'agent');
  writeFileSync(join(root, 'b.txt'), 'unsaved\n'); await assert.rejects(rollbackSession(root, id), /uncommitted/);
  assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'unsaved\n');
  writeFileSync(join(root, 'b.txt'), 'before\n');
  assert.deepEqual(await rollbackSession(root, id), ['a.txt']);
  assert.equal((await git.branch()).current, 'feature/base'); assert.ok((await git.branch()).all.includes(branch));
});

test('undo uses the actual feature-branch base and preserves exact file bytes', async t => {
  const { root, git, id } = await fixture(t);
  writeFileSync(join(root, 'a.txt'), 'feature\n\n'); await git.add('a.txt'); await git.commit('feature work');
  await createSessionBranch(root, id);
  writeFileSync(join(root, 'a.txt'), 'agent'); await commitFile(root, 'a.txt', 'agent');
  await undoFile(root, 'a.txt', id); assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'feature\n\n');
});

test('undo removes a file created by the session', async t => {
  const { root, id } = await fixture(t); await createSessionBranch(root, id);
  writeFileSync(join(root, 'new.txt'), 'created'); await commitFile(root, 'new.txt', 'new');
  assert.equal((await undoFile(root, 'new.txt', id)).deleted, true); assert.equal(existsSync(join(root, 'new.txt')), false);
});

test('unchanged files do not fail completion or create empty commits', async t => {
  const { root, git } = await fixture(t);
  const before = await git.revparse(['HEAD']);
  assert.equal(await commitFile(root, 'a.txt', 'unchanged'), '');
  assert.equal(await git.revparse(['HEAD']), before);
});
