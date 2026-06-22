import { describe, expect, test } from 'bun:test';
import { SSEBroadcaster } from '../events/broadcaster';
import { FakeRedis } from './harness';

describe('SSEBroadcaster', () => {
  test('registerClient adds client and subscribes to redis channel', async () => {
    const redis = new FakeRedis();
    const bcast = new SSEBroadcaster(redis);
    const received: string[] = [];
    bcast.registerClient('s1', 'c1', (frame) => received.push(frame));
    // subscribe is async; flush microtasks
    await Promise.resolve();
    expect(redis.subscribed.has('anvil:session:s1')).toBe(true);
    expect(bcast.countClients('s1')).toBe(1);
  });

  test('broadcastToSession sends SSE-formatted data to all clients', async () => {
    const redis = new FakeRedis();
    const bcast = new SSEBroadcaster(redis);
    const a: string[] = [];
    const b: string[] = [];
    bcast.registerClient('s1', 'c1', (f) => a.push(f));
    bcast.registerClient('s1', 'c2', (f) => b.push(f));
    bcast.broadcastToSession('s1', '{"type":"x"}');
    expect(a).toEqual(['data: {"type":"x"}\n\n']);
    expect(b).toEqual(['data: {"type":"x"}\n\n']);
  });

  test('redis message triggers broadcast to clients', async () => {
    const redis = new FakeRedis();
    const bcast = new SSEBroadcaster(redis);
    const received: string[] = [];
    bcast.registerClient('s1', 'c1', (f) => received.push(f));
    await redis.publish('anvil:session:s1', '{"type":"plan_ready"}');
    expect(received).toEqual(['data: {"type":"plan_ready"}\n\n']);
  });

  test('unregisterClient removes client and unsubscribes when empty', async () => {
    const redis = new FakeRedis();
    const bcast = new SSEBroadcaster(redis);
    const unregister = bcast.registerClient('s1', 'c1', () => {});
    await Promise.resolve();
    expect(redis.subscribed.has('anvil:session:s1')).toBe(true);
    unregister();
    await Promise.resolve();
    expect(bcast.countClients('s1')).toBe(0);
    expect(redis.subscribed.has('anvil:session:s1')).toBe(false);
  });

  test('disconnected client is removed on failed send', async () => {
    const redis = new FakeRedis();
    const bcast = new SSEBroadcaster(redis);
    let allow = true;
    bcast.registerClient('s1', 'c1', () => {
      if (!allow) throw new Error('disconnected');
    });
    const ok: string[] = [];
    bcast.registerClient('s1', 'c2', (f) => ok.push(f));
    expect(bcast.countClients('s1')).toBe(2);
    allow = false;
    bcast.broadcastToSession('s1', '{"t":1}');
    expect(bcast.countClients('s1')).toBe(1);
    expect(ok).toEqual(['data: {"t":1}\n\n']);
  });

  test('heartbeat sends to all connected clients', async () => {
    const redis = new FakeRedis();
    const bcast = new SSEBroadcaster(redis);
    const a: string[] = [];
    const b: string[] = [];
    bcast.registerClient('s1', 'c1', (f) => a.push(f));
    bcast.registerClient('s2', 'c2', (f) => b.push(f));
    bcast.sendHeartbeat();
    expect(a).toEqual([': heartbeat\n\n']);
    expect(b).toEqual([': heartbeat\n\n']);
  });

  test('heartbeat drops dead clients', () => {
    const redis = new FakeRedis();
    const bcast = new SSEBroadcaster(redis);
    bcast.registerClient('s1', 'c1', () => {
      throw new Error('gone');
    });
    bcast.sendHeartbeat();
    expect(bcast.countClients('s1')).toBe(0);
  });

  test('multiple subscribers receive the same message', async () => {
    const redis = new FakeRedis();
    const bcast = new SSEBroadcaster(redis);
    const a: string[] = [];
    const b: string[] = [];
    const c: string[] = [];
    bcast.registerClient('s1', 'c1', (f) => a.push(f));
    bcast.registerClient('s1', 'c2', (f) => b.push(f));
    bcast.registerClient('s1', 'c3', (f) => c.push(f));
    await redis.publish('anvil:session:s1', '{"type":"tool_call"}');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(1);
  });
});
