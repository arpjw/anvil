import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  CommandRunner,
  PortWaiter,
  VMDriver,
  VMHandle,
} from './types';
import { shortId } from './types';
import { defaultPortWaiter, defaultRunner } from './runner';

export interface FirecrackerDriverOptions {
  runner?: CommandRunner;
  waitForPort?: PortWaiter;
  binary?: string;
  baseImagePath?: string;
  sessionsDir?: string;
  configTemplatePath?: string;
  readyTimeoutMs?: number;
  hostIpForSession?: (sessionId: string) => string;
  guestPort?: number;
}

interface FirecrackerProcess {
  pid: number;
  ip: string;
  port: number;
  workDir: string;
}

const activeProcs = new Map<string, FirecrackerProcess>();

export class FirecrackerDriver implements VMDriver {
  private readonly runner: CommandRunner;
  private readonly waitForPort: PortWaiter;
  private readonly binary: string;
  private readonly baseImagePath: string;
  private readonly sessionsDir: string;
  private readonly configTemplatePath: string;
  private readonly readyTimeoutMs: number;
  private readonly hostIpForSession: (sessionId: string) => string;
  private readonly guestPort: number;

  constructor(opts: FirecrackerDriverOptions = {}) {
    this.runner = opts.runner ?? defaultRunner;
    this.waitForPort = opts.waitForPort ?? defaultPortWaiter;
    this.binary =
      opts.binary ??
      process.env.FIRECRACKER_BINARY ??
      '/usr/local/bin/firecracker';
    this.baseImagePath =
      opts.baseImagePath ??
      process.env.VM_BASE_IMAGE_PATH ??
      '/var/lib/anvil/base.ext4';
    this.sessionsDir = opts.sessionsDir ?? '/var/lib/anvil/sessions';
    this.configTemplatePath =
      opts.configTemplatePath ??
      path.resolve(
        process.cwd(),
        '../vm/image/firecracker-config.template.json',
      );
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
    this.hostIpForSession =
      opts.hostIpForSession ?? ((sid) => `172.16.${parseInt(shortId(sid).slice(0, 2), 16) % 256}.2`);
    this.guestPort = opts.guestPort ?? 8080;
  }

  async startVM(sessionId: string): Promise<VMHandle> {
    const workDir = path.join(this.sessionsDir, sessionId);
    const rootfsPath = path.join(workDir, 'rootfs.ext4');
    const configPath = path.join(workDir, 'config.json');

    await fs.mkdir(workDir, { recursive: true });
    await fs.copyFile(this.baseImagePath, rootfsPath);

    const template = await fs.readFile(this.configTemplatePath, 'utf-8');
    const config = template
      .replaceAll('{{SESSION_ID}}', sessionId)
      .replaceAll('{{SESSION_ID_SHORT}}', shortId(sessionId));
    await fs.writeFile(configPath, config);

    const result = await this.runner(this.binary, [
      '--no-api',
      '--config-file',
      configPath,
    ]);
    const pid = Number(result.stdout.trim());
    if (!Number.isFinite(pid)) {
      throw new Error(`firecracker did not return a pid: ${result.stdout}`);
    }

    const ip = this.hostIpForSession(sessionId);
    await this.waitForPort(ip, this.guestPort, this.readyTimeoutMs);

    activeProcs.set(sessionId, { pid, ip, port: this.guestPort, workDir });

    return {
      sessionId,
      containerId: String(pid),
      ip,
      port: this.guestPort,
      status: 'ready',
    };
  }

  async stopVM(sessionId: string): Promise<void> {
    const proc = activeProcs.get(sessionId);
    if (!proc) return;
    try {
      await this.runner('kill', ['-TERM', String(proc.pid)]);
    } catch {
      // tolerate already-dead process
    }
    try {
      await fs.rm(proc.workDir, { recursive: true, force: true });
    } catch {
      // tolerate cleanup failures
    }
    activeProcs.delete(sessionId);
  }

  async getVMStatus(sessionId: string): Promise<VMHandle | null> {
    const proc = activeProcs.get(sessionId);
    if (!proc) return null;
    try {
      await this.runner('kill', ['-0', String(proc.pid)]);
      return {
        sessionId,
        containerId: String(proc.pid),
        ip: proc.ip,
        port: proc.port,
        status: 'ready',
      };
    } catch {
      activeProcs.delete(sessionId);
      return {
        sessionId,
        containerId: String(proc.pid),
        ip: proc.ip,
        port: proc.port,
        status: 'stopped',
      };
    }
  }
}
