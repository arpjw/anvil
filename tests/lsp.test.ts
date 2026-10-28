import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LspClient } from '../src/lsp/client.js';

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'anvil-lsp-'));
  const bin = join(root, 'node_modules', '.bin', 'typescript-language-server');
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  copyFileSync(resolve('tests/fixtures/lsp-server.mjs'), bin); chmodSync(bin, 0o755);
  const client = new LspClient(); await client.start(root);
  t.after(async () => { await client.shutdown(); rmSync(root, { recursive: true, force: true }); });
  return { root, client };
}

test('LSP rejects validation when disconnected', async () => {
  await assert.rejects(new LspClient().checkContent('/a.ts', 'CLEAN'), /not ready/);
});
test('LSP times out closed instead of accepting missing diagnostics', async t => {
  const { root, client } = await fixture(t);
  await assert.rejects(client.checkContent(join(root, 'a.ts'), 'SILENT', 80), /not validated/);
});
test('LSP waits for the current document version', async t => {
  const { root, client } = await fixture(t);
  const errors = await client.checkContent(join(root, 'a.ts'), 'STALE', 1500);
  assert.equal(errors.length, 1);
});
test('LSP frames respect UTF-8 byte lengths and split multibyte characters', async t => {
  const { root, client } = await fixture(t);
  const errors = await client.checkContent(join(root, 'a.ts'), 'UNICODE', 1500);
  assert.equal(errors[0]!.message, '錯誤: café 🚀');
  assert.deepEqual(await client.checkContent(join(root, 'a.ts'), 'CLEAN', 1500), []);
});
test('LSP process death rejects pending diagnostics promptly', async t => {
  const { root, client } = await fixture(t);
  await assert.rejects(client.checkContent(join(root, 'a.ts'), 'EXIT', 1500), /exited/);
});

test('bundled TypeScript server validates a project without a local language server', async t => {
  const { writeFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'anvil-real-lsp-'));
  const client = new LspClient();
  t.after(async () => { await client.shutdown(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true }, include: ['*.ts'] }));
  const file = join(root, 'sample.ts'); writeFileSync(file, 'export const value: number = 1;\n');
  await client.start(root);
  const errors = await client.checkContent(file, 'export const value: number = "wrong";\n');
  assert.ok(errors.some(error => error.severity === 'error' && error.message.includes('not assignable')));
  assert.deepEqual(await client.checkContent(file, 'export const value: number = 2;\n'), []);
});
