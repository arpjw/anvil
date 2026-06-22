import { describe, expect, test } from 'bun:test';
import { pino } from 'pino';
import { DockerDriver } from '../vm/docker';
import { SessionPool } from '../vm/pool';
import { startEventRelay } from '../vm/event-relay';
import { provisionSession, ProvisionError } from '../vm/provisioner';
import { containerName } from '../vm/types';
import type { CommandResult, CommandRunner, PortWaiter, VMHandle } from '../vm/types';
import type { AppDeps, GithubClientFactory, VerifyTokenFn } from '../lib/context';
import { createMemoryRepository, FakeRedis } from './harness';
import { SSEBroadcaster } from '../events/broadcaster';
import type { Repo, Session, User } from '../db/schema';

const silentLogger = pino({ enabled: false });
void silentLogger;

type Call = { cmd: string; args: string[] };

function makeRunner(
  handlers: Array<(call: Call) => CommandResult | undefined>,
  recorder?: Call[],
): CommandRunner {
  return async (cmd, args) => {
    const call = { cmd, args };
    recorder?.push(call);
    for (const h of handlers) {
      const result = h(call);
      if (result) {
        if (result.exitCode !== 0) {
          const err = new Error(`command failed: ${cmd}`);
          (err as { result?: CommandResult }).result = result;
          throw err;
        }
        return result;
      }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
}

const ok = (stdout: string): CommandResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string): CommandResult => ({ stdout: '', stderr, exitCode: 1 });

function noopPortWaiter(): PortWaiter {
  return async () => {};
}

function makeAppDeps(repo: ReturnType<typeof createMemoryRepository>): AppDeps {
  const verifyToken: VerifyTokenFn = async () => ({ clerkId: 'noop' });
  const githubClient: GithubClientFactory = () => ({
    async reposGet() {
      return { defaultBranch: 'main' };
    },
    async reposListBranches() {
      return [];
    },
  });
  const redis = new FakeRedis();
  const broadcaster = new SSEBroadcaster(redis);
  return { repo, verifyToken, githubClient, redis, broadcaster };
}

describe('DockerDriver.startVM', () => {
  test('runs docker network create + docker run + docker inspect', async () => {
    const calls: Call[] = [];
    const runner = makeRunner(
      [
        (c) => {
          if (c.cmd === 'docker' && c.args[0] === 'network' && c.args[1] === 'inspect') {
            return fail('no such network');
          }
          if (c.cmd === 'docker' && c.args[0] === 'network' && c.args[1] === 'create') {
            return ok('netid\n');
          }
          if (c.cmd === 'docker' && c.args[0] === 'run') {
            return ok('container-abc\n');
          }
          if (c.cmd === 'docker' && c.args[0] === 'inspect') {
            return ok('54321\n');
          }
          return undefined;
        },
      ],
      calls,
    );

    const driver = new DockerDriver({
      runner,
      waitForPort: noopPortWaiter(),
    });

    const handle = await driver.startVM('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    expect(handle.containerId).toBe('container-abc');
    expect(handle.port).toBe(54321);
    expect(handle.ip).toBe('127.0.0.1');
    expect(handle.status).toBe('ready');

    const runCall = calls.find((c) => c.cmd === 'docker' && c.args[0] === 'run');
    expect(runCall).toBeDefined();
    expect(runCall!.args).toContain('-d');
    expect(runCall!.args).toContain('--name');
    expect(runCall!.args).toContain(containerName('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    expect(runCall!.args).toContain('-p');
    expect(runCall!.args).toContain('0:8080');
    expect(runCall!.args).toContain('--network');
    expect(runCall!.args).toContain('anvil-net');
    expect(runCall!.args.at(-1)).toBe('anvil-vm');
  });

  test('skips network create when network already exists', async () => {
    const calls: Call[] = [];
    const runner = makeRunner(
      [
        (c) => {
          if (c.cmd === 'docker' && c.args[0] === 'network' && c.args[1] === 'inspect') {
            return ok('exists\n');
          }
          if (c.cmd === 'docker' && c.args[0] === 'run') return ok('id\n');
          if (c.cmd === 'docker' && c.args[0] === 'inspect') return ok('40000\n');
          return undefined;
        },
      ],
      calls,
    );
    const driver = new DockerDriver({ runner, waitForPort: noopPortWaiter() });
    await driver.startVM('sess-001');
    expect(calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create')).toBeUndefined();
  });
});

describe('DockerDriver.stopVM', () => {
  test('calls docker stop and docker rm', async () => {
    const calls: Call[] = [];
    const runner = makeRunner(
      [
        (c) => {
          if (c.cmd === 'docker' && (c.args[0] === 'stop' || c.args[0] === 'rm')) {
            return ok('');
          }
          return undefined;
        },
      ],
      calls,
    );
    const driver = new DockerDriver({ runner, waitForPort: noopPortWaiter() });
    await driver.stopVM('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const stopCall = calls.find((c) => c.args[0] === 'stop');
    const rmCall = calls.find((c) => c.args[0] === 'rm');
    expect(stopCall).toBeDefined();
    expect(rmCall).toBeDefined();
    expect(stopCall!.args[1]).toBe(containerName('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    expect(rmCall!.args[1]).toBe(containerName('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
  });

  test('tolerates docker stop failure', async () => {
    const runner = makeRunner([
      (c) => {
        if (c.args[0] === 'stop') return fail('no such container');
        if (c.args[0] === 'rm') return fail('no such container');
        return undefined;
      },
    ]);
    const driver = new DockerDriver({ runner, waitForPort: noopPortWaiter() });
    await driver.stopVM('sess-xyz');
  });
});

describe('SessionPool', () => {
  function fakeWs(): { send: (d: string) => void; close: () => void; readyState: number; sent: string[] } {
    const sent: string[] = [];
    return {
      send: (d: string) => sent.push(d),
      close: () => {},
      readyState: 1,
      sent,
    };
  }

  test('add and get work', () => {
    const pool = new SessionPool();
    const ws = fakeWs();
    const handle: VMHandle = {
      sessionId: 's1',
      containerId: 'c1',
      ip: '1.2.3.4',
      port: 4242,
      status: 'ready',
    };
    pool.add('s1', ws, handle);
    expect(pool.get('s1')?.vmHandle).toEqual(handle);
    expect(pool.list()).toEqual(['s1']);
  });

  test('subscribe receives broadcast events', () => {
    const pool = new SessionPool();
    const ws = fakeWs();
    pool.add('s1', ws, {
      sessionId: 's1',
      containerId: 'c',
      ip: '127.0.0.1',
      port: 1,
      status: 'ready',
    });
    const received: unknown[] = [];
    const unsub = pool.subscribe('s1', (e) => received.push(e));
    pool.broadcast('s1', { type: 'hello', payload: { x: 1 } });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'hello', payload: { x: 1 } });
    unsub();
    pool.broadcast('s1', { type: 'second' });
    expect(received).toHaveLength(1);
  });

  test('remove clears listeners', () => {
    const pool = new SessionPool();
    const ws = fakeWs();
    pool.add('s1', ws, {
      sessionId: 's1',
      containerId: 'c',
      ip: '127.0.0.1',
      port: 1,
      status: 'ready',
    });
    pool.subscribe('s1', () => {});
    pool.remove('s1');
    expect(pool.get('s1')).toBeUndefined();
    expect(pool.list()).toEqual([]);
  });

  test('send serializes message to ws', () => {
    const pool = new SessionPool();
    const ws = fakeWs();
    pool.add('s1', ws, {
      sessionId: 's1',
      containerId: 'c',
      ip: '127.0.0.1',
      port: 1,
      status: 'ready',
    });
    pool.send('s1', { type: 'approve' });
    expect(ws.sent).toEqual(['{"type":"approve"}']);
  });
});

class FakeSocket {
  private handlers = new Map<string, Set<(arg: unknown) => void>>();
  addEventListener(event: string, handler: (arg: unknown) => void): void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
  }
  removeEventListener(event: string, handler: (arg: unknown) => void): void {
    this.handlers.get(event)?.delete(handler);
  }
  fire(event: string, arg: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h(arg);
  }
  emitMessage(msg: unknown): void {
    this.fire('message', { data: JSON.stringify(msg) });
  }
}

describe('event-relay', () => {
  test('done event updates session to complete and broadcasts session_complete', async () => {
    const repo = createMemoryRepository();
    const user = await repo.createUser({ clerkId: 'c1' });
    const repoRow = await repo.createRepo({
      userId: user.id,
      fullName: 'a/b',
      defaultBranch: 'main',
    });
    const session = await repo.createSession({
      userId: user.id,
      repoId: repoRow.id,
      status: 'running',
      request: 'do thing',
      model: 'claude-sonnet-4-6',
    });

    const deps = makeAppDeps(repo);
    const { sessionPool } = await import('../vm/pool');
    sessionPool.add(session.id, { send: () => {}, close: () => {}, readyState: 1 }, {
      sessionId: session.id,
      containerId: 'c',
      ip: '127.0.0.1',
      port: 1,
      status: 'ready',
    });
    const received: unknown[] = [];
    sessionPool.subscribe(session.id, (e) => received.push(e));

    const ws = new FakeSocket();
    startEventRelay(session.id, ws as unknown as Parameters<typeof startEventRelay>[1], deps);
    ws.emitMessage({ type: 'done', payload: { summary: 'all good' } });

    await new Promise((r) => setTimeout(r, 5));

    const reloaded = await repo.findSessionById(session.id);
    expect(reloaded?.status).toBe('complete');
    expect(reloaded?.completedAt).toBeInstanceOf(Date);
    expect(typeof reloaded?.durationSeconds).toBe('number');
    expect(received.find((e: unknown) => (e as { type: string }).type === 'session_complete')).toBeDefined();

    sessionPool.remove(session.id);
  });

  test('error event updates session to failed', async () => {
    const repo = createMemoryRepository();
    const user = await repo.createUser({ clerkId: 'c1' });
    const repoRow = await repo.createRepo({
      userId: user.id,
      fullName: 'a/b',
      defaultBranch: 'main',
    });
    const session = await repo.createSession({
      userId: user.id,
      repoId: repoRow.id,
      status: 'running',
      request: 'thing',
      model: 'claude-sonnet-4-6',
    });

    const deps = makeAppDeps(repo);
    const { sessionPool } = await import('../vm/pool');
    sessionPool.add(session.id, { send: () => {}, close: () => {}, readyState: 1 }, {
      sessionId: session.id,
      containerId: 'c',
      ip: '127.0.0.1',
      port: 1,
      status: 'ready',
    });

    const ws = new FakeSocket();
    startEventRelay(session.id, ws as unknown as Parameters<typeof startEventRelay>[1], deps);
    ws.emitMessage({ type: 'error', payload: { message: 'boom' } });

    await new Promise((r) => setTimeout(r, 5));
    const reloaded = await repo.findSessionById(session.id);
    expect(reloaded?.status).toBe('failed');
    sessionPool.remove(session.id);
  });

  test('event message persists to repo and broadcasts', async () => {
    const repo = createMemoryRepository();
    const user = await repo.createUser({ clerkId: 'c1' });
    const repoRow = await repo.createRepo({
      userId: user.id,
      fullName: 'a/b',
      defaultBranch: 'main',
    });
    const session = await repo.createSession({
      userId: user.id,
      repoId: repoRow.id,
      status: 'running',
      request: 'thing',
      model: 'claude-sonnet-4-6',
    });

    const deps = makeAppDeps(repo);
    const { sessionPool } = await import('../vm/pool');
    sessionPool.add(session.id, { send: () => {}, close: () => {}, readyState: 1 }, {
      sessionId: session.id,
      containerId: 'c',
      ip: '127.0.0.1',
      port: 1,
      status: 'ready',
    });

    const received: unknown[] = [];
    sessionPool.subscribe(session.id, (e) => received.push(e));

    const ws = new FakeSocket();
    startEventRelay(session.id, ws as unknown as Parameters<typeof startEventRelay>[1], deps);
    ws.emitMessage({ type: 'event', payload: { type: 'phase', payload: { phase: 'planning' } } });

    await new Promise((r) => setTimeout(r, 5));
    expect(repo._events.size).toBe(1);
    expect(received).toEqual([{ type: 'phase', payload: { phase: 'planning' } }]);
    sessionPool.remove(session.id);
  });
});

class ScriptedSocket {
  readyState = 0;
  private listeners = new Map<string, Set<(arg: unknown) => void>>();
  send = (_d: string): void => {};
  close = (): void => {};
  addEventListener(event: string, handler: (arg: unknown) => void): void {
    const s = this.listeners.get(event) ?? new Set();
    s.add(handler);
    this.listeners.set(event, s);
  }
  removeEventListener(event: string, handler: (arg: unknown) => void): void {
    this.listeners.get(event)?.delete(handler);
  }
  open(): void {
    this.readyState = 1;
    this.fire('open', undefined);
  }
  message(msg: unknown): void {
    this.fire('message', { data: JSON.stringify(msg) });
  }
  fire(event: string, arg: unknown): void {
    for (const h of this.listeners.get(event) ?? []) h(arg);
  }
}

describe('provisionSession', () => {
  test('timeout triggers ProvisionError and stops vm', async () => {
    const repo = createMemoryRepository();
    const user = await repo.createUser({ clerkId: 'c1' });
    const repoRow = await repo.createRepo({
      userId: user.id,
      fullName: 'a/b',
      defaultBranch: 'main',
    });
    const session = await repo.createSession({
      userId: user.id,
      repoId: repoRow.id,
      status: 'queued',
      request: 'r',
      model: 'claude-sonnet-4-6',
    });

    const stopped: string[] = [];
    const driver = {
      async startVM(sid: string): Promise<VMHandle> {
        return {
          sessionId: sid,
          containerId: 'c',
          ip: '127.0.0.1',
          port: 9001,
          status: 'ready',
        };
      },
      async stopVM(sid: string): Promise<void> {
        stopped.push(sid);
      },
      async getVMStatus(): Promise<VMHandle | null> {
        return null;
      },
    };

    // wsFactory returns a socket that never opens; with a 30ms timeout we should
    // get a ProvisionError, the driver's stopVM should be called, and the
    // session should be marked failed.
    const wsFactory = () => new ScriptedSocket() as unknown as ReturnType<typeof Object>;

    await expect(
      provisionSession(
        { session, repo: repoRow, user, apiKey: 'k' },
        {
          driver,
          // biome-ignore lint/suspicious/noExplicitAny: test factory
          wsFactory: wsFactory as any,
          appDeps: makeAppDeps(repo),
          timeoutMs: 30,
        },
      ),
    ).rejects.toBeInstanceOf(ProvisionError);

    expect(stopped).toContain(session.id);
    const reloaded = await repo.findSessionById(session.id);
    expect(reloaded?.status).toBe('failed');
  });

  test('happy path: opens ws, receives ready and setup_complete, marks provisioning', async () => {
    const repo = createMemoryRepository();
    const user = await repo.setUserGithub(
      (await repo.createUser({ clerkId: 'c1' })).id,
      { githubLogin: 'octo', githubAccessToken: 'gh-token' },
    );
    const repoRow = await repo.createRepo({
      userId: user.id,
      fullName: 'octo/cat',
      defaultBranch: 'main',
    });
    const session = await repo.createSession({
      userId: user.id,
      repoId: repoRow.id,
      status: 'queued',
      request: 'r',
      model: 'claude-sonnet-4-6',
    });

    const driver = {
      async startVM(sid: string): Promise<VMHandle> {
        return {
          sessionId: sid,
          containerId: 'c',
          ip: '10.0.0.1',
          port: 5000,
          status: 'ready',
        };
      },
      async stopVM(): Promise<void> {},
      async getVMStatus(): Promise<VMHandle | null> {
        return null;
      },
    };

    const scripted = new ScriptedSocket();
    const wsFactory = () => {
      setTimeout(() => scripted.open(), 1);
      setTimeout(
        () => scripted.message({ type: 'ready', payload: { version: '1.0.0' } }),
        5,
      );
      return scripted as unknown as ReturnType<typeof Object>;
    };
    const sent: string[] = [];
    scripted.send = (d: string) => {
      sent.push(d);
      const parsed = JSON.parse(d);
      if (parsed.type === 'setup') {
        setTimeout(
          () =>
            scripted.message({
              type: 'setup_complete',
              payload: { repoPath: '/workspace/repo' },
            }),
          5,
        );
      }
    };

    const result = await provisionSession(
      { session, repo: repoRow, user, apiKey: 'k' },
      {
        driver,
        // biome-ignore lint/suspicious/noExplicitAny: test factory
        wsFactory: wsFactory as any,
        appDeps: makeAppDeps(repo),
        timeoutMs: 5000,
      },
    );

    expect(result.vmHandle.ip).toBe('10.0.0.1');
    expect(result.vmHandle.port).toBe(5000);
    const reloaded = await repo.findSessionById(session.id);
    expect(reloaded?.status).toBe('provisioning');
    expect(reloaded?.vmIp).toBe('10.0.0.1');
    expect(reloaded?.vmPort).toBe(5000);

    const setupMessage = sent
      .map((s) => JSON.parse(s))
      .find((m) => m.type === 'setup');
    expect(setupMessage).toBeDefined();
    expect(setupMessage.payload.repoUrl).toBe('https://github.com/octo/cat.git');
    expect(setupMessage.payload.githubToken).toBe('gh-token');
  });
});
