/**
 * A minimal fake WebSocket for Jest tests — the same class `packages/store/src/testing/FakeWebSocket.ts`
 * provides for Vitest, duplicated rather than imported: that file is re-exported from
 * `@medguard/store/testing`'s barrel alongside the conformance suite, which imports `vitest`
 * directly — `require`-ing it (as Jest's CommonJS runtime does, unlike Vitest's ESM) throws
 * ("Vitest cannot be imported in a CommonJS module using require()"). `LiveClient`
 * (`packages/store/src/liveClient.ts`) only touches the global `WebSocket` constructor and a
 * handful of `EventTarget` events, so this stays in lockstep with the original by construction —
 * if that surface ever changes, `SyncProvider.test.tsx` (the only consumer here) will fail loudly.
 */
export class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  static reset() {
    FakeWebSocket.instances = [];
  }
  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error('No WebSocket was constructed');
    return ws;
  }

  readyState = 0; // CONNECTING

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[],
  ) {
    super();
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  message(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}
