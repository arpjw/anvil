import { logger } from '../lib/logger';
import { getVMDriver } from './index';
import type { VMDriver, VMHandle } from './types';

export type PooledVMStatus = 'warming' | 'ready' | 'assigned' | 'stopped';

export interface PooledVM {
  id: string; // internal handle id, distinct from sessionId
  vmHandle: VMHandle | null; // populated once warmVM resolves
  status: PooledVMStatus;
  createdAt: Date;
  assignedSessionId?: string;
  errorMessage?: string;
}

export interface HealthCheck {
  (host: string, port: number, timeoutMs: number): Promise<void>;
}

export interface VMPoolManagerOptions {
  targetSize: number;
  driver?: VMDriver;
  maintainIntervalMs?: number;
  warmingTimeoutMs?: number;
  now?: () => Date;
  healthCheck?: HealthCheck;
}

const DEFAULT_MAINTAIN_MS = 30_000;
const DEFAULT_WARMING_TIMEOUT_MS = 10 * 60_000;

function newInternalId(): string {
  return `pool-${crypto.randomUUID().slice(0, 8)}`;
}

export class VMPoolManager {
  private readonly pool = new Map<string, PooledVM>();
  private targetSize: number;
  private driver: VMDriver | null;
  private readonly maintainIntervalMs: number;
  private readonly warmingTimeoutMs: number;
  private readonly nowFn: () => Date;
  private readonly healthCheck: HealthCheck | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(options: VMPoolManagerOptions) {
    this.targetSize = Math.max(0, Math.floor(options.targetSize));
    this.driver = options.driver ?? null;
    this.maintainIntervalMs = options.maintainIntervalMs ?? DEFAULT_MAINTAIN_MS;
    this.warmingTimeoutMs = options.warmingTimeoutMs ?? DEFAULT_WARMING_TIMEOUT_MS;
    this.nowFn = options.now ?? (() => new Date());
    this.healthCheck = options.healthCheck;
  }

  private resolveDriver(): VMDriver {
    if (this.driver) return this.driver;
    const drv = getVMDriver();
    this.driver = drv;
    return drv;
  }

  // Snapshot for observability / tests.
  snapshot(): PooledVM[] {
    return Array.from(this.pool.values()).map((vm) => ({ ...vm }));
  }

  size(status?: PooledVMStatus): number {
    if (!status) return this.pool.size;
    let n = 0;
    for (const vm of this.pool.values()) if (vm.status === status) n++;
    return n;
  }

  setTargetSize(n: number): void {
    this.targetSize = Math.max(0, Math.floor(n));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Kick off initial warm-ups; run maintain on interval.
    void this.warmToTarget();
    this.timer = setInterval(() => {
      this.maintain();
    }, this.maintainIntervalMs);
    // Node's setInterval keeps the process alive by default. If the process
    // is short-lived (tests), the caller must call stop().
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Destroy all VMs that aren't currently assigned.
    const toStop: PooledVM[] = [];
    for (const vm of this.pool.values()) {
      if (vm.status === 'assigned') continue;
      toStop.push(vm);
    }
    await Promise.all(toStop.map((vm) => this.destroy(vm)));
  }

  // Assigns a ready VM to `sessionId`. Falls back to on-demand creation via
  // driver.startVM(sessionId). After acquiring, warms a replacement.
  async acquire(sessionId: string): Promise<VMHandle> {
    let ready: PooledVM | null = null;
    for (const vm of this.pool.values()) {
      if (vm.status === 'ready' && vm.vmHandle) {
        ready = vm;
        break;
      }
    }

    if (ready && ready.vmHandle) {
      ready.status = 'assigned';
      ready.assignedSessionId = sessionId;
      // Fire background replacement; don't await.
      void this.warmToTarget();
      return { ...ready.vmHandle, sessionId };
    }

    // Fallback: on-demand.
    const driver = this.resolveDriver();
    const handle = await driver.startVM(sessionId);
    // Track the acquired VM in the pool with status=assigned so release() can
    // clean it up uniformly.
    this.pool.set(handle.containerId, {
      id: handle.containerId,
      vmHandle: handle,
      status: 'assigned',
      createdAt: this.nowFn(),
      assignedSessionId: sessionId,
    });
    // Still try to top up warm capacity for the next caller.
    void this.warmToTarget();
    return handle;
  }

  // Called when a session ends. Destroys the associated VM (no reuse for
  // security — each session gets a fresh box).
  async release(sessionId: string): Promise<void> {
    const assigned: PooledVM[] = [];
    for (const vm of this.pool.values()) {
      if (vm.assignedSessionId === sessionId) assigned.push(vm);
    }
    await Promise.all(assigned.map((vm) => this.destroy(vm)));
  }

  private async destroy(vm: PooledVM): Promise<void> {
    try {
      if (vm.vmHandle) {
        await this.resolveDriver().stopVM(vm.vmHandle.sessionId);
      }
    } catch (err) {
      logger.warn({ vmId: vm.id, err }, 'failed to stop VM during pool destroy');
    }
    vm.status = 'stopped';
    this.pool.delete(vm.id);
  }

  private async warmToTarget(): Promise<void> {
    const readyOrWarming =
      this.size('ready') + this.size('warming');
    const need = Math.max(0, this.targetSize - readyOrWarming);
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < need; i++) jobs.push(this.warmVM());
    await Promise.all(jobs);
  }

  // Test hook: awaits any in-flight warm-ups and tops the pool up to target.
  async waitForWarm(): Promise<void> {
    await this.warmToTarget();
  }

  private async warmVM(): Promise<void> {
    const entry: PooledVM = {
      id: newInternalId(),
      vmHandle: null,
      status: 'warming',
      createdAt: this.nowFn(),
    };
    this.pool.set(entry.id, entry);

    try {
      const driver = this.resolveDriver();
      const handle = await driver.startVM(entry.id);
      if (this.healthCheck) {
        await this.healthCheck(handle.ip, handle.port, 10_000);
      }
      // If the entry was released or the pool destroyed while warming, drop the VM.
      if (!this.pool.has(entry.id)) {
        await driver.stopVM(handle.sessionId).catch(() => {});
        return;
      }
      entry.vmHandle = handle;
      entry.status = 'ready';
    } catch (err) {
      logger.warn({ vmId: entry.id, err }, 'warm VM failed to boot');
      entry.status = 'stopped';
      entry.errorMessage = (err as Error).message;
      this.pool.delete(entry.id);
    }
  }

  // Public for tests; scheduled by start().
  maintain(): void {
    const cutoff = this.nowFn().getTime() - this.warmingTimeoutMs;
    const stuck: PooledVM[] = [];
    for (const vm of this.pool.values()) {
      if (vm.status === 'warming' && vm.createdAt.getTime() < cutoff) stuck.push(vm);
    }
    for (const vm of stuck) {
      logger.warn({ vmId: vm.id, ageMs: this.nowFn().getTime() - vm.createdAt.getTime() }, 'destroying stuck warming VM');
      void this.destroy(vm);
    }
    void this.warmToTarget();
  }
}

const envTargetSize = Number(process.env.VM_POOL_SIZE ?? 2);

export const vmPoolManager = new VMPoolManager({
  targetSize: Number.isFinite(envTargetSize) && envTargetSize >= 0 ? envTargetSize : 2,
});
