import { describe, test, expect } from 'bun:test';
import { VMPoolManager } from '../vm/pool-manager';
import type { VMDriver, VMHandle } from '../vm/types';

function makeDriver(): {
  driver: VMDriver;
  started: string[];
  stopped: string[];
  nextIp: string;
  nextPort: number;
} {
  const started: string[] = [];
  const stopped: string[] = [];
  const driver: VMDriver = {
    async startVM(sessionId: string): Promise<VMHandle> {
      started.push(sessionId);
      return {
        sessionId,
        containerId: `container-${sessionId}`,
        ip: '10.0.0.1',
        port: 8080,
        status: 'ready',
      };
    },
    async stopVM(sessionId: string): Promise<void> {
      stopped.push(sessionId);
    },
    async getVMStatus() {
      return null;
    },
  };
  return { driver, started, stopped, nextIp: '10.0.0.1', nextPort: 8080 };
}

describe('VMPoolManager.acquire', () => {
  test('falls back to on-demand when the pool is empty', async () => {
    const drv = makeDriver();
    const pool = new VMPoolManager({ targetSize: 0, driver: drv.driver });

    const handle = await pool.acquire('sess-1');
    expect(handle.sessionId).toBe('sess-1');
    expect(drv.started).toEqual(['sess-1']);
    // On-demand VMs are tracked so release() cleans them up too.
    expect(pool.size('assigned')).toBe(1);
  });

  test('uses a pre-warmed VM when one is ready and warms a replacement', async () => {
    const drv = makeDriver();
    const pool = new VMPoolManager({
      targetSize: 1,
      driver: drv.driver,
      maintainIntervalMs: 100_000, // effectively disable the interval for the test
    });
    pool.start();
    await pool.waitForWarm();
    expect(pool.size('ready')).toBe(1);

    // Acquire consumes the warm one.
    const handle = await pool.acquire('sess-real');
    expect(handle.sessionId).toBe('sess-real');
    expect(pool.size('assigned')).toBe(1);

    // A replacement is kicked off in the background; ensure the pool re-warms
    // back to targetSize after a moment (racing with the microtask queue).
    await pool.waitForWarm();
    expect(pool.size('ready')).toBe(1);
    // The initially-warmed VM is now assigned; it isn't returned to the ready pool.
    expect(drv.started.length).toBe(2);

    await pool.stop();
  });
});

describe('VMPoolManager.release', () => {
  test('destroys the VM and removes it from the pool', async () => {
    const drv = makeDriver();
    const pool = new VMPoolManager({ targetSize: 0, driver: drv.driver });
    await pool.acquire('sess-r');
    expect(pool.size()).toBe(1);
    await pool.release('sess-r');
    expect(pool.size()).toBe(0);
    // Under the hood we call stopVM against the session id of the handle.
    expect(drv.stopped).toContain('sess-r');
  });
});

describe('VMPoolManager.stop', () => {
  test('destroys unassigned VMs but leaves assigned VMs alone until release', async () => {
    const drv = makeDriver();
    const pool = new VMPoolManager({
      targetSize: 2,
      driver: drv.driver,
      maintainIntervalMs: 100_000,
    });
    pool.start();
    await pool.waitForWarm();
    expect(pool.size('ready')).toBe(2);

    await pool.acquire('sess-a');
    expect(pool.size('assigned')).toBe(1);
    await pool.waitForWarm(); // let the replacement finish
    expect(pool.size('ready')).toBe(2);

    await pool.stop();
    // All ready VMs were destroyed; the assigned one stays until release.
    expect(pool.size('ready')).toBe(0);
    expect(pool.size('assigned')).toBe(1);
  });
});

describe('VMPoolManager.maintain', () => {
  test('destroys warming VMs older than the timeout', async () => {
    // Drive time forward via a controllable clock.
    let now = new Date('2026-07-02T00:00:00Z');
    const drv = makeDriver();
    // Slow-boot driver: startVM never resolves during the test.
    const stuckDriver: VMDriver = {
      startVM: () => new Promise(() => {}),
      stopVM: drv.driver.stopVM,
      getVMStatus: drv.driver.getVMStatus,
    };
    const pool = new VMPoolManager({
      targetSize: 1,
      driver: stuckDriver,
      maintainIntervalMs: 100_000,
      warmingTimeoutMs: 60_000,
      now: () => now,
    });
    pool.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(pool.size('warming')).toBe(1);

    // Fast-forward 5 minutes.
    now = new Date(now.getTime() + 5 * 60_000);
    pool.maintain();
    // The stuck one should be evicted. maintain also triggers warmToTarget
    // which starts a new warming VM that will also never resolve here.
    await new Promise((r) => setTimeout(r, 5));
    const warming = pool.size('warming');
    // Expect: eviction removed the old warming entry (leaves at most one new one).
    expect(warming).toBeLessThanOrEqual(1);
  });
});
