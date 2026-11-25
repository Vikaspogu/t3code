// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
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
  vi.restoreAllMocks();
});

describe("HermesSessionStore", () => {
  it("preserves the exact turn input across reopen and rejects a changed retry", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-turn-"));
    cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
    const path = NodePath.join(directory, "sessions.sqlite3");
    const store = new HermesSessionStore(path);
    const identity = {
      threadId: "thread-1",
      profileId: "profile-1",
      instanceId: "instance-1",
      principalId: "uid:1000",
      authorityEpoch: 1,
    };
    const reservation = store.reserve(identity);
    const turn = {
      ...identity,
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      text: "exact\ninput",
    };
    try {
      expect(() => store.reserveTextTurn(turn)).toThrow("session mapping");
      store.bind(identity.threadId, reservation.requestId, turn.sessionId);
      const payload = store.reserveTextTurn(turn);
      expect(payload).toEqual({
        session_id: "session-1",
        input_id: expect.any(String),
        text: "exact\ninput",
      });
      const reopened = new HermesSessionStore(path);
      try {
        expect(reopened.reserveTextTurn(turn)).toEqual(payload);
        expect(() =>
          reopened.reserveTextTurn({
            ...turn,
            image: {
              attachmentId: "image-1",
              filename: "image.png",
              mime: "image/png",
              contentBase64: "AAECAw==",
            },
          }),
        ).toThrow("different input");
        expect(() => reopened.reserveTextTurn({ ...turn, text: "changed" })).toThrow(
          "different input",
        );
        expect(() => reopened.reserveTextTurn({ ...turn, principalId: "uid:1001" })).toThrow(
          "session mapping",
        );
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
    }
  });

  it("keeps image intent immutable across turn reservation retries", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-image-intent-"));
    cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
    const store = new HermesSessionStore(NodePath.join(directory, "sessions.sqlite3"));
    try {
      const identity = {
        threadId: "thread-1",
        profileId: "profile-1",
        instanceId: "instance-1",
        principalId: "uid:1000",
        authorityEpoch: 1,
      };
      const { requestId } = store.reserve(identity);
      const sessionId = "session-1";
      store.bind(identity.threadId, requestId, sessionId);
      const turn = {
        ...identity,
        sessionId,
        runId: "run-1",
        attemptId: "attempt-1",
        text: "original",
      };
      const image = {
        attachmentId: "image-1",
        filename: "image.png",
        mime: "image/png" as const,
        contentBase64: "AAECAw==",
      };
      const imageTurn = { ...turn, image };
      const { input_id: inputId } = store.reserveTextTurn(imageTurn);
      expect(() => store.reserveTextTurn(turn)).toThrow("different input");
      store.claimPendingImage(inputId);
      store.recordAttachedImage({
        inputId,
        attachmentId: image.attachmentId,
        path: "/profile/cache/images/image.png",
        mime: image.mime,
        bytes: 4,
      });
      expect(() =>
        store.reserveTextTurn({ ...turn, image: { ...image, contentBase64: "BAUGBw==" } }),
      ).toThrow("different input");
      const { contentBase64, ...metadata } = image;
      expect(
        store.reserveTextTurn({ ...turn, image: { contentBase64, ...metadata } }).input_id,
      ).toBe(inputId);
      expect(store.getPendingImage(inputId)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("journals the exact admission and retains its terminal receipt across reopen", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-receipt-"));
    cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
    const path = NodePath.join(directory, "sessions.sqlite3");
    const identity = {
      threadId: "thread-1",
      profileId: "profile-1",
      instanceId: "instance-1",
      principalId: "uid:1000",
      authorityEpoch: 1,
    };
    const sessionId = "session-1";
    const started = {
      admission_id: "admission-1",
      ref: { profile_id: identity.profileId, session_id: sessionId },
      sequence: 1,
      status: "started",
      outcome: null,
      authority_epoch: 1,
      execution_generation: 2,
    };
    const terminal = { ...started, status: "terminal", outcome: "completed" };
    const store = new HermesSessionStore(path);
    let inputId: string;
    try {
      const reservation = store.reserve(identity);
      store.bind(identity.threadId, reservation.requestId, sessionId);
      inputId = store.reserveTextTurn({
        ...identity,
        sessionId,
        runId: "run-1",
        attemptId: "attempt-1",
        text: "input",
      }).input_id;
      expect(() =>
        store.recordTextTurnReceipt(inputId, { ...started, authority_epoch: 2 }),
      ).toThrow();
      expect(() =>
        store.recordTextTurnReceipt(inputId, {
          ...started,
          ref: { ...started.ref, session_id: "other" },
        }),
      ).toThrow();
      expect(store.getTextTurnReceipt(inputId)).toBeNull();
      const next = { ...identity, sessionId, runId: "run-2", attemptId: "attempt-2", text: "next" };
      const secondConnection = new HermesSessionStore(path);
      try {
        expect(() => secondConnection.reserveTextTurn(next)).toThrow("unresolved");
        expect(store.recordTextTurnReceipt(inputId, started)).toEqual(started);
        expect(() => secondConnection.reserveTextTurn(next)).toThrow("unresolved");
        const prompt = {
          kind: "approval",
          prompt_id: "approval-1",
          execution_generation: 2,
          command: "example",
          choices: ["deny"],
        };
        expect(store.recordTextTurnInteraction(inputId, "admission-1", prompt).state).toBe(
          "pending",
        );
        store.settleTextTurnInteraction(inputId, "approval-1", "resolved");
        expect(store.recordTextTurnInteraction(inputId, "admission-1", prompt).state).toBe(
          "resolved",
        );
        expect(store.settleTextTurnInteraction(inputId, "approval-1", "resolved")).toBe("resolved");
        expect(store.settleTextTurnInteraction(inputId, "approval-1", "expired")).toBe("resolved");
        expect(() => store.settleTextTurnInteraction(inputId, "missing", "resolved")).toThrow(
          "missing or contradicts",
        );
      } finally {
        secondConnection.close();
      }
      expect(() =>
        store.recordTextTurnReceipt(inputId, { ...terminal, admission_id: "other" }),
      ).toThrow();
      expect(() =>
        store.recordTextTurnReceipt(inputId, { ...terminal, execution_generation: 3 }),
      ).toThrow();
      expect(store.recordTextTurnReceipt(inputId, terminal)).toEqual(terminal);
    } finally {
      store.close();
    }
    const reopened = new HermesSessionStore(path);
    try {
      expect(reopened.getTextTurnReceipt(inputId)).toEqual(terminal);
      expect(() => reopened.recordTextTurnReceipt(inputId, started)).toThrow();
      expect(reopened.recordTextTurnReceipt(inputId, terminal)).toEqual(terminal);
      expect(
        reopened.reserveTextTurn({
          ...identity,
          sessionId,
          runId: "run-2",
          attemptId: "attempt-2",
          text: "next",
        }).input_id,
      ).not.toBe(inputId);
    } finally {
      reopened.close();
    }
  });
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
      let dropAfterDescribe = false;
      let resumeEpoch = runtime.authority_epoch;
      let redirectedSessionId: string | undefined;
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
                  ? {
                      session_id: redirectedSessionId ?? params.session_id,
                      authority_epoch: resumeEpoch,
                      execution_generation: 0,
                    }
                  : null;
          queueMicrotask(() => {
            const dropping = dropAfterDescribe && rpc.method === "runtime.describe";
            // A queued response can be delivered after the transport stops accepting writes.
            if (dropping) this.readyState = 2;
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
            );
            if (dropping) this.close();
          });
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
          const beforeDrop = calls.length;
          dropAfterDescribe = true;
          const dropped = yield* Effect.result(opened.resumeThread({ providerThread: ensured }));
          dropAfterDescribe = false;
          expect(calls.slice(beforeDrop).map(({ method }) => method)).toEqual(["runtime.describe"]);
          expect(dropped._tag).toBe("Failure");
          expect((yield* opened.resumeThread({ providerThread: ensured })).nativeThreadRef).toEqual(
            ensured.nativeThreadRef,
          );
          resumeEpoch = 5;
          expect(
            yield* Effect.flip(opened.resumeThread({ providerThread: ensured })),
          ).toMatchObject({
            _tag: "ProviderAdapterProtocolError",
            detail: "Invalid Hermes session.resume response",
            cause: {
              message: "Hermes session.resume authority epoch does not match runtime.describe",
            },
          });
          resumeEpoch = 4;
          const beforeRedirect = calls.length;
          redirectedSessionId = "session-b";
          expect(
            yield* Effect.flip(opened.resumeThread({ providerThread: ensured })),
          ).toMatchObject({
            detail: "Hermes resumed a different session",
          });
          expect(calls.slice(beforeRedirect)).toMatchObject([
            { method: "runtime.describe" },
            { method: "session.resume", params: { session_id: "session-a" } },
          ]);
          redirectedSessionId = undefined;
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
          expect(opened.canResumeAfterRestart).toBe(false);
          expect(opened.resumeTurn).toBeUndefined();
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
      const environment: NodeJS.ProcessEnv = {
        HERMES_SESSION_TOKEN: "secret",
        HERMES_GATEWAY_URL: "ws://other.test/api/ws",
        HERMES_STATE_DIR: NodePath.join(directory, "state"),
        HERMES_ALLOW_CLEARTEXT: "1",
      };
      const instanceId = ProviderInstanceId.make("hermes-test");
      const adapter = makeHermesAdapterV2({ instanceId, settings, environment });
      const input = {
        threadId: ThreadId.make("thread-config"),
        providerSessionId: ProviderSessionId.make("provider-session-config"),
        modelSelection: { instanceId, model: "default" },
        runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" } as const,
      };
      const openError = () => Effect.scoped(Effect.flip(adapter.openSession(input)));
      expect((yield* openError())._tag).toBe("ProviderAdapterProtocolError");
      environment.HERMES_GATEWAY_URL = settings.endpoint;
      environment.HERMES_STATE_DIR = cwd;
      expect((yield* openError())._tag).toBe("ProviderAdapterProtocolError");
      environment.HERMES_STATE_DIR = NodePath.relative(
        process.cwd(),
        NodePath.join(directory, "state"),
      );
      expect(yield* openError()).toMatchObject({
        _tag: "ProviderAdapterProtocolError",
        detail: expect.stringContaining("absolute external HERMES_STATE_DIR"),
      });
      environment.HERMES_STATE_DIR = NodePath.join(directory, "state");
      delete environment.HERMES_ALLOW_CLEARTEXT;
      expect((yield* openError())._tag).toBe("ProviderAdapterProtocolError");
    }),
  );
});

