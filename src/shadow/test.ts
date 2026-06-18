/**
 * Phase 3 shadow workspace integration test.
 *
 * Runs a two-cycle scenario:
 *   Cycle 1 — broken TypeScript (type errors) → expect rejection with diagnostics
 *   Cycle 2 — fixed TypeScript               → expect clean commit
 *
 * The test file lives temporarily inside src/ so the TS language server
 * has full project context (tsconfig, node_modules) when checking it.
 *
 * Run with:  npx tsx src/shadow/test.ts
 */
import { randomUUID } from 'crypto';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { shadowWrite, commitToReal, clearSession } from './workspace.js';
import { getLspClient } from '../lsp/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use the anvil project root — it has node_modules/typescript so the LSP
// can perform full semantic checking.
const WORKDIR = resolve(__dirname, '../..');
// Place the scratch file in src/ so it falls inside the tsconfig include paths.
const TEST_FILE = resolve(WORKDIR, 'src', '_shadow_test_scratch.ts');
const SESSION = randomUUID();
const LOG_PATH = `/tmp/anvil/${SESSION}/shadow.log`;

async function main(): Promise<void> {
  console.log('Phase 3 — Shadow Workspace Test');
  console.log(`Session : ${SESSION}`);
  console.log(`Workdir : ${WORKDIR}`);
  console.log(`Log     : ${LOG_PATH}`);
  console.log();

  // Write a clean placeholder so the LSP knows the file before we shadow it.
  writeFileSync(TEST_FILE, 'export {};\n', 'utf-8');

  // Warm up the LSP (start + typescript version negotiation).
  const lsp = await getLspClient(WORKDIR);
  await new Promise(r => setTimeout(r, 300));

  try {
    // -----------------------------------------------------------------------
    // Cycle 1: broken content — must be rejected
    // -----------------------------------------------------------------------
    const brokenContent = [
      '// Deliberately broken TypeScript',
      'const count: number = "not a number";',  // string → number
      'const greet = (name: string): void => {',
      '  return name.toUpperCase();',            // non-void return
      '};',
      'export { count, greet };',
    ].join('\n') + '\n';

    console.log('=== Cycle 1: broken content ===');
    console.log(brokenContent);

    const r1 = await shadowWrite(SESSION, TEST_FILE, brokenContent, WORKDIR);
    console.log(`clean      : ${r1.clean}`);
    console.log('diagnostics:');
    for (const d of r1.diagnostics) {
      console.log(`  ${d.line}:${d.character} [${d.severity}] ${d.message}`);
    }
    console.log();

    if (r1.clean) throw new Error('FAIL: broken content was not rejected');
    if (r1.diagnostics.length === 0) throw new Error('FAIL: expected diagnostics but got none');

    // -----------------------------------------------------------------------
    // Cycle 2: fixed content — must commit
    // -----------------------------------------------------------------------
    const fixedContent = [
      '// Fixed version',
      'const count: number = 42;',
      'const greet = (name: string): string => {',
      '  return name.toUpperCase();',
      '};',
      'export { count, greet };',
    ].join('\n') + '\n';

    console.log('=== Cycle 2: fixed content ===');
    console.log(fixedContent);

    const r2 = await shadowWrite(SESSION, TEST_FILE, fixedContent, WORKDIR);
    console.log(`clean      : ${r2.clean}`);
    if (r2.diagnostics.length > 0) {
      console.log('unexpected diagnostics:');
      for (const d of r2.diagnostics) {
        console.log(`  ${d.line}:${d.character} [${d.severity}] ${d.message}`);
      }
    }
    console.log();

    if (!r2.clean) throw new Error('FAIL: fixed content was rejected');

    await commitToReal(SESSION, TEST_FILE);
    const committed = readFileSync(TEST_FILE, 'utf-8');
    console.log('=== Committed file content ===');
    console.log(committed);

    // -----------------------------------------------------------------------
    // shadow.log
    // -----------------------------------------------------------------------
    if (existsSync(LOG_PATH)) {
      console.log('=== shadow.log ===');
      const entries = readFileSync(LOG_PATH, 'utf-8').trim().split('\n');
      for (const line of entries) {
        try { console.log(JSON.stringify(JSON.parse(line), null, 2)); }
        catch { console.log(line); }
      }
      console.log();
    }

    console.log('PASS: Phase 3 shadow workspace test complete.');

  } finally {
    rmSync(TEST_FILE, { force: true });
    clearSession(SESSION);
    await lsp.shutdown();
  }
}

main().catch(err => {
  console.error('Error:', (err as Error).stack ?? (err as Error).message);
  process.exit(1);
});
