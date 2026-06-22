import { logger } from '../lib/logger';
import { channelFor } from './pipeline';

export interface RedisSubscriber {
  subscribe(channel: string): Promise<unknown> | unknown;
  unsubscribe(channel: string): Promise<unknown> | unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): this;
  off?(event: 'message', listener: (channel: string, message: string) => void): this;
}

export interface SSEClient {
  id: string;
  sessionId: string;
  send: (data: string) => void;
}

const HEARTBEAT_FRAME = ': heartbeat\n\n';

export class SSEBroadcaster {
  private readonly clients = new Map<string, Set<SSEClient>>();
  private readonly redisSubscriber: RedisSubscriber;
  private readonly messageListener: (channel: string, message: string) => void;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(redisSubscriber: RedisSubscriber) {
    this.redisSubscriber = redisSubscriber;
    this.messageListener = (channel, message) => {
      this.handleRedisMessage(channel, message);
    };
    this.redisSubscriber.on('message', this.messageListener);
  }

  private handleRedisMessage(channel: string, message: string): void {
    const prefix = 'anvil:session:';
    if (!channel.startsWith(prefix)) return;
    const sessionId = channel.slice(prefix.length);
    this.broadcastToSession(sessionId, message);
  }

  registerClient(
    sessionId: string,
    clientId: string,
    send: (data: string) => void,
  ): () => void {
    let set = this.clients.get(sessionId);
    const isFirst = !set;
    if (!set) {
      set = new Set();
      this.clients.set(sessionId, set);
    }
    const client: SSEClient = { id: clientId, sessionId, send };
    set.add(client);

    if (isFirst) {
      void Promise.resolve(this.redisSubscriber.subscribe(channelFor(sessionId)))
        .catch((err) =>
          logger.warn({ sessionId, err }, 'redis subscribe failed'),
        );
    }

    return () => this.unregisterClient(sessionId, clientId);
  }

  unregisterClient(sessionId: string, clientId: string): void {
    const set = this.clients.get(sessionId);
    if (!set) return;
    for (const client of set) {
      if (client.id === clientId) {
        set.delete(client);
        break;
      }
    }
    if (set.size === 0) {
      this.clients.delete(sessionId);
      void Promise.resolve(
        this.redisSubscriber.unsubscribe(channelFor(sessionId)),
      ).catch((err) =>
        logger.warn({ sessionId, err }, 'redis unsubscribe failed'),
      );
    }
  }

  broadcastToSession(sessionId: string, message: string): void {
    const set = this.clients.get(sessionId);
    if (!set || set.size === 0) return;
    const frame = `data: ${message}\n\n`;
    const dead: SSEClient[] = [];
    for (const client of set) {
      try {
        client.send(frame);
      } catch (err) {
        logger.warn(
          { sessionId, clientId: client.id, err },
          'sse send failed, dropping client',
        );
        dead.push(client);
      }
    }
    for (const d of dead) set.delete(d);
    if (set.size === 0) {
      this.clients.delete(sessionId);
      void Promise.resolve(
        this.redisSubscriber.unsubscribe(channelFor(sessionId)),
      ).catch(() => {});
    }
  }

  sendHeartbeat(): void {
    for (const [sessionId, set] of this.clients) {
      const dead: SSEClient[] = [];
      for (const client of set) {
        try {
          client.send(HEARTBEAT_FRAME);
        } catch {
          dead.push(client);
        }
      }
      for (const d of dead) set.delete(d);
      if (set.size === 0) {
        this.clients.delete(sessionId);
        void Promise.resolve(
          this.redisSubscriber.unsubscribe(channelFor(sessionId)),
        ).catch(() => {});
      }
    }
  }

  startHeartbeat(intervalMs = 30_000): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  countClients(sessionId: string): number {
    return this.clients.get(sessionId)?.size ?? 0;
  }

  close(): void {
    this.stopHeartbeat();
    this.redisSubscriber.off?.('message', this.messageListener);
    this.clients.clear();
  }
}

export function createBroadcaster(
  redisSubscriber: RedisSubscriber,
): SSEBroadcaster {
  return new SSEBroadcaster(redisSubscriber);
}
