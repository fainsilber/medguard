import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from '../testUtils/FakeWebSocket.js';
import { LiveClient } from './liveClient.js';

/**
 * `LiveClient`'s reconnect/backoff behavior, against a fake WebSocket rather than a real
 * connection — what matters here is *when* it reconnects and *what* it does with a message, not
 * the transport itself.
 */

const latest = () => FakeWebSocket.latest();

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LiveClient', () => {
  it('connects to /api/v1/live over ws(s), carrying the device token as the subprotocol', () => {
    const client = new LiveClient({
      apiBaseUrl: 'https://example.com',
      deviceToken: 'tok-1',
      onMessage: vi.fn(),
    });

    client.start();

    expect(latest().url).toBe('wss://example.com/api/v1/live');
    expect(latest().protocols).toEqual(['tok-1']);
    client.stop();
  });

  it('reports status through open, message, and reconnect transitions', () => {
    const onStatusChange = vi.fn();
    const onMessage = vi.fn();
    const client = new LiveClient({
      apiBaseUrl: 'http://localhost:8787',
      deviceToken: 'tok-1',
      onMessage,
      onStatusChange,
    });

    client.start();
    expect(onStatusChange).toHaveBeenCalledWith('connecting');

    latest().open();
    expect(onStatusChange).toHaveBeenCalledWith('open');

    latest().message({ type: 'sync', cursor: 5 });
    expect(onMessage).toHaveBeenCalledWith({ type: 'sync', cursor: 5 });

    client.stop();
  });

  it('reconnects after a close, with exponentially growing backoff', () => {
    const onStatusChange = vi.fn();
    const client = new LiveClient({
      apiBaseUrl: 'http://localhost:8787',
      deviceToken: 'tok-1',
      onMessage: vi.fn(),
      onStatusChange,
    });

    client.start();
    latest().open();
    const firstSocket = latest();

    firstSocket.close();
    expect(onStatusChange).toHaveBeenCalledWith('reconnecting');

    // Nothing yet — the first backoff interval (1s) hasn't elapsed.
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Second failure backs off further (2s), not immediately.
    latest().close();
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    client.stop();
  });

  it('resets backoff to the initial interval after a successful reconnect', () => {
    const client = new LiveClient({
      apiBaseUrl: 'http://localhost:8787',
      deviceToken: 'tok-1',
      onMessage: vi.fn(),
    });

    client.start();
    latest().open();
    latest().close();
    vi.advanceTimersByTime(1000); // first reconnect, after the 1s backoff
    latest().open(); // succeeds — backoff should reset
    latest().close();

    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    client.stop();
  });

  it('never reconnects once stopped, even mid-backoff', () => {
    const client = new LiveClient({
      apiBaseUrl: 'http://localhost:8787',
      deviceToken: 'tok-1',
      onMessage: vi.fn(),
    });

    client.start();
    latest().open();
    latest().close();
    client.stop();

    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not let a malformed message frame throw or break the channel', () => {
    const onMessage = vi.fn();
    const client = new LiveClient({
      apiBaseUrl: 'http://localhost:8787',
      deviceToken: 'tok-1',
      onMessage,
    });

    client.start();
    latest().open();
    expect(() => latest().dispatchEvent(new MessageEvent('message', { data: 'not json' }))).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();

    client.stop();
  });
});
