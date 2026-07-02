import { describe, test, expect, beforeEach } from 'bun:test';
import { createHarness, readJson, type Harness } from './harness';

let h: Harness;

async function seedUser(): Promise<{ token: string; userId: string }> {
  const token = 'tok-billing';
  h.tokens.set(token, { clerkId: 'clerk-b' });
  const user = await h.repo.createUser({ clerkId: 'clerk-b' });
  return { token, userId: user.id };
}

describe('GET /billing/usage', () => {
  beforeEach(() => {
    h = createHarness();
  });

  test('returns 0 minutes and free tier for a new user', async () => {
    const { token } = await seedUser();
    const res = await h.authedFetch('/api/v1/billing/usage', { token });
    expect(res.status).toBe(200);
    const body = await readJson<{ minutes: number; planTier: string }>(res);
    expect(body.minutes).toBe(0);
    expect(body.planTier).toBe('free');
  });

  test('sums usage records for the current period', async () => {
    const { token, userId } = await seedUser();
    // Create dummy session records — usage records need a session_id
    const repo = await h.repo.createRepo({
      userId,
      fullName: 'o/r',
      defaultBranch: 'main',
    });
    const s1 = await h.repo.createSession({
      userId,
      repoId: repo.id,
      status: 'complete',
      branch: 'main',
      request: 'a',
      model: 'm',
    });
    const s2 = await h.repo.createSession({
      userId,
      repoId: repo.id,
      status: 'complete',
      branch: 'main',
      request: 'b',
      model: 'm',
    });
    await h.repo.createUsageRecord({ userId, sessionId: s1.id, minutes: 3 });
    await h.repo.createUsageRecord({ userId, sessionId: s2.id, minutes: 5 });

    const res = await h.authedFetch('/api/v1/billing/usage', { token });
    expect(res.status).toBe(200);
    const body = await readJson<{ minutes: number; records: unknown[] }>(res);
    expect(body.minutes).toBe(8);
    expect(body.records.length).toBe(2);
  });
});

describe('POST /billing/checkout', () => {
  beforeEach(() => {
    h = createHarness();
  });

  test('creates a customer if missing, then returns a checkout url', async () => {
    const { token, userId } = await seedUser();
    const res = await h.authedFetch('/api/v1/billing/checkout', {
      method: 'POST',
      token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'pro' }),
    });
    expect(res.status).toBe(200);
    const body = await readJson<{ url: string }>(res);
    expect(body.url).toBe('https://stripe.example/checkout');
    expect(h.stripe.createdCustomers.length).toBe(1);
    const first = h.stripe.createdCustomers[0];
    if (!first) throw new Error('missing customer');
    expect(first.metadata?.userId).toBe(userId);
    expect(h.stripe.checkoutSessions.length).toBe(1);
    const co = h.stripe.checkoutSessions[0];
    if (!co) throw new Error('missing checkout session');
    expect(co.priceId).toBe('price_pro');
  });

  test('reuses an existing stripe customer if present', async () => {
    const { token, userId } = await seedUser();
    await h.repo.setUserStripeCustomer(userId, 'cus_existing');
    const res = await h.authedFetch('/api/v1/billing/checkout', {
      method: 'POST',
      token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'team' }),
    });
    expect(res.status).toBe(200);
    expect(h.stripe.createdCustomers.length).toBe(0);
    const co = h.stripe.checkoutSessions[0];
    if (!co) throw new Error('missing checkout session');
    expect(co.customerId).toBe('cus_existing');
    expect(co.priceId).toBe('price_team');
  });
});

describe('Stripe webhook', () => {
  beforeEach(() => {
    h = createHarness();
  });

  test('checkout.session.completed upgrades user to pro', async () => {
    const { userId } = await seedUser();
    const payload = {
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { userId },
        },
      },
    };
    const res = await h.app.fetch(
      new Request('http://test.local/webhooks/stripe', {
        method: 'POST',
        headers: {
          'stripe-signature': 'ignored-by-stub',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(res.status).toBe(200);
    const stored = await h.repo.findUserById(userId);
    expect(stored?.planTier).toBe('pro');
    expect(stored?.stripeSubscriptionId).toBe('sub_1');
  });

  test('customer.subscription.deleted downgrades to free', async () => {
    const { userId } = await seedUser();
    await h.repo.setUserSubscription(userId, {
      subscriptionId: 'sub_1',
      planTier: 'pro',
    });
    const payload = {
      type: 'customer.subscription.deleted',
      data: {
        object: {
          metadata: { userId },
        },
      },
    };
    const res = await h.app.fetch(
      new Request('http://test.local/webhooks/stripe', {
        method: 'POST',
        headers: {
          'stripe-signature': 'ignored-by-stub',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(res.status).toBe(200);
    const stored = await h.repo.findUserById(userId);
    expect(stored?.planTier).toBe('free');
  });
});
