import { CommandId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import {
  hermesReservedRestartCandidate,
  hermesRestartRecoveryCandidate,
} from "./HermesRestartRecovery.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as RunExecutionService from "./RunExecutionService.ts";

export class HermesRestartRecoveryService extends Context.Service<
  HermesRestartRecoveryService,
  { readonly recover: Effect.Effect<void> }
>()("t3/orchestration-v2/HermesRestartRecoveryService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
  const runExecution = yield* RunExecutionService.RunExecutionServiceV2;

  const recover = Effect.gen(function* () {
    const resolved = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (resolved === null) {
      yield* Effect.logWarning("Hermes restart recovery skipped: server settings unavailable");
      return;
    }
    const threadIds = yield* projections.getRecoveryThreadIds("runtime").pipe(Effect.orDie);
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function* () {
          const projection = yield* projections.getRuntimeRecoveryProjection(threadId);
          if (
            !resolveProjectSettings(resolved, projection.thread.projectId).settings
              .continueThreadsAfterServerUpdate
          )
            return;
          const accepted = hermesRestartRecoveryCandidate(projection);
          const reserved =
            accepted === undefined
              ? yield* hermesReservedRestartCandidate(projection, projections.getThreadRecords)
              : undefined;
          const candidate = accepted ?? reserved;
          if (candidate === undefined) return;
          const { run, attempt, providerThread, rootNode } = candidate;
          const fullProjection = yield* projections.getThreadProjection(threadId);
          const checkpointScope = fullProjection.checkpointScopes.find(
            (entry) => entry.id === rootNode.checkpointScopeId,
          );
          if (checkpointScope === undefined) {
            yield* Effect.logWarning("Missing Hermes recovery checkpoint scope", {
              threadId,
              runId: run.id,
            });
            return;
          }
          const providerSessionId = providerThread.providerSessionId;
          if (providerSessionId === null) return;
          const message = yield* projections.getRunMessage(threadId, run.id);
          if (message === undefined) {
            yield* Effect.logWarning("Missing Hermes recovery message", {
              threadId,
              runId: run.id,
            });
            return;
          }

          yield* Effect.gen(function* () {
            const resolvedPolicy = yield* runtimePolicy.resolve({
              thread: projection.thread,
              modelSelection: run.modelSelection,
            });
            const session = yield* providerSessions.open({
              threadId,
              providerSessionId,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedPolicy,
              ...(projection.providerSessions.find(
                (existing) => existing.id === providerSessionId,
              ) === undefined
                ? {}
                : {
                    resumeFromSession: projection.providerSessions.find(
                      (existing) => existing.id === providerSessionId,
                    )!,
                  }),
              ...(providerThread.nativeThreadRef?.nativeId == null
                ? {}
                : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
              ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
                ? {}
                : {
                    initialProviderItemIdentityVersion:
                      providerThread.nativeMetadata.itemIdentityVersion,
                  }),
            });
            if (
              session.driver !== "hermes" ||
              session.instanceId !== run.providerInstanceId ||
              session.providerSessionId !== providerSessionId ||
              session.canResumeAfterRestart !== true ||
              session.resumeTurn === undefined
            ) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: providerThread.driver,
                detail: "Opened session cannot resume the original turn.",
              });
            }
            yield* runExecution.startRootRun({
              commandId: CommandId.make(`hermes-restart:${run.id}`),
              providerSessionId,
              appThread: projection.thread,
              run,
              attempt,
              attemptId: attempt.id,
              rootNode,
              checkpointScope,
              providerThread,
              message: {
                messageId: message.id,
                text: message.text,
                attachments: message.attachments,
                createdBy: message.createdBy,
                creationSource: message.creationSource,
                ...(message.scheduledTaskId === undefined
                  ? {}
                  : { scheduledTaskId: message.scheduledTaskId }),
                ...(message.senderThreadId === undefined
                  ? {}
                  : { senderThreadId: message.senderThreadId }),
              },
              session,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedPolicy,
              providerTurnOrdinal:
                accepted?.providerTurn.ordinal ?? reserved?.providerTurnOrdinal ?? 1,
              nativeThreadHasTurns:
                accepted !== undefined || (reserved?.providerTurnOrdinal ?? 1) > 1,
              resume: true,
              preserveRunOnResumeError: true,
            });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Hermes same-run restart recovery refused; preserving the original request",
                  {
                    threadId,
                    runId: run.id,
                    providerSessionId,
                    cause: Cause.pretty(cause),
                  },
                );
                // Release reruns the same eligibility check. A still-exact
                // candidate remains pending for a later restart; an emitted mismatch is cancelled.
                yield* providerSessions
                  .release({
                    providerSessionId,
                    reason: "runtime_error",
                    preservePendingRequest: true,
                    detail: "Hermes same-run restart recovery was refused.",
                  })
                  .pipe(
                    Effect.catchCause((releaseCause) =>
                      Effect.logWarning("Failed to close refused Hermes recovery session", {
                        threadId,
                        runId: run.id,
                        providerSessionId,
                        cause: Cause.pretty(releaseCause),
                      }),
                    ),
                  );
              }),
            ),
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed Hermes same-run restart recovery; preserving durable state", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  }).pipe(Effect.withSpan("HermesRestartRecoveryService.recover"));

  return HermesRestartRecoveryService.of({ recover });
});

export const layer = Layer.effect(HermesRestartRecoveryService, make);
