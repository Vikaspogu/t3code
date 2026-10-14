import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexProtocol from "effect-codex-app-server/protocol";
import type { CodexAppServerIncomingNotification } from "effect-codex-app-server/protocol";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import {
  nativeVoiceProtocolOptions,
  openNativeVoice,
  type NativeVoiceEvent,
} from "./NativeVoice.ts";

it.effect(
  "traces actual speech request and reply without exposing contents or claiming audio",
  () =>
    Effect.gen(function* () {
      const logs: Array<{ message: string; annotations: Record<string, unknown> }> = [];
      const logger = Logger.make<unknown, void>(({ fiber, message }) => {
        logs.push({
          message: String(message),
          annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
        });
      });
      yield* Effect.gen(function* () {
        const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
        const output = yield* Queue.unbounded<string>();
        const decoder = new TextDecoder();
        const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
          ...nativeVoiceProtocolOptions("trace-call"),
          stdio: Stdio.make({
            args: Effect.succeed([]),
            stdin: Stream.fromQueue(input),
            stdout: () =>
              Sink.forEach((chunk: string | Uint8Array) =>
                Queue.offer(
                  output,
                  typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
                ),
              ),
            stderr: () => Sink.drain,
          }),
        });
        const text = "secret speech content";
        const request = yield* transport
          .request("thread/realtime/appendSpeech", { threadId: "coordinator", text })
          .pipe(Effect.forkScoped);
        const wire = JSON.parse(yield* Queue.take(output)) as { id: number };
        yield* Queue.offer(
          input,
          new TextEncoder().encode(
            JSON.stringify({
              method: "thread/realtime/transcript/done",
              params: { role: "user", text: "secret user transcript" },
            }) + "\n",
          ),
        );
        yield* Queue.offer(
          input,
          new TextEncoder().encode(
            JSON.stringify({ id: wire.id, result: { secret: "secret reply" } }) + "\n",
          ),
        );
        yield* Fiber.join(request);
        assert.deepStrictEqual(
          logs.map((entry) => entry.annotations),
          [
            {
              callId: "trace-call",
              event: "speech-requested",
              requestId: wire.id,
              textChars: text.length,
            },
            { callId: "trace-call", event: "transcript-final", role: "user", textChars: 22 },
            {
              callId: "trace-call",
              event: "speech-response",
              requestId: wire.id,
              outcome: "accepted",
            },
          ],
        );
        assert.isFalse(JSON.stringify(logs).includes("secret"));
        assert.isFalse(JSON.stringify(logs).includes("delivered"));
      }).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      );
    }),
);

