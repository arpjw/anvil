import { execa } from 'execa';
import { resolve } from 'path';

const BLOCKED_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\//,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /chmod\s+777\b/,        // chmod 777 <any-path>  e.g. chmod 777 ./
  /chmod\s+-R\s+777\b/,  // chmod -R 777 <any-path>  common recursive footgun
  /curl\s+.*\|\s*sh\b/,
  /wget\s+.*\|\s*sh\b/,
];

const MAX_COMBINED = 20_000;

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export async function runCommand(
  command: string,
  workdir: string,
  timeoutSeconds = 30,
): Promise<RunCommandResult> {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return {
        stdout: '',
        stderr: `Blocked: command matches disallowed pattern (${pattern.source})`,
        exitCode: 1,
        timedOut: false,
      };
    }
  }

  const absWorkdir = resolve(workdir);

  try {
    const proc = await execa('sh', ['-c', command], {
      cwd: absWorkdir,
      timeout: timeoutSeconds * 1000,
      reject: false,
    });

    let stdout = proc.stdout ?? '';
    let stderr = proc.stderr ?? '';

    const combined = stdout.length + stderr.length;
    if (combined > MAX_COMBINED) {
      const excess = combined - MAX_COMBINED;
      const note = `\n[...${excess} chars truncated]`;
      if (stdout.length > MAX_COMBINED) {
        stdout = stdout.slice(0, MAX_COMBINED - note.length) + note;
        stderr = '';
      } else {
        const budget = MAX_COMBINED - stdout.length - note.length;
        stderr = stderr.slice(0, Math.max(0, budget)) + note;
      }
    }

    return {
      stdout,
      stderr,
      exitCode: proc.exitCode ?? 0,
      timedOut: (proc as unknown as { timedOut?: boolean }).timedOut ?? false,
    };
  } catch (err) {
    const e = err as { timedOut?: boolean; message?: string };
    return {
      stdout: '',
      stderr: e.message ?? String(err),
      exitCode: 1,
      timedOut: e.timedOut ?? false,
    };
  }
}
