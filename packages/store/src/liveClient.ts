import type { LiveMessage } from '@medguard/shared';

export type LiveClientStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LiveClientLog {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

const noopLog: LiveClientLog = { debug: () => {}, info: () => {}, warn: () => {} };

export interface LiveClientOptions {
  apiBaseUrl: string;
  deviceToken: string;
  onMessage: (message: LiveMessage) => void;
  onStatusChange?: (status: LiveClientStatus) => void;
  log?: LiveClientLog;
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Keeps a WebSocket open to the household's live channel (`GET /api/v1/live`), reconnecting with
 * exponential backoff whenever it drops.
 *
 * The device token travels as the WebSocket subprotocol, not an `Authorization` header — a
 * browser's native `WebSocket` API cannot set custom headers, so this is the one place a client
 * can hand the server a credential at handshake time. See `apps/api/src/routes/live.ts`. React
 * Native's global `WebSocket` *can* set headers, but this class deliberately doesn't use that
 * capability either (docs/android-client-plan.md, "One deliberate non-optimization") — forking
 * the auth path per client would give `HouseholdDO`'s connection handling two shapes for no
 * reason web and Android can't already share via this one class.
 *
 * Platform-agnostic: the only ambient dependency is the global `WebSocket` constructor, which
 * both the browser and Hermes/React Native provide with a compatible API
 * (`addEventListener`, a protocols array as the second constructor argument). Shared by
 * `apps/web` and `apps/android` rather than forked, per cross-cutting rule 5.
 *
 * Backoff is deterministic, without jitter: callers of this package are covered by the no-ambient-
 * randomness lint rule (the same one that forbids domain code from calling `Math.random()`), and
 * a two-or-three-device household has no thundering-herd problem for jitter to solve.
 */
export class LiveClient {
  private readonly log: LiveClientLog;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private stopped = true;

  constructor(private readonly options: LiveClientOptions) {
    this.log = options.log ?? noopLog;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Idempotent, and final — a stopped client must not reconnect itself, even mid-backoff. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const { apiBaseUrl, deviceToken } = this.options;
    const wsUrl = `${apiBaseUrl.replace(/^http/, 'ws')}/api/v1/live`;

    this.log.debug('connecting', { wsUrl });
    this.setStatus('connecting');
    const ws = new WebSocket(wsUrl, [deviceToken]);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.log.info('connection open');
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.setStatus('open');
    });

    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data as string) as LiveMessage;
        this.options.onMessage(message);
      } catch {
        // A malformed frame must not take the whole channel down.
        this.log.warn('dropped a malformed message frame');
      }
    });

    // 'error' is always followed by 'close' for a WebSocket, so reconnect scheduling lives there
    // alone rather than being duplicated across both handlers.
    ws.addEventListener('close', () => {
      this.log.warn('connection closed');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      this.setStatus('closed');
      return;
    }
    this.setStatus('reconnecting');
    this.log.debug('reconnecting after backoff', { backoffMs: this.backoffMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private setStatus(status: LiveClientStatus): void {
    this.options.onStatusChange?.(status);
  }
}
