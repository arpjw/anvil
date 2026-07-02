import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { runCommand } from '../../tools/run_command.js';
import { runTests, type RunTestsResult } from '../../tools/run_tests.js';

export type ValidationPhase = 'typecheck' | 'lint' | 'test' | 'custom';

export interface ValidationError {
  phase: ValidationPhase;
  file: string;
  line: number;
  message: string;
  fixable: boolean;
}

export interface ValidateInput {
  workdir: string;
  files?: string[];
  sessionId?: string;
}

export interface ValidateOutput {
  passed: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export interface FixInput {
  workdir: string;
  errors: ValidationError[];
  sessionId?: string;
}

export interface FixOutput {
  fixable: ValidationError[];
  plan: string;
}

export interface ValidationEngineOptions {
  // Reserved for future flags (e.g. skip a phase). Kept for symmetry with the
  // originally-specified API surface.
  skipLint?: boolean;
  skipTests?: boolean;
  skipCustom?: boolean;
}

export class ValidationEngine {
  private running = false;
  private readonly options: ValidationEngineOptions;

  constructor(options: ValidationEngineOptions = {}) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async validate(input: ValidateInput): Promise<ValidateOutput> {
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];

    // 1. Type check
    const typeErrs = await runTypeCheck(input.workdir);
    errors.push(...typeErrs);

    // 2. Lint
    if (!this.options.skipLint) {
      const { errs, warns } = await runLint(input.workdir);
      errors.push(...errs);
      warnings.push(...warns);
    }

    // 3. Tests
    if (!this.options.skipTests) {
      const testErrs = await runTestsPhase(input.workdir);
      errors.push(...testErrs);
    }

    // 4. Custom rules from .anvil/rules.md
    if (!this.options.skipCustom) {
      const customErrs = await runCustomRules(input.workdir);
      errors.push(...customErrs);
    }

    return { passed: errors.length === 0, errors, warnings };
  }

  async planFix(input: FixInput): Promise<FixOutput> {
    const fixable = input.errors.filter(e => e.fixable);

    if (fixable.length === 0) {
      return {
        fixable: [],
        plan: 'No auto-fixable errors detected. Manual review required.',
      };
    }

    const byPhase = groupByPhase(fixable);
    const parts: string[] = ['Auto-fix plan:', ''];

    if (byPhase.typecheck.length > 0) {
      parts.push(`Type errors (${byPhase.typecheck.length}):`);
      parts.push(
        '  Read each affected file, locate the type mismatch, and adjust the',
        '  type or the value so tsc passes. Do not change semantics beyond',
        '  what the type error requires.',
      );
      for (const e of byPhase.typecheck.slice(0, 20)) {
        parts.push(`    - ${e.file}:${e.line} — ${e.message}`);
      }
      parts.push('');
    }

    if (byPhase.lint.length > 0) {
      parts.push(`Lint errors (${byPhase.lint.length}):`);
      parts.push(
        '  Apply the minimal fix per rule. Prefer the codebase style already',
        '  established over introducing new patterns.',
      );
      for (const e of byPhase.lint.slice(0, 20)) {
        parts.push(`    - ${e.file}:${e.line} — ${e.message}`);
      }
      parts.push('');
    }

    if (byPhase.test.length > 0) {
      parts.push(`Failing tests (${byPhase.test.length}):`);
      parts.push(
        '  Fix the underlying code so each listed test passes. Do NOT edit',
        '  the tests themselves unless the test is clearly wrong.',
      );
      for (const e of byPhase.test.slice(0, 20)) {
        parts.push(`    - ${e.file ? `${e.file}: ` : ''}${e.message}`);
      }
      parts.push('');
    }

    if (byPhase.custom.length > 0) {
      parts.push(`Custom rule failures (${byPhase.custom.length}):`);
      for (const e of byPhase.custom.slice(0, 20)) {
        parts.push(`    - ${e.message}`);
      }
      parts.push('');
    }

    return { fixable, plan: parts.join('\n').trimEnd() };
  }
}

// ── Phase implementations ────────────────────────────────────────────────────

async function runTypeCheck(workdir: string): Promise<ValidationError[]> {
  if (existsSync(join(workdir, 'tsconfig.json'))) {
    const result = await runCommand('npx tsc --noEmit', workdir, 60);
    if (result.exitCode === 0) return [];
    return parseTscErrors(result.stdout + '\n' + result.stderr);
  }
  if (existsSync(join(workdir, 'pyproject.toml'))) {
    const result = await runCommand('python -m mypy .', workdir, 60);
    if (result.exitCode === 0) return [];
    return parseMypyErrors(result.stdout + '\n' + result.stderr);
  }
  if (existsSync(join(workdir, 'Cargo.toml'))) {
    const result = await runCommand('cargo check', workdir, 60);
    if (result.exitCode === 0) return [];
    return parseCargoErrors(result.stdout + '\n' + result.stderr);
  }
  return [];
}

async function runLint(
  workdir: string,
): Promise<{ errs: ValidationError[]; warns: ValidationError[] }> {
  // eslint
  const eslintConfigs = [
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
    '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs',
  ];
  if (eslintConfigs.some(f => existsSync(join(workdir, f)))) {
    const result = await runCommand('npx eslint . --format compact', workdir, 60);
    if (result.exitCode === 0) return { errs: [], warns: [] };
    return parseEslintCompact(result.stdout + '\n' + result.stderr);
  }

  // pylint / ruff (best-effort detection)
  if (existsSync(join(workdir, '.pylintrc'))) {
    const result = await runCommand('python -m pylint .', workdir, 60);
    if (result.exitCode === 0) return { errs: [], warns: [] };
    return parsePylint(result.stdout + '\n' + result.stderr);
  }

  return { errs: [], warns: [] };
}

