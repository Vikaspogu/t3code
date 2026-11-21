// @effect-diagnostics processEnvInEffect:off
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { HermesGateway, hermesOrigin } from "./gateway.ts";

const socketMock = vi.hoisted(() => ({
  current: null as unknown as new (
    url: URL,
    protocols: ReadonlyArray<string>,
    init: { headers: { origin: string } },
  ) => EventTarget & {
    readyState: number;
    send: (data: string, callback: (error?: Error) => void) => void;
    close: () => void;
  },
}));

vi.mock("ws", () => ({
  get default() {
    return socketMock.current;
  },
}));

class IdleWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readyState = 0;
  static last: IdleWebSocket | null = null;

  constructor() {
    super();
    IdleWebSocket.last = this;
    queueMicrotask(() => {
      this.readyState = IdleWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(_data: string, callback: (error?: Error) => void): void {
    callback();
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

const endpoint = "ws://hermes.test/api/ws";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.HERMES_ALLOW_CLEARTEXT;
});

describe("HermesGateway deadlines", () => {
  it("times out a stalled ticket exchange", async () => {
    vi.useFakeTimers();
    socketMock.current = IdleWebSocket;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    process.env.HERMES_ALLOW_CLEARTEXT = "1";
    // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- fake timers drive the real socket timers
    const result = Effect.runPromise(
      Effect.scoped(HermesGateway.connect(endpoint, "secret", hermesOrigin(endpoint))),
    );
    result.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(result).rejects.toThrow(/ticket|aborted|timeout/i);
  });

  it("times out an RPC that receives no response", async () => {
    vi.useFakeTimers();
    socketMock.current = IdleWebSocket;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ticket: "ticket-a" })),
    );
    process.env.HERMES_ALLOW_CLEARTEXT = "1";
    // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- fake timers drive the real socket timers
    const result = Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gateway = yield* HermesGateway.connect(endpoint, "secret", hermesOrigin(endpoint));
          yield* gateway.request("runtime.describe", {});
        }),
      ),
    );
    result.catch(() => {});
    await vi.advanceTimersByTimeAsync(40_001);
    await expect(result).rejects.toThrow(/timed out/i);
    expect(IdleWebSocket.last?.readyState).toBe(3);
  });
});
