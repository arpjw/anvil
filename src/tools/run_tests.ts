import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { runCommand } from './run_command.js';

export interface FailingTest {
  name: string;
  file: string;
  error: string;
}

export interface RunTestsResult {
  passed: boolean;
  runner: string | null;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  failingTests: FailingTest[];
  rawOutput: string;
}

interface Detected {
  runner: string;
  command: string;
}

function detectRunner(workdir: string): Detected | null {
  // 1. package.json scripts.test
  const pkgPath = join(workdir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: { test?: string } };
      const script = pkg.scripts?.test ?? '';
      if (script && !script.startsWith('echo')) {
        return { runner: 'npm', command: script };
      }
    } catch { /* ignore */ }
  }

  // 2. jest.config.*
  const jestFiles = ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.json'];
  if (jestFiles.some(f => existsSync(join(workdir, f)))) {
    return { runner: 'jest', command: 'npx jest' };
  }

  // 3. vitest.config.*
  const vitestFiles = ['vitest.config.js', 'vitest.config.ts', 'vitest.config.mjs'];
  if (vitestFiles.some(f => existsSync(join(workdir, f)))) {
    return { runner: 'vitest', command: 'npx vitest run' };
  }

  // 4. pytest
  if (existsSync(join(workdir, 'pytest.ini'))) {
    return { runner: 'pytest', command: 'python -m pytest' };
  }
  if (existsSync(join(workdir, 'pyproject.toml'))) {
    const content = readFileSync(join(workdir, 'pyproject.toml'), 'utf-8');
    if (content.includes('[tool.pytest')) {
      return { runner: 'pytest', command: 'python -m pytest' };
    }
  }

  // 5. Cargo
  if (existsSync(join(workdir, 'Cargo.toml'))) {
    return { runner: 'cargo', command: 'cargo test' };
  }

  // 6. Go
  if (existsSync(join(workdir, 'go.mod'))) {
    return { runner: 'go', command: 'go test ./...' };
  }

  return null;
}

function detectParserFromCommand(command: string): string {
  if (command.includes('vitest')) return 'vitest';
  if (command.includes('jest')) return 'jest';
  if (command.includes('pytest')) return 'pytest';
  if (command.includes('cargo test')) return 'cargo';
  if (command.includes('go test')) return 'go';
  return 'jest'; // default to jest-style output
}

function applyFilter(command: string, runner: string, filter: string): string {
  switch (runner) {
    case 'vitest': return `${command} ${filter}`;
    case 'jest':   return `${command} --testPathPattern="${filter}"`;
    case 'pytest': return `${command} -k "${filter}"`;
    case 'cargo':  return `${command} ${filter}`;
    case 'go':     return `${command} -run "${filter}"`;
    default:       return `${command} ${filter}`;
  }
}

function parseOutput(
  output: string,
  runner: string,
): Pick<RunTestsResult, 'totalTests' | 'passedTests' | 'failedTests' | 'skippedTests' | 'failingTests'> {
  let totalTests = 0, passedTests = 0, failedTests = 0, skippedTests = 0;
  const failingTests: FailingTest[] = [];

  if (runner === 'jest') {
    // Tests: 2 passed, 1 failed, 3 total
    const m = output.match(/Tests:\s+(?:(\d+) failed,?\s*)?(?:(\d+) skipped,?\s*)?(?:(\d+) passed,?\s*)?(\d+) total/);
    if (m) {
      failedTests  = parseInt(m[1] ?? '0');
      skippedTests = parseInt(m[2] ?? '0');
      passedTests  = parseInt(m[3] ?? '0');
      totalTests   = parseInt(m[4] ?? '0');
    }
    const failLines = output.match(/^\s{2}● .+$/gm) ?? [];
    for (const line of failLines) {
      failingTests.push({ name: line.replace(/^\s+● /, '').trim(), file: '', error: '' });
    }
  } else if (runner === 'vitest') {
    // Tests  2 passed | 1 failed (3)
    const m = output.match(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) failed)?(?:\s*\|\s*(\d+) skipped)?\s+\((\d+)\)/);
    if (m) {
      passedTests  = parseInt(m[1] ?? '0');
      failedTests  = parseInt(m[2] ?? '0');
      skippedTests = parseInt(m[3] ?? '0');
      totalTests   = parseInt(m[4] ?? '0');
    }
    // × file > describe > test
    const failLines = output.match(/^\s*[×✕x]\s+.+$/gm) ?? [];
    for (const line of failLines) {
      const raw = line.trim().replace(/^[×✕x]\s+/, '');
      const parts = raw.split(' > ');
      const file = parts[0] ?? '';
      const name = parts.slice(1).join(' > ') || raw;
      failingTests.push({ name, file, error: '' });
    }
    // If no summary line found, fall back to counting × lines
    if (!m && failLines.length > 0) {
      failedTests = failLines.length;
      totalTests  = failedTests;
    }
  } else if (runner === 'pytest') {
    const m = output.match(/(\d+) failed.*?(\d+) passed/);
    if (m) {
      failedTests = parseInt(m[1]);
      passedTests = parseInt(m[2]);
      totalTests  = passedTests + failedTests;
    }
    const failLines = output.match(/^FAILED .+$/gm) ?? [];
    for (const line of failLines) {
      const parts = line.replace('FAILED ', '').split('::');
      failingTests.push({ name: parts.slice(1).join('::'), file: parts[0] ?? '', error: '' });
    }
  } else if (runner === 'cargo') {
    const m = output.match(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/);
    if (m) {
      passedTests  = parseInt(m[1]);
      failedTests  = parseInt(m[2]);
      skippedTests = parseInt(m[3]);
      totalTests   = passedTests + failedTests;
    }
    const failLines = output.match(/^test .+ \.\.\. FAILED$/gm) ?? [];
    for (const line of failLines) {
      const name = line.replace(/^test /, '').replace(/ \.\.\. FAILED$/, '');
      failingTests.push({ name, file: '', error: '' });
    }
  } else if (runner === 'go') {
    const failLines = output.match(/^--- FAIL: .+$/gm) ?? [];
    const passLines = output.match(/^--- PASS: .+$/gm) ?? [];
    failedTests = failLines.length;
    passedTests = passLines.length;
    totalTests  = passedTests + failedTests;
    for (const line of failLines) {
      const name = line.replace(/^--- FAIL: /, '').replace(/\s+\([\d.]+s\)$/, '');
      failingTests.push({ name, file: '', error: '' });
    }
  }

  return { totalTests, passedTests, failedTests, skippedTests, failingTests };
}

export async function runTests(workdir: string, filter?: string): Promise<RunTestsResult> {
  const detected = detectRunner(workdir);

  if (!detected) {
    return {
      passed: true,
      runner: null,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
      failingTests: [],
      rawOutput: 'No test runner detected.',
    };
  }

  let { command } = detected;
  const { runner } = detected;

  if (filter) {
    const parseRunner = detectParserFromCommand(command);
    command = applyFilter(command, parseRunner, filter);
  }

  const cmdResult = await runCommand(command, workdir, 120);
  const rawOutput = [cmdResult.stdout, cmdResult.stderr].filter(Boolean).join('\n');

  const parseRunner = detectParserFromCommand(command);
  const parsed = parseOutput(rawOutput, parseRunner);
  const passed = cmdResult.exitCode === 0;

  return { passed, runner, rawOutput, ...parsed };
}
