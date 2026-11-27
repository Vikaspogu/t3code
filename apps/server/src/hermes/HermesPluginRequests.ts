import {
  HermesPluginRequestError,
  type HermesPluginInvokeInput,
  type HermesPluginInvokeResult,
  type HermesPluginListToolsInput,
  type HermesPluginListToolsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

export class HermesPluginRequests extends Context.Service<
  HermesPluginRequests,
  {
    readonly listTools: (
      input: HermesPluginListToolsInput,
    ) => Effect.Effect<HermesPluginListToolsResult, HermesPluginRequestError>;
    readonly invoke: (
      input: HermesPluginInvokeInput,
    ) => Effect.Effect<HermesPluginInvokeResult, HermesPluginRequestError>;
  }
>()("t3/hermes/HermesPluginRequests") {}

const isRequestError = Schema.is(HermesPluginRequestError);

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const resolve = Effect.fn("HermesPluginRequests.resolve")(function* (
    input: HermesPluginListToolsInput,
  ) {
    const fail = (reason: HermesPluginRequestError["reason"]) =>
      new HermesPluginRequestError({ threadId: input.threadId, reason });
    const projection = yield* threadManagement.getThreadRecords(input.threadId, [
      "providerThreads",
    ]);
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === input.providerThreadId,
    );
    if (!providerThread) return yield* fail("thread-not-found");
    if (providerThread.driver !== "hermes") return yield* fail("provider-unsupported");
    if (providerThread.providerSessionId === null) return yield* fail("session-stopped");
    const runtime = Option.getOrUndefined(
      yield* providerSessions.get(providerThread.providerSessionId),
    );
    if (!runtime) return yield* fail("session-stopped");
    if (!runtime.hermesPlugins) return yield* fail("provider-unsupported");
    return { providerThread, hermesPlugins: runtime.hermesPlugins };
  });

  const toRequestError =
    (input: HermesPluginListToolsInput) =>
    (cause: unknown): Effect.Effect<never, HermesPluginRequestError> => {
      if (isRequestError(cause)) return Effect.fail(cause);
      const detail = Predicate.hasProperty(cause, "detail") ? cause.detail : undefined;
      const reason =
        detail === "Hermes plugin RPC is disabled"
          ? "disabled"
          : detail === "Invalid Hermes plugin method"
            ? "invalid-method"
            : Predicate.isTagged(cause, "ProviderAdapterSessionStoppedError")
              ? "session-stopped"
              : "request-failed";
      return Effect.logWarning("hermes-plugin-request.failed", {
        threadId: input.threadId,
        cause: Predicate.hasProperty(cause, "_tag") ? cause._tag : "unknown",
      }).pipe(
        Effect.andThen(
          Effect.fail(new HermesPluginRequestError({ threadId: input.threadId, reason })),
        ),
      );
    };

  const listTools = Effect.fn("HermesPluginRequests.listTools")(
    function* (input: HermesPluginListToolsInput) {
      const { providerThread, hermesPlugins } = yield* resolve(input);
      return { tools: yield* hermesPlugins.listTools({ providerThread }) };
    },
    (effect, input) => effect.pipe(Effect.catch(toRequestError(input))),
  );

  const invoke = Effect.fn("HermesPluginRequests.invoke")(
    function* (input: HermesPluginInvokeInput) {
      const { providerThread, hermesPlugins } = yield* resolve(input);
      return {
        result: yield* hermesPlugins.invoke({
          providerThread,
          method: input.method,
          params: input.params,
        }),
      };
    },
    (effect, input) => effect.pipe(Effect.catch(toRequestError(input))),
  );

  return HermesPluginRequests.of({ listTools, invoke });
});

export const layer = Layer.effect(HermesPluginRequests, make);