const input = {
  instanceId: ProviderInstanceId.make("codex"),
  threadId: ThreadId.make("t3-thread"),
  cwd: "/project",
  model: "gpt-6.1-sol",
  offerSdp: "offer",
  callId: "fixture-call",
};
it.effect("keeps protocol diagnostics bounded and ignores malformed or private payloads", () =>
  Effect.gen(function* () {
    const logs: Array<Record<string, unknown>> = [];
    const capture = Logger.make<unknown, void>(({ fiber, message }) => {
      logs.push({ message: String(message), ...fiber.getRef(References.CurrentLogAnnotations) });
    });
    const options = nativeVoiceProtocolOptions("trace-call");
    const logger = options.logger;
    if (!logger) throw new Error("Missing voice protocol logger");
    yield* Effect.gen(function* () {
      for (const payload of [
        null,
        undefined,
        [],
        "secret raw",
        { method: "thread/realtime/transcript/done", params: null },
        { id: 10, result: "secret unmatched" },
      ]) {
        yield* logger({ direction: "incoming", stage: "decoded", payload });
      }
      yield* logger({ direction: "incoming", stage: "raw", payload: "secret SDP" });
      yield* logger({ direction: "incoming", stage: "decode_failed", payload: "secret error" });
      yield* logger({
        direction: "incoming",
        stage: "decoded",
        payload: { method: "thread/realtime/sdp", params: { sdp: "secret SDP" } },
      });
      assert.deepStrictEqual(logs, []);
      for (let id = 1; id <= 33; id++) {
        yield* logger({
          direction: "outgoing",
          stage: "decoded",
          payload: {
            id,
            method: "thread/realtime/appendSpeech",
            params: { text: "secret speech" },
          },
        });
      }
      yield* logger({ direction: "incoming", stage: "decoded", payload: { id: 1, result: {} } });
      assert.strictEqual(logs.length, 33);
      yield* logger({
        direction: "incoming",
        stage: "decoded",
        payload: { id: 2, error: { code: -1, message: "secret error", data: "secret data" } },
      });
      yield* logger({
        direction: "incoming",
        stage: "decoded",
        payload: {
          method: "thread/realtime/transcript/done",
          params: { role: "assistant", text: "secret reply" },
        },
      });
      yield* logger({ direction: "incoming", stage: "decoded", payload: { id: 2, result: {} } });
      assert.deepStrictEqual(logs.slice(33), [
        {
          message: "Orbit voice native trace",
          callId: "trace-call",
          event: "speech-response",
          requestId: 2,
          outcome: "error",
          errorCode: -1,
        },
        {
          message: "Orbit voice native trace",
          callId: "trace-call",
          event: "transcript-final",
          role: "assistant",
          textChars: 12,
        },
      ]);
      assert.isFalse(JSON.stringify(logs).includes("secret"));
    }).pipe(
      Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    );
  }),
);
const disabledServer = (name: string) => ({
  name,
  authStatus: "unsupported",
  httpOrigin: null,
  pluginId: null,
  serverInfo: null,
  serverCapabilities: null,
  toolsError: null,
  tools: {},
  resources: [],
  resourceTemplates: [],
  runtimeStatus: "disabled",
});
const disabledInventory = (name: string) => ({ data: [disabledServer(name)], nextCursor: null });
const fixture = ({
  output = '{"decision":"task"}',
  pending = false,
  inventoryFor = disabledInventory,
  missingAck = false,
  failRequest,
  observedEvents,
  calls = [],
}: {
  output?: string;
  pending?: boolean;
  inventoryFor?: (serverName: string) => unknown;
  missingAck?: boolean;
  failRequest?: string;
  observedEvents?: Array<NativeVoiceEvent>;
  calls?: Array<{ method: string; params: unknown }>;
} = {}) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<CodexAppServerIncomingNotification>();
    const started = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const captions = yield* Queue.unbounded<string>();
    const events: Array<NativeVoiceEvent> = observedEvents ?? [];
    let threads = 0;
    let clientManagedHandoffs = false;
    const notice = (method: string, params: unknown) =>
      Queue.offer(queue, { method, params }).pipe(Effect.asVoid);
    const speech = (text: string) =>
      notice("thread/realtime/transcript/done", {
        threadId: "coordinator",
        role: "assistant",
        text,
      });
    // Codex 0.161 handoff_out suppresses backing replies; append_speech remains independent.
    const completeBackingTurn = (text: string) =>
      Effect.gen(function* () {
        yield* notice("item/completed", {
          threadId: "coordinator",
          turnId: "native-handoff",
          item: { type: "agentMessage", text },
        });
        if (!clientManagedHandoffs) yield* speech(text);
      });
    const client = CodexClient.CodexAppServerClient.of({
      raw: {
        notifications: Stream.fromQueue(queue),
        requests: Stream.empty,
        notify: () => Effect.void,
        respond: () => Effect.void,
        respondError: () => Effect.void,
        request: (method, params) =>
          Effect.gen(function* () {
            calls.push({ method, params });
            if (method === failRequest)
              return yield* CodexErrors.CodexAppServerRequestError.methodNotFound(method);
            if (method === "initialize") return { userAgent: "codex_cli_rs/0.161.0" };
            if (method === "config/read")
              return {
                config: {
                  mcp_servers: { personal: { enabled: true }, project: { enabled: true } },
                },
              };
            if (method === "thread/start")
              return {
                thread: {
                  id: ++threads === 1 ? "coordinator" : "router",
                  ephemeral: true,
                  environments: [],
                },
                approvalPolicy: "never",
                sandbox: { type: "readOnly", networkAccess: false },
              };
            if (method === "mcpServerStatus/list")
              return inventoryFor((params as { serverName: string }).serverName);
            if (method === "thread/realtime/start") {
              clientManagedHandoffs =
                (params as { clientManagedHandoffs?: boolean }).clientManagedHandoffs === true;
              yield* notice("thread/realtime/sdp", { threadId: "coordinator", sdp: "answer" });
              return {};
            }
            if (method === "thread/realtime/appendSpeech") {
              yield* speech((params as { text: string }).text);
              return {};
            }
            if (method === "turn/start") {
              if (missingAck) {
                yield* Deferred.succeed(started, undefined);
                return yield* Effect.never;
              }
              if (!pending) {
                yield* notice("item/completed", {
                  threadId: "coordinator",
                  turnId: "native-handoff",
                  item: { type: "agentMessage", text: '{"decision":"steer"}' },
                });
                yield* notice("item/completed", {
                  threadId: "router",
                  turnId: "other-turn",
                  item: { type: "agentMessage", text: '{"decision":"steer"}' },
                });
                yield* notice("turn/completed", {
                  threadId: "router",
                  turn: { id: "other-turn", status: "completed" },
                });
                yield* notice("item/completed", {
                  threadId: "router",
                  turnId: "owned-turn",
                  item: { type: "agentMessage", text: output },
                });
                yield* notice("turn/completed", {
                  threadId: "router",
                  turn: { id: "owned-turn", status: "completed" },
                });
              }
              yield* Deferred.succeed(started, undefined);
              yield* Effect.yieldNow;
              return { turn: { id: "owned-turn" } };
            }
            return {};
          }),
      },
      request: () => Effect.die("Only raw pinned protocol calls are expected"),
      notify: () => Effect.void,
      handleServerRequest: () => Effect.void,
      handleServerNotification: () => Effect.void,
      handleUnknownServerRequest: () => Effect.void,
      handleUnknownServerNotification: () => Effect.void,
    });
    const call = yield* openNativeVoice(client, input, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "caption") yield* Queue.offer(captions, event.text);
        if (event.type === "closed") yield* Deferred.succeed(closed, undefined);
      }),
    );
    return { call, calls, events, notice, started, closed, queue, captions, completeBackingTurn };
  });

