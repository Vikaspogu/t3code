// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { HermesSettings } from "../settings.ts";
import { HERMES_PROVIDER, makeHermesAdapterV2 } from "./adapter.ts";
import { HermesSessionStore } from "./gateway.ts";

const socketMock = vi.hoisted(() => ({
  current: null as unknown as new (
    url: URL,
    protocols: ReadonlyArray<string>,
    init: { headers: { origin: string } },
  ) => EventTarget,
}));
vi.mock("ws", () => ({
  default: class {
    static readonly OPEN = 1;
    constructor(url: URL, protocols: ReadonlyArray<string>, init: { headers: { origin: string } }) {
      return new socketMock.current(url, protocols, init);
    }
  },
}));
const decodeHermesSettings = Schema.decodeSync(HermesSettings);
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.unstubAllGlobals();
});

describe("HermesSessionStore", () => {
  it("reserves before create, persists the binding, and rejects identity drift", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-store-"));
    cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
    const path = NodePath.join(directory, "state.sqlite3");
    const identity = {
      threadId: "thread-a",
      profileId: "/profile",
      instanceId: "instance-a",
      principalId: "uid:1000",
      authorityEpoch: 4,
    };
    const first = new HermesSessionStore(path);
    const reservation = first.reserve(identity);
    expect(reservation.sessionId).toBeNull();
    expect(first.reserve(identity).requestId).toBe(reservation.requestId);
    first.bind(reservation.threadId, reservation.requestId, "session-a");
    const unbound = first.reserve({ ...identity, threadId: "thread-unbound" });
    const reReserved = first.reserve({
      ...identity,
      threadId: "thread-unbound",
      instanceId: "instance-b",
    });
    expect(reReserved.requestId).not.toBe(unbound.requestId);
    expect(reReserved.instanceId).toBe("instance-b");
    first.close();

    const reopened = new HermesSessionStore(path);
    cleanups.push(() => reopened.close());
    expect(reopened.get("thread-a")?.sessionId).toBe("session-a");
    expect(() => reopened.reserve({ ...identity, instanceId: "instance-b" })).toThrow(/identity/);
    expect(reopened.reserve({ ...identity, threadId: "thread-b" }).requestId).not.toBe(
      reservation.requestId,
    );
  });
});

