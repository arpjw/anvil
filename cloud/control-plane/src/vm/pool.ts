import type { VMHandle } from './types';

export interface PoolWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

export interface PoolEntry {
  ws: PoolWebSocket;
  vmHandle: VMHandle;
  listeners: Set<(event: unknown) => void>;
}

export type UIEvent = { type: string; payload?: unknown };

export class SessionPool {
  private readonly connections = new Map<string, PoolEntry>();

  add(sessionId: string, ws: PoolWebSocket, vmHandle: VMHandle): void {
    this.connections.set(sessionId, {
      ws,
      vmHandle,
      listeners: new Set(),
    });
  }

  get(sessionId: string): PoolEntry | undefined {
    return this.connections.get(sessionId);
  }

  remove(sessionId: string): void {
    const entry = this.connections.get(sessionId);
    if (!entry) return;
    entry.listeners.clear();
    this.connections.delete(sessionId);
  }

  send(sessionId: string, message: unknown): void {
    const entry = this.connections.get(sessionId);
    if (!entry) return;
    entry.ws.send(JSON.stringify(message));
  }

  subscribe(
    sessionId: string,
    listener: (event: UIEvent) => void,
  ): () => void {
    const entry = this.connections.get(sessionId);
    if (!entry) {
      return () => {};
    }
    const wrapped = listener as (event: unknown) => void;
    entry.listeners.add(wrapped);
    return () => {
      entry.listeners.delete(wrapped);
    };
  }

  broadcast(sessionId: string, event: UIEvent): void {
    const entry = this.connections.get(sessionId);
    if (!entry) return;
    for (const listener of entry.listeners) {
      try {
        (listener as (e: UIEvent) => void)(event);
      } catch {
        // never let a bad listener take down the relay
      }
    }
  }

  list(): string[] {
    return Array.from(this.connections.keys());
  }
}

export const sessionPool = new SessionPool();
