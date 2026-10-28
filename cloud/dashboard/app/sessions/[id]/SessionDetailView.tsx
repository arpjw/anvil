'use client';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { getSession } from '@/lib/api';
import { useSessionEvents } from '@/lib/sse';
import { SessionWorkspace } from '@/components/SessionWorkspace';
import type { SessionDetail } from '@/lib/types';

export function SessionDetailView({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { data, error, mutate } = useSWR<SessionDetail>(`/sessions/${sessionId}`, () => getSession(sessionId), { refreshInterval: 10_000 });
  const live = useSessionEvents(sessionId);
  if (error && !data) return <div className="workspace-empty" role="alert"><h1>Session unavailable</h1><p>{error.message}</p><button className="button-secondary" onClick={() => void mutate()}>Try again</button></div>;
  if (!data) return <div className="workspace-empty" role="status">Loading your workspace…</div>;
  // SSE snapshots contain the session row, not the detail response's repo/diffs.
  const session = { ...live.initialSession, ...data };
  return <SessionWorkspace session={session} status={live.status ?? session.status} events={live.events}
    connection={live.connection} connectionError={live.connectionError} onReconnect={live.reconnect}
    onRefresh={() => { void mutate(); live.reconnect(); }} onResumed={id => router.push(`/sessions/${id}`)} />;
}
