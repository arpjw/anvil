import { execa } from 'execa';
import { randomUUID } from 'node:crypto';
import { commandDirectory, executionContext } from '../execution/context.js';
import { StringDecoder } from 'string_decoder';
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

  const context = executionContext();
  let absWorkdir: string;
  try {
    absWorkdir = commandDirectory(workdir);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 300) throw new Error('Command timeout must be between 0 and 300 seconds.');
    if (context) {
      uiStream.throwIfCancelled();
      if (context.commands === 'deny' || (context.commands === 'ask' && !(await uiStream.waitForCommandApproval(randomUUID(), command, absWorkdir)))) {
        return { stdout: '', stderr: 'Command not approved. Headless runs require --allow-commands to execute shell commands and project checks.', exitCode: 126, timedOut: false };
      }
      uiStream.throwIfCancelled();
    }
  } catch (err) { return { stdout: '', stderr: (err as Error).message, exitCode: 126, timedOut: false }; }

  const captured: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  let retained = 0;
  let truncated = false;
  let streamed = 0;
  const emit = (line: string, which: 'stdout' | 'stderr'): void => {
    if (streamed >= 64_000) return;
    const bounded = line.slice(0, 64_000 - streamed);
    streamed += bounded.length + 1;
    uiStream.push({ type: 'command_output', command, line: bounded, stream: which });
  };
  const consume = (chunk: Buffer | string, which: 'stdout' | 'stderr'): void => {
    const text = typeof chunk === 'string' ? chunk : decoders[which].write(chunk);
    const keep = text.slice(0, Math.max(0, MAX_COMBINED - retained));
    captured[which] += keep;
    retained += keep.length;
    truncated ||= keep.length < text.length;
    if (streamed >= 64_000) return;
    buffers[which] += text.slice(0, 64_000 - streamed);
    while (buffers[which].length) {
      const newline = buffers[which].indexOf('\n');
      if (newline < 0 && buffers[which].length < 2048) break;
      const end = newline >= 0 ? Math.min(newline, 2048) : 2048;
      emit(buffers[which].slice(0, end), which);
      buffers[which] = buffers[which].slice(end + (newline === end ? 1 : 0));
    }
  };
  const output = (): { stdout: string; stderr: string } => {
    for (const which of ['stdout', 'stderr'] as const) {
      consume(decoders[which].end(), which);
      if (buffers[which]) emit(buffers[which], which);
      buffers[which] = '';
    }
    if (truncated) captured.stderr += '\n[output truncated]';
    return captured;
  };

  let childPid: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const stop = () => {
    if (childPid && process.platform !== 'win32') {
      try { process.kill(-childPid, 'SIGKILL'); } catch { /* group already exited */ }
    }
  };
  const signal = context ? uiStream.signal : undefined;
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const env = context ? Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT']
      .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])) : process.env;
    const subprocess = execa('sh', ['-c', command], {
      cwd: absWorkdir,
      timeout: timeoutSeconds * 1000,
      cancelSignal: signal,
      forceKillAfterDelay: 500,
      detached: process.platform !== 'win32',
      extendEnv: false,
      env,
      reject: false,
      buffer: false, // stream mode
    });

    childPid = subprocess.pid;
    timer = setTimeout(() => { timedOut = true; stop(); }, timeoutSeconds * 1000);
    if (signal?.aborted) stop();
    subprocess.stdout?.on('data', (c) => consume(c, 'stdout'));
    subprocess.stderr?.on('data', (c) => consume(c, 'stderr'));

    const proc = await subprocess;
    timedOut ||= proc.timedOut ?? false;

    return {
      ...output(),
      exitCode: signal?.aborted ? 130 : timedOut ? 124 : proc.exitCode ?? (proc.failed ? 1 : 0),
      timedOut: timedOut || (proc.timedOut ?? false),
    };
  } catch (err) {
    const e = err as { timedOut?: boolean; message?: string };
    timedOut ||= e.timedOut ?? false;
    return {
      ...output(),
      stderr: (captured.stderr + '\n' + (e.message ?? String(err))).slice(-MAX_COMBINED),
      exitCode: 1,
      timedOut: timedOut || (e.timedOut ?? false),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    if (context || timedOut || signal?.aborted) stop();
  }
}
