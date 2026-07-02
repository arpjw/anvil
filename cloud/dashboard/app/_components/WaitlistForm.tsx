'use client';

import { useState } from 'react';
import { joinWaitlist } from '@/lib/api';

export function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'added' }
    | { kind: 'already' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || submitting) return;
    setSubmitting(true);
    setStatus({ kind: 'idle' });
    try {
      const res = await joinWaitlist(email.trim(), 'landing');
      setStatus(res.added ? { kind: 'added' } : { kind: 'already' });
      if (res.added) setEmail('');
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full">
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          required
          className="flex-1 px-3 py-2 text-sm rounded font-mono"
          style={{
            backgroundColor: '#0d0d0d',
            border: '1px solid #1f1f1f',
            color: '#f0f0f0',
          }}
        />
        <button
          type="submit"
          disabled={submitting || !email.trim()}
          className="px-4 py-2 text-sm rounded font-medium disabled:opacity-40"
          style={{
            backgroundColor: 'transparent',
            border: '1px solid #2a2a2a',
            color: '#f0f0f0',
          }}
        >
          {submitting ? 'Submitting…' : 'Join waitlist'}
        </button>
      </div>
      {status.kind === 'added' && (
        <p className="mt-2 text-xs" style={{ color: '#4ade80' }}>
          You&apos;re on the list. We&apos;ll be in touch.
        </p>
      )}
      {status.kind === 'already' && (
        <p className="mt-2 text-xs" style={{ color: '#6b7280' }}>
          You&apos;re already on the list.
        </p>
      )}
      {status.kind === 'error' && (
        <p className="mt-2 text-xs" style={{ color: '#f87171' }}>
          {status.message}
        </p>
      )}
    </form>
  );
}
