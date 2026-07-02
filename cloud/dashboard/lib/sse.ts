'use client';

import { useEffect, useRef, useState } from 'react';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import type { SessionDetail, SessionStatus, UIEvent } from './types';

const MAX_EVENTS = 200;
const RECONNECT_DELAY_MS = 3_000;

interface SessionStateFrame {
  type: 'session_state';
  payload: { session: SessionDetail; recentEvents: Array<{ type: string; payload: unknown; createdAt: string }> };
}

function isSessionStateFrame(value: unknown): value is SessionStateFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'session_state'
  );
}

function deriveStatusFromEvent(type: string): SessionStatus | null {
  switch (type) {
    case 'plan_ready':
      return 'reviewing';
    case 'done':
    case 'session_complete':
      return 'complete';
    case 'error':
    case 'session_error':
      return 'failed';
    case 'aborted':
      return 'aborted';
    default:
      return null;
  }
}

export interface UseSessionEventsResult {
  events: UIEvent[];
  status: SessionStatus | null;
  isConnected: boolean;
  initialSession: SessionDetail | null;
}

export function useSessionEvents(
  sessionId: string | null,
): UseSessionEventsResult {
  const [events, setEvents] = useState<UIEvent[]>([]);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [initialSession, setInitialSession] = useState<SessionDetail | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      setStatus(null);
      setIsConnected(false);
      setInitialSession(null);
      return;
    }

    cancelledRef.current = false;
    setEvents([]);
    setStatus(null);
    setIsConnected(false);
    setInitialSession(null);

    const connect = async (): Promise<void> => {
      if (cancelledRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;

      const parser = createParser({
        onEvent(message: EventSourceMessage) {
          if (!message.data) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(message.data);
          } catch {
            return;
          }
          if (isSessionStateFrame(parsed)) {
            setInitialSession(parsed.payload.session);
            setStatus(parsed.payload.session.status);
            const replay: UIEvent[] = parsed.payload.recentEvents
              .slice()
              .reverse()
              .map((e) => ({
                type: e.type,
                payload: e.payload,
                timestamp: new Date(e.createdAt).getTime(),
              }));
            setEvents(replay);
            return;
          }
          const evt = parsed as UIEvent;
          setEvents((prev) => {
            const next = [...prev, evt];
            return next.length > MAX_EVENTS
              ? next.slice(next.length - MAX_EVENTS)
              : next;
          });
          const derived = deriveStatusFromEvent(evt.type);
          if (derived) setStatus(derived);
        },
      });

      try {
        const res = await fetch(`/api/proxy/sessions/${sessionId}/events`, {
          signal: controller.signal,
          credentials: 'include',
          headers: { Accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: ${res.status}`);
        }
        setIsConnected(true);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        if (cancelledRef.current) return;
        if ((err as Error).name === 'AbortError') return;
      } finally {
        setIsConnected(false);
      }

      if (cancelledRef.current) return;
      reconnectTimerRef.current = setTimeout(() => {
        void connect();
      }, RECONNECT_DELAY_MS);
    };

    void connect();

    return () => {
      cancelledRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [sessionId]);

  return { events, status, isConnected, initialSession };
}
