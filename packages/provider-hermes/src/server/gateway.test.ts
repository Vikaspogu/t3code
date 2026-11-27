// @effect-diagnostics processEnvInEffect:off
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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

it("delivers canonical events without confusing server requests with replies", async () => {
  const event = {
    type: "message.delta",
    session_id: "session-1",
    replay_epoch: "epoch-1",
    seq: 1,
    admission_id: "admission-1",
    payload: { text: "hello" },
  };
  socketMock.current = class extends IdleWebSocket {
    override send(data: string, callback: (error?: Error) => void): void {
      const outgoing = JSON.parse(data) as { id: string; method?: string };
      if (!outgoing.method) {
        callback();
        return;
      }
      const { id } = outgoing;
      for (const frame of [
        {
          method: "event",
          params: { type: "gateway.ready", payload: { session_authority: true } },
        },
        { method: "event", params: { type: "sessions.changed", session_id: "" } },
        { method: "event", params: event },
        { id, method: "clarify", params: {} },
        { id, result: { status: "queued" } },
      ]) {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify({ jsonrpc: "2.0", ...frame }) }),
        );
      }
      callback();
    }
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ticket: "ticket-a" })),
  );
  const url = "ws://127.0.0.1/api/ws";
  // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- drives native WebSocket callbacks
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* HermesGateway.connect(url, "secret", hermesOrigin(url));
        const connection = yield* gateway.connection;
        const events = yield* connection.subscribeEvents(event.session_id);
        const result = yield* connection.request("prompt.submit", {});
        expect(result).toEqual({ status: "queued" });
        const received: unknown[] = [];
        IdleWebSocket.last?.close();
        const error = yield* Effect.flip(
          Stream.runForEach(events, (frame) => Effect.sync(() => received.push(frame))),
        );
        expect(received).toEqual([event]);
        expect(error.operation).toBe("socket");
      }),
    ),
  );
});

it("rejects deferred secure server requests without waiting for a timeout", async () => {
  const replies: Array<Record<string, unknown>> = [];
  socketMock.current = class extends IdleWebSocket {
    override send(data: string, callback: (error?: Error) => void): void {
      replies.push(JSON.parse(data) as Record<string, unknown>);
      callback();
    }
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ticket: "ticket-a" })),
  );
  const url = "ws://127.0.0.1/api/ws";
  // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- drives native WebSocket callbacks
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* HermesGateway.connect(url, "secret", hermesOrigin(url));
        yield* gateway.connection;
        const socket = IdleWebSocket.last!;
        for (const method of ["sudo", "secret", "vault.unlock_prompt", "future.request"]) {
          socket.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ jsonrpc: "2.0", id: `srq-${method}`, method, params: {} }),
            }),
          );
        }
        expect(replies).toEqual(
          ["sudo", "secret", "vault.unlock_prompt", "future.request"].map((method) => ({
            jsonrpc: "2.0",
            id: `srq-${method}`,
            error: {
              code: -32601,
              message: `T3 Code does not yet support Hermes ${method} requests`,
            },
          })),
        );
        socket.close();
      }),
    ),
  );
});

it("fails a lagging event stream when its backlog fills", async () => {
  socketMock.current = IdleWebSocket;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ticket: "ticket-a" })),
  );
  const url = "ws://127.0.0.1/api/ws";
  // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- drives native WebSocket callbacks
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* HermesGateway.connect(url, "secret", hermesOrigin(url));
        const connection = yield* gateway.connection;
        const events = yield* connection.subscribeEvents("s");
        const otherEvents = yield* connection.subscribeEvents("other");
        const socket = IdleWebSocket.last!;
        for (let seq = 1; seq <= 257; seq++) {
          socket.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                jsonrpc: "2.0",
                method: "event",
                params: {
                  type: "message.delta",
                  session_id: "s",
                  replay_epoch: "e",
                  seq,
                  payload: {},
                },
              }),
            }),
          );
        }
        socket.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              jsonrpc: "2.0",
              method: "event",
              params: { type: "message.delta", session_id: "other", seq: 1, payload: {} },
            }),
          }),
        );
        const [otherFrame] = yield* Stream.runCollect(Stream.take(otherEvents, 1)).pipe(
          Effect.timeout("1 second"),
        );
        expect(otherFrame?.session_id).toBe("other");
        const received: Array<number | undefined> = [];
        const error = yield* Effect.flip(
          Stream.runForEach(events, ({ seq }) => Effect.sync(() => received.push(seq))),
        );
        expect(received).toEqual(Array.from({ length: 256 }, (_, index) => index + 1));
        expect(error.message).toContain("backlog overflow");
        expect(socket.readyState).toBe(IdleWebSocket.OPEN);
        socket.close();
        const closed = yield* Effect.flip(connection.subscribeEvents("s"));
        expect(closed.message).toContain("not open");
      }),
    ),
  );
});

