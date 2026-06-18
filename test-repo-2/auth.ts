// Authentication layer — session management, password hashing (fake), role checks

import type { Account, AccountId } from './types.js';
import { AppError } from './types.js';
import { getAccountById, getAccountByEmail } from './db.js';

// ---- Session store (in-memory) ----
const sessions = new Map<string, { userId: AccountId; expiresAt: Date }>();

function generateToken(): string {
  return `tok_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function hashPassword(plain: string): string {
  // Not real hashing — placeholder
  return `hashed:${plain}`;
}

// ---- Public auth API ----

export interface LoginResult {
  token: string;
  user: Account;
  expiresAt: Date;
}

export function login(email: string, password: string): LoginResult {
  const user = getAccountByEmail(email);
  if (!user) throw new AppError('Invalid credentials', 'AUTH_INVALID', 401);

  // In a real system, compare hashed passwords
  if (hashPassword(password) !== hashPassword(password)) {
    throw new AppError('Invalid credentials', 'AUTH_INVALID', 401);
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h
  sessions.set(token, { userId: user.id, expiresAt });
  return { token, user, expiresAt };
}

export function logout(token: string): void {
  sessions.delete(token);
}

export function getSessionUser(token: string): Account {
  const session = sessions.get(token);
  if (!session) throw new AppError('Not authenticated', 'AUTH_REQUIRED', 401);
  if (session.expiresAt < new Date()) {
    sessions.delete(token);
    throw new AppError('Session expired', 'AUTH_EXPIRED', 401);
  }
  return getAccountById(session.userId);
}

export function requireRole(token: string, role: Account['role']): Account {
  const user = getSessionUser(token);
  if (user.role !== role && user.role !== 'admin') {
    throw new AppError('Forbidden', 'AUTH_FORBIDDEN', 403);
  }
  return user;
}

export function isAdmin(token: string): boolean {
  try {
    const user = getSessionUser(token);
    return user.role === 'admin';
  } catch {
    return false;
  }
}
