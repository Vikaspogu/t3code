import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

import { HermesSessionStore } from "@t3tools/provider-hermes/server";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProjectionRuntimeRecoveryState, ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import { restartContinuationBlocked, restartStopRequested } from "./RestartContinuation.ts";

class HermesReservationReadError extends Schema.TaggedError<
  HermesReservationReadError,
  { readonly brand: unique symbol }
>()("HermesReservationReadError", { message: Schema.String, cause: Schema.Defect() }) {}

interface HermesRestartRun {
  readonly run: OrchestrationV2Run;
  readonly attempt: OrchestrationV2RunAttempt;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly rootNode: OrchestrationV2ExecutionNode;
}

export interface HermesRestartRecoveryCandidate extends HermesRestartRun {
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly request: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly item: OrchestrationV2TurnItem;
}

export const hermesResumeRefusalReason = "Hermes resume refused; restart required.";

function originalHermesRun(
  projection: ProjectionRuntimeRecoveryState,
): HermesRestartRun | undefined {
  if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;
  const activeRuns = projection.runs.filter(
    (run) => run.status === "running" || run.status === "waiting",
  );
  if (activeRuns.length !== 1) return;
  const run = activeRuns[0]!;
  if (
    run.threadId !== projection.thread.id ||
    run.providerThreadId === null ||
    run.rootNodeId === null ||
    run.activeAttemptId === null ||
    projection.thread.providerInstanceId !== run.providerInstanceId
  )
    return;

  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  if (
    providerThread === undefined ||
    providerThread.driver !== "hermes" ||
    providerThread.appThreadId !== projection.thread.id ||
    providerThread.providerInstanceId !== run.providerInstanceId ||
    providerThread.providerSessionId === null ||
    providerThread.ownerNodeId !== null ||
    providerThread.nativeThreadRef?.driver !== "hermes" ||
    typeof providerThread.nativeThreadRef.nativeId !== "string" ||
    providerThread.nativeThreadRef.nativeId.length === 0 ||
    providerThread.nativeThreadRef.strength !== "strong"
  )
    return;

  const attempt = projection.attempts.find(
    (candidate) => candidate.id === run.activeAttemptId && candidate.runId === run.id,
  );
  if (
    attempt === undefined ||
    attempt.status !== "running" ||
    attempt.rootNodeId !== run.rootNodeId ||
    attempt.providerThreadId !== providerThread.id ||
    attempt.providerInstanceId !== run.providerInstanceId
  )
    return;

  const rootNode = projection.nodes.find(
    (candidate) =>
      candidate.id === run.rootNodeId &&
      candidate.runId === run.id &&
      candidate.kind === "root_turn" &&
      candidate.providerThreadId === providerThread.id &&
      (candidate.status === "running" || candidate.status === "waiting") &&
      candidate.checkpointScopeId !== null,
  );
  if (rootNode === undefined) return;
  return { run, attempt, providerThread, rootNode };
}

/** Accepted interactions require the full original request and turn identity. */
export function hermesRestartRecoveryCandidate(
  projection: ProjectionRuntimeRecoveryState,
): HermesRestartRecoveryCandidate | undefined {
  const original = originalHermesRun(projection);
  if (original === undefined) return;
  const { run, attempt, providerThread } = original;
  const acceptedTurns = projection.providerTurns.filter((turn) => turn.runAttemptId === attempt.id);
  if (acceptedTurns.length !== 1) return;
  const providerTurn = acceptedTurns[0]!;
  if (
    (attempt.providerTurnId !== null && providerTurn.id !== attempt.providerTurnId) ||
    providerTurn.providerThreadId !== providerThread.id ||
    providerTurn.nodeId !== attempt.rootNodeId ||
    providerTurn.status !== "running"
  )
    return;

  const runNodeIds = new Set(
    projection.nodes.filter((node) => node.runId === run.id).map((node) => node.id),
  );
  const pendingRequests = projection.runtimeRequests.filter(
    (request) => request.status === "pending" && runNodeIds.has(request.nodeId),
  );
  if (pendingRequests.length !== 1) return;
  const request = pendingRequests[0]!;
  const responseCapability = request.responseCapability;
  if (
    (request.kind !== "command" && request.kind !== "user_input") ||
    request.providerTurnId !== providerTurn.id ||
    (responseCapability.type === "live"
      ? responseCapability.providerSessionId !== providerThread.providerSessionId
      : responseCapability.type !== "not_resumable" ||
        responseCapability.reason !== hermesResumeRefusalReason)
  )
    return;

  const node = projection.nodes.find(
    (candidate) =>
      candidate.id === request.nodeId &&
      candidate.runId === run.id &&
      candidate.rootNodeId === run.rootNodeId &&
      candidate.providerTurnId === providerTurn.id &&
      candidate.runtimeRequestId === request.id &&
      candidate.status === "waiting",
  );
  const item = projection.turnItems.find(
    (candidate) =>
      candidate.runId === run.id &&
      candidate.nodeId === request.nodeId &&
      candidate.providerTurnId === providerTurn.id &&
      candidate.status === "waiting" &&
      ((candidate.type === "approval_request" &&
        request.kind === "command" &&
        candidate.requestId === request.id) ||
        (candidate.type === "user_input_request" &&
          request.kind === "user_input" &&
          candidate.requestId === request.id)),
  );
  if (node === undefined || item === undefined) return;
  return {
    ...original,
    providerTurn,
    request,
    node,
    item,
  };
}

/** A reservation is evidence of an attempted start, even before T3 has a provider turn. */
export const hermesReservedRestartCandidate = Effect.fn("hermesReservedRestartCandidate")(
  function* (
    projection: ProjectionRuntimeRecoveryState,
    getThreadRecords: ProjectionStoreV2Shape["getThreadRecords"],
  ) {
    const candidate = originalHermesRun(projection);
    const sessionId = candidate?.providerThread.nativeThreadRef?.nativeId;
    if (!candidate || !sessionId) return;
    const directory = HermesSessionStore.stateDirectoryFromEnv();
    if (!directory) return;
    const { run, attempt, providerThread } = candidate;
    if (
      run.status !== "running" ||
      attempt.providerTurnId !== null ||
      restartContinuationBlocked(projection, run, yield* DateTime.now, false) ||
      projection.providerTurns.some((turn) => turn.runAttemptId === attempt.id) ||
      (yield* restartStopRequested(getThreadRecords, projection.thread, run))
    )
      return;

    const { providerTurns } = yield* getThreadRecords(projection.thread.id, ["providerTurns"], {
      providerTurnThreadIds: [providerThread.id],
    });
    if (providerTurns.some((turn) => turn.runAttemptId === attempt.id)) return;
    const reserved = yield* Effect.try({
      try: () =>
        HermesSessionStore.hasReservedTurn(
          directory,
          projection.thread.id,
          run.id,
          sessionId,
          attempt.id,
        ),
      catch: (cause) =>
        new HermesReservationReadError({
          message: "Could not read the durable Hermes reservation",
          cause,
        }),
    });
    if (!reserved) return;
    return {
      ...candidate,
      providerTurnOrdinal:
        providerTurns.reduce((ordinal, turn) => Math.max(ordinal, turn.ordinal), 0) + 1,
    };
  },
);
