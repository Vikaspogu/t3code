import {
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type HermesPluginRequestError,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as HermesPluginRequests from "./HermesPluginRequests.ts";

const threadId = ThreadId.make("thread-hermes");
const providerThreadId = ProviderThreadId.make("provider-thread-hermes");
const providerSessionId = ProviderSessionId.make("provider-session-hermes");
const driver = ProviderDriverKind.make("hermes");
const input = { threadId, providerThreadId };
const calls: unknown[] = [];

function makeLayer(options?: {
  readonly providerThread?: Partial<OrchestrationV2ProviderThread> | null;
  readonly live?: boolean;
  readonly hermesPlugins?: ProviderAdapter.ProviderAdapterV2HermesPlugins;
}) {
  const providerThread =
    options?.providerThread === null
      ? []
      : [
          {
            id: providerThreadId,
            driver: "hermes",
            providerSessionId,
            ...options?.providerThread,
          } as OrchestrationV2ProviderThread,
        ];
  return HermesPluginRequests.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed({ providerThreads: providerThread } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeed(
              options?.live === false
                ? Option.none()
                : Option.some(
                    (options?.hermesPlugins
                      ? { hermesPlugins: options.hermesPlugins }
                      : {}) as ProviderAdapter.ProviderAdapterV2SessionRuntime,
                  ),
            ),
        }),
      ),
    ),
  );
}

const reason = <A, R>(effect: Effect.Effect<A, HermesPluginRequestError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

const protocolError = (detail: string) =>
  new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail });

describe("HermesPluginRequests", () => {
  it.effect("lists tools and invokes plugin methods on the resolved provider thread", () =>
    Effect.gen(function* () {
      const requests = yield* HermesPluginRequests.HermesPluginRequests;
      assert.deepEqual(yield* requests.listTools(input), {
        tools: [
          { name: "plugin.ivan_personal.echo", toolset: "ivan_personal", description: "Echo" },
        ],
      });
      assert.deepEqual(
        yield* requests.invoke({
          ...input,
          method: "plugin.ivan_personal.echo",
          params: { message: "hello" },
        }),
        { result: { echo: "hello" } },
      );
      assert.deepEqual(calls, [
        { method: "plugin.ivan_personal.echo", params: { message: "hello" } },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          hermesPlugins: {
            listTools: () =>
              Effect.succeed([
                {
                  name: "plugin.ivan_personal.echo",
                  toolset: "ivan_personal",
                  description: "Echo",
                },
              ]),
            invoke: (call) =>
              Effect.sync(() => {
                calls.push({ method: call.method, params: call.params });
                return { echo: "hello" };
              }),
          },
        }),
      ),
    ),
  );

  it.effect("distinguishes missing threads, unsupported providers, and stopped sessions", () =>
    Effect.gen(function* () {
      const check = (
        layer: Layer.Layer<HermesPluginRequests.HermesPluginRequests>,
        expected: HermesPluginRequestError["reason"],
      ) =>
        Effect.gen(function* () {
          const requests = yield* HermesPluginRequests.HermesPluginRequests.pipe(
            Effect.provide(layer),
          );
          assert.equal(yield* reason(requests.listTools(input)), expected);
        });
      yield* check(makeLayer({ providerThread: null }), "thread-not-found");
      yield* check(
        makeLayer({ providerThread: { driver: ProviderDriverKind.make("codex") } }),
        "provider-unsupported",
      );
      yield* check(makeLayer({ providerThread: { providerSessionId: null } }), "session-stopped");
      yield* check(makeLayer({ live: false }), "session-stopped");
      yield* check(makeLayer(), "provider-unsupported");
    }),
  );

  it.effect("maps adapter failures to stable request errors", () =>
    Effect.gen(function* () {
      const check = (
        failure: ProviderAdapter.ProviderAdapterV2Error,
        expected: HermesPluginRequestError["reason"],
      ) =>
        Effect.gen(function* () {
          const requests = yield* HermesPluginRequests.HermesPluginRequests.pipe(
            Effect.provide(
              makeLayer({
                hermesPlugins: {
                  listTools: () => Effect.fail(failure),
                  invoke: () => Effect.fail(failure),
                },
              }),
            ),
          );
          assert.equal(yield* reason(requests.listTools(input)), expected);
          assert.equal(
            yield* reason(
              requests.invoke({ ...input, method: "plugin.ivan_personal.echo", params: {} }),
            ),
            expected,
          );
        });
      yield* check(protocolError("Hermes plugin RPC is disabled"), "disabled");
      yield* check(protocolError("Invalid Hermes plugin method"), "invalid-method");
      yield* check(
        new ProviderAdapter.ProviderAdapterSessionStoppedError({ driver }),
        "session-stopped",
      );
      yield* check(protocolError("gateway unavailable"), "request-failed");
    }),
  );
});
