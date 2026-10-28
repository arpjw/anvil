'use client';
import { useEffect, useState, useRef } from 'react';
import { createParser } from 'eventsource-parser';
import type { Session, SessionStatus, UIEvent } from './types';
import { parseFrame, mergeEvents, deriveStatus, isTerminal, type SessionFrame } from './session-events';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'error';
export function useSessionEvents(sessionId: string | null) {
  const [events, setEvents] = useState<UIEvent[]>([]);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [initialSession, setInitialSession] = useState<Session | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const previousSession = useRef<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let terminal = false;
    let attempts = 0;
    if (previousSession.current !== sessionId) {
      setEvents([]); setStatus(null); setInitialSession(null); previousSession.current = sessionId;
    }
    setConnectionError(null);
    if (!sessionId) { setConnection('closed'); return; }
    async function connect() {
      if (cancelled) return;
      controller = new AbortController();
      setConnection(attempts ? 'reconnecting' : 'connecting');
      let retry = true;
      const parser = createParser({ onEvent(message) {
        if (cancelled) return;
        const frame = parseFrame(message.data);
        if (!frame) return;
        if (frame.type === 'session_state') {
          const { session, recentEvents } = (frame as SessionFrame).payload;
          setInitialSession(session); setStatus(session.status); terminal = isTerminal(session.status);
          const replay = recentEvents.filter(e => typeof e.type === 'string').map(e => ({ id: e.id, type: e.type, payload: e.payload, timestamp: new Date(e.createdAt).getTime() }));
          setEvents(prev => mergeEvents(prev, replay));
        } else {
          setEvents(prev => mergeEvents(prev, [frame as UIEvent]));
          const next = deriveStatus(frame as UIEvent);
          if (next) { setStatus(next); terminal = isTerminal(next); }
        }
      } });
      try {
        const response = await fetch(`/api/proxy/sessions/${sessionId}/events`, { signal: controller.signal,
          credentials: 'include', headers: { Accept: 'text/event-stream' } });
        if (!response.ok || !response.body) {
          retry = ![401, 403, 404].includes(response.status);
          throw new Error(response.status === 401 ? 'Sign in again to reconnect.' : `Live connection unavailable (${response.status}).`);
        }
        if (cancelled) return;
        setConnection('live'); setConnectionError(null); attempts = 0;
        const reader = response.body.getReader(); const decoder = new TextDecoder();
        try {
          while (!cancelled) {
            const { done, value } = await reader.read();
            if (done) { parser.feed(decoder.decode()); break; }
            parser.feed(decoder.decode(value, { stream: true }));
            if (terminal) { await reader.cancel(); break; }
          }
        } finally { reader.releaseLock(); }
      } catch (err) {
        if (cancelled || (err as Error).name === 'AbortError') return;
        setConnectionError((err as Error).message);
      }
      if (cancelled) return;
      if (terminal) { setConnection('closed'); return; }
      if (!retry) { setConnection('error'); return; }
      setConnection('reconnecting');
      const delay = Math.min(1000 * 2 ** attempts++, 15_000);
      timer = setTimeout(() => void connect(), delay);
    }
    void connect();
    return () => { cancelled = true; clearTimeout(timer); controller?.abort(); };
  }, [sessionId, generation]);

  return { events, status, initialSession, isConnected: connection === 'live', connection, connectionError,
    reconnect: () => setGeneration(n => n + 1) };
}
