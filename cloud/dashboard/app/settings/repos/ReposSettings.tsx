'use client';

import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { connectRepo, deleteRepo, getRepos } from '@/lib/api';
import type { Repo } from '@/lib/types';

export function ReposSettings() {
  const { mutate } = useSWRConfig();
  const { data: repos, isLoading } = useSWR<Repo[]>('/repos', getRepos);

  const [fullName, setFullName] = useState('');
  const [branch, setBranch] = useState('main');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConnect() {
    if (!fullName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await connectRepo(fullName.trim(), branch.trim() || 'main');
      setFullName('');
      setBranch('main');
      mutate('/repos');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onRemove(repo: Repo) {
    if (!confirm(`Remove ${repo.fullName}?`)) return;
    try {
      await deleteRepo(repo.id);
      mutate('/repos');
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-medium mb-8">Repositories</h1>

      <section
        className="rounded-md p-4 mb-8"
        style={{
          backgroundColor: '#111111',
          border: '1px solid #1f1f1f',
        }}
      >
        <h2
          className="text-[11px] uppercase tracking-wider font-mono mb-3"
          style={{ color: '#6b7280' }}
        >
          Connect a repository
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px_auto] gap-2">
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="owner/repo"
            className="px-3 py-2 text-sm rounded font-mono"
            style={{
              backgroundColor: '#0a0a0a',
              border: '1px solid #2a2a2a',
              color: '#f0f0f0',
            }}
          />
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="default branch"
            className="px-3 py-2 text-sm rounded font-mono"
            style={{
              backgroundColor: '#0a0a0a',
              border: '1px solid #2a2a2a',
              color: '#f0f0f0',
            }}
          />
          <button
            onClick={onConnect}
            disabled={!fullName.trim() || submitting}
            className="px-4 py-2 text-sm rounded font-medium disabled:opacity-40"
            style={{ backgroundColor: '#fbbf24', color: '#0a0a0a' }}
          >
            {submitting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        {error && (
          <p className="text-xs mt-2" style={{ color: '#f87171' }}>
            {error}
          </p>
        )}
      </section>

      <section>
        <h2
          className="text-[11px] uppercase tracking-wider font-mono mb-3"
          style={{ color: '#6b7280' }}
        >
          Connected
        </h2>
        {isLoading && (
          <p className="text-sm" style={{ color: '#6b7280' }}>
            Loading…
          </p>
        )}
        {repos && repos.length === 0 && (
          <p className="text-sm" style={{ color: '#6b7280' }}>
            No repositories connected yet.
          </p>
        )}
        {repos && repos.length > 0 && (
          <ul className="space-y-2">
            {repos.map((r) => (
              <li
                key={r.id}
                className="rounded-md p-3 flex items-center justify-between"
                style={{
                  backgroundColor: '#111111',
                  border: '1px solid #1f1f1f',
                }}
              >
                <div>
                  <div className="font-mono text-sm" style={{ color: '#f0f0f0' }}>
                    {r.fullName}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: '#6b7280' }}>
                    default: {r.defaultBranch}
                  </div>
                </div>
                <button
                  onClick={() => onRemove(r)}
                  className="text-xs px-2.5 py-1 rounded"
                  style={{
                    color: '#f87171',
                    border: '1px solid rgba(248, 113, 113, 0.3)',
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
