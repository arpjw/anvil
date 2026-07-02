import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../lib/context';
import { HttpError } from '../lib/errors';

export interface RateLimitStore {
  incrWithExpire(key: string, ttlSeconds: number): Promise<number>;
}

export interface RateLimitOptions {
  windowSeconds: number;
  max: number;
  bucket: string;
  keyFn?: (c: import('hono').Context<AppEnv>) => string | Promise<string>;
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    const baseKey = opts.keyFn ? await opts.keyFn(c) : user?.id ?? 'anon';
    const store = c.get('deps').rateLimit;
    const redisKey = `rl:${opts.bucket}:${baseKey}`;
    const count = await store.incrWithExpire(redisKey, opts.windowSeconds);
    if (count > opts.max) {
      throw new HttpError(
        429,
        'rate_limited',
        `too many requests (${opts.max}/${opts.windowSeconds}s)`,
        {
          details: {
            bucket: opts.bucket,
            windowSeconds: opts.windowSeconds,
            max: opts.max,
          },
        },
      );
    }
    await next();
  };
}

export function makeRedisStore(redis: {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}): RateLimitStore {
  return {
    async incrWithExpire(key, ttl) {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, ttl);
      return count;
    },
  };
}

export function makeMemoryStore(): RateLimitStore {
  const store = new Map<string, { count: number; expires: number }>();
  return {
    async incrWithExpire(key, ttlSeconds) {
      const now = Date.now();
      const entry = store.get(key);
      if (!entry || entry.expires <= now) {
        store.set(key, { count: 1, expires: now + ttlSeconds * 1000 });
        return 1;
      }
      entry.count++;
      return entry.count;
    },
  };
}
