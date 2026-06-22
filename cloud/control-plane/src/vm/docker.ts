import {
  containerName,
  type CommandRunner,
  type PortWaiter,
  type VMDriver,
  type VMHandle,
} from './types';
import { defaultPortWaiter, defaultRunner } from './runner';

export interface DockerDriverOptions {
  runner?: CommandRunner;
  waitForPort?: PortWaiter;
  image?: string;
  network?: string;
  readyTimeoutMs?: number;
}

export class DockerDriver implements VMDriver {
  private readonly runner: CommandRunner;
  private readonly waitForPort: PortWaiter;
  private readonly image: string;
  private readonly network: string;
  private readonly readyTimeoutMs: number;

  constructor(opts: DockerDriverOptions = {}) {
    this.runner = opts.runner ?? defaultRunner;
    this.waitForPort = opts.waitForPort ?? defaultPortWaiter;
    this.image = opts.image ?? 'anvil-vm';
    this.network = opts.network ?? 'anvil-net';
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  }

  private async ensureNetwork(): Promise<void> {
    try {
      await this.runner('docker', ['network', 'inspect', this.network]);
    } catch {
      await this.runner('docker', ['network', 'create', this.network]);
    }
  }

  async startVM(sessionId: string): Promise<VMHandle> {
    await this.ensureNetwork();

    const name = containerName(sessionId);
    const runResult = await this.runner('docker', [
      'run',
      '-d',
      '--name',
      name,
      '-p',
      '0:8080',
      '--network',
      this.network,
      this.image,
    ]);
    const containerId = runResult.stdout.trim();

    const inspectResult = await this.runner('docker', [
      'inspect',
      '--format',
      '{{ (index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort }}',
      containerId,
    ]);
    const hostPort = Number(inspectResult.stdout.trim());
    if (!Number.isFinite(hostPort) || hostPort <= 0) {
      throw new Error(
        `failed to read host port for container ${containerId}: ${inspectResult.stdout}`,
      );
    }

    await this.waitForPort('127.0.0.1', hostPort, this.readyTimeoutMs);

    return {
      sessionId,
      containerId,
      ip: '127.0.0.1',
      port: hostPort,
      status: 'ready',
    };
  }

  async stopVM(sessionId: string): Promise<void> {
    const name = containerName(sessionId);
    try {
      await this.runner('docker', ['stop', name]);
    } catch {
      // tolerate already-stopped containers
    }
    try {
      await this.runner('docker', ['rm', name]);
    } catch {
      // tolerate already-removed containers
    }
  }

  async getVMStatus(sessionId: string): Promise<VMHandle | null> {
    const name = containerName(sessionId);
    try {
      const result = await this.runner('docker', [
        'inspect',
        '--format',
        '{{.Id}}|{{.State.Status}}|{{ (index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort }}',
        name,
      ]);
      const parts = result.stdout.trim().split('|');
      const id = parts[0] ?? '';
      const state = parts[1] ?? '';
      const portStr = parts[2] ?? '';
      const port = Number(portStr);
      const status: VMHandle['status'] =
        state === 'running'
          ? 'ready'
          : state === 'created'
            ? 'starting'
            : state === 'exited' || state === 'dead' || state === 'removing'
              ? 'stopped'
              : 'error';
      return {
        sessionId,
        containerId: id,
        ip: '127.0.0.1',
        port: Number.isFinite(port) ? port : 0,
        status,
      };
    } catch {
      return null;
    }
  }
}