it.each([
  {
    kind: "replay gap",
    frame: { type: "session.replay_gap", payload: {} },
    error: "Gateway reported an event replay gap",
  },
  {
    kind: "malformed event",
    frame: { type: "message.delta", seq: "2", payload: {} },
    error: "Invalid Hermes session event",
  },
])("fails only the addressed event stream on a $kind", async ({ frame, error: expectedError }) => {
  socketMock.current = IdleWebSocket;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ticket: "ticket-a" })),
  );
  const url = "ws://127.0.0.1/api/ws";
  // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- drives native WebSocket callbacks
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* HermesGateway.connect(url, "secret", hermesOrigin(url));
        const connection = yield* gateway.connection;
        const events = yield* connection.subscribeEvents("s");
        const otherEvents = yield* connection.subscribeEvents("other");
        const socket = IdleWebSocket.last!;
        for (const params of [
          { type: "session.replay_gap", session_id: "", payload: {} },
          { type: "global.update", seq: "not a session sequence", payload: {} },
          { ...frame, session_id: "s" },
          { type: "message.delta", session_id: "other", seq: 1, payload: {} },
        ]) {
          socket.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ jsonrpc: "2.0", method: "event", params }),
            }),
          );
        }
        const [otherFrame] = yield* Stream.runCollect(Stream.take(otherEvents, 1)).pipe(
          Effect.timeout("1 second"),
        );
        expect(otherFrame?.session_id).toBe("other");
        const error = yield* Stream.runDrain(events).pipe(Effect.timeout("1 second"), Effect.flip);
        expect(error.message).toContain(expectedError);
        expect(socket.readyState).toBe(IdleWebSocket.OPEN);
      }),
    ),
  );
});

it("replays a contiguous suffix and refuses an incomplete or foreign replay", async () => {
  const event = (seq: number) => ({
    type: "message.delta",
    session_id: "s",
    replay_epoch: "e",
    seq,
    payload: { text: "delta" },
  });
  const pluginWithoutPayload = {
    type: "plugin.ivan_personal.media_updated",
    session_id: "s",
    replay_epoch: "e",
    seq: 3,
  };
  let page = {
    replay_epoch: "e",
    last_sequence: 4,
    epoch: "e",
    latest_seq: 4,
    count: 2,
    open_requests: [],
    snapshot_required: false,
    truncated: false,
    events: [pluginWithoutPayload, event(4)],
  };
  socketMock.current = class extends IdleWebSocket {
    override send(data: string, callback: (error?: Error) => void): void {
      const { id, method, params } = JSON.parse(data) as {
        id: string;
        method: string;
        params: unknown;
      };
      expect(method).toBe("session.events.since");
      expect(params).toEqual({ session_id: "s", replay_epoch: "e", last_sequence: 2 });
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ jsonrpc: "2.0", id, result: page }),
        }),
      );
      callback();
    }
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ticket: "ticket-a" })),
  );
  const url = "ws://127.0.0.1/api/ws";
  // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- drives native WebSocket callbacks
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* HermesGateway.connect(url, "secret", hermesOrigin(url));
        const connection = yield* gateway.connection;
        const replay = connection.replayEvents("s", { epoch: "e", sequence: 2 });
        expect(yield* replay).toEqual([pluginWithoutPayload, event(4)]);
        const complete = page;
        for (const invalid of [
          { ...complete, snapshot_required: true },
          { ...complete, truncated: true },
          { ...complete, replay_epoch: "other" },
          { ...complete, last_sequence: 5 },
          { ...complete, events: [event(4)] },
          { ...complete, events: [{ ...event(3), session_id: "foreign" }, event(4)] },
          { ...complete, events: [{ ...event(3), replay_epoch: "other" }, event(4)] },
          { ...complete, events: [{ ...event(3), type: "session.replay_gap" }, event(4)] },
        ]) {
          page = invalid;
          expect((yield* Effect.flip(replay)).operation).toBe("session.events.since");
        }
      }),
    ),
  );
});
it("refuses a request on an old connection even after a replacement opens", async () => {
  const methods: string[] = [];
  socketMock.current = class extends IdleWebSocket {
    override send(data: string, callback: (error?: Error) => void): void {
      const { id, method } = JSON.parse(data) as { id: string; method: string };
      methods.push(method);
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ jsonrpc: "2.0", id, result: {} }),
        }),
      );
      callback();
    }
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ticket: "ticket-a" })),
  );
  const url = "ws://127.0.0.1/api/ws";
  // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- drives native WebSocket callbacks
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* HermesGateway.connect(url, "secret", hermesOrigin(url));
        const old = yield* gateway.connection;
        yield* old.request("runtime.describe", {});
        const socket = IdleWebSocket.last!;
        socket.close();

        const replacement = yield* gateway.connection;
        expect(IdleWebSocket.last).not.toBe(socket);
        const error = yield* Effect.flip(
          old.request("session.resume", { session_id: "s" }).pipe(Effect.asVoid),
        );
        expect(error.message).toContain("Pinned Gateway connection is not open");
        expect((yield* Effect.flip(old.subscribeEvents("s"))).operation).toBe("socket");
        yield* replacement.request("runtime.describe", {});
        expect(methods).toEqual(["runtime.describe", "runtime.describe"]);
      }),
    ),
  );
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
          const connection = yield* gateway.connection;
          yield* connection.request("runtime.describe", {});
        }),
      ),
    );
    result.catch(() => {});
    await vi.advanceTimersByTimeAsync(40_001);
    await expect(result).rejects.toThrow(/timed out/i);
    expect(IdleWebSocket.last?.readyState).toBe(3);
  });
});
