import type { CommandResult, CommandRunner, PortWaiter } from './types';

export const defaultRunner: CommandRunner = async (cmd, args) => {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const result: CommandResult = { stdout, stderr, exitCode };
  if (exitCode !== 0) {
    const err = new Error(
      `command failed (${cmd} ${args.join(' ')}): ${stderr || stdout}`,
    );
    (err as { result?: CommandResult }).result = result;
    throw err;
  }
  return result;
};

export const defaultPortWaiter: PortWaiter = async (host, port, timeoutMs) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const socket = await Bun.connect({
        hostname: host,
        port,
        socket: {
          open() {},
          data() {},
          error() {},
          close() {},
        },
      });
      socket.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`timed out waiting for ${host}:${port} after ${timeoutMs}ms`);
};
