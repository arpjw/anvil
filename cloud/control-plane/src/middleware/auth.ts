import { createClerkClient, verifyToken as clerkVerifyToken } from '@clerk/backend';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppDeps, AppEnv, VerifyTokenFn } from '../lib/context';
import type { Repository } from '../db/repository';
import type { User } from '../db/schema';
import { HttpError } from '../lib/errors';

export function createClerkVerifyToken(secretKey: string): VerifyTokenFn {
  if (!secretKey) {
    throw new Error('CLERK_SECRET_KEY is required');
  }
  // createClerkClient is exercised so misconfiguration surfaces at boot
  createClerkClient({ secretKey });

  return async (token: string) => {
    const payload = await clerkVerifyToken(token, { secretKey });
    const clerkId = payload.sub;
    if (!clerkId) {
      throw new HttpError(401, 'unauthorized', 'token missing subject');
    }
    return { clerkId };
  };
}

export function extractBearer(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;
  const [scheme, value] = authHeader.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim();
}

export async function getCurrentUser(
  repo: Repository,
  clerkId: string,
): Promise<User> {
  const existing = await repo.findUserByClerkId(clerkId);
  if (existing) return existing;
  return repo.createUser({ clerkId });
}

export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next) => {
    const deps = c.get('deps') as AppDeps | undefined;
    if (!deps) {
      throw new HttpError(500, 'misconfigured', 'app deps missing');
    }

    const token = extractBearer(c.req.header('authorization'));
    if (!token) {
      throw new HttpError(401, 'unauthorized', 'missing bearer token');
    }

    let clerkId: string;
    try {
      const verified = await deps.verifyToken(token);
      clerkId = verified.clerkId;
    } catch (err) {
      throw new HttpError(401, 'unauthorized', 'invalid token', { cause: err });
    }

    const user = await getCurrentUser(deps.repo, clerkId);
    c.set('user', user);
    await next();
  };
}
