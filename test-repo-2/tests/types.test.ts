import { describe, it, expect } from 'vitest';
import { createAccount } from '../db.js';
import type { AccountId } from '../types.js';

describe('AccountId', () => {
  it('is a string type', () => {
    const id: AccountId = 'u_123';
    expect(typeof id).toBe('string');
  });
});

describe('createAccount', () => {
  it('returns an Account with the correct shape', () => {
    const account = createAccount({
      email: 'test@example.com',
      name: 'Test User',
      role: 'customer',
    });

    expect(account.email).toBe('test@example.com');
    expect(account.name).toBe('Test User');
    expect(account.role).toBe('customer');
    expect(typeof account.id).toBe('string');
    expect(account.createdAt).toBeInstanceOf(Date);
  });

  it('assigns an id with the expected format', () => {
    const account = createAccount({ email: 'a@example.com', name: 'Alice', role: 'customer' });
    // id is generated as `u_${Date.now()}`
    expect(account.id).toMatch(/^u_\d+$/);
  });

  it('accepts admin role', () => {
    const admin = createAccount({ email: 'admin@example.com', name: 'Admin', role: 'admin' });
    expect(admin.role).toBe('admin');
  });
});
