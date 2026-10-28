import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationEngine } from '../src/services/validation/index.js';
import { runCommand } from '../src/tools/run_command.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'anvil-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}

test('nonzero type checker exit cannot become a pass when diagnostics are unparseable', async t => {
  const root = fixture(t); writeFileSync(join(root, 'tsconfig.json'), '{}');
  const engine = new ValidationEngine({ commandRunner: async () => ({ stdout: '', stderr: 'compiler missing', exitCode: 127, timedOut: false }) });
  const result = await engine.validate({ workdir: root });
  assert.equal(result.passed, false); assert.match(result.errors[0]!.message, /compiler missing/);
  assert.equal(result.checks[0]!.status, 'failed');
});

test('empty projects report skipped checks without inventing validation', async t => {
  const result = await new ValidationEngine().validate({ workdir: fixture(t) });
  assert.equal(result.checks.length, 4); assert.ok(result.checks.every(c => c.status === 'skipped'));
});

test('ESLint JSON errors and warnings are retained', async t => {
  const root = fixture(t); writeFileSync(join(root, 'eslint.config.js'), 'export default [];');
  const engine = new ValidationEngine({ commandRunner: async command => {
    assert.match(command, /--format json/);
    return { stdout: JSON.stringify([{ filePath: 'a.ts', messages: [
      { severity: 2, line: 3, message: 'unused variable', ruleId: 'no-unused-vars' },
      { severity: 1, line: 5, message: 'warning' },
    ] }]), stderr: '', exitCode: 1, timedOut: false };
  } });
  const result = await engine.validate({ workdir: root });
  assert.equal(result.errors.length, 1); assert.equal(result.warnings.length, 1); assert.equal(result.errors[0]!.line, 3);
});

test('project scripts run through npm so local binaries and lifecycle hooks work', async t => {
  const root = fixture(t); writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'check-types', lint: 'eslint src', test: 'vitest run' } }));
  const commands: string[] = [];
  const result = await new ValidationEngine({ commandRunner: async command => {
    commands.push(command); return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
  } }).validate({ workdir: root });
  assert.deepEqual(commands, ['npm run --silent typecheck', 'npm run --silent lint', 'npm test --']);
  assert.deepEqual(result.checks.map(c => c.status), ['passed', 'passed', 'passed', 'skipped']);
});

test('custom checks return real failures', async t => {
  const root = fixture(t); mkdirSync(join(root, '.anvil')); writeFileSync(join(root, '.anvil/rules.md'), 'VALIDATE: exit 7\n');
  const result = await new ValidationEngine().validate({ workdir: root });
  assert.equal(result.passed, false); assert.equal(result.errors[0]!.phase, 'custom');
});

test('command output stays bounded even for long lines and failure paths', async t => {
  const result = await runCommand(`node -e "process.stdout.write('x'.repeat(300000));process.exit(3)"`, fixture(t));
  assert.equal(result.exitCode, 3); assert.ok(result.stdout.length + result.stderr.length < 20100);
  assert.match(result.stderr, /truncated/);
});

test('timeout never returns exit code zero', async t => {
  const result = await runCommand(`node -e "setTimeout(()=>{},10000)"`, fixture(t), 0.1);
  assert.equal(result.timedOut, true); assert.notEqual(result.exitCode, 0);
});
