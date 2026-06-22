export type VMStatus = 'starting' | 'ready' | 'stopped' | 'error';

export interface VMHandle {
  sessionId: string;
  containerId: string;
  ip: string;
  port: number;
  status: VMStatus;
}

export interface VMDriver {
  startVM(sessionId: string): Promise<VMHandle>;
  stopVM(sessionId: string): Promise<void>;
  getVMStatus(sessionId: string): Promise<VMHandle | null>;
}

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CommandRunner = (
  cmd: string,
  args: string[],
) => Promise<CommandResult>;

export type PortWaiter = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<void>;

export function shortId(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 8);
}

export function containerName(sessionId: string): string {
  return `anvil-session-${shortId(sessionId)}`;
}
