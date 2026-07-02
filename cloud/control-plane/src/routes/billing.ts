import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { AppEnv } from '../lib/context';

function startOfCurrentBillingPeriod(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const checkoutBody = z.object({
  plan: z.enum(['pro', 'team']),
});

export function billingRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth());

  r.get('/usage', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const since = startOfCurrentBillingPeriod();
    const records = await deps.repo.listUsageBySince(user.id, since);
    const minutes = records.reduce((n, r) => n + r.minutes, 0);
    return c.json({
      period: { start: since.toISOString(), end: null },
      minutes,
      records,
      planTier: user.planTier,
      freeMinutesPerMonth: deps.billing.freeMinutesPerMonth,
    });
  });

  r.post('/checkout', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    if (!deps.stripe) {
      throw new HttpError(503, 'billing_disabled', 'billing is not configured');
    }
    const parsed = checkoutBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'invalid checkout body', {
        details: parsed.error.flatten(),
      });
    }
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await deps.stripe.createCustomer({
        metadata: { userId: user.id, clerkId: user.clerkId },
      });
      customerId = customer.id;
      await deps.repo.setUserStripeCustomer(user.id, customerId);
    }
    const priceId = deps.billing.priceIds[parsed.data.plan];
    const session = await deps.stripe.createCheckoutSession({
      customerId,
      priceId,
      successUrl: deps.billing.successUrl,
      cancelUrl: deps.billing.cancelUrl,
    });
    return c.json({ url: session.url });
  });

  r.post('/portal', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    if (!deps.stripe) {
      throw new HttpError(503, 'billing_disabled', 'billing is not configured');
    }
    if (!user.stripeCustomerId) {
      throw new HttpError(400, 'no_customer', 'no stripe customer yet');
    }
    const session = await deps.stripe.createPortalSession({
      customerId: user.stripeCustomerId,
      returnUrl: deps.billing.portalReturnUrl,
    });
    return c.json({ url: session.url });
  });

  return r;
}

export function stripeWebhookRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/stripe', async (c) => {
    const deps = c.get('deps');
    if (!deps.stripe) {
      throw new HttpError(503, 'billing_disabled', 'billing is not configured');
    }
    const signature = c.req.header('stripe-signature');
    if (!signature) {
      throw new HttpError(400, 'missing_signature', 'missing stripe-signature');
    }
    const rawBody = await c.req.text();
    let event: { type: string; data: Record<string, unknown> };
    try {
      event = await deps.stripe.parseWebhook(rawBody, signature);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(401, 'bad_sig', (err as Error).message);
    }

    if (event.type === 'checkout.session.completed') {
      const obj = event.data.object as Record<string, unknown> | undefined;
      const customerId = String(obj?.customer ?? '');
      const subId = String(obj?.subscription ?? '');
      const metadata = (obj?.metadata as Record<string, string> | undefined) ?? {};
      const userId = metadata.userId;
      if (userId && subId) {
        await deps.repo.setUserSubscription(userId, {
          subscriptionId: subId,
          planTier: 'pro',
        });
      }
      logger.info({ customerId, subId, userId }, 'checkout completed');
    } else if (event.type === 'customer.subscription.deleted') {
      const obj = event.data.object as Record<string, unknown> | undefined;
      const metadata = (obj?.metadata as Record<string, string> | undefined) ?? {};
      const userId = metadata.userId;
      if (userId) {
        await deps.repo.setUserSubscription(userId, {
          subscriptionId: '',
          planTier: 'free',
        });
      }
    }

    return c.json({ ok: true });
  });

  return r;
}
