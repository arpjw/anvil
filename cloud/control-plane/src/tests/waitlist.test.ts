import { describe, test, expect, beforeEach } from 'bun:test';
import { createHarness, readJson, type Harness } from './harness';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

describe('POST /waitlist', () => {
  test('accepts a new signup', async () => {
    const res = await h.app.fetch(
      new Request('http://test.local/api/v1/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.co', source: 'landing' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ added: boolean; alreadyOnList: boolean }>(res);
    expect(body.added).toBe(true);
    expect(body.alreadyOnList).toBe(false);
    const count = await h.repo.countWaitlistSignups();
    expect(count).toBe(1);
  });

  test('is idempotent for the same email', async () => {
    for (let i = 0; i < 2; i++) {
      await h.app.fetch(
        new Request('http://test.local/api/v1/waitlist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'x@y.co' }),
        }),
      );
    }
    const second = await h.app.fetch(
      new Request('http://test.local/api/v1/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'x@y.co' }),
      }),
    );
    const body = await readJson<{ added: boolean; alreadyOnList: boolean }>(second);
    expect(body.added).toBe(false);
    expect(body.alreadyOnList).toBe(true);
    const count = await h.repo.countWaitlistSignups();
    expect(count).toBe(1);
  });

  test('400 on invalid email', async () => {
    const res = await h.app.fetch(
      new Request('http://test.local/api/v1/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /waitlist/count', () => {
  test('reports 0 initially', async () => {
    const res = await h.app.fetch(
      new Request('http://test.local/api/v1/waitlist/count'),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ count: number }>(res);
    expect(body.count).toBe(0);
  });
});
