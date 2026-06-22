import { describe, expect, test } from 'bun:test';
import { createHarness } from './harness';

describe('GET /health', () => {
  test('returns 200 with status ok, version, timestamp', async () => {
    const h = createHarness();
    const res = await h.app.fetch(new Request('http://test.local/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      version: string;
      timestamp: string;
    };
    expect(body.status).toBe('ok');
    expect(body.version).toBe('1.0.0');
    expect(typeof body.timestamp).toBe('string');
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
  });

  test('/health does not require auth', async () => {
    const h = createHarness();
    const res = await h.app.fetch(new Request('http://test.local/health'));
    expect(res.status).toBe(200);
  });
});