async function runTestsPhase(workdir: string): Promise<ValidationError[]> {
  const result: RunTestsResult = await runTests(workdir);
  if (!result.runner) return [];
  if (result.passed) return [];
  const out: ValidationError[] = [];
  for (const t of result.failingTests) {
    out.push({
      phase: 'test',
      file: t.file || '',
      line: 0,
      message: t.error ? `${t.name}: ${t.error}` : t.name,
      fixable: true,
    });
  }
  if (out.length === 0) {
    // No parsed failures but the runner reported failure — surface the raw tail.
    out.push({
      phase: 'test',
      file: '',
      line: 0,
      message: `${result.runner} reported failure; ${result.failedTests || 'unknown'} failing`,
      fixable: true,
    });
  }
  return out;
}

async function runCustomRules(workdir: string): Promise<ValidationError[]> {
  const rulesPath = join(workdir, '.anvil', 'rules.md');
  if (!existsSync(rulesPath)) return [];

  let content: string;
  try {
    content = readFileSync(rulesPath, 'utf-8');
  } catch {
    return [];
  }

  const cmds: string[] = [];
  for (const line of content.split('\n')) {
    const m = /^\s*(?:[-*]\s*)?VALIDATE:\s*(.+?)\s*$/.exec(line);
    if (m) cmds.push(m[1]);
  }
  if (cmds.length === 0) return [];

  const out: ValidationError[] = [];
  for (const cmd of cmds) {
    const result = await runCommand(cmd, workdir, 60);
    if (result.exitCode === 0) continue;
    const tail = (result.stdout + '\n' + result.stderr).trim().split('\n').slice(-5).join('\n');
    out.push({
      phase: 'custom',
      file: '',
      line: 0,
      message: `\`${cmd}\` failed (exit ${result.exitCode}): ${tail.slice(0, 500)}`,
      fixable: false, // custom rules are user-defined; punt on auto-fix classification
    });
  }
  return out;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

// TS7016 style errors like "src/foo.ts(12,5): error TS1234: Some message"
function parseTscErrors(output: string): ValidationError[] {
  const rgx = /^(.+?)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)$/;
  const out: ValidationError[] = [];
  for (const line of output.split('\n')) {
    const m = rgx.exec(line.trim());
    if (!m) continue;
    out.push({
      phase: 'typecheck',
      file: m[1],
      line: Number(m[2]),
      message: `${m[3]}: ${m[4]}`,
      fixable: true,
    });
    if (out.length >= 50) break;
  }
  return out;
}

// mypy: "path.py:LINE: error: message"
function parseMypyErrors(output: string): ValidationError[] {
  const rgx = /^(.+?):(\d+):\s*error:\s*(.+)$/;
  const out: ValidationError[] = [];
  for (const line of output.split('\n')) {
    const m = rgx.exec(line.trim());
    if (!m) continue;
    out.push({
      phase: 'typecheck',
      file: m[1],
      line: Number(m[2]),
      message: m[3],
      fixable: true,
    });
    if (out.length >= 50) break;
  }
  return out;
}

// cargo check errors are multi-line; take the first "error[E....]: message" line
function parseCargoErrors(output: string): ValidationError[] {
  const rgx = /^error(?:\[[A-Z0-9]+\])?:\s*(.+)$/;
  const out: ValidationError[] = [];
  for (const line of output.split('\n')) {
    const m = rgx.exec(line.trim());
    if (!m) continue;
    out.push({
      phase: 'typecheck',
      file: '',
      line: 0,
      message: m[1],
      fixable: true,
    });
    if (out.length >= 50) break;
  }
  return out;
}

// eslint compact format:
//   file.ts: line 42, col 5, Error - message (rule)
//   file.ts: line 12, col 3, Warning - message (rule)
function parseEslintCompact(
  output: string,
): { errs: ValidationError[]; warns: ValidationError[] } {
  const rgx = /^(.+?):\s*line\s+(\d+),\s*col\s+\d+,\s*(Error|Warning)\s*-\s*(.+?)(?:\s*\(([^)]+)\))?$/;
  const errs: ValidationError[] = [];
  const warns: ValidationError[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    const m = rgx.exec(line);
    if (!m) continue;
    const rec: ValidationError = {
      phase: 'lint',
      file: m[1],
      line: Number(m[2]),
      message: m[5] ? `${m[4]} (${m[5]})` : m[4],
      fixable: true,
    };
    if (m[3] === 'Error') errs.push(rec);
    else warns.push(rec);
    if (errs.length + warns.length >= 100) break;
  }
  return { errs, warns };
}

// pylint default: "path.py:LINE:COL: TYPE message (rule)"
function parsePylint(
  output: string,
): { errs: ValidationError[]; warns: ValidationError[] } {
  const rgx = /^(.+?):(\d+):\d+:\s*([EWCFR])\d+:\s*(.+)$/;
  const errs: ValidationError[] = [];
  const warns: ValidationError[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    const m = rgx.exec(line);
    if (!m) continue;
    const rec: ValidationError = {
      phase: 'lint',
      file: m[1],
      line: Number(m[2]),
      message: m[4],
      fixable: true,
    };
    if (m[3] === 'E' || m[3] === 'F') errs.push(rec);
    else warns.push(rec);
    if (errs.length + warns.length >= 100) break;
  }
  return { errs, warns };
}

function groupByPhase(errors: ValidationError[]): Record<ValidationPhase, ValidationError[]> {
  const out: Record<ValidationPhase, ValidationError[]> = {
    typecheck: [], lint: [], test: [], custom: [],
  };
  for (const e of errors) out[e.phase].push(e);
  return out;
}

// ── Singleton ────────────────────────────────────────────────────────────────

export const validationEngine = new ValidationEngine();
