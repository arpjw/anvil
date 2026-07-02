import type { StripeClient } from './context';
import { HttpError } from './errors';

const STRIPE_API = 'https://api.stripe.com/v1';

function form(body: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) params.set(k, String(v));
  return params.toString();
}

async function stripeRequest(
  path: string,
  secret: string,
  body?: Record<string, string | number>,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? form(body) : undefined,
  });
  const parsed = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = parsed.error as { message?: string } | undefined;
    throw new HttpError(
      502,
      'stripe_error',
      err?.message ?? `stripe request failed (${res.status})`,
    );
  }
  return parsed;
}

async function verifyWebhookSignature(
  rawBody: string,
  header: string,
  secret: string,
  toleranceSeconds = 300,
): Promise<void> {
  const parts: Record<string, string> = {};
  for (const chunk of header.split(',')) {
    const [k, v] = chunk.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  const timestamp = parts['t'];
  const v1 = parts['v1'];
  if (!timestamp || !v1) throw new HttpError(401, 'bad_sig', 'missing t or v1');
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > toleranceSeconds) {
    throw new HttpError(401, 'stale_sig', 'timestamp outside tolerance');
  }
  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedPayload),
  );
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (!timingSafeEqualHex(expected, v1)) {
    throw new HttpError(401, 'bad_sig', 'signature mismatch');
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function createStripeClient(
  secretKey: string,
  webhookSecret: string,
): StripeClient {
  return {
    async createCustomer({ email, metadata }) {
      const body: Record<string, string> = {};
      if (email) body.email = email;
      if (metadata) {
        for (const [k, v] of Object.entries(metadata)) {
          body[`metadata[${k}]`] = v;
        }
      }
      const res = await stripeRequest('/customers', secretKey, body);
      return { id: String(res.id) };
    },
    async reportUsage({ subscriptionItemId, quantity, idempotencyKey }) {
      await stripeRequest(
        `/subscription_items/${subscriptionItemId}/usage_records`,
        secretKey,
        {
          quantity,
          timestamp: Math.floor(Date.now() / 1000),
          action: 'increment',
        },
        idempotencyKey,
      );
    },
    async createCheckoutSession({ customerId, priceId, successUrl, cancelUrl }) {
      const res = await stripeRequest('/checkout/sessions', secretKey, {
        customer: customerId,
        mode: 'subscription',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': 1,
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
      return { url: String(res.url) };
    },
    async createPortalSession({ customerId, returnUrl }) {
      const res = await stripeRequest('/billing_portal/sessions', secretKey, {
        customer: customerId,
        return_url: returnUrl,
      });
      return { url: String(res.url) };
    },
    async parseWebhook(rawBody, signature) {
      await verifyWebhookSignature(rawBody, signature, webhookSecret);
      const parsed = JSON.parse(rawBody) as {
        type: string;
        data: Record<string, unknown>;
      };
      return { type: parsed.type, data: parsed.data };
    },
  };
}