describe("HermesAdapterV2 G2 text turns", () => {
  const threadId = ThreadId.make("thread-g2");
  const instanceId = ProviderInstanceId.make("hermes-g2");
  const modelSelection = { instanceId, model: "default" };

  const installSocket = () => {
    const state = {
      calls: [] as Array<{ method: string; params: Record<string, unknown>; socket: number }>,
      submissions: [] as Array<Record<string, unknown>>,
      admissions: new Map<
        string,
        { admission: string; text: string; outcome: string; ownerEpoch: number }
      >(),
      events: [] as Array<Record<string, unknown>>,
      sockets: [] as Array<{ close: () => void }>,
      dropNextSubmit: false,
      dropNextResponse: false,
      omitSubmitResult: false,
      receiptOverride: null as null | "unknown" | "unavailable",
      failNextResponseSend: false,
      imageBytes: 4 as number | null,
      imageMime: "image/png" as string,

      restartStatus: null as null | "queued" | "started" | "unknown" | "terminal",
      restartOutcome: "interrupted" as string | null,
      dropNextCleanup: false,
      interruptsBeforeSettlement: 0,
      wrongRecoveryIdentity: false,
      missingRecoveryPending: false,
      omitResumeState: false,
      resumePending: null as null | ReadonlyArray<Record<string, unknown>>,
      duplicateRecoveryPending: false,
      refuseSubmit: false,
      finishTurn: null as (() => void) | null,
      interruptAck: {} as {
        sessionId?: string;
        profileId?: string;
        instanceId?: string;
        authorityEpoch?: number;
        executionGeneration?: number;
      },
      replayMode: "normal" as "normal" | "gap" | "epoch" | "authority",
      wrongAdmission: false,
      wrongEventAuthority: false,
      nextOutcome: "completed" as "completed" | "interrupted" | "cancelled",
      queueBeforeStart: false,
      prompt: null as null | {
        kind: "approval" | "clarify";
        promptId: string;
        generation?: number;
        choices?: string[];
        duplicate?: boolean;
      },
      promptAnswers: [] as Array<Record<string, unknown>>,
      dropTurnStream: false,
      splitTurnStream: false,
      setCurrentAuthority: () => {},
      sequence: 0,
    };
    const runtime = {
      profile_id: "/profile",
      instance_id: "instance-a",
      authority_epoch: 4,
      capabilities: ["durable-admission-v1", "event-replay-v1"],
    };
    state.setCurrentAuthority = () => {
      runtime.instance_id = "instance-b";
      runtime.authority_epoch = 5;
    };
    const authorityFor = (socketNumber: number) =>
      state.restartStatus && socketNumber > 1
        ? 5
        : state.replayMode === "authority" && socketNumber > 1
          ? 5
          : runtime.authority_epoch;
    const instanceFor = (socketNumber: number) =>
      state.restartStatus && socketNumber > 1 ? "instance-b" : runtime.instance_id;
    class MockWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = 0;
      readonly socketNumber = state.sockets.length + 1;

      constructor() {
        super();
        state.sockets.push(this);
        queueMicrotask(() => {
          this.readyState = MockWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        });
      }

      emit(frame: Record<string, unknown>): void {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
      }
      event(frame: Record<string, unknown>): void {
        this.emit({ id: null, method: "event", params: frame });
      }

      respond(id: unknown, result: unknown): void {
        this.emit({ jsonrpc: "2.0", id, result });
      }

      close(): void {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }

      send(data: string, callback: (error?: Error) => void): void {
        const rpc = JSON.parse(data);
        if (
          state.failNextResponseSend &&
          (rpc.method === "approval.respond" || rpc.method === "clarify.respond")
        ) {
          state.failNextResponseSend = false;
          callback(new Error("response send failed"));
          return;
        }
        callback();
        const params = rpc.params ?? {};
        state.calls.push({ method: rpc.method, params, socket: this.socketNumber });
        queueMicrotask(() => {
          if (rpc.method === "runtime.describe") {
            this.respond(rpc.id, {
              ...runtime,
              instance_id: instanceFor(this.socketNumber),
              authority_epoch: authorityFor(this.socketNumber),
            });
            return;
          }
          if (rpc.method === "session.create") {
            this.respond(rpc.id, { session_id: "session-a" });
            return;
          }
          if (rpc.method === "session.resume") {
            const admission = [...state.admissions.entries()].at(-1);
            const prompt = state.prompt
              ? {
                  kind: state.prompt.kind,
                  prompt_id: state.prompt.promptId,
                  execution_generation: state.prompt.generation ?? 1,
                  ...(state.prompt.kind === "approval"
                    ? {
                        command: "rm -rf /tmp/example",
                        choices: state.prompt.choices ?? ["once", "session", "always", "deny"],
                      }
                    : { question: "Continue?", choices: ["yes", "no"], multi_select: false }),
                }
              : null;
            const pending =
              state.prompt && admission && state.restartStatus !== "terminal"
                ? {
                    input_id: admission[0],
                    admission_id: admission[1].admission,
                    status: state.restartStatus ?? "started",
                    sequence: 1,
                    execution_generation: state.restartStatus === "queued" ? null : 1,
                    ref: { profile_id: "/profile", session_id: "session-a" },
                    authority_epoch: admission[1].ownerEpoch,
                  }
                : null;
            this.respond(rpc.id, {
              session_id: "session-a",
              stored_session_id: "session-a",
              authority_epoch: authorityFor(this.socketNumber),
              execution_generation: 1,
              replay_epoch: "epoch-a",
              last_sequence: state.sequence,
              ...(state.resumePending
                ? { pending: state.resumePending, prompts: [] }
                : !state.omitResumeState &&
                  (pending && !state.missingRecoveryPending
                    ? {
                        pending: [pending, ...(state.duplicateRecoveryPending ? [pending] : [])],
                        prompts: state.restartStatus
                          ? []
                          : [prompt, ...(state.prompt?.duplicate ? [prompt] : [])],
                      }
                    : state.restartStatus ||
                        state.events.some(
                          (event) =>
                            event.type === "message.complete" &&
                            event.admission_id === admission?.[1].admission,
                        )
                      ? { pending: [], prompts: [] }
                      : {})),
            });
            const recoveredInputId = state.resumePending?.[0]?.input_id;
            const recovered =
              typeof recoveredInputId === "string"
                ? state.admissions.get(recoveredInputId)
                : undefined;
            if (state.resumePending?.length === 1 && recovered) {
              const complete = {
                type: "message.complete",
                seq: ++state.sequence,
                session_id: "session-a",
                replay_epoch: "epoch-a",
                authority_epoch: recovered.ownerEpoch,
                execution_generation: 1,
                admission_id: recovered.admission,
                payload: { status: "complete", outcome: recovered.outcome, text: recovered.text },
              };
              state.events.push(complete);
              queueMicrotask(() => this.event(complete));
            }
            if (state.dropTurnStream && this.socketNumber > 1) this.close();
            return;
          }
          if (rpc.method === "session.events.since") {
            if (state.replayMode === "epoch" || params.replay_epoch !== "epoch-a") {
              this.respond(rpc.id, {
                snapshot_required: true,
                truncated: false,
                replay_epoch: "epoch-a",
                last_sequence: state.sequence,
                events: [],
              });
              return;
            }
            let events = state.events.filter(
              (event) => Number(event.seq) > Number(params.last_sequence),
            );
            if (state.replayMode === "gap" && events.length > 0) {
              events = [{ ...events[0]!, seq: Number(events[0]!.seq) + 1 }, ...events.slice(1)];
            }
            this.respond(rpc.id, {
              snapshot_required: false,
              truncated: false,
              replay_epoch: "epoch-a",
              last_sequence: state.sequence,
              events,
            });
            for (const frame of events) queueMicrotask(() => this.event(frame));
            return;
          }
          if (rpc.method === "prompt.receipt") {
            if (state.receiptOverride === "unavailable") {
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: JSON.stringify({
                    jsonrpc: "2.0",
                    id: rpc.id,
                    error: { code: -32603, message: "receipt unavailable" },
                  }),
                }),
              );
              return;
            }
            const admission = String(params.admission_id);
            const existing = [...state.admissions.values()].find(
              (entry) => entry.admission === admission,
            )!;
            const restarted = state.restartStatus !== null;
            const status =
              state.receiptOverride ??
              (restarted
                ? state.restartStatus!
                : state.queueBeforeStart && state.prompt
                  ? "started"
                  : "terminal");
            this.respond(rpc.id, {
              admission_id: state.wrongRecoveryIdentity ? "foreign-admission" : admission,
              ref: {
                profile_id: "/profile",
                session_id: state.wrongRecoveryIdentity ? "foreign-session" : "session-a",
              },
              sequence: 1,
              status,
              outcome:
                status === "terminal"
                  ? restarted
                    ? state.restartOutcome
                    : existing.outcome
                  : null,
              authority_epoch: state.wrongRecoveryIdentity ? 3 : existing.ownerEpoch,
              execution_generation: state.wrongRecoveryIdentity
                ? 2
                : status === "queued" || (!restarted && existing.outcome === "cancelled")
                  ? null
                  : 1,
              ...(status === "terminal"
                ? {
                    result: {
                      final_response: restarted ? "recovered" : existing.text,
                      error: null,
                      messages: [{ role: "tool", content: "do not persist tool output" }],
                    },
                    usage: { input_tokens: 1, output_tokens: 1 },
                  }
                : {}),
            });
            return;
          }
          if (rpc.method === "image.attach_bytes") {
            this.respond(rpc.id, {
              attached: true,
              path: "/profile/cache/images/upload-1.png",
              mime: state.imageMime,
              ...(state.imageBytes === null ? {} : { bytes: state.imageBytes }),
            });
            return;
          }
          if (rpc.method === "prompt.submit") {
            state.submissions.push(params);
            if (state.refuseSubmit) {
              this.emit({
                jsonrpc: "2.0",
                id: rpc.id,
                error: { code: -32000, message: "permission_denied" },
              });
              return;
            }
            const inputId = String(params.input_id);
            const existing = state.admissions.get(inputId);
            if (existing) {
              this.respond(rpc.id, {
                admission_id: existing.admission,
                ref: { profile_id: "/profile", session_id: "session-a" },
                sequence: 1,
                status: "terminal",
                outcome: existing.outcome,
                authority_epoch: existing.ownerEpoch,
                execution_generation: existing.outcome === "cancelled" ? null : 1,
                ...(state.omitSubmitResult ? {} : { result: { final_response: existing.text } }),
              });
              return;
            }
            const admission = `admission-${state.admissions.size + 1}`;
            const visibleAdmission = state.wrongAdmission ? "foreign-admission" : admission;
            const outcome = state.nextOutcome;
            state.nextOutcome = "completed";
            const queued = outcome === "cancelled";
            const text = queued ? "" : admission === "admission-1" ? "hello" : "replayed";
            state.admissions.set(inputId, {
              admission,
              text,
              outcome,
              ownerEpoch: authorityFor(this.socketNumber),
            });
            const deltas = admission === "admission-1" ? ["hel", null, "lo"] : [text];
            const frames = (
              queued
                ? [
                    {
                      type: "message.complete",
                      payload: { text: "", content: "", admission_id: admission, outcome },
                    },
                  ]
                : [
                    { type: "message.start", payload: { role: "assistant", part_id: "part-1" } },
                    ...deltas.map((delta) => ({
                      type: "message.delta",
                      payload: { part_id: "part-1", role: "assistant", text: delta },
                    })),
                    {
                      type: "message.complete",
                      payload: {
                        part_id: "part-1",
                        role: "assistant",
                        status: outcome === "interrupted" ? "interrupted" : "complete",
                        outcome: outcome === "interrupted" ? "cancelled" : outcome,
                        text,
                      },
                    },
                  ]
            ).map((frame) => ({
              ...frame,
              seq: ++state.sequence,
              session_id: "session-a",
              replay_epoch: "epoch-a",
              authority_epoch: state.wrongEventAuthority ? 6 : authorityFor(this.socketNumber),
              ...(queued ? {} : { execution_generation: 1 }),
              admission_id: visibleAdmission,
            }));
            if (!state.dropTurnStream && !state.prompt) state.events.push(...frames);
            else if (!state.prompt) state.sequence -= frames.length;
            if (state.dropNextSubmit) {
              state.dropNextSubmit = false;
              this.close();
              return;
            }
            this.respond(rpc.id, {
              admission_id: admission,
              ref: { profile_id: "/profile", session_id: "session-a" },
              sequence: 1,
              status: queued || state.queueBeforeStart ? "queued" : "started",
              outcome: null,
              authority_epoch: authorityFor(this.socketNumber),
              execution_generation: queued || state.queueBeforeStart ? null : 1,
            });
            if (state.prompt) {
              state.sequence -= frames.length;
              if (state.queueBeforeStart) {
                const start = { ...frames[0]!, seq: ++state.sequence };
                state.events.push(start);
                this.event(start);
              }
              const prompt = {
                type: `${state.prompt.kind}.request`,
                seq: ++state.sequence,
                session_id: "session-a",
                replay_epoch: "epoch-a",
                authority_epoch: authorityFor(this.socketNumber),
                admission_id: admission,
                execution_generation: state.prompt.generation ?? 1,
                payload: {
                  kind: state.prompt.kind,
                  prompt_id: state.prompt.promptId,
                  execution_generation: state.prompt.generation ?? 1,
                  ...(state.prompt.kind === "approval"
                    ? {
                        command: "rm -rf /tmp/example",
                        choices: state.prompt.choices ?? ["once", "session", "always", "deny"],
                      }
                    : { question: "Continue?", choices: ["yes", "no"], multi_select: false }),
                },
              };
              state.events.push(prompt);
              if (!state.dropTurnStream) this.event(prompt);
              return;
            }
            if (state.dropTurnStream) this.close();
            else if (state.splitTurnStream) {
              for (const frame of frames.slice(0, -1)) this.event(frame);
            } else if (outcome !== "completed") {
              state.finishTurn = () => {
                for (const frame of frames) this.event(frame);
              };
            } else for (const frame of frames) this.event(frame);
            return;
          }
          if (rpc.method === "prompt.resolve_unknown") {
            expect(params).toEqual({
              session_id: "session-a",
              admission_id: [...state.admissions.values()].at(-1)?.admission,
              execution_generation: 1,
            });
            state.restartStatus = "terminal";
            state.restartOutcome = "interrupted";
            if (state.dropNextCleanup) {
              state.dropNextCleanup = false;
              this.emit({
                jsonrpc: "2.0",
                id: rpc.id,
                error: { code: -32000, message: "response lost" },
              });
              return;
            }
            this.respond(rpc.id, {
              admission_id: params.admission_id,
              ref: { profile_id: "/profile", session_id: "session-a" },
              sequence: 1,
              status: "terminal",
              outcome: "interrupted",
              authority_epoch: 4,
              execution_generation: 1,
            });
            return;
          }
          if (rpc.method === "approval.respond" || rpc.method === "clarify.respond") {
            const prompt = state.prompt;
            const expectedKeys = [
              "session_id",
              "execution_generation",
              "prompt_id",
              rpc.method === "approval.respond" ? "choice" : "answer",
            ].sort();
            if (
              JSON.stringify(Object.keys(params).sort()) !== JSON.stringify(expectedKeys) ||
              params.session_id !== "session-a" ||
              params.execution_generation !== (prompt?.generation ?? 1) ||
              (prompt && rpc.method !== `${prompt.kind}.respond`)
            ) {
              throw new Error(`Invalid canonical response params ${JSON.stringify(params)}`);
            }
            if (
              prompt?.kind === "approval" &&
              !(prompt.choices ?? ["once", "session", "always", "deny"]).includes(params.choice)
            ) {
              throw new Error("Hermes approval choice was not offered");
            }
            if (state.dropNextResponse) {
              state.dropNextResponse = false;
              this.close();
              return;
            }
            if (prompt) state.promptAnswers.push(params);
            const admissionId = [...state.admissions.values()].at(-1)!.admission;
            state.prompt = null;
            this.respond(rpc.id, {
              status: prompt ? "resolved" : "already_resolved",
              prompt_id: params.prompt_id,
            });
            if (prompt) {
              const settled = {
                type: `${prompt.kind}.settled`,
                seq: ++state.sequence,
                session_id: "session-a",
                replay_epoch: "epoch-a",
                authority_epoch: authorityFor(this.socketNumber),
                admission_id: admissionId,
                execution_generation: 1,
                payload: { prompt_id: prompt.promptId, execution_generation: 1 },
              };
              const complete = {
                type: "message.complete",
                seq: ++state.sequence,
                session_id: "session-a",
                replay_epoch: "epoch-a",
                authority_epoch: authorityFor(this.socketNumber),
                admission_id: admissionId,
                execution_generation: 1,
                payload: { status: "complete", outcome: "completed", text: "answered" },
              };
              state.events.push(settled, complete);
              if (prompt.promptId === "approval-4") {
                state.finishTurn = () => {
                  this.event(settled);
                  this.event(complete);
                };
              } else {
                this.event(settled);
                this.event(complete);
              }
            }
            return;
          }
          if (rpc.method === "session.interrupt") {
            if (state.restartStatus === "started") {
              if (state.interruptsBeforeSettlement > 0) {
                state.interruptsBeforeSettlement -= 1;
              } else {
                state.restartStatus = "terminal";
                state.restartOutcome = "interrupted";
              }
              if (state.dropNextCleanup) {
                state.dropNextCleanup = false;
                this.emit({
                  jsonrpc: "2.0",
                  id: rpc.id,
                  error: { code: -32000, message: "response lost" },
                });
                return;
              }
            }
            this.respond(rpc.id, {
              ref: {
                profile_id: state.interruptAck.profileId ?? "/profile",
                session_id: state.interruptAck.sessionId ?? "session-a",
              },
              instance_id: state.interruptAck.instanceId ?? instanceFor(this.socketNumber),
              authority_epoch: state.interruptAck.authorityEpoch ?? authorityFor(this.socketNumber),
              execution_generation: state.interruptAck.executionGeneration ?? 1,
              execution_state: "running",
              revision: 0,
            });
            return;
          }
          throw new Error(`Unexpected RPC ${rpc.method}`);
        });
      }
    }
    socketMock.current = MockWebSocket as never;
    return state;
  };

  const configure = (directory: string) => {
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
    cleanups.push(() => {
      delete process.env.HERMES_SESSION_TOKEN;
      delete process.env.HERMES_GATEWAY_URL;
      delete process.env.HERMES_STATE_DIR;
      delete process.env.HERMES_ALLOW_CLEARTEXT;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ticket: "ticket-a" })),
    );
    NodeFS.mkdirSync(NodePath.join(directory, "work"), { recursive: true });
    return settings;
  };

  const turnInput = (
    providerThread: OrchestrationV2ProviderThread,
    cwd: string,
    run: number,
    text: string,
  ): ProviderAdapter.ProviderAdapterV2TurnInput => ({
    appThread: {} as never,
    threadId,
    runId: RunId.make(`run-${run}`),
    runOrdinal: run,
    providerTurnOrdinal: run,
    attemptId: RunAttemptId.make(`attempt-${run}`),
    rootNodeId: NodeId.make(`node-${run}`),
    providerThread,
    message: {
      messageId: MessageId.make(`message-${run}`),
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
  });

  const runSelectionTurn = (
    selection: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"],
    restartBeforeStart = false,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-g3-mutation-"));
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        const settings = configure(directory);
        const cwd = NodePath.join(directory, "work");
        const adapter = makeHermesAdapterV2({ instanceId, settings, enableTextTurnsForTest: true });
        const opened = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-g3-mutation"),
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const providerThread = yield* opened.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const transition = yield* adapter.planSelectionTransition({
          current: modelSelection,
          target: selection,
          sessionCapabilities: yield* adapter.getCapabilities(),
        });
        if (restartBeforeStart) {
          state.restartStatus = "unknown";
          state.sockets.at(-1)!.close();
        }
        const input = turnInput(providerThread, cwd, 1, "use the requested model selection");
        const result = yield* Effect.result(
          opened.startTurn({ ...input, modelSelection: selection }),
        );
        return { state, result, transition };
      }),
    );

  it.live("refuses a new turn on a changed Gateway before touching a session", () =>
    Effect.gen(function* () {
      const { state, result } = yield* runSelectionTurn(modelSelection, true);
      expect(result._tag).toBe("Failure");
      expect(state.calls.filter(({ socket }) => socket > 1).map(({ method }) => method)).toEqual([
        "runtime.describe",
      ]);
      expect(state.submissions).toEqual([]);
    }).pipe(Effect.timeout("10 seconds")),
  );

  const runD6Turn = (
    state: ReturnType<typeof installSocket>,
    beforeStart?: (original: ReturnType<HermesSessionStore["reserveTextTurn"]> | null) => void,
    reserve = true,
    image?: {
      readonly attachmentId: string;
      readonly filename: string;
      readonly mime: "image/png";
      readonly contentBase64: string;
    },
  ) =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-g3-d6-"));
      cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
      const settings = configure(directory);
      const cwd = NodePath.join(directory, "work");
      const path = NodePath.join(directory, "state", "sessions.sqlite3");
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      const identity = {
        threadId,
        profileId: "/profile",
        instanceId: "instance-a",
        principalId: "uid:1000",
        authorityEpoch: 4,
      };
      const reservationStore = new HermesSessionStore(path);
      const original = (() => {
        try {
          const reservation = reservationStore.reserve(identity);
          reservationStore.bind(threadId, reservation.requestId, "session-a");
          return reserve
            ? reservationStore.reserveTextTurn({
                ...identity,
                sessionId: "session-a",
                runId: RunId.make("run-1"),
                attemptId: RunAttemptId.make("attempt-1"),
                text: "exact journal-only input",
                ...(image ? { image } : {}),
              })
            : null;
        } finally {
          reservationStore.close();
        }
      })();

      const adapter = makeHermesAdapterV2({ instanceId, settings, enableTextTurnsForTest: true });
      const opened = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-g2"),
        modelSelection,
        runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
      });
      const providerThread = yield* opened.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
      });
      const terminalQueue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const observed: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      yield* Stream.runForEach(opened.events, (event) =>
        Effect.gen(function* () {
          observed.push(event);
          yield* Queue.offer(terminalQueue, event);
        }),
      ).pipe(Effect.forkScoped);
      beforeStart?.(original);
      yield* opened
        .startTurn({
          ...turnInput(providerThread, cwd, 1, original?.text ?? "missing reservation"),
          resume: true,
        })
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              if (state.receiptOverride !== "unavailable" || !original) return;
              const store = new HermesSessionStore(path);
              try {
                expect(store.getTextTurnReceipt(original.input_id)).toBeNull();
              } finally {
                store.close();
              }
            }),
          ),
        );
      let terminal: ProviderAdapter.ProviderAdapterV2Event;
      while (true) {
        const event = yield* Queue.take(terminalQueue);
        if (event.type === "turn.terminal") {
          terminal = event;
          break;
        }
      }
      const receiptStore = new HermesSessionStore(path);
      const receipt = original ? receiptStore.getTextTurnReceipt(original.input_id) : null;
      receiptStore.close();
      return { directory, original, observed, receipt, terminal };
    });

  it.live("D6 leaves the receipt uncommitted when the terminal result lookup fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = installSocket();
        const error = yield* Effect.flip(
          runD6Turn(state, (reserved) => {
            state.admissions.set(reserved!.input_id, {
              admission: "admission-pending",
              text: "joined",
              outcome: "completed",
              ownerEpoch: 4,
            });
            state.resumePending = [];
            state.omitSubmitResult = true;
            state.receiptOverride = "unavailable";
          }),
        );
        expect(error).toMatchObject({ _tag: "ProviderAdapterProtocolError" });
        expect(state.submissions).toHaveLength(1);
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  it.live("D6 fetches the result when an exact submit returns only terminal metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = installSocket();
        const { directory, original, observed, terminal } = yield* runD6Turn(state, (reserved) => {
          state.admissions.set(reserved!.input_id, {
            admission: "admission-pending",
            text: "joined",
            outcome: "completed",
            ownerEpoch: 4,
          });
          state.resumePending = [];
          state.omitSubmitResult = true;
        });

        expect(terminal).toMatchObject({ type: "turn.terminal", status: "completed" });
        expect(observed).toContainEqual(
          expect.objectContaining({
            type: "message.updated",
            message: expect.objectContaining({ text: "joined", streaming: false }),
          }),
        );
        expect(state.submissions).toHaveLength(1);
        expect(state.calls.filter((call) => call.method === "prompt.receipt")).toEqual([
          expect.objectContaining({
            params: {
              session_id: "session-a",
              admission_id: "admission-pending",
              include_result: true,
            },
          }),
        ]);
        const db = new NodeSqlite.DatabaseSync(
          NodePath.join(directory, "state", "sessions.sqlite3"),
          { readOnly: true },
        );
        try {
          const row = db
            .prepare("SELECT receipt_json FROM hermes_text_receipts WHERE input_id = ?")
            .get(original!.input_id);
          expect(JSON.parse(String(row?.receipt_json)).result).toEqual({
            final_response: "joined",
          });
        } finally {
          db.close();
        }
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  const d6Pending = (original: ReturnType<HermesSessionStore["reserveTextTurn"]>) => ({
    input_id: original.input_id,
    admission_id: "admission-pending",
    status: "started",
    outcome: null,
    sequence: 1,
    execution_generation: 1,
    ref: { profile_id: "/profile", session_id: "session-a" },
    authority_epoch: 4,
  });

  it.live("D6 submits the exact stored payload once after a journal-only reservation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = installSocket();
        const { original, receipt, terminal } = yield* runD6Turn(state, () => {
          state.resumePending = [];
        });
        expect(terminal.status).toBe("completed");
        expect(state.submissions).toEqual([
          {
            session_id: "session-a",
            input_id: original!.input_id,
            text: "exact journal-only input",
          },
        ]);
        expect(receipt).toMatchObject({ status: "terminal" });
      }),
    ),
  );

  it.live("D6 does not repeat an ambiguous exact submit failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = installSocket();
        const error = yield* Effect.flip(
          runD6Turn(state, () => {
            state.resumePending = [];
            state.refuseSubmit = true;
          }),
        );
        expect(error).toMatchObject({ _tag: "ProviderAdapterProtocolError" });
        expect(state.submissions).toHaveLength(1);
      }),
    ),
  );

  it.live.each([{ phase: "before" }, { phase: "after" }] as const)(
    "D6 does not repeat submit when receipt journaling fails $phase the response commit",
    ({ phase }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const state = installSocket();
          const recordReceipt = HermesSessionStore.prototype.recordTextTurnReceipt;
          vi.spyOn(HermesSessionStore.prototype, "recordTextTurnReceipt").mockImplementationOnce(
            function (this: HermesSessionStore, ...args) {
              if (phase === "after") Reflect.apply(recordReceipt, this, args);
              throw new Error(`receipt journal failed ${phase} commit`);
            },
          );

          const error = yield* Effect.flip(
            runD6Turn(state, () => {
              state.resumePending = [];
            }),
          );

          expect(error).toMatchObject({
            detail: "Hermes returned an invalid or foreign turn receipt",
          });
          expect(state.submissions).toHaveLength(1);
          expect(state.calls.filter((call) => call.method === "prompt.submit")).toHaveLength(1);
        }),
      ).pipe(Effect.timeout("10 seconds")),
  );

  it.live("D6 adopts an exact canonical pending admission without submitting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = installSocket();
        const { receipt, terminal } = yield* runD6Turn(state, (reserved) => {
          state.admissions.set(reserved!.input_id, {
            admission: "admission-pending",
            text: "joined",
            outcome: "completed",
            ownerEpoch: 4,
          });
          state.resumePending = [d6Pending(reserved!)];
        });
        expect(terminal.status).toBe("completed");
        expect(state.submissions).toEqual([]);
        expect(receipt).toMatchObject({
          status: "terminal",

          admission_id: "admission-pending",
        });
      }),
    ),
  );

  it.live("D6 rejects resume without the original reservation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = installSocket();
        const error = yield* Effect.flip(runD6Turn(state, undefined, false));
        expect(error).toMatchObject({ detail: "Hermes resume does not match the original run" });
        expect(state.submissions).toEqual([]);
      }),
    ),
  );

  it.live("D6 rejects journal-only recovery under a different authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = installSocket();
        const error = yield* Effect.flip(
          runD6Turn(state, () => {
            state.resumePending = [];
            state.setCurrentAuthority();
          }),
        );
        expect(error).toMatchObject({
          detail: "Hermes resume requires the same Gateway authority",
        });
        expect(state.submissions).toEqual([]);
      }),
    ),
  );

  it.live("D6 refuses recovery when the configured principal changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-g3-owner-"));
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        const settings = configure(directory);
        const runtimePolicy = {
          cwd: NodePath.join(directory, "work"),
          runtimeMode: "full-access",
          interactionMode: "default",
        } as const;
        const sessionInput = {
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-g3-owner"),
          modelSelection,
          runtimePolicy,
        };
        const open = (principalId: string) =>
          makeHermesAdapterV2({
            instanceId,
            settings: decodeHermesSettings({ ...settings, principalId }),
            enableTextTurnsForTest: true,
          }).openSession(sessionInput);
        const original = yield* open("uid:1000");
        const providerThread = yield* original.ensureThread(sessionInput);
        const checkpoint = state.calls.length;

        const changed = yield* open("uid:1001");
        expect(yield* Effect.flip(changed.resumeThread({ providerThread }))).toMatchObject({
          detail: "Hermes runtime identity changed; recovery must fence this session",
        });
        expect(
          yield* Effect.flip(
            changed.startTurn({
              ...turnInput(providerThread, runtimePolicy.cwd, 1, "must not be replayed"),
              resume: true,
            }),
          ),
        ).toMatchObject({ detail: "Hermes turn does not match the durable pinned identity" });
        expect(state.calls.slice(checkpoint).map(({ method }) => method)).toEqual([
          "runtime.describe",
          "runtime.describe",
        ]);
      }),
    ),
  );

  it.live("D6 rejects an ambiguous pending join without submitting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = installSocket();
        const error = yield* Effect.flip(
          runD6Turn(state, (original) => {
            const pending = d6Pending(original!);
            state.resumePending = [pending, pending];
          }),
        );
        expect(error).toMatchObject({
          detail: "Hermes resume admission is ambiguous; refusing to resubmit",
        });
        expect(state.submissions).toEqual([]);
      }),
    ),
  );
  it.live("projects live output and recovers replay before one exact retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-g2-live-"));
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        const settings = configure(directory);
        const cwd = NodePath.join(directory, "work");
        const adapter = makeHermesAdapterV2({ instanceId, settings, enableTextTurnsForTest: true });
        const opened = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-g2"),
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const providerThread = yield* opened.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const observed: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const terminalQueue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* Stream.runForEach(opened.events, (event) =>
          Effect.gen(function* () {
            observed.push(event);
            yield* Queue.offer(terminalQueue, event);
          }),
        ).pipe(Effect.forkScoped);
        const takeTerminal = Effect.fnUntraced(function* () {
          while (true) {
            const event = yield* Queue.take(terminalQueue);
            if (event.type === "turn.terminal") return event;
          }
        });

        const first = turnInput(providerThread, cwd, 1, "first exact input");
        yield* opened.startTurn(first);
        const firstTerminal = yield* takeTerminal();
        expect(firstTerminal.status).toBe("completed");
        expect(state.calls.some((call) => call.method === "session.events.since")).toBe(false);

        state.dropNextSubmit = true;
        const second = turnInput(providerThread, cwd, 2, "second exact input");
        yield* opened.startTurn(second);
        const secondTerminal = yield* takeTerminal();
        expect(secondTerminal.status).toBe("completed");
        yield* opened.startTurn(second);
        expect(state.submissions).toHaveLength(3);
        expect(state.submissions[2]).toEqual(state.submissions[1]);
        const recoveryCalls = state.calls
          .filter((call) => call.socket === 2)
          .map((call) => call.method);
        expect(recoveryCalls.slice(0, 4)).toEqual([
          "runtime.describe",
          "session.events.since",
          "session.resume",
          "prompt.submit",
        ]);

        const messages = observed.filter((event) => event.type === "message.updated");
        expect(messages.map((event) => event.message.text)).toEqual([
          "hel",
          "hello",
          "hello",
          "replayed",
        ]);
        expect(messages.filter((event) => !event.message.streaming)).toHaveLength(2);
        expect(new Set(messages.map((event) => event.message.id)).size).toBe(2);
        expect(observed.filter((event) => event.type === "turn.terminal")).toHaveLength(2);
        const terminals = observed.filter((event) => event.type === "turn.terminal");
        expect(terminals.every((event) => event.status === "completed")).toBe(true);

        state.nextOutcome = "interrupted";
        yield* opened.startTurn(turnInput(providerThread, cwd, 3, "interrupted input"));
        const takeRunning = Effect.fnUntraced(function* () {
          while (true) {
            const event = yield* Queue.take(terminalQueue);
            if (event.type === "provider_turn.updated" && event.providerTurn.status === "running") {
              return event.providerTurn.id;
            }
          }
        });
        const providerTurnId = yield* takeRunning();
        yield* Effect.flip(
          opened.interruptTurn({
            providerThread: {
              ...providerThread,
              nativeThreadRef: { ...providerThread.nativeThreadRef!, nativeId: "foreign-session" },
            },
            providerTurnId,
          }),
        );
        yield* Effect.flip(
          opened.interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true }),
        );
        const wrongTurn = yield* Effect.flip(
          opened.interruptTurn({
            providerThread,
            providerTurnId: ProviderTurnId.make("other-turn"),
          }),
        );
        expect(wrongTurn).toMatchObject({
          detail: "Hermes interrupt does not match an active turn",
        });
        expect(state.calls.filter((call) => call.method === "session.interrupt")).toHaveLength(0);

        const wrongAcks = [
          { sessionId: "foreign-session" },
          { profileId: "/foreign-profile" },
          { instanceId: "instance-b" },
          { authorityEpoch: 5 },
          { executionGeneration: 2 },
        ];
        for (const wrongAck of wrongAcks) {
          state.interruptAck = wrongAck;
          const result = yield* Effect.result(
            opened.interruptTurn({ providerThread, providerTurnId }),
          );
          expect(result, JSON.stringify(wrongAck)).toMatchObject({ _tag: "Failure" });
        }
        state.interruptAck = {};
        yield* opened.interruptTurn({ providerThread, providerTurnId });
        const stopCalls = state.calls.filter((call) => call.method === "session.interrupt");
        expect(stopCalls).toHaveLength(wrongAcks.length + 1);
        expect(stopCalls.slice(-1)).toEqual([
          {
            method: "session.interrupt",
            params: { session_id: "session-a", execution_generation: 1 },
            socket: state.calls.filter((call) => call.method === "prompt.submit").at(-1)?.socket,
          },
        ]);
        expect(observed.filter((event) => event.type === "turn.terminal")).toHaveLength(2);
        state.finishTurn!();
        const interrupted = yield* takeTerminal();
        expect(interrupted).toMatchObject({ status: "cancelled", threadDisposition: "reusable" });
        yield* Effect.flip(opened.interruptTurn({ providerThread, providerTurnId }));

        state.nextOutcome = "cancelled";
        const beforeQueued = observed.filter((event) => event.type === "message.updated").length;
        yield* opened.startTurn(turnInput(providerThread, cwd, 4, "cancelled before claim"));
        const queuedTurnId = yield* takeRunning();
        const queuedStop = yield* Effect.flip(
          opened.interruptTurn({ providerThread, providerTurnId: queuedTurnId }),
        );
        expect(queuedStop).toMatchObject({
          detail: "Hermes interrupt requires a verified started receipt",
        });
        expect(state.calls.filter((call) => call.method === "session.interrupt")).toHaveLength(
          wrongAcks.length + 1,
        );
        state.finishTurn!();
        expect(yield* takeTerminal()).toMatchObject({
          status: "cancelled",
          threadDisposition: "reusable",
        });
        expect(observed.filter((event) => event.type === "message.updated")).toHaveLength(
          beforeQueued,
        );

        state.splitTurnStream = true;
        const beforeReplay = state.calls.filter(
          (call) => call.method === "session.events.since",
        ).length;
        const beforeSubmit = state.submissions.length;
        const midTurn = turnInput(providerThread, cwd, 5, "disconnect after admission");
        yield* opened.startTurn(midTurn);
        let streamed: Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "message.updated" }>;
        while (true) {
          const event = yield* Queue.take(terminalQueue);
          if (event.type === "message.updated" && event.message.streaming) {
            streamed = event;
            break;
          }
        }
        state.sockets.at(-1)!.close();
        expect(yield* takeTerminal()).toMatchObject({ status: "completed" });
        expect(state.submissions).toHaveLength(beforeSubmit + 1);
        expect(state.calls.filter((call) => call.method === "session.events.since")).toHaveLength(
          beforeReplay + 1,
        );
        const recoveredMessages = observed.filter(
          (event) => event.type === "message.updated" && event.message.id === streamed.message.id,
        );
        expect(recoveredMessages).toEqual([
          streamed,
          expect.objectContaining({
            message: expect.objectContaining({ text: "replayed", streaming: false }),
          }),
        ]);
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  it.live.each([
    { fault: "foreign admission" },
    { fault: "wrong event authority" },
    { fault: "repeated disconnect" },
  ] as const)("fails closed on $fault without projecting text or resubmitting", ({ fault }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-g2-identity-"));
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        state.wrongAdmission = fault === "foreign admission";
        state.wrongEventAuthority = fault === "wrong event authority";
        state.dropTurnStream = fault === "repeated disconnect";
        const settings = configure(directory);
        const cwd = NodePath.join(directory, "work");
        const adapter = makeHermesAdapterV2({
          instanceId,
          settings,
          enableTextTurnsForTest: true,
        });
        const opened = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-identity"),
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const providerThread = yield* opened.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const observed: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        yield* Stream.runForEach(opened.events, (event) =>
          Effect.gen(function* () {
            observed.push(event);
            yield* Queue.offer(events, event);
          }),
        ).pipe(Effect.forkScoped);
        yield* opened.startTurn(turnInput(providerThread, cwd, 1, "do not replace admission"));
        let terminal:
          | Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
          | undefined;
        while (!terminal) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal") terminal = event;
        }
        expect(terminal.status).toBe("failed");
        expect(terminal.threadDisposition).toBe("broken");
        const repeat = yield* Effect.flip(
          opened.startTurn(turnInput(providerThread, cwd, 1, "do not replace admission")),
        );
        expect(repeat).toMatchObject({
          detail: "Unfinished Hermes turn recovery requires the existing run",
        });
        const next = yield* Effect.flip(
          opened.startTurn(turnInput(providerThread, cwd, 2, "do not admit more work")),
        );
        expect(next).toMatchObject({ detail: "Could not reserve exact Hermes turn input" });
        expect(observed.filter((event) => event.type === "message.updated")).toHaveLength(0);
        expect(state.submissions).toHaveLength(1);
        expect(state.calls.filter((call) => call.method === "session.events.since")).toHaveLength(
          state.dropTurnStream ? 1 : 0,
        );
        expect(state.sockets).toHaveLength(state.dropTurnStream ? 2 : 1);
      }),
    ),
  );

  it.live("does not journal a submit receipt that contradicts replay identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "hermes-g2-replay-receipt-"),
        );
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        state.wrongAdmission = true;
        state.dropNextSubmit = true;
        const settings = configure(directory);
        const cwd = NodePath.join(directory, "work");
        const adapter = makeHermesAdapterV2({
          instanceId,
          settings,
          enableTextTurnsForTest: true,
        });
        const opened = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-replay-receipt"),
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const providerThread = yield* opened.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });

        const error = yield* Effect.flip(
          opened.startTurn(turnInput(providerThread, cwd, 1, "never journal a foreign retry")),
        );

        expect(error).toMatchObject({ detail: "Hermes receipt does not match the replayed turn" });
        expect(state.submissions).toHaveLength(2);
        const store = new HermesSessionStore(NodePath.join(directory, "state", "sessions.sqlite3"));
        expect(store.getTextTurnReceipt(String(state.submissions[0]!.input_id))).toBeNull();
        store.close();
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  it.live.each([
    { mode: "gap" },
    { mode: "epoch" },
    { mode: "authority" },
    { mode: "refusal" },
    { mode: "disabled" },
  ] as const)("does not repeat or bypass a $mode failure", ({ mode }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `hermes-g2-${mode}-`));
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        state.dropNextSubmit = mode === "gap" || mode === "epoch" || mode === "authority";
        if (state.dropNextSubmit && mode !== "refusal" && mode !== "disabled")
          state.replayMode = mode;
        state.refuseSubmit = mode === "refusal";
        const settings = configure(directory);
        const cwd = NodePath.join(directory, "work");
        const adapter = makeHermesAdapterV2({
          instanceId,
          settings,
          enableTextTurnsForTest: mode !== "disabled",
        });
        const opened = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`provider-session-${mode}`),
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const providerThread = yield* opened.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const error = yield* Effect.flip(
          opened.startTurn(turnInput(providerThread, cwd, 1, "never execute twice")),
        );
        expect(error._tag).toBe("ProviderAdapterProtocolError");
        expect(state.submissions).toHaveLength(mode === "disabled" ? 0 : 1);
        if (mode === "disabled") {
          expect(error.message).toContain("Hermes turns are unavailable");
        } else {
          expect(state.calls.at(-1)?.method).toBe(
            mode === "refusal"
              ? "prompt.submit"
              : mode === "authority"
                ? "runtime.describe"
                : "session.events.since",
          );
        }
      }),
    ),
  );

  it.live("answers same-authority approval and clarification once across reconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-g3-controls-"));
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        const settings = configure(directory);
        const cwd = NodePath.join(directory, "work");
        const adapter = makeHermesAdapterV2({ instanceId, settings, enableTextTurnsForTest: true });
        const opened = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-g3"),
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const providerThread = yield* opened.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const observed: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* Stream.runForEach(opened.events, (event) =>
          Effect.gen(function* () {
            observed.push(event);
            yield* Queue.offer(events, event);
          }),
        ).pipe(Effect.forkScoped);
        const next = (type: ProviderAdapter.ProviderAdapterV2Event["type"]) =>
          Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(events);
              if (event.type === "turn.terminal" && event.status === "failed") {
                throw new Error(JSON.stringify(event.failure));
              }
              if (event.type === type) return event;
            }
          });

        state.prompt = { kind: "approval", promptId: "approval-1" };
        yield* opened.startTurn(turnInput(providerThread, cwd, 1, "needs approval"));
        const approval = yield* next("runtime_request.updated");
        if (approval.type !== "runtime_request.updated") throw new Error("unreachable");
        expect(approval.runtimeRequest.status).toBe("pending");
        expect(approval.runtimeRequest.kind).toBe("command");
        const approvalCard = observed.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "approval_request" &&
            event.turnItem.requestId === approval.runtimeRequest.id,
        );
        expect(approvalCard).toMatchObject({
          turnItem: {
            prompt: "rm -rf /tmp/example",
            options: [
              { decision: "accept", label: "once" },
              { decision: "acceptForSession", label: "session" },
              { decision: "acceptAlways", label: "always" },
              { decision: "decline", label: "deny" },
            ],
          },
        });
        state.sockets.at(-1)!.close();
        yield* Effect.promise(() =>
          expect
            .poll(() => state.calls.filter((call) => call.method === "session.resume").length)
            .toBe(2),
        );
        yield* opened.respondToRuntimeRequest({
          requestId: approval.runtimeRequest.id,
          decision: "acceptForSession",
        });
        yield* next("turn.terminal");
        expect(state.promptAnswers).toEqual([
          {
            session_id: "session-a",
            prompt_id: "approval-1",
            choice: "session",
            execution_generation: 1,
          },
        ]);
        yield* opened.respondToRuntimeRequest({
          requestId: approval.runtimeRequest.id,
          decision: "acceptForSession",
        });
        expect(state.promptAnswers).toHaveLength(1);
        expect(
          observed.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
        ).toHaveLength(1);

        state.prompt = { kind: "clarify", promptId: "clarify-1" };
        yield* opened.startTurn(turnInput(providerThread, cwd, 2, "needs clarification"));
        const clarification = yield* next("runtime_request.updated");
        if (clarification.type !== "runtime_request.updated") throw new Error("unreachable");
        expect(clarification.runtimeRequest.kind).toBe("user_input");
        const clarificationCard = observed.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "user_input_request" &&
            event.turnItem.requestId === clarification.runtimeRequest.id,
        );
        expect(clarificationCard).toMatchObject({
          turnItem: {
            questions: [
              {
                id: "clarify-1",
                question: "Continue?",
                options: [
                  { label: "yes", description: "yes" },
                  { label: "no", description: "no" },
                ],
              },
            ],
          },
        });
        yield* opened.respondToRuntimeRequest({
          requestId: clarification.runtimeRequest.id,
          answers: { "clarify-1": "yes" },
        });
        yield* next("turn.terminal");
        expect(state.promptAnswers[1]).toEqual({
          session_id: "session-a",
          prompt_id: "clarify-1",
          answer: "yes",
          execution_generation: 1,
        });

        state.prompt = { kind: "approval", promptId: "approval-2", choices: ["deny"] };
        yield* opened.startTurn(turnInput(providerThread, cwd, 3, "needs denial"));
        const denial = yield* next("runtime_request.updated");
        if (denial.type !== "runtime_request.updated") throw new Error("unreachable");
        yield* Effect.flip(
          opened.respondToRuntimeRequest({
            requestId: denial.runtimeRequest.id,
            decision: "accept",
          }),
        );
        expect(state.promptAnswers).toHaveLength(2);
        yield* opened.respondToRuntimeRequest({
          requestId: denial.runtimeRequest.id,
          decision: "decline",
        });
        yield* next("turn.terminal");
        expect(state.promptAnswers[2]).toEqual({
          session_id: "session-a",
          prompt_id: "approval-2",
          choice: "deny",
          execution_generation: 1,
        });

        state.prompt = { kind: "approval", promptId: "approval-3", choices: ["deny"] };
        yield* opened.startTurn(turnInput(providerThread, cwd, 4, "uncertain response"));
        const uncertain = yield* next("runtime_request.updated");
        if (uncertain.type !== "runtime_request.updated") throw new Error("unreachable");
        state.dropNextResponse = true;
        yield* Effect.flip(
          opened.respondToRuntimeRequest({
            requestId: uncertain.runtimeRequest.id,
            decision: "decline",
          }),
        );
        expect(state.calls.filter((call) => call.method === "approval.respond")).toHaveLength(3);
        expect(state.promptAnswers).toHaveLength(3);
        yield* Effect.promise(() =>
          expect
            .poll(() =>
              observed.some(
                (event) =>
                  event.type === "runtime_request.updated" &&
                  event.runtimeRequest.id === uncertain.runtimeRequest.id &&
                  event.runtimeRequest.responseCapability.type === "not_resumable",
              ),
            )
            .toBe(true),
        );
        yield* Effect.promise(() =>
          expect
            .poll(
              () =>
                observed.filter(
                  (event) =>
                    event.type === "runtime_request.updated" &&
                    event.runtimeRequest.id === uncertain.runtimeRequest.id &&
                    event.runtimeRequest.status === "pending" &&
                    event.runtimeRequest.responseCapability.type === "live",
                ).length,
            )
            .toBe(2),
        );
        yield* opened.respondToRuntimeRequest({
          requestId: uncertain.runtimeRequest.id,
          decision: "decline",
        });
        yield* next("turn.terminal");
        expect(state.promptAnswers[3]).toMatchObject({ prompt_id: "approval-3", choice: "deny" });

        state.prompt = { kind: "approval", promptId: "approval-4", choices: ["deny"] };
        yield* opened.startTurn(turnInput(providerThread, cwd, 5, "settlement failure"));
        let settlement:
          | Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
          | undefined;
        while (!settlement) {
          const event = yield* next("runtime_request.updated");
          if (
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.nativeRequestRef?.nativeId === "approval-4"
          ) {
            settlement = event;
          }
        }
        vi.spyOn(HermesSessionStore.prototype, "settleTextTurnInteraction").mockImplementationOnce(
          () => {
            throw new Error("journal unavailable");
          },
        );
        const settlementError = yield* Effect.flip(
          opened.respondToRuntimeRequest({
            requestId: settlement.runtimeRequest.id,
            decision: "decline",
          }),
        );
        expect(settlementError.message).toContain("Hermes response outcome is uncertain");
        expect(
          observed.some(
            (event) =>
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.id === settlement.runtimeRequest.id &&
              event.runtimeRequest.status === "resolved",
          ),
        ).toBe(false);
        yield* Effect.promise(() =>
          expect
            .poll(() =>
              observed.some(
                (event) =>
                  event.type === "runtime_request.updated" &&
                  event.runtimeRequest.id === settlement.runtimeRequest.id &&
                  event.runtimeRequest.responseCapability.type === "not_resumable",
              ),
            )
            .toBe(true),
        );

        // The gateway completed while disconnected. Canonical pending no longer contains the turn.
        state.sockets.at(-1)!.close();
        expect(yield* next("turn.terminal")).toMatchObject({
          status: "completed",
          threadDisposition: "reusable",
        });
        expect(
          state.calls.filter((call) => call.method === "prompt.receipt").at(-1)?.params,
        ).toMatchObject({ session_id: "session-a", admission_id: "admission-5" });
        expect(state.submissions).toHaveLength(5);
        expect(
          state.calls.filter(
            (call) => call.method === "approval.respond" && call.params.prompt_id === "approval-4",
          ),
        ).toHaveLength(1);
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  it.live.each(["approval", "clarify"] as const)(
    "does not attribute an already closed %s to this caller",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-g3-closed-"));
          cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
          const state = installSocket();
          const settings = configure(directory);
          const cwd = NodePath.join(directory, "work");
          const adapter = makeHermesAdapterV2({
            instanceId,
            settings,
            enableTextTurnsForTest: true,
          });
          const runtimePolicy = {
            cwd,
            runtimeMode: "full-access",
            interactionMode: "default",
          } as const;
          const opened = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-g3-closed"),
            modelSelection,
            runtimePolicy,
          });
          const providerThread = yield* opened.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          yield* Stream.runForEach(opened.events, (event) => Queue.offer(events, event)).pipe(
            Effect.forkScoped,
          );
          const nextRequest = Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(events);
              if (event.type === "runtime_request.updated") return event.runtimeRequest;
            }
          });
          state.prompt = { kind, promptId: "closed-by-another-viewer" };
          yield* opened.startTurn(turnInput(providerThread, cwd, 1, "await answer"));
          const prompt = yield* nextRequest;
          state.prompt = null; // Hermes has already closed the prompt, but T3 has not seen that yet.
          yield* opened.respondToRuntimeRequest(
            kind === "approval"
              ? { requestId: prompt.id, decision: "accept" }
              : { requestId: prompt.id, answers: { "closed-by-another-viewer": "yes" } },
          );
          const closed = yield* nextRequest;
          expect(closed).toMatchObject({
            id: prompt.id,
            status: "resolved",
            responseCapability: { type: "not_resumable" },
          });
          expect(closed).not.toHaveProperty("decision");
          if (kind === "clarify") expect(closed).toHaveProperty("answers", {});
          expect(state.promptAnswers).toHaveLength(0);
        }),
      ).pipe(Effect.timeout("10 seconds")),
  );

  const approvalSnapshots = [
    "complete",
    "omitted",
    "duplicate",
    "terminal",
    "unknown",
    "wrong-input",
    "missing-input",
  ] as const;

  it.live.each(approvalSnapshots)(
    "recovers a started approval only from a valid snapshot (%s)",
    (snapshot) =>
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-g3-restart-"));
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        const settings = configure(directory);
        const cwd = NodePath.join(directory, "work");
        const runtimePolicy = {
          cwd,
          runtimeMode: "full-access",
          interactionMode: "default",
        } as const;
        let originalInput!: ProviderAdapter.ProviderAdapterV2TurnInput;
        let previousSession!: ProviderAdapter.ProviderAdapterV2SessionRuntime["providerSession"];
        let originalRequestId: OrchestrationV2RuntimeRequest["id"] | null = null;

        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = makeHermesAdapterV2({
              instanceId,
              settings,
              enableTextTurnsForTest: true,
            });
            const opened = yield* adapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make("provider-session-g3-restart"),
              modelSelection,
              runtimePolicy,
            });
            previousSession = opened.providerSession;
            const providerThread = yield* opened.ensureThread({
              threadId,
              modelSelection,
              runtimePolicy,
            });
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            yield* Stream.runForEach(opened.events, (event) => Queue.offer(events, event)).pipe(
              Effect.forkScoped,
            );
            state.prompt = { kind: "approval", promptId: "restart-approval" };
            originalInput = turnInput(providerThread, cwd, 1, "keep the original run");
            yield* opened.startTurn(originalInput);
            while (!originalRequestId) {
              const event = yield* Queue.take(events);
              if (
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "pending"
              ) {
                expect(event.runtimeRequest.nativeRequestRef?.nativeId).toBe("restart-approval");
                originalRequestId = event.runtimeRequest.id;
              }
            }
          }),
        );

        const stored = new HermesSessionStore(
          NodePath.join(directory, "state", "sessions.sqlite3"),
        );
        const receipt = stored.getTextTurnReceipt(String(state.submissions[0]!.input_id));
        stored.close();
        expect(receipt).toMatchObject({
          admission_id: "admission-1",
          status: "started",
          execution_generation: 1,
          authority_epoch: 4,
        });
        expect(state.submissions).toHaveLength(1);
        expect(
          state.calls.filter((call) =>
            [
              "approval.respond",
              "clarify.respond",
              "session.interrupt",
              "prompt.resolve_unknown",
            ].includes(call.method),
          ),
        ).toHaveLength(0);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = makeHermesAdapterV2({
              instanceId,
              settings,
              enableTextTurnsForTest: true,
            });
            const opened = yield* adapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make("provider-session-g3-restart"),
              modelSelection,
              runtimePolicy,
              resumeFromSession: previousSession,
              initialNativeThreadId: originalInput.providerThread.nativeThreadRef!.nativeId!,
              initialProviderItemIdentityVersion: 2,
            });
            yield* opened.ensureThread({
              threadId,
              modelSelection,
              runtimePolicy,
            });
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            const observed: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
            yield* Stream.runForEach(opened.events, (event) =>
              Effect.gen(function* () {
                observed.push(event);
                yield* Queue.offer(events, event);
              }),
            ).pipe(Effect.forkScoped);
            const { message, ...run } = originalInput;
            expect(opened.resumeTurn).toBeTypeOf("function");
            const callsBeforeResume = state.calls.length;
            state.omitResumeState = snapshot === "omitted";
            state.prompt = {
              kind: "approval",
              promptId: "restart-approval",
              duplicate: snapshot === "duplicate",
            };
            if (snapshot === "terminal" || snapshot === "unknown") {
              state.resumePending = [];
            }
            if (snapshot === "wrong-input" || snapshot === "missing-input") {
              state.resumePending = [
                {
                  admission_id: "admission-1",
                  ...(snapshot === "wrong-input" ? { input_id: "foreign-input" } : {}),
                },
              ];
            }
            if (
              snapshot === "unknown" ||
              snapshot === "wrong-input" ||
              snapshot === "missing-input"
            ) {
              if (snapshot === "unknown") state.receiptOverride = "unknown";
              const error = yield* Effect.flip(
                opened.resumeTurn!({ ...run, messageId: message.messageId }),
              );
              expect(error).toMatchObject(
                snapshot === "unknown"
                  ? { detail: "Hermes recovery did not return a supported terminal receipt" }
                  : {
                      detail: "Invalid Hermes pending prompt resume",
                      cause: { message: "Hermes resume admission is foreign or ambiguous" },
                    },
              );
              expect(
                state.calls
                  .slice(callsBeforeResume)
                  .filter(({ method }) => method === "prompt.receipt"),
              ).toHaveLength(snapshot === "unknown" ? 1 : 0);
              expect(observed).toEqual([]);
              expect(state.submissions).toHaveLength(1);
              const store = new HermesSessionStore(
                NodePath.join(directory, "state", "sessions.sqlite3"),
              );
              try {
                expect(store.getTextTurnReceipt(String(state.submissions[0]!.input_id))).toEqual(
                  receipt,
                );
              } finally {
                store.close();
              }
              return;
            }
            if (snapshot !== "complete" && snapshot !== "terminal") {
              const error = yield* Effect.flip(
                opened.resumeTurn!({ ...run, messageId: message.messageId }),
              );
              expect(error).toMatchObject(
                snapshot === "omitted"
                  ? {
                      detail: "Invalid Hermes pending prompt resume",
                      cause: { message: "Hermes resume has no canonical pending prompt state" },
                    }
                  : { detail: "Hermes resumed prompts are ambiguous" },
              );
              yield* Effect.yieldNow;
              expect(observed).toEqual([]);
              const methods = state.calls.slice(callsBeforeResume).map(({ method }) => method);
              expect(methods.filter((method) => method !== "runtime.describe")).toEqual([
                "session.resume",
              ]);
              return;
            }
            if (snapshot === "terminal") {
              yield* opened.resumeTurn!({ ...run, messageId: message.messageId });
              let terminal: ProviderAdapter.ProviderAdapterV2Event | undefined;
              while (terminal === undefined) {
                const event = yield* Queue.take(events);
                if (event.type === "turn.terminal") terminal = event;
              }
              expect(terminal).toMatchObject({ status: "completed" });
              expect(
                state.calls
                  .slice(callsBeforeResume)
                  .filter((call) => call.method === "prompt.receipt"),
              ).toEqual([
                expect.objectContaining({
                  params: {
                    session_id: "session-a",
                    admission_id: "admission-1",
                    include_result: true,
                  },
                }),
              ]);
              expect(state.submissions).toHaveLength(1);
              expect(state.promptAnswers).toHaveLength(0);
              expect(
                state.calls
                  .slice(callsBeforeResume)
                  .some((call) => call.method === "prompt.interrupt"),
              ).toBe(false);
              return;
            }
            yield* opened.resumeTurn!({ ...run, messageId: message.messageId });
            while (true) {
              const event = yield* Queue.take(events);
              if (
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "pending" &&
                event.runtimeRequest.nativeRequestRef?.nativeId === "restart-approval"
              ) {
                expect(event.runtimeRequest.id).toBe(originalRequestId);
                expect(observed.slice(0, observed.indexOf(event))).toContainEqual(
                  expect.objectContaining({
                    type: "provider_turn.updated",
                    providerTurn: expect.objectContaining({
                      id: event.runtimeRequest.providerTurnId,
                      status: "running",
                    }),
                  }),
                );
                break;
              }
            }
            expect(
              state.calls
                .slice(callsBeforeResume)
                .filter((call) =>
                  [
                    "prompt.submit",
                    "approval.respond",
                    "clarify.respond",
                    "session.interrupt",
                    "prompt.resolve_unknown",
                  ].includes(call.method),
                ),
            ).toHaveLength(0);
            yield* opened.respondToRuntimeRequest({
              requestId: originalRequestId!,
              decision: "accept",
            });
            while (true) {
              const event = yield* Queue.take(events);
              if (event.type === "turn.terminal") {
                expect(event.status).toBe("completed");
                break;
              }
            }
            expect(
              observed.filter(
                (event) =>
                  event.type === "runtime_request.updated" &&
                  event.runtimeRequest.status === "pending" &&
                  event.runtimeRequest.nativeRequestRef?.nativeId === "restart-approval",
              ),
            ).toHaveLength(1);
            expect(state.promptAnswers).toHaveLength(1);
            expect(state.submissions).toHaveLength(1);
          }),
        );
      }).pipe(Effect.timeout("10 seconds")),
  );

  it.live("recovers an answer-send failure without duplicating the answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "hermes-g3-answer-fault-"),
        );
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        const settings = configure(directory);
        const cwd = NodePath.join(directory, "work");
        const adapter = makeHermesAdapterV2({ instanceId, settings, enableTextTurnsForTest: true });
        const opened = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-g3-answer-fault"),
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const providerThread = yield* opened.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* Stream.runForEach(opened.events, (event) => Queue.offer(events, event)).pipe(
          Effect.forkScoped,
        );
        const nextRequest = (promptId: string, live = false) =>
          Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(events);
              if (
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.nativeRequestRef?.nativeId === promptId &&
                event.runtimeRequest.status === "pending" &&
                (!live || event.runtimeRequest.responseCapability.type === "live")
              ) {
                return event.runtimeRequest;
              }
            }
          });
        const nextTerminal = Effect.gen(function* () {
          while (true) {
            const event = yield* Queue.take(events);
            if (event.type === "turn.terminal") return event;
          }
        });

        state.prompt = { kind: "approval", promptId: "before-answer", choices: ["deny"] };
        yield* opened.startTurn(turnInput(providerThread, cwd, 1, "fail before answer"));
        const beforeAnswer = yield* nextRequest("before-answer");
        state.failNextResponseSend = true;
        const sendError = yield* Effect.flip(
          opened.respondToRuntimeRequest({ requestId: beforeAnswer.id, decision: "decline" }),
        );
        expect(sendError.message).toContain("Hermes response outcome is uncertain");
        expect(
          state.calls.some(
            (call) =>
              call.method === "approval.respond" && call.params.prompt_id === "before-answer",
          ),
        ).toBe(false);
        expect(state.promptAnswers).toHaveLength(0);

        state.sockets.at(-1)!.close();
        const reoffered = yield* nextRequest("before-answer", true);
        yield* opened.respondToRuntimeRequest({ requestId: reoffered.id, decision: "decline" });
        expect(yield* nextTerminal).toMatchObject({ status: "completed" });
        expect(state.promptAnswers).toHaveLength(1);
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  it.live("recovers when journaling fails after the resolution commit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "hermes-g3-resolution-"),
        );
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        const settings = configure(directory);
        const cwd = NodePath.join(directory, "work");
        const adapter = makeHermesAdapterV2({ instanceId, settings, enableTextTurnsForTest: true });
        const opened = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-g3-resolution"),
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const providerThread = yield* opened.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* Stream.runForEach(opened.events, (event) => Queue.offer(events, event)).pipe(
          Effect.forkScoped,
        );

        state.prompt = { kind: "approval", promptId: "approval-4", choices: ["deny"] };
        yield* opened.startTurn(turnInput(providerThread, cwd, 1, "fail after resolution commit"));
        let request: OrchestrationV2RuntimeRequest | undefined;
        while (!request) {
          const event = yield* Queue.take(events);
          if (
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.nativeRequestRef?.nativeId === "approval-4"
          ) {
            request = event.runtimeRequest;
          }
        }
        const settle = HermesSessionStore.prototype.settleTextTurnInteraction;
        vi.spyOn(HermesSessionStore.prototype, "settleTextTurnInteraction").mockImplementationOnce(
          function (this: HermesSessionStore, ...args) {
            Reflect.apply(settle, this, args);
            throw new Error("resolution journal failed after commit");
          },
        );
        const settlementError = yield* Effect.flip(
          opened.respondToRuntimeRequest({ requestId: request.id, decision: "decline" }),
        );
        expect(settlementError.message).toContain("Hermes response outcome is uncertain");
        expect(state.promptAnswers).toHaveLength(1);

        state.sockets.at(-1)!.close();
        let recoveredRequest: OrchestrationV2RuntimeRequest | undefined;
        while (true) {
          const event = yield* Queue.take(events);
          if (event.type === "runtime_request.updated" && event.runtimeRequest.id === request.id) {
            recoveredRequest = event.runtimeRequest;
          }
          if (event.type === "turn.terminal") {
            expect(event).toMatchObject({ status: "completed" });
            break;
          }
        }
        expect(recoveredRequest?.status).toBe("resolved");
        expect(recoveredRequest).not.toHaveProperty("decision");
        yield* opened.respondToRuntimeRequest({ requestId: request.id, decision: "decline" });
        expect(state.calls.filter((call) => call.method === "approval.respond")).toHaveLength(1);
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  it.live("does not submit when the pre-submit turn journal fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "hermes-g3-turn-journal-"),
        );
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        const settings = configure(directory);
        const cwd = NodePath.join(directory, "work");
        const adapter = makeHermesAdapterV2({ instanceId, settings, enableTextTurnsForTest: true });
        const opened = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-g3-turn-journal"),
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const providerThread = yield* opened.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const reserveTextTurn = vi
          .spyOn(HermesSessionStore.prototype, "reserveTextTurn")
          .mockImplementationOnce(() => {
            throw new Error("journal unavailable");
          });

        const callCount = state.calls.length;
        const failure = yield* Effect.flip(
          opened.startTurn(turnInput(providerThread, cwd, 1, "journal failure")),
        );

        expect(reserveTextTurn).toHaveBeenCalledTimes(1);
        expect(failure._tag).toBe("ProviderAdapterProtocolError");
        expect(state.submissions).toHaveLength(0);
        expect(state.calls).toHaveLength(callCount);
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  it.live("fails before prompt projection when interaction journaling fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-g3-journal-"));
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        const settings = configure(directory);
        const cwd = NodePath.join(directory, "work");
        const adapter = makeHermesAdapterV2({ instanceId, settings, enableTextTurnsForTest: true });
        const opened = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-g3-journal"),
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const providerThread = yield* opened.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const observed: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* Stream.runForEach(opened.events, (event) =>
          Effect.gen(function* () {
            observed.push(event);
            yield* Queue.offer(events, event);
          }),
        ).pipe(Effect.forkScoped);
        vi.spyOn(HermesSessionStore.prototype, "recordTextTurnInteraction").mockImplementationOnce(
          () => {
            throw new Error("journal unavailable");
          },
        );
        state.prompt = { kind: "approval", promptId: "approval-journal" };
        yield* opened.startTurn(turnInput(providerThread, cwd, 1, "journal failure"));
        let terminal:
          | Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
          | undefined;
        while (!terminal) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal") terminal = event;
        }
        expect(terminal.status).toBe("failed");
        expect(
          observed.some(
            (event) =>
              event.type === "runtime_request.updated" ||
              (event.type === "turn_item.updated" &&
                (event.turnItem.type === "approval_request" ||
                  event.turnItem.type === "user_input_request")),
          ),
        ).toBe(false);
        expect(state.promptAnswers).toHaveLength(0);
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  it.live.each([{ mode: "mismatched" }, { mode: "ambiguous" }] as const)(
    "fails closed on a $mode prompt without answering",
    ({ mode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), `hermes-g3-${mode}-`),
          );
          cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
          const state = installSocket();
          const settings = configure(directory);
          const cwd = NodePath.join(directory, "work");
          const adapter = makeHermesAdapterV2({
            instanceId,
            settings,
            enableTextTurnsForTest: true,
          });
          const opened = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(`provider-session-g3-${mode}`),
            modelSelection,
            runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
          });
          const providerThread = yield* opened.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
          });
          const observed: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          yield* Stream.runForEach(opened.events, (event) =>
            Effect.gen(function* () {
              observed.push(event);
              yield* Queue.offer(events, event);
            }),
          ).pipe(Effect.forkScoped);
          state.prompt = {
            kind: "approval",
            promptId: `prompt-${mode}`,
            ...(mode === "mismatched" ? { generation: 2 } : { duplicate: true }),
          };
          yield* opened.startTurn(turnInput(providerThread, cwd, 1, "reject bad prompt"));
          if (mode === "ambiguous") state.sockets.at(-1)!.close();
          let terminal:
            | Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
            | undefined;
          while (!terminal) {
            const event = yield* Queue.take(events);
            if (event.type === "turn.terminal") terminal = event;
          }
          expect(terminal.status).toBe("failed");
          expect(state.promptAnswers).toHaveLength(0);
          const requests = observed.filter((event) => event.type === "runtime_request.updated");
          expect(requests).toHaveLength(mode === "ambiguous" ? 2 : 0);
          if (mode === "ambiguous" && requests.at(-1)?.type === "runtime_request.updated") {
            expect(requests.at(-1)?.runtimeRequest.status).toBe("expired");
          }
        }),
      ).pipe(Effect.timeout("10 seconds")),
  );
  it.live("admits new work only after an exact operator-discarded admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-g4-discard-"));
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        const settings = configure(directory);
        const cwd = NodePath.join(directory, "work");
        const adapter = makeHermesAdapterV2({
          instanceId,
          settings,
          enableTextTurnsForTest: true,
        });
        const opened = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-g4-discard"),
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const providerThread = yield* opened.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const observed: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        yield* Stream.runForEach(opened.events, (event) =>
          Effect.gen(function* () {
            observed.push(event);
            yield* Queue.offer(events, event);
          }),
        ).pipe(Effect.forkScoped);

        state.nextOutcome = "interrupted";
        yield* opened.startTurn(turnInput(providerThread, cwd, 1, "held ordinary work"));
        const oldInputId = String(state.submissions[0]!.input_id);
        let oldReceipt: ReturnType<HermesSessionStore["getTextTurnReceipt"]> = null;
        yield* Effect.promise(() =>
          expect
            .poll(() => {
              const store = new HermesSessionStore(
                NodePath.join(directory, "state", "sessions.sqlite3"),
              );
              oldReceipt = store.getTextTurnReceipt(oldInputId);
              store.close();
              return oldReceipt?.status;
            })
            .toBe("started"),
        );
        state.resumePending = [{ ...oldReceipt!, input_id: oldInputId, status: "unknown" }];
        state.restartStatus = "unknown";
        state.sockets.at(-1)!.close();
        while (!observed.some((event) => event.type === "turn.terminal")) {
          yield* Queue.take(events);
        }
        expect(observed.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        expect(
          state.calls.filter(
            (call) =>
              call.method === "session.interrupt" || call.method === "prompt.resolve_unknown",
          ),
        ).toHaveLength(0);

        state.restartStatus = "terminal";
        state.resumePending = [];
        state.restartOutcome = "interrupted";
        state.prompt = { kind: "clarify", promptId: "after-operator-discard" };
        yield* opened.startTurn(turnInput(providerThread, cwd, 2, "new work after discard"));
        state.setCurrentAuthority();
        state.restartStatus = null;
        while (
          !observed.some(
            (event) =>
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.nativeRequestRef?.nativeId === "after-operator-discard",
          )
        ) {
          yield* Queue.take(events);
        }

        expect(state.submissions.map((submission) => submission.text)).toEqual([
          "held ordinary work",
          "new work after discard",
        ]);
        expect(observed.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        expect(
          state.calls.filter(
            (call) =>
              call.method === "session.interrupt" || call.method === "prompt.resolve_unknown",
          ),
        ).toHaveLength(0);
        const store = new HermesSessionStore(NodePath.join(directory, "state", "sessions.sqlite3"));
        const original = store.getTextTurnReceipt(String(state.submissions[0]!.input_id));
        expect(original).toMatchObject({ status: "terminal", outcome: "interrupted" });
        expect(store.get(threadId)).toMatchObject({ instanceId: "instance-b", authorityEpoch: 5 });
        store.close();
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  it.live.each([
    { status: "unknown", cleanup: "prompt.resolve_unknown", unlock: true, dropResponse: true },
    {
      status: "unknown",
      cleanup: "prompt.resolve_unknown",
      unlock: true,
      restartingSocket: "refused",
    },
    { status: "unknown", cleanup: "prompt.resolve_unknown", unlock: true, restartingSocket: 503 },
    { status: "unknown", cleanup: null, unlock: false, restartingSocket: 401 },
    { status: "unknown", cleanup: "prompt.resolve_unknown", unlock: true, queueBeforeStart: true },
    { status: "started", cleanup: "session.interrupt", unlock: true, dropResponse: true },
    { status: "started", cleanup: "session.interrupt", unlock: true },
    { status: "started", cleanup: "session.interrupt", unlock: false, wrongAck: true },
    { status: "started", cleanup: "session.interrupt", unlock: true, delaySettlement: 1 },
    { status: "started", cleanup: "session.interrupt", unlock: false, delaySettlement: 2 },
    { status: "terminal", cleanup: null, unlock: true },
    { status: "queued", cleanup: null, unlock: false },
    { status: "unknown", cleanup: null, unlock: false, wrongIdentity: true },
    { status: "unknown", cleanup: null, unlock: false, missingPending: true },
    { status: "unknown", cleanup: null, unlock: false, duplicatePending: true },
  ] as const)(
    "cleans a later-epoch $status admission fail-closed (unlock=$unlock, initially queued=$queueBeforeStart, socket restarting=$restartingSocket)",
    ({ status, cleanup, unlock, ...fault }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "hermes-g3-restart-"),
          );
          cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
          const state = installSocket();
          const settings = configure(directory);
          const cwd = NodePath.join(directory, "work");
          const adapter = makeHermesAdapterV2({
            instanceId,
            settings,
            enableTextTurnsForTest: true,
          });
          const opened = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(
              `provider-session-restart-${status}-${unlock}`,
            ),
            modelSelection,
            runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
          });
          const providerThread = yield* opened.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
          });
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          yield* Stream.runForEach(opened.events, (event) => Queue.offer(events, event)).pipe(
            Effect.forkScoped,
          );
          state.queueBeforeStart = fault.queueBeforeStart ?? false;
          state.prompt = { kind: "approval", promptId: "before-restart" };
          yield* opened.startTurn(turnInput(providerThread, cwd, 1, "wait for approval"));
          let pendingRequest: OrchestrationV2RuntimeRequest | undefined;
          while (!pendingRequest) {
            const event = yield* Queue.take(events);
            expect(event.type, JSON.stringify(event)).not.toBe("turn.terminal");
            if (event.type === "runtime_request.updated") pendingRequest = event.runtimeRequest;
          }

          state.restartStatus = status;
          if (status === "terminal") state.restartOutcome = "completed";
          state.dropNextCleanup = fault.dropResponse ?? false;
          state.interruptsBeforeSettlement = fault.delaySettlement ?? 0;
          if (fault.wrongAck) state.interruptAck.instanceId = "foreign-instance";
          state.wrongRecoveryIdentity = fault.wrongIdentity ?? false;
          state.missingRecoveryPending = fault.missingPending ?? false;
          state.duplicateRecoveryPending = fault.duplicatePending ?? false;
          if (fault.restartingSocket === "refused") {
            vi.mocked(fetch).mockRejectedValueOnce(
              new TypeError("fetch failed", {
                cause: Object.assign(new Error(), { code: "ECONNREFUSED" }),
              }),
            );
          } else if (fault.restartingSocket !== undefined) {
            vi.mocked(fetch).mockResolvedValueOnce(
              new Response(null, { status: fault.restartingSocket }),
            );
          }
          state.sockets.at(-1)!.close();
          let terminal:
            | Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
            | undefined;
          while (!terminal) {
            const event = yield* Queue.take(events);
            if (event.type === "turn.terminal") terminal = event;
          }
          expect(terminal.status).toBe(status === "terminal" ? "completed" : "failed");
          if (fault.delaySettlement && !unlock) {
            expect(JSON.stringify(terminal.failure)).toContain(
              "gateway_restart_recovery_pending: cleanup did not reach a terminal receipt",
            );
          }
          expect(state.calls.filter((call) => call.method === "session.events.since")).toHaveLength(
            0,
          );
          expect(state.submissions).toHaveLength(1);
          expect(state.promptAnswers).toHaveLength(0);
          const cleanupCalls = state.calls.filter(
            (call) =>
              call.method === "session.interrupt" || call.method === "prompt.resolve_unknown",
          );
          const attempts = fault.delaySettlement ? 2 : cleanup ? 1 : 0;
          expect(cleanupCalls.map((call) => call.method)).toEqual(Array(attempts).fill(cleanup));
          if (attempts === 2) {
            expect(cleanupCalls[1]?.params).toEqual(cleanupCalls[0]?.params);
            const first = state.calls.indexOf(cleanupCalls[0]!);
            expect(state.calls[first + 1]?.method).toBe("prompt.receipt");
          }
          if (fault.wrongAck) {
            const afterAck = state.calls.slice(state.calls.indexOf(cleanupCalls[0]!) + 1);
            expect(afterAck.some((call) => call.method === "prompt.receipt")).toBe(false);
          }

          const stale = yield* Effect.flip(
            opened.respondToRuntimeRequest({ requestId: pendingRequest.id, decision: "accept" }),
          );
          expect(stale._tag).toBe("ProviderAdapterProtocolError");
          expect(state.calls.filter((call) => call.method === "approval.respond")).toHaveLength(0);

          if (unlock) {
            if (status !== "terminal") {
              expect(JSON.stringify(terminal.failure)).toContain(
                "original prompt was not re-executed",
              );
            }
            state.setCurrentAuthority();
            state.restartStatus = null;
            state.queueBeforeStart = false;
            state.prompt = { kind: "clarify", promptId: `after-restart-${status}` };
            yield* opened.startTurn(turnInput(providerThread, cwd, 2, "later work"));
            let laterRequest: OrchestrationV2RuntimeRequest | undefined;
            while (!laterRequest) {
              const event = yield* Queue.take(events);
              if (
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.nativeRequestRef?.nativeId === `after-restart-${status}`
              ) {
                laterRequest = event.runtimeRequest;
              }
            }
            expect(state.submissions).toHaveLength(2);
          } else {
            const blocked = yield* Effect.flip(
              opened.startTurn(turnInput(providerThread, cwd, 2, "must stay fenced")),
            );
            expect(blocked._tag).toBe("ProviderAdapterProtocolError");
            expect(state.submissions).toHaveLength(1);
          }
        }),
      ).pipe(Effect.timeout("10 seconds")),
  );
  it.live("G3 recovers an image reservation that crashed before its first upload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = installSocket();
        let staged: unknown;
        const { directory, original, terminal } = yield* runD6Turn(
          state,
          (reserved) => {
            state.resumePending = [];
            const store = new HermesSessionStore(
              NodePath.join(process.env.HERMES_STATE_DIR!, "sessions.sqlite3"),
            );
            staged = store.getPendingImage(reserved!.input_id);
            store.close();
          },
          true,
          {
            attachmentId: "image-1",
            filename: "image.png",
            mime: "image/png",
            contentBase64: "AAECAw==",
          },
        );
        expect(staged).toMatchObject({ uploadClaimed: false, contentBase64: "AAECAw==" });
        expect(terminal.status).toBe("completed");
        expect(state.calls.filter((call) => call.method === "image.attach_bytes")).toHaveLength(1);
        expect(state.calls.find((call) => call.method === "image.attach_bytes")).toMatchObject({
          params: {
            session_id: "session-a",
            filename: "image.png",
            content_base64: "AAECAw==",
          },
        });
        expect(state.submissions).toEqual([
          {
            session_id: "session-a",
            input_id: original!.input_id,
            text: "exact journal-only input",
            attachments: [{ path: "/profile/cache/images/upload-1.png", mime: "image/png" }],
          },
        ]);
        const store = new HermesSessionStore(NodePath.join(directory, "state", "sessions.sqlite3"));
        expect(store.getPendingImage(original!.input_id)).toBeNull();
        store.close();
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  it.live("G3 reuses the durable attached identity without uploading again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = installSocket();
        const { original, receipt, terminal } = yield* runD6Turn(state, (reserved) => {
          state.resumePending = [];
          const store = new HermesSessionStore(
            NodePath.join(process.env.HERMES_STATE_DIR!, "sessions.sqlite3"),
          );
          store.reservePendingImage({
            inputId: reserved!.input_id,
            sessionId: "session-a",
            attachmentId: "image-1",
            filename: "image.png",
            contentBase64: "AAECAw==",
            mime: "image/png",
          });
          store.recordAttachedImage({
            inputId: reserved!.input_id,
            attachmentId: "image-1",
            path: "/profile/cache/images/upload-1.png",
            mime: "image/png",
            bytes: 4,
          });
          store.close();
        });
        expect(terminal.status).toBe("completed");
        expect(receipt).toMatchObject({ status: "terminal" });
        expect(state.calls.filter((call) => call.method === "image.attach_bytes")).toHaveLength(0);
        expect(state.submissions).toEqual([
          {
            session_id: "session-a",
            input_id: original!.input_id,
            text: "exact journal-only input",
            attachments: [{ path: "/profile/cache/images/upload-1.png", mime: "image/png" }],
          },
        ]);
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  it.live("G3 fences an ambiguous attach instead of duplicating the image", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = installSocket();
        let inputId = "";
        const error = yield* Effect.flip(
          runD6Turn(state, (reserved) => {
            state.resumePending = [];
            inputId = reserved!.input_id;
            const store = new HermesSessionStore(
              NodePath.join(process.env.HERMES_STATE_DIR!, "sessions.sqlite3"),
            );
            store.reservePendingImage({
              inputId: reserved!.input_id,
              sessionId: "session-a",
              attachmentId: "image-1",
              filename: "image.png",
              contentBase64: "AAECAw==",
              mime: "image/png",
            });
            store.claimPendingImage(reserved!.input_id);
            store.close();
          }),
        );
        expect(error).toMatchObject({
          detail: "Hermes image attach has an ambiguous prior result; refusing a duplicate upload",
        });
        expect(state.calls.filter((call) => call.method === "image.attach_bytes")).toHaveLength(0);
        expect(state.submissions).toEqual([]);
        const store = new HermesSessionStore(
          NodePath.join(process.env.HERMES_STATE_DIR!, "sessions.sqlite3"),
        );
        expect(store.getPendingImage(inputId)).toMatchObject({
          uploadClaimed: true,
          contentBase64: "",
        });
        store.close();
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  it.live.each([
    {
      mode: "declared oversize",
      sizeBytes: 10 * 1024 * 1024 + 1,
      imageBytes: 4,
      imageMime: "image/png",
    },
    { mode: "declared size mismatch", sizeBytes: 5, imageBytes: 4, imageMime: "image/png" },
    { mode: "missing returned bytes", sizeBytes: 4, imageBytes: null, imageMime: "image/png" },
    { mode: "returned size mismatch", sizeBytes: 4, imageBytes: 5, imageMime: "image/png" },
    { mode: "returned MIME mismatch", sizeBytes: 4, imageBytes: 4, imageMime: "image/jpeg" },
  ])(
    "G3 rejects $mode without submitting the prompt",
    ({ mode, sizeBytes, imageBytes, imageMime }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "hermes-g3-invalid-"),
          );
          cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
          const state = installSocket();
          state.imageBytes = imageBytes;
          state.imageMime = imageMime;
          const settings = configure(directory);
          const cwd = NodePath.join(directory, "work");
          const imagePath = NodePath.join(directory, "image.png");
          NodeFS.writeFileSync(imagePath, Buffer.from([0, 1, 2, 3]));
          const adapter = makeHermesAdapterV2({
            instanceId,
            settings,
            enableTextTurnsForTest: true,
            resolveAttachmentPath: () => imagePath,
          });
          const opened = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(`provider-session-g3-${mode}`),
            modelSelection,
            runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
          });
          const providerThread = yield* opened.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
          });
          const input = turnInput(providerThread, cwd, 1, "inspect this image");
          const error = yield* Effect.flip(
            opened.startTurn({
              ...input,
              message: {
                ...input.message,
                attachments: [
                  {
                    type: "image",
                    id: "image-1",
                    name: "image.png",
                    mimeType: "image/png",
                    sizeBytes,
                  },
                ],
              },
            }),
          );
          expect(error._tag).toBe("ProviderAdapterProtocolError");
          expect(state.submissions).toEqual([]);
          expect(state.calls.filter((call) => call.method === "image.attach_bytes")).toHaveLength(
            mode === "declared oversize" || mode === "declared size mismatch" ? 0 : 1,
          );
        }),
      ).pipe(Effect.timeout("10 seconds")),
  );

  it.live("G3 stages one image before the exact prompt submission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-g3-image-"));
        cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
        const state = installSocket();
        const settings = configure(directory);
        const cwd = NodePath.join(directory, "work");
        const imagePath = NodePath.join(directory, "image.png");
        NodeFS.writeFileSync(imagePath, Buffer.from([0, 1, 2, 3]));
        const adapter = makeHermesAdapterV2({
          instanceId,
          settings,
          enableTextTurnsForTest: true,
          resolveAttachmentPath: () => imagePath,
        });
        const opened = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-g3-image"),
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const providerThread = yield* opened.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* Stream.runForEach(opened.events, (event) => Queue.offer(events, event)).pipe(
          Effect.forkScoped,
        );
        const input = turnInput(providerThread, cwd, 1, "inspect this image");
        yield* opened.startTurn({
          ...input,
          message: {
            ...input.message,
            attachments: [
              {
                type: "image",
                id: "image-1",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 4,
              },
            ],
          },
        });
        let terminal: ProviderAdapter.ProviderAdapterV2Event | undefined;
        while (terminal?.type !== "turn.terminal") terminal = yield* Queue.take(events);
        expect(terminal.status).toBe("completed");
        expect(
          state.calls
            .filter((call) => ["image.attach_bytes", "prompt.submit"].includes(call.method))
            .map((call) => call.method),
        ).toEqual(["image.attach_bytes", "prompt.submit"]);
        expect(state.calls.find((call) => call.method === "image.attach_bytes")?.params).toEqual({
          session_id: "session-a",
          content_base64: "AAECAw==",
          filename: "image.png",
        });
        expect(state.submissions).toEqual([
          {
            session_id: "session-a",
            input_id: expect.any(String),
            text: "inspect this image",
            attachments: [{ path: "/profile/cache/images/upload-1.png", mime: "image/png" }],
          },
        ]);
        const store = new HermesSessionStore(
          NodePath.join(directory, "state", "sessions.sqlite3"),
          true,
        );
        const inputId = state.submissions[0]!.input_id as string;
        expect(store.getPendingImage(inputId)).toBeNull();
        expect(store.getAttachedImage(inputId)).toMatchObject({
          path: "/profile/cache/images/upload-1.png",
          mime: "image/png",
        });
        store.close();
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );

  it.live("G3 uses the configured profile selection without a model mutation", () =>
    Effect.gen(function* () {
      const { state, result, transition } = yield* runSelectionTurn({
        ...modelSelection,
        options: [{ id: "reasoningEffort", value: "default" }],
      });
      expect(transition).toEqual({ type: "apply_on_next_turn" });
      expect(result._tag).toBe("Success");
      expect(state.calls.some((call) => call.method === "session.mutate")).toBe(false);
      expect(state.submissions).toHaveLength(1);
    }).pipe(Effect.timeout("10 seconds")),
  );

  it.live("G3 rejects custom model and reasoning selections without a Gateway write", () =>
    Effect.gen(function* () {
      for (const selection of [
        { ...modelSelection, model: "switched" },
        { ...modelSelection, options: [{ id: "reasoningEffort", value: "high" }] },
      ]) {
        const { state, result, transition } = yield* runSelectionTurn(selection);
        expect(transition).toMatchObject({
          type: "reject",
          reason: expect.stringContaining("Use the configured Hermes profile defaults"),
        });
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ProviderAdapterProtocolError",
            detail: expect.stringContaining("Use the configured Hermes profile defaults"),
          },
        });
        expect(state.calls.some((call) => call.method === "session.mutate")).toBe(false);
        expect(state.submissions).toEqual([]);
      }
    }).pipe(Effect.timeout("10 seconds")),
  );
});
