import { execa } from 'execa';
import { resolve } from 'path';
import { uiStream } from '../ui/stream.js';

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

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  // Streaming buffers — flush on newline, emit a command_output event per line
  // so TUIs / cloud dashboards can render progress before the process exits.
  const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  const consume = (chunk: Buffer | string, which: 'stdout' | 'stderr'): void => {
    buffers[which] += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    while (true) {
      const idx = buffers[which].indexOf('\n');
      if (idx === -1) break;
      const line = buffers[which].slice(0, idx);
      buffers[which] = buffers[which].slice(idx + 1);
      if (which === 'stdout') stdoutLines.push(line);
      else stderrLines.push(line);
      uiStream.push({ type: 'command_output', command, line, stream: which });
    }
  };

  try {
    const subprocess = execa('sh', ['-c', command], {
      cwd: absWorkdir,
      timeout: timeoutSeconds * 1000,
      reject: false,
      buffer: false, // stream mode
    });

    subprocess.stdout?.on('data', (c) => consume(c, 'stdout'));
    subprocess.stderr?.on('data', (c) => consume(c, 'stderr'));

    const proc = await subprocess;

    // Flush any partial trailing lines that never saw a newline.
    if (buffers.stdout) {
      stdoutLines.push(buffers.stdout);
      uiStream.push({ type: 'command_output', command, line: buffers.stdout, stream: 'stdout' });
    }
    if (buffers.stderr) {
      stderrLines.push(buffers.stderr);
      uiStream.push({ type: 'command_output', command, line: buffers.stderr, stream: 'stderr' });
    }

    let stdout = stdoutLines.join('\n');
    let stderr = stderrLines.join('\n');

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
      stdout: stdoutLines.join('\n'),
      stderr: (stderrLines.length > 0 ? stderrLines.join('\n') + '\n' : '') + (e.message ?? String(err)),
      exitCode: 1,
      timedOut: e.timedOut ?? false,
    };
  }
}
