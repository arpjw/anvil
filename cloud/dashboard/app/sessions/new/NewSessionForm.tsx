'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import useSWR, { useSWRConfig } from 'swr';
import {
  connectRepo,
  createSession,
  getRepoBranches,
  getRepos,
} from '@/lib/api';
import { MODELS, type ModelId, type Repo } from '@/lib/types';

export function NewSessionForm() {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const { data: repos } = useSWR<Repo[]>('/repos', getRepos);

  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [request, setRequest] = useState('');
  const [model, setModel] = useState<ModelId>('claude-sonnet-4-6');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRepo = useMemo(
    () => repos?.find((r) => r.id === selectedRepoId) ?? null,
    [repos, selectedRepoId],
  );

  useEffect(() => {
    if (selectedRepo && !selectedBranch) {
      setSelectedBranch(selectedRepo.defaultBranch);
    }
  }, [selectedRepo, selectedBranch]);

  async function onSubmit() {
    if (!selectedRepoId || !selectedBranch || !request.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await createSession({
        repoId: selectedRepoId,
        branch: selectedBranch,
        request: request.trim(),
        model,
      });
      router.push(`/sessions/${session.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10 space-y-10">
      <h1 className="text-2xl font-medium">New session</h1>

      <StepRepo
        repos={repos}
        selectedRepoId={selectedRepoId}
        onSelect={(id) => {
          setSelectedRepoId(id);
          setSelectedBranch(null);
        }}
        onRepoConnected={() => mutate('/repos')}
      />

      {selectedRepoId && (
        <StepBranch
          repoId={selectedRepoId}
          defaultBranch={selectedRepo?.defaultBranch ?? 'main'}
          selectedBranch={selectedBranch}
          onSelect={setSelectedBranch}
        />
      )}

      {selectedRepoId && selectedBranch && (
        <StepRequest
          request={request}
          onRequestChange={setRequest}
          model={model}
          onModelChange={setModel}
        />
      )}

      {error && (
        <div
          className="rounded-md p-3 text-sm"
          style={{
            backgroundColor: '#111111',
            border: '1px solid rgba(248, 113, 113, 0.4)',
            color: '#f87171',
          }}
        >
          {error}
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={onSubmit}
          disabled={
            !selectedRepoId || !selectedBranch || !request.trim() || submitting
          }
          className="px-4 py-2 text-sm rounded-md font-medium transition-opacity hover:opacity-90 disabled:opacity-40"
          style={{
            backgroundColor: '#fbbf24',
            color: '#0a0a0a',
          }}
        >
          {submitting ? 'Starting…' : 'Start session'}
        </button>
      </div>
    </div>
  );
}

function StepHeader({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-baseline gap-3 mb-3">
      <span
        className="font-mono text-xs"
        style={{ color: '#6b7280' }}
      >
        Step {n}
      </span>
      <h2 className="text-base font-medium">{title}</h2>
    </div>
  );
}

function StepRepo({
  repos,
  selectedRepoId,
  onSelect,
  onRepoConnected,
}: {
  repos: Repo[] | undefined;
  selectedRepoId: string | null;
  onSelect: (id: string) => void;
  onRepoConnected: () => void;
}) {
  const [showConnect, setShowConnect] = useState(false);
  const [newFullName, setNewFullName] = useState('');
  const [newBranch, setNewBranch] = useState('main');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  async function connect() {
    setConnecting(true);
    setConnectError(null);
    try {
      await connectRepo(newFullName.trim(), newBranch.trim() || 'main');
      setNewFullName('');
      setNewBranch('main');
      setShowConnect(false);
      onRepoConnected();
    } catch (err) {
      setConnectError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  return (
    <section>
      <StepHeader n={1} title="Which repo?" />
      {repos && repos.length === 0 && (
        <p className="text-sm mb-3" style={{ color: '#6b7280' }}>
          Connect a repo first.{' '}
          <Link
            href="/settings/repos"
            className="underline"
            style={{ color: '#fbbf24' }}
          >
            Go to repo settings
          </Link>
          .
        </p>
      )}
      {repos && repos.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {repos.map((r) => {
            const active = r.id === selectedRepoId;
            return (
              <button
                key={r.id}
                onClick={() => onSelect(r.id)}
                className="text-left p-3 rounded-md transition-colors"
                style={{
                  backgroundColor: active ? '#161616' : '#111111',
                  border: active
                    ? '1px solid #fbbf24'
                    : '1px solid #1f1f1f',
                }}
              >
                <div
                  className="font-mono text-sm"
                  style={{ color: '#f0f0f0' }}
                >
                  {r.fullName}
                </div>
                <div
                  className="text-xs mt-1"
                  style={{ color: '#6b7280' }}
                >
                  default: {r.defaultBranch}
                </div>
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-3">
        {!showConnect ? (
          <button
            onClick={() => setShowConnect(true)}
            className="text-sm underline"
            style={{ color: '#6b7280' }}
          >
            Connect another repo
          </button>
        ) : (
          <div
            className="rounded-md p-3 space-y-2"
            style={{
              backgroundColor: '#111111',
              border: '1px solid #1f1f1f',
            }}
          >
            <input
              value={newFullName}
              onChange={(e) => setNewFullName(e.target.value)}
              placeholder="owner/repo"
              className="w-full px-3 py-2 text-sm rounded font-mono"
              style={{
                backgroundColor: '#0a0a0a',
                border: '1px solid #2a2a2a',
                color: '#f0f0f0',
              }}
            />
            <input
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              placeholder="default branch"
              className="w-full px-3 py-2 text-sm rounded font-mono"
              style={{
                backgroundColor: '#0a0a0a',
                border: '1px solid #2a2a2a',
                color: '#f0f0f0',
              }}
            />
            {connectError && (
              <p className="text-xs" style={{ color: '#f87171' }}>
                {connectError}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowConnect(false)}
                className="px-3 py-1.5 text-sm rounded"
                style={{ color: '#6b7280' }}
              >
                Cancel
              </button>
              <button
                onClick={connect}
                disabled={!newFullName.trim() || connecting}
                className="px-3 py-1.5 text-sm rounded font-medium disabled:opacity-40"
                style={{ backgroundColor: '#fbbf24', color: '#0a0a0a' }}
              >
                {connecting ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function StepBranch({
  repoId,
  defaultBranch,
  selectedBranch,
  onSelect,
}: {
  repoId: string;
  defaultBranch: string;
  selectedBranch: string | null;
  onSelect: (b: string) => void;
}) {
  const { data: branches, isLoading } = useSWR<string[]>(
    `/repos/${repoId}/branches`,
    () => getRepoBranches(repoId),
  );
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const list = branches ?? [];
    if (!filter) return list;
    return list.filter((b) =>
      b.toLowerCase().includes(filter.toLowerCase()),
    );
  }, [branches, filter]);

  return (
    <section>
      <StepHeader n={2} title="Which branch?" />
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={`Search branches (default: ${defaultBranch})`}
        className="w-full px-3 py-2 text-sm rounded font-mono mb-2"
        style={{
          backgroundColor: '#111111',
          border: '1px solid #1f1f1f',
          color: '#f0f0f0',
        }}
      />
      {isLoading && (
        <p className="text-sm" style={{ color: '#6b7280' }}>
          Loading branches…
        </p>
      )}
      {!isLoading && filtered.length === 0 && (
        <p className="text-sm" style={{ color: '#6b7280' }}>
          No branches found.
        </p>
      )}
      <div
        className="max-h-56 overflow-y-auto rounded-md"
        style={{
          backgroundColor: '#111111',
          border: '1px solid #1f1f1f',
        }}
      >
        {filtered.map((b) => {
          const active = b === selectedBranch;
          return (
            <button
              key={b}
              onClick={() => onSelect(b)}
              className="block w-full text-left px-3 py-2 text-sm font-mono transition-colors hover:bg-[#161616]"
              style={{
                color: active ? '#fbbf24' : '#f0f0f0',
                borderLeft: active
                  ? '2px solid #fbbf24'
                  : '2px solid transparent',
              }}
            >
              {b}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function StepRequest({
  request,
  onRequestChange,
  model,
  onModelChange,
}: {
  request: string;
  onRequestChange: (s: string) => void;
  model: ModelId;
  onModelChange: (m: ModelId) => void;
}) {
  return (
    <section>
      <StepHeader n={3} title="What should Anvil do?" />
      <textarea
        value={request}
        onChange={(e) => onRequestChange(e.target.value)}
        rows={6}
        placeholder="Add input validation to all API endpoints"
        className="w-full p-3 text-sm rounded font-mono"
        style={{
          backgroundColor: '#0d0d0d',
          border: '1px solid #1f1f1f',
          color: '#f0f0f0',
        }}
      />
      <div className="mt-4">
        <div
          className="text-[11px] uppercase tracking-wider mb-2 font-mono"
          style={{ color: '#6b7280' }}
        >
          Model
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {MODELS.map((m) => {
            const active = m.id === model;
            return (
              <button
                key={m.id}
                onClick={() => onModelChange(m.id)}
                className="text-left p-2 rounded-md transition-colors"
                style={{
                  backgroundColor: active ? '#161616' : '#111111',
                  border: active
                    ? '1px solid #fbbf24'
                    : '1px solid #1f1f1f',
                }}
              >
                <div className="text-sm" style={{ color: '#f0f0f0' }}>
                  {m.label}
                </div>
                <div
                  className="text-[11px] font-mono"
                  style={{ color: '#6b7280' }}
                >
                  {m.provider}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