describe("HermesAdapterV2 G1 lifecycle", () => {
  it.effect("creates once, resumes the exact session, and leaves turns disabled", () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-adapter-"));
      cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

      const runtime = {
        profile_id: "/profile",
        instance_id: "instance-a",
        authority_epoch: 4,
        capabilities: ["durable-admission-v1", "event-replay-v1"],
      };
      const sockets: Array<{ close: () => void; dispatchEvent: (event: Event) => boolean }> = [];
      let failResume = false;
      let failSend = false;
      let malformedMessage = false;
      class MockWebSocket extends EventTarget {
        static readonly OPEN = 1;
        readyState = 0;

        constructor(
          url: URL,
          protocols: ReadonlyArray<string>,
          init: { headers: { origin: string } },
        ) {
          super();
          sockets.push(this);
          expect(url.searchParams.get("token")).toBeNull();
          expect(url.searchParams.get("native_dial")).toBe("browser");
          expect(protocols).toEqual(["hermes-gateway-v1", "hermes-gateway-ticket.ticket-a"]);
          expect(init.headers.origin).toBe("http://hermes.test");
          queueMicrotask(() => {
            this.readyState = MockWebSocket.OPEN;
            this.dispatchEvent(new Event("open"));
          });
        }

        send(data: string, callback: (error?: Error) => void): void {
          if (failSend) {
            callback(new Error("send failed"));
            return;
          }
          callback();
          const rpc = JSON.parse(data);
          const params = rpc.params ?? {};
          calls.push({ method: rpc.method, params });
          const result =
            rpc.method === "runtime.describe"
              ? runtime
              : rpc.method === "session.create"
                ? { session_id: "session-a" }
                : rpc.method === "session.resume"
                  ? { session_id: params.session_id, execution_generation: 0 }
                  : null;
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: malformedMessage
                  ? "{"
                  : JSON.stringify({
                      jsonrpc: "2.0",
                      id: rpc.id,
                      ...(failResume && rpc.method === "session.resume"
                        ? { error: { code: -32601, message: "resume failed" } }
                        : { result }),
                    }),
              }),
            ),
          );
        }

        close(): void {
          this.readyState = 3;
          this.dispatchEvent(new Event("close"));
        }
      }
      socketMock.current = MockWebSocket;
      const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) =>
        Response.json({ ticket: "ticket-a" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const settings = decodeHermesSettings({
        enabled: true,
        endpoint: "ws://hermes.test/api/ws",
        profileId: "/profile",
        principalId: "uid:1000",
      });
      process.env.HERMES_SESSION_TOKEN = "secret";
      process.env.HERMES_GATEWAY_URL = settings.endpoint;
      process.env.HERMES_STATE_DIR = NodePath.join(directory, "state");
      process.env.HERMES_ALLOW_CLEARTEXT = "1";
      NodeFS.mkdirSync(NodePath.join(directory, "work"), { recursive: true });
      cleanups.push(() => {
        delete process.env.HERMES_SESSION_TOKEN;
        delete process.env.HERMES_GATEWAY_URL;
        delete process.env.HERMES_STATE_DIR;
        delete process.env.HERMES_ALLOW_CLEARTEXT;
      });
      const threadId = ThreadId.make("thread-a");
      const instanceId = ProviderInstanceId.make("hermes-test");
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = {
        cwd: NodePath.join(directory, "work"),
        runtimeMode: "full-access",
        interactionMode: "default",
      } as const;
      const providerSessionId = ProviderSessionId.make("provider-session-a");
      const adapter = makeHermesAdapterV2({
        instanceId,
        settings,
      });
      const capabilities = yield* adapter.getCapabilities();
      expect(capabilities.threads.canRollbackThread).toBe(false);
      expect(capabilities.turns.supportsInterrupt).toBe(false);
      expect(capabilities.streaming.streamsAssistantText).toBe(false);
      expect(capabilities.approvals.supportsCommandApproval).toBe(false);

      const thread = yield* Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* adapter.openSession({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          const ensured = yield* opened.ensureThread({ threadId, modelSelection, runtimePolicy });
          expect(fetchMock.mock.calls[0]![0].toString()).toBe(
            "http://hermes.test/api/webapp/socket-ticket?socket=gateway",
          );
          expect(fetchMock.mock.calls[0]![1]?.headers).toEqual({
            "X-Hermes-Session-Token": "secret",
          });
          expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
          sockets.at(-1)!.close();
          const repeated = yield* opened.ensureThread({ threadId, modelSelection, runtimePolicy });
          expect(repeated.nativeThreadRef).toEqual(ensured.nativeThreadRef);
          expect(sockets).toHaveLength(2);
          sockets[0]!.dispatchEvent(new Event("close"));
          sockets[0]!.dispatchEvent(new MessageEvent("message", { data: "{" }));
          const adopted = yield* opened.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
            existingProviderThread: {
              ...ensured,
              id: ProviderThreadId.make("provider-thread:adopted"),
              nativeThreadRef: null,
            },
          });
          expect(adopted.id).toBe("provider-thread:adopted");
          expect(
            (yield* Effect.flip(
              opened.ensureThread({
                threadId,
                modelSelection,
                runtimePolicy,
                existingProviderThread: {
                  ...ensured,
                  nativeThreadRef: {
                    driver: HERMES_PROVIDER,
                    nativeId: "session-b",
                    strength: "strong",
                  },
                },
              }),
            ))._tag,
          ).toBe("ProviderAdapterProtocolError");
          expect((yield* opened.resumeThread({ providerThread: ensured })).nativeThreadRef).toEqual(
            ensured.nativeThreadRef,
          );
          runtime.instance_id = "instance-b";
          expect((yield* Effect.flip(opened.resumeThread({ providerThread: ensured })))._tag).toBe(
            "ProviderAdapterProtocolError",
          );
          runtime.instance_id = "instance-a";
          runtime.authority_epoch = 5;
          expect((yield* Effect.flip(opened.resumeThread({ providerThread: ensured })))._tag).toBe(
            "ProviderAdapterProtocolError",
          );
          runtime.authority_epoch = 4;
          runtime.profile_id = "/other";
          expect(
            (yield* Effect.flip(opened.ensureThread({ threadId, modelSelection, runtimePolicy })))
              ._tag,
          ).toBe("ProviderAdapterProtocolError");
          runtime.profile_id = "/profile";
          expect(
            (yield* Effect.flip(
              opened.resumeThread({
                providerThread: {
                  ...ensured,
                  nativeThreadRef: {
                    driver: HERMES_PROVIDER,
                    nativeId: "session-b",
                    strength: "strong",
                  },
                },
              }),
            ))._tag,
          ).toBe("ProviderAdapterProtocolError");
          failResume = true;
          expect((yield* Effect.flip(opened.resumeThread({ providerThread: ensured })))._tag).toBe(
            "ProviderAdapterProtocolError",
          );
          failResume = false;
          failSend = true;
          expect((yield* Effect.flip(opened.resumeThread({ providerThread: ensured })))._tag).toBe(
            "ProviderAdapterProtocolError",
          );
          failSend = false;
          malformedMessage = true;
          expect((yield* Effect.flip(opened.resumeThread({ providerThread: ensured })))._tag).toBe(
            "ProviderAdapterProtocolError",
          );
          malformedMessage = false;
          sockets.at(-1)!.close();
          fetchMock.mockRejectedValueOnce(new Error("ticket failed"));
          expect((yield* Effect.flip(opened.resumeThread({ providerThread: ensured })))._tag).toBe(
            "ProviderAdapterProtocolError",
          );
          expect(
            (yield* opened.readThreadSnapshot({ providerThread: ensured })).providerThread,
          ).toEqual(ensured);
          expect((yield* Effect.flip(opened.startTurn({} as never)))._tag).toBe(
            "ProviderAdapterProtocolError",
          );
          return ensured;
        }),
      );
      expect(thread.nativeThreadRef?.nativeId).toBe("session-a");
      expect(calls.filter(({ method }) => method === "session.create")).toHaveLength(1);
      expect(calls.find(({ method }) => method === "session.create")?.params.request_id).toMatch(
        /^t3-/,
      );
      expect(calls.filter(({ method }) => method === "session.resume").length).toBeGreaterThan(0);
    }),
  );
  it.effect("rejects endpoint, state-directory, and cleartext misconfiguration", () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-config-"));
      cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
      const cwd = NodePath.join(directory, "work");
      NodeFS.mkdirSync(cwd);
      const settings = decodeHermesSettings({
        enabled: true,
        endpoint: "ws://hermes.test/api/ws",
        profileId: "/profile",
        principalId: "uid:1000",
      });
      process.env.HERMES_SESSION_TOKEN = "secret";
      process.env.HERMES_GATEWAY_URL = "ws://other.test/api/ws";
      process.env.HERMES_STATE_DIR = NodePath.join(directory, "state");
      process.env.HERMES_ALLOW_CLEARTEXT = "1";
      cleanups.push(() => {
        delete process.env.HERMES_SESSION_TOKEN;
        delete process.env.HERMES_GATEWAY_URL;
        delete process.env.HERMES_STATE_DIR;
        delete process.env.HERMES_ALLOW_CLEARTEXT;
      });
      const instanceId = ProviderInstanceId.make("hermes-test");
      const adapter = makeHermesAdapterV2({ instanceId, settings });
      const input = {
        threadId: ThreadId.make("thread-config"),
        providerSessionId: ProviderSessionId.make("provider-session-config"),
        modelSelection: { instanceId, model: "default" },
        runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" } as const,
      };
      const openError = () => Effect.scoped(Effect.flip(adapter.openSession(input)));
      expect((yield* openError())._tag).toBe("ProviderAdapterProtocolError");
      process.env.HERMES_GATEWAY_URL = settings.endpoint;
      process.env.HERMES_STATE_DIR = cwd;
      expect((yield* openError())._tag).toBe("ProviderAdapterProtocolError");
      process.env.HERMES_STATE_DIR = NodePath.join(directory, "state");
      delete process.env.HERMES_ALLOW_CLEARTEXT;
      expect((yield* openError())._tag).toBe("ProviderAdapterProtocolError");
    }),
  );
});