it.effect("binds router output to its acknowledged turn even when completion arrives first", () =>
  Effect.gen(function* () {
    const { call, calls } = yield* fixture();
    assert.equal(call.answerSdp, "answer");
    assert.equal(
      yield* call.classify({ text: "  Fix the café button.\n", context: "No task is active." }),
      "task",
    );
    const start = calls.find((entry) => entry.method === "turn/start")?.params as {
      threadId: string;
      input: [{ text: string }];
    };
    assert.equal(JSON.parse(start.input[0].text).text, "  Fix the café button.\n");
    assert.equal(start.threadId, "router");
  }),
);

it.effect("disables inherited MCP, plugins, environment access and agents on both threads", () =>
  Effect.gen(function* () {
    const { calls } = yield* fixture();
    const starts = calls
      .filter((entry) => entry.method === "thread/start")
      .map((entry) => entry.params);
    assert.lengthOf(starts, 2);
    for (const start of starts) {
      assert.deepInclude(start, {
        environments: [],
        runtimeWorkspaceRoots: [],
        selectedCapabilityRoots: [],
        dynamicTools: [],
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const config = (
        start as { config: { mcp_servers: unknown; features: Record<string, boolean> } }
      ).config;
      assert.deepEqual(config.mcp_servers, {
        personal: { enabled: false },
        project: { enabled: false },
      });
      assert.isFalse(config.features.plugins);
      assert.isFalse(config.features.multi_agent);
      assert.isFalse(config.features.multi_agent_v2);
    }
  }),
);

it.effect("invalid classifier output asks for clarification without adopting model text", () =>
  Effect.gen(function* () {
    const { call } = yield* fixture({
      output: '{"decision":"task","instruction":"rewrite everything"}',
    });
    assert.equal(
      yield* call.classify({ text: "What is happening?", context: "A task is active." }),
      "clarify",
    );
  }),
);

it.effect("routing timeout interrupts only the acknowledged router turn", () =>
  Effect.gen(function* () {
    const { call, calls, started } = yield* fixture({ pending: true });
    const fiber = yield* call.classify({ text: "Fix it", context: "" }).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("20 seconds");
    const result = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isFailure(result));
    assert.deepEqual(
      calls.filter((entry) => entry.method === "turn/interrupt"),
      [{ method: "turn/interrupt", params: { threadId: "router", turnId: "owned-turn" } }],
    );
  }),
);

it.effect("speech uses assistant appendSpeech and never a user-role native turn", () =>
  Effect.gen(function* () {
    const { call, calls } = yield* fixture();
    yield* call.speak("Your coding task is still working.");
    assert.deepEqual(
      calls.filter((entry) => entry.method === "thread/realtime/appendSpeech"),
      [
        {
          method: "thread/realtime/appendSpeech",
          params: { threadId: "coordinator", text: "Your coding task is still working." },
        },
      ],
    );
    assert.isFalse(calls.some((entry) => entry.method === "thread/realtime/appendText"));
  }),
);

it.effect("host task speech survives while competing backing replies are suppressed", () =>
  Effect.gen(function* () {
    const { call, captions, completeBackingTurn } = yield* fixture();
    yield* completeBackingTurn("I cannot run shell commands here.");
    yield* call.speak("The coding task was accepted.");
    yield* call.speak("The coding task completed.");
    const observed: Array<string> = [];
    while (observed.at(-1) !== "The coding task completed.") {
      observed.push(yield* Queue.take(captions));
    }
    assert.deepEqual(observed, ["The coding task was accepted.", "The coding task completed."]);
  }),
);

it.effect("native execution closes voice and rejects later speech", () =>
  Effect.gen(function* () {
    const { call, notice, closed, events } = yield* fixture();
    yield* notice("item/started", {
      threadId: "coordinator",
      item: { type: "commandExecution", command: "ignored" },
    });
    yield* Deferred.await(closed);
    assert.isTrue(Exit.isFailure(yield* call.speak("Do not deliver this.").pipe(Effect.exit)));
    assert.equal(events.filter((event) => event.type === "closed").length, 1);
  }),
);

it.effect("closing the call scope stops realtime and rejects later speech", () =>
  Effect.gen(function* () {
    const callScope = yield* Scope.make();
    const { call, calls } = yield* fixture().pipe(Effect.provideService(Scope.Scope, callScope));
    yield* Scope.close(callScope, Exit.void);
    assert.deepEqual(
      calls.filter((entry) => entry.method === "thread/realtime/stop"),
      [{ method: "thread/realtime/stop", params: { threadId: "coordinator" } }],
    );
    assert.isTrue(Exit.isFailure(yield* call.speak("Do not deliver this.").pipe(Effect.exit)));
  }),
);

it.effect("a native process exit closes the call without waiting for another request", () =>
  Effect.gen(function* () {
    const { queue, closed } = yield* fixture();
    yield* Queue.shutdown(queue);
    yield* Deferred.await(closed);
  }),
);

it.effect("a missing router acknowledgement ends the call without guessing a turn id", () =>
  Effect.gen(function* () {
    const { call, calls, events, started } = yield* fixture({ missingAck: true });
    const routing = yield* call
      .classify({ text: "Fix the button", context: "" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("20 seconds");
    assert.isTrue(Exit.isFailure(yield* Fiber.await(routing)));
    assert.isTrue(events.some((event) => event.type === "closed"));
    assert.isFalse(calls.some((entry) => entry.method === "turn/interrupt"));
  }),
);

it.effect("preserves startup request failure without a cleanup close event", () =>
  Effect.gen(function* () {
    const events: Array<NativeVoiceEvent> = [];
    const result = yield* fixture({ failRequest: "config/read", observedEvents: events }).pipe(
      Effect.scoped,
      Effect.result,
    );
    assert.equal(result._tag, "Failure");
    assert.deepEqual(events, []);
    if (result._tag === "Failure") assert.include(result.failure.message, "config/read");
  }),
);

it.effect(
  "connects after confirming each configured server is disabled on both native threads",
  () =>
    Effect.gen(function* () {
      const { call, calls } = yield* fixture();
      assert.equal(call.answerSdp, "answer");
      assert.deepEqual(
        calls
          .filter((entry) => entry.method === "mcpServerStatus/list")
          .map((entry) => entry.params),
        [
          { threadId: "coordinator", serverName: "personal" },
          { threadId: "coordinator", serverName: "project" },
          { threadId: "router", serverName: "personal" },
          { threadId: "router", serverName: "project" },
        ],
      );
    }),
);

const inventoryFailures: Array<{
  label: string;
  reason: string;
  inventoryFor: (name: string) => unknown;
}> = [
  { label: "absent inventory", reason: "invalid inventory", inventoryFor: () => undefined },
  {
    label: "malformed inventory",
    reason: "invalid inventory",
    inventoryFor: () => ({ data: {}, nextCursor: null }),
  },
  {
    label: "missing server",
    reason: "missing server",
    inventoryFor: () => ({ data: [], nextCursor: null }),
  },
  {
    label: "multiple servers",
    reason: "multiple servers",
    inventoryFor: (name) => ({
      data: [disabledServer(name), disabledServer(name)],
      nextCursor: null,
    }),
  },
  {
    label: "wrong server",
    reason: "server identity mismatch",
    inventoryFor: () => disabledInventory("unrequested-server"),
  },
  {
    label: "missing server identity",
    reason: "server identity mismatch",
    inventoryFor: (name) => ({
      data: [{ ...disabledServer(name), name: undefined }],
      nextCursor: null,
    }),
  },
  {
    label: "malformed server",
    reason: "invalid server",
    inventoryFor: () => ({ data: [null], nextCursor: null }),
  },
  {
    label: "pagination",
    reason: "paginated inventory",
    inventoryFor: (name) => ({ ...disabledInventory(name), nextCursor: "page-2" }),
  },
  {
    label: "missing pagination state",
    reason: "missing pagination state",
    inventoryFor: (name) => ({ data: [disabledServer(name)] }),
  },
  ...[
    undefined,
    null,
    "notStarted",
    "starting",
    "connected",
    "authenticationRequired",
    "failed",
    "cancelled",
    "unexpected-private-value",
  ].map((runtimeStatus) => ({
    label: `unconfirmed status ${runtimeStatus}`,
    reason:
      runtimeStatus == null
        ? "missing server state"
        : runtimeStatus === "unexpected-private-value"
          ? "unknown server state"
          : `server state ${runtimeStatus}`,
    inventoryFor: (name: string) => ({
      data: [{ ...disabledServer(name), runtimeStatus }],
      nextCursor: null,
    }),
  })),
  ...["tools", "resources", "resourceTemplates"].flatMap((field) =>
    [undefined, null, "malformed", field === "tools" ? { execute: {} } : [{}]].map(
      (value, index) => ({
        label: `${field} invalid case ${index}`,
        reason: index === 3 ? "nonempty collections" : "invalid collections",
        inventoryFor: (name: string) => ({
          data: [{ ...disabledServer(name), [field]: value }],
          nextCursor: null,
        }),
      }),
    ),
  ),
];
it.effect.each(inventoryFailures)(
  "refuses $label before opening audio",
  ({ inventoryFor, reason }) =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; params: unknown }> = [];
      const result = yield* fixture({ inventoryFor, calls }).pipe(Effect.scoped, Effect.result);
      assert.equal(result._tag, "Failure");
      assert.isFalse(calls.some((entry) => entry.method === "thread/realtime/start"));
      if (result._tag === "Failure") {
        assert.equal(
          result.failure.message,
          `The voice runtime could not confirm tool isolation (${reason}).`,
        );
        assert.notInclude(result.failure.message, "unrequested-server");
        assert.notInclude(result.failure.message, "unexpected-private-value");
      }
    }),
);
