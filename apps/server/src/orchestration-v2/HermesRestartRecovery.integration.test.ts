import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@t3tools/provider-core/server/failure";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { hermesRestartRecoveryCandidate } from "./HermesRestartRecovery.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("hermes");
const instanceId = ProviderInstanceId.make("hermes-restart-test");
const selection = { instanceId, model: "hermes-test" } as const;
const capabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;

interface PendingArtifacts {
  readonly node: OrchestrationV2ExecutionNode;
  readonly request: OrchestrationV2RuntimeRequest;
  readonly item: OrchestrationV2TurnItem;
  readonly providerTurn: OrchestrationV2ProviderTurn;
}

interface RecoveryAdapterState {
  readonly started: ReadonlyArray<string>;
  readonly resumeAttempts: ReadonlyArray<string>;
  readonly resumed: ReadonlyArray<{
    readonly runId: string;
    readonly attemptId: string;
    readonly providerTurnId: string;
    readonly requestId: string;
  }>;
  readonly responses: ReadonlyArray<string>;
  readonly refuseResume: boolean;
  readonly refuseReopen: boolean;
  readonly clarify: boolean;
  readonly openAttempts: number;
}

const requestFor = (projection: OrchestrationV2ThreadProjection) => {
  const request = projection.runtimeRequests.find(
    (candidate) => candidate.kind === "command" || candidate.kind === "user_input",
  );
  assert.isDefined(request);
  return request;
};

function makeRecoveryAdapter(
  state: Ref.Ref<RecoveryAdapterState>,
  signals: {
    readonly resumeAttempted: Deferred.Deferred<void>;
    readonly resumed: Deferred.Deferred<void>;
  },
  lostPrompt?: {
    readonly parentThreadId: ThreadId;
    readonly released: Deferred.Deferred<void>;
  },
) {
  const artifacts = new Map<string, PendingArtifacts>();
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" } as const),
    openSession: (
      sessionInput: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ): Effect.Effect<
      ProviderAdapter.ProviderAdapterV2SessionRuntime,
      ProviderAdapter.ProviderAdapterV2Error,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        yield* Ref.update(state, (value) => ({ ...value, openAttempts: value.openAttempts + 1 }));
        if (current.refuseReopen && current.started.length > 0) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver,
            detail: "Synthetic failure before session registration.",
          });
        }
        const ids = yield* IdAllocator.IdAllocatorV2;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* Scope.Scope;
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
          model: sessionInput.modelSelection.model,
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const emitPending = (
          input:
            | ProviderAdapter.ProviderAdapterV2TurnInput
            | ProviderAdapter.ProviderAdapterV2ResumeTurnInput,
          providerTurnId: ProviderTurnId,
          originalRequestId?: PendingArtifacts["request"]["id"],
        ) =>
          Effect.gen(function* () {
            const requestId =
              originalRequestId ??
              (yield* ids.allocate.runtimeRequest({
                driver,
                providerTurnId,
                nativeRequestId: "approval-1",
              }));
            const existing = artifacts.get(String(requestId));
            const createdAt = yield* DateTime.now;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: providerTurnId,
              providerThreadId: input.providerThread.id,
              nodeId: input.rootNodeId,
              runAttemptId: input.attemptId,
              nativeTurnRef: {
                driver,
                nativeId: "native-turn-1",
                strength: "strong",
              },
              ordinal: input.providerTurnOrdinal,
              status: "running",
              startedAt: existing?.providerTurn.startedAt ?? createdAt,
              completedAt: null,
            };
            const nodeId = ids.derive.approvalNode({ requestId });
            const nativeItemRef = { driver, nativeId: "approval-1", strength: "strong" as const };
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: input.threadId,
              runId: input.runId,
              parentNodeId: input.rootNodeId,
              rootNodeId: input.rootNodeId,
              kind: current.clarify ? "user_input_request" : "approval_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: input.providerThread.id,
              providerTurnId,
              nativeItemRef,
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: existing?.node.startedAt ?? createdAt,
              completedAt: null,
            };
            const request: OrchestrationV2RuntimeRequest = {
              id: requestId,
              nodeId,
              providerTurnId,
              nativeRequestRef: nativeItemRef,
              kind: current.clarify ? "user_input" : "command",
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId: input.providerThread.providerSessionId!,
              },
              createdAt: existing?.request.createdAt ?? createdAt,
              resolvedAt: null,
            };
            const item: OrchestrationV2TurnItem = {
              id: ids.derive.approvalTurnItem({ requestId }),
              threadId: input.threadId,
              runId: input.runId,
              nodeId,
              providerThreadId: input.providerThread.id,
              providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal: input.providerTurnOrdinal * 100 + 3,
              status: "waiting",
              title: null,
              startedAt: existing?.item.startedAt ?? createdAt,
              completedAt: null,
              updatedAt: createdAt,
              requestId,
              ...(current.clarify
                ? {
                    type: "user_input_request" as const,
                    questions: [
                      { id: "q", header: "Choice", question: "Which option?", options: [] },
                    ],
                  }
                : {
                    type: "approval_request" as const,
                    requestKind: "command" as const,
                    prompt: "Allow the original command?",
                    options: [
                      { decision: "accept", label: "once" },
                      { decision: "decline", label: "deny" },
                    ],
                  }),
            };
            const next = { node, request, item, providerTurn };
            artifacts.set(String(requestId), next);
            yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn });
            yield* Queue.offer(events, { type: "node.updated", driver, node });
            yield* Queue.offer(events, {
              type: "runtime_request.updated",
              driver,
              runtimeRequest: request,
            });
            yield* Queue.offer(events, { type: "turn_item.updated", driver, turnItem: item });
            return next;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterProtocolError({
                  driver,
                  detail: "test request allocation failed",
                  cause,
                }),
            ),
          );

        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          canResumeAfterRestart: true,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread: (threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) =>
            DateTime.now.pipe(
              Effect.map((createdAt): OrchestrationV2ProviderThread => ({
                id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              })),
            ),
          resumeThread: ({ providerThread }: { providerThread: OrchestrationV2ProviderThread }) =>
            Effect.succeed(providerThread),
          startTurn: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(state, (current) => ({
                ...current,
                started: [...current.started, String(input.attemptId)],
              }));
              if (lostPrompt !== undefined && input.threadId !== lostPrompt.parentThreadId) {
                yield* Deferred.await(lostPrompt.released);
                const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
                const occurredAt = yield* DateTime.now;
                const message =
                  "gateway_restart_lost_prompt: Hermes restarted while waiting for approval or clarification. " +
                  "The old admission was interrupted and the original prompt was not re-executed.";
                const failure = makeProviderFailure({
                  cause: message,
                  class: "provider_error",
                  message,
                  retryable: false,
                });
                const failureItemOrdinal = input.providerTurnOrdinal * 100 + 2;
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: input.providerThread.id,
                    nodeId: input.rootNodeId,
                    runAttemptId: input.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: "native-turn-1",
                      strength: "strong",
                    },
                    ordinal: input.providerTurnOrdinal,
                    status: "failed",
                    startedAt: occurredAt,
                    completedAt: occurredAt,
                  },
                });
                yield* Queue.offer(events, {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...input.providerThread,
                    status: "idle",
                    updatedAt: occurredAt,
                  },
                });
                yield* Queue.offer(events, {
                  type: "turn_item.updated",
                  driver,
                  turnItem: makeProviderFailureTurnItem({
                    driver,
                    threadId: input.threadId,
                    runId: input.runId,
                    nodeId: input.rootNodeId,
                    providerThreadId: input.providerThread.id,
                    providerTurnId,
                    itemOrdinal: failureItemOrdinal,
                    failure,
                    occurredAt,
                  }),
                });
                yield* Queue.offer(events, {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: input.providerThread.id,
                  providerTurnId,
                  runOrdinal: input.runOrdinal,
                  failureItemOrdinal,
                  status: "failed",
                  failure,
                  threadDisposition: "reusable",
                });
                return;
              }
              yield* emitPending(input, ProviderTurnId.make(`provider-turn:${input.attemptId}`));
            }).pipe(Effect.asVoid),
          resumeTurn: (input: ProviderAdapter.ProviderAdapterV2ResumeTurnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(state, (current) => ({
                ...current,
                resumeAttempts: [...current.resumeAttempts, String(input.attemptId)],
              }));
              yield* Deferred.succeed(signals.resumeAttempted, undefined);
              if ((yield* Ref.get(state)).refuseResume) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver,
                  detail: "simulated resume refusal",
                });
              }
              const original = [...artifacts.values()].find(
                (artifact) => artifact.providerTurn.runAttemptId === input.attemptId,
              );
              if (original === undefined) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver,
                  detail: "original pending request is unavailable",
                });
              }
              yield* Ref.update(state, (current) => ({
                ...current,
                resumed: [
                  ...current.resumed,
                  {
                    runId: String(input.runId),
                    attemptId: String(input.attemptId),
                    providerTurnId: `provider-turn:${input.attemptId}`,
                    requestId: String(original.request.id),
                  },
                ],
              }));
              yield* Deferred.succeed(signals.resumed, undefined);
              yield* emitPending(
                input,
                ProviderTurnId.make(`provider-turn:${input.attemptId}`),
                original.request.id,
              );
            }).pipe(Effect.asVoid),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: ({
            requestId,
          }: {
            requestId: OrchestrationV2RuntimeRequest["id"];
          }) =>
            Effect.gen(function* () {
              yield* Ref.update(state, (current) => ({
                ...current,
                responses: [...current.responses, String(requestId)],
              }));
              const artifact = artifacts.get(String(requestId));
              if (artifact === undefined) return;
              const now = yield* DateTime.now;
              yield* Queue.offer(events, {
                type: "runtime_request.updated",
                driver,
                runtimeRequest: { ...artifact.request, status: "resolved", resolvedAt: now },
              });
              yield* Queue.offer(events, {
                type: "node.updated",
                driver,
                node: { ...artifact.node, status: "completed", completedAt: now },
              });
              yield* Queue.offer(events, {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  ...artifact.item,
                  status: "completed",
                  completedAt: now,
                  updatedAt: now,
                },
              });
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: { ...artifact.providerTurn, status: "completed", completedAt: now },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: artifact.providerTurn.providerThreadId,
                providerTurnId: artifact.providerTurn.id,
                runOrdinal: artifact.providerTurn.ordinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
        return runtime;
      }).pipe(Effect.provide(IdAllocator.layer), Effect.orDie),
  } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
}

it.live.each([
  {
    key: "enabled",
    name: "preserves and resumes the original Hermes approval through the actual restart lifecycle",
    continueThreads: true,
    refuseResume: false,
  },
  {
    key: "opt-out",
    name: "keeps generic shutdown cancellation when automatic Hermes recovery is disabled",
    continueThreads: false,
    refuseResume: false,
  },
  {
    key: "refusal",
    name: "fails closed without a live response route when Hermes refuses resume",
    continueThreads: true,
    refuseResume: true,
  },
  {
    key: "reopen-failure",
    name: "closes the stale Hermes answer route after a crash and failed session open",
    continueThreads: true,
    refuseResume: false,
    refuseReopen: true,
  },
  {
    key: "clarify",
    name: "resumes a Hermes clarification and delivers the answer to the original request",
    continueThreads: true,
    refuseResume: false,
    clarify: true,
  },
] as const)("$name", (scenario) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(`hermes-restart-recovery-${scenario.key}`);
    const threadId = ThreadId.make(`thread:hermes-restart-recovery-${scenario.key}`);
    const state = yield* Ref.make<RecoveryAdapterState>({
      started: [],
      resumeAttempts: [],
      resumed: [],
      responses: [],
      refuseResume: scenario.refuseResume,
      refuseReopen: "refuseReopen" in scenario,
      clarify: "clarify" in scenario,
      openAttempts: 0,
    });
    const resumeAttempted = yield* Deferred.make<void>();
    const resumedSignal = yield* Deferred.make<void>();
    const adapterLayer = ProviderAdapterRegistry.layerSingle(
      makeRecoveryAdapter(state, { resumeAttempted, resumed: resumedSignal }),
    );
    let originalRunId: string | undefined;
    let originalAttemptId: string | undefined;
    let originalRequestId: string | undefined;

    const databaseLayer = SqlitePersistence.layerFromPath(`${cwd}/hermes-recovery.sqlite`).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const firstScope = yield* Scope.make();
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const waitForProjection = (
        predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
      ) =>
        eventSink.stream({ threadId }).pipe(
          Stream.filterEffect(() =>
            orchestrator.getThreadProjection(threadId).pipe(Effect.map(predicate)),
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.timeout("5 seconds"),
          Effect.andThen(orchestrator.getThreadProjection(threadId)),
        );
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:hermes-recovery-create"),
        threadId,
        projectId: ProjectId.make("project:hermes-recovery"),
        title: "Hermes recovery",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "server",
        commandId: CommandId.make("command:hermes-recovery-start"),
        threadId,
        messageId: MessageId.make("message:hermes-recovery"),
        text: "wait for approval",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        modelSelection: selection,
      });
      const waiting = yield* waitForProjection(
        (projection) =>
          (projection.runs[0]?.status === "running" || projection.runs[0]?.status === "waiting") &&
          projection.providerTurns.some(
            (turn: OrchestrationV2ProviderTurn) =>
              turn.runAttemptId === projection.attempts[0]?.id && turn.status === "running",
          ) &&
          projection.runtimeRequests.some(
            (request: OrchestrationV2RuntimeRequest) => request.status === "pending",
          ),
      );
      originalRunId = waiting.runs[0]!.id;
      originalAttemptId = waiting.attempts.find((attempt) => attempt.runId === originalRunId)!.id;
      originalRequestId = requestFor(waiting).id;
      const candidate = hermesRestartRecoveryCandidate(waiting);
      assert.isDefined(candidate);
      assert.isUndefined(
        hermesRestartRecoveryCandidate({
          ...waiting,
          runtimeRequests: [...waiting.runtimeRequests, requestFor(waiting)],
        }),
        "ambiguous pending requests must not resume",
      );
      assert.isUndefined(
        hermesRestartRecoveryCandidate({ ...waiting, providerTurns: [] }),
        "missing accepted turn must not resume",
      );
      assert.isUndefined(
        hermesRestartRecoveryCandidate({ ...waiting, turnItems: [] }),
        "missing request item must not resume",
      );
      if ("refuseReopen" in scenario) return; // Simulate process loss without shutdown reconciliation.
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      yield* recovery.prepareForShutdown;
      const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      yield* providerSessions.shutdown;
      yield* recovery.reconcile("shutdown");
    }).pipe(
      Effect.provideService(Scope.Scope, firstScope),
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "hermes-restart-recovery:first" },
          adapterLayer,
          {
            databaseLayer,
            recoverOnStartup: true,
            continueThreadsAfterServerUpdate: scenario.continueThreads,
          },
        ),
      ),
      Effect.provideService(Scope.Scope, firstScope),
    );
    yield* Scope.close(firstScope, Exit.void);

    const secondScope = yield* Scope.make();
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const waitForProjection = (
        predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
      ) =>
        eventSink.stream({ threadId }).pipe(
          Stream.filterEffect(() =>
            orchestrator.getThreadProjection(threadId).pipe(Effect.map(predicate)),
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.timeout("5 seconds"),
          Effect.andThen(orchestrator.getThreadProjection(threadId)),
        );
      const sql = yield* SqlClient.SqlClient;
      if (!scenario.continueThreads) {
        const stopped = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(stopped.runs[0]?.id, originalRunId);
        assert.equal(stopped.runs[0]?.status, "cancelled");
        assert.equal(requestFor(stopped).status, "cancelled");
        assert.lengthOf((yield* Ref.get(state)).started, 1);
        assert.lengthOf((yield* Ref.get(state)).resumeAttempts, 0);
        assert.lengthOf((yield* Ref.get(state)).resumed, 0);
        assert.lengthOf((yield* Ref.get(state)).responses, 0);
        return;
      }
      if (scenario.refuseResume || "refuseReopen" in scenario) {
        if (scenario.refuseResume) yield* Deferred.await(resumeAttempted);
        const refused = yield* waitForProjection(
          (projection) => requestFor(projection).responseCapability.type === "not_resumable",
        );
        assert.equal(refused.runs[0]?.id, originalRunId);
        assert.include(["running", "waiting"], refused.runs[0]?.status);
        assert.lengthOf(refused.attempts, 1);
        assert.equal(requestFor(refused).id, originalRequestId);
        assert.equal(requestFor(refused).status, "pending");
        const responseExit = yield* Effect.exit(
          orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("command:hermes-recovery-refused-answer"),
            threadId,
            requestId: requestFor(refused).id,
            decision: "accept",
          }),
        );
        assert.isTrue(Exit.isFailure(responseExit));
        const afterRejectedAnswer = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(requestFor(afterRejectedAnswer).status, "pending");
        assert.isDefined(hermesRestartRecoveryCandidate(afterRejectedAnswer));
        assert.equal((yield* Ref.get(state)).openAttempts, 2);
        assert.lengthOf((yield* Ref.get(state)).started, 1);
        assert.lengthOf((yield* Ref.get(state)).resumed, 0);
        assert.lengthOf((yield* Ref.get(state)).responses, 0);
        return;
      }
      yield* Deferred.await(resumedSignal);
      const resumed = yield* waitForProjection((projection) => {
        const request = requestFor(projection);
        return (
          projection.runs[0]?.id === originalRunId &&
          (projection.runs[0]?.status === "running" || projection.runs[0]?.status === "waiting") &&
          request.id === originalRequestId &&
          request.status === "pending" &&
          request.responseCapability.type === "live"
        );
      });
      assert.lengthOf(resumed.runs, 1);
      assert.lengthOf(resumed.attempts, 1);
      assert.lengthOf((yield* Ref.get(state)).started, 1);
      const continuations = yield* sql<{ readonly effect_type: string }>`
          SELECT effect_type FROM orchestration_v2_effect_outbox
          WHERE thread_id = ${threadId}
            AND effect_type = 'provider-runtime.continue'
            AND status IN ('pending', 'running')`;
      assert.deepEqual(continuations, []);
      assert.deepEqual((yield* Ref.get(state)).resumed, [
        {
          runId: originalRunId!,
          attemptId: originalAttemptId!,
          providerTurnId: `provider-turn:${originalAttemptId}`,
          requestId: requestFor(resumed).id,
        },
      ]);
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("command:hermes-recovery-answer"),
        threadId,
        requestId: requestFor(resumed).id,
        ...("clarify" in scenario ? { answers: { q: "first" } } : { decision: "accept" as const }),
      });
      const answered = yield* waitForProjection(
        (projection) =>
          projection.runs[0]?.status === "completed" &&
          projection.runtimeRequests[0]?.status === "resolved",
      );
      assert.equal(answered.runs[0]?.id, originalRunId);
      assert.deepEqual((yield* Ref.get(state)).responses, [originalRequestId!]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ProviderReplayHarness.layerWithRegistry(
            { name: "hermes-restart-recovery:second" },
            adapterLayer,
            {
              databaseLayer,
              recoverOnStartup: true,
              continueThreadsAfterServerUpdate: scenario.continueThreads,
            },
          ),
          databaseLayer,
        ),
      ),
      Effect.provideService(Scope.Scope, secondScope),
      Effect.ensuring(Scope.close(secondScope, Exit.void)),
    );
  }),
);

it.live("releases a delegated parent after a Hermes lost-prompt terminal failure", () =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("hermes-restart-recovery-delegate");
    const parentThreadId = ThreadId.make("thread:hermes-restart-recovery-parent");
    const state = yield* Ref.make<RecoveryAdapterState>({
      started: [],
      resumeAttempts: [],
      resumed: [],
      responses: [],
      refuseResume: false,
      refuseReopen: false,
      clarify: false,
      openAttempts: 0,
    });
    const resumeAttempted = yield* Deferred.make<void>();
    const resumed = yield* Deferred.make<void>();
    const lostPromptReleased = yield* Deferred.make<void>();
    const adapterLayer = ProviderAdapterRegistry.layerSingle(
      makeRecoveryAdapter(
        state,
        { resumeAttempted, resumed },
        { parentThreadId, released: lostPromptReleased },
      ),
    );
    const databaseLayer = SqlitePersistence.layerFromPath(`${cwd}/hermes-recovery.sqlite`).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const scope = yield* Scope.make();

    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const waitForProjection = (
        threadId: ThreadId,
        predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
      ) =>
        eventSink.stream({ threadId }).pipe(
          Stream.filterEffect(() =>
            orchestrator.getThreadProjection(threadId).pipe(Effect.map(predicate)),
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.timeout("5 seconds"),
          Effect.andThen(orchestrator.getThreadProjection(threadId)),
        );

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:hermes-delegate-create-parent"),
        threadId: parentThreadId,
        projectId: ProjectId.make("project:hermes-delegate-recovery"),
        title: "Hermes delegate recovery",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "server",
        commandId: CommandId.make("command:hermes-delegate-start-parent"),
        threadId: parentThreadId,
        messageId: MessageId.make("message:hermes-delegate-parent"),
        text: "delegate and wait",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        modelSelection: selection,
      });
      const waiting = yield* waitForProjection(
        parentThreadId,
        (projection) =>
          projection.runs[0]?.status === "running" &&
          projection.runtimeRequests.some((request) => request.status === "pending"),
      );
      const originalRun = waiting.runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("command:hermes-delegate-child"),
        parentThreadId,
        parentRunId: originalRun.id,
        parentNodeId: originalRun.rootNodeId!,
        task: "Lose this prompt during a Gateway restart",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
      });
      const delegated = yield* waitForProjection(
        parentThreadId,
        (projection) => projection.subagents.length === 1,
      );
      const task = delegated.subagents[0]!;
      const childThreadId = task.childThreadId!;
      yield* waitForProjection(childThreadId, (projection) =>
        projection.runs.some((run) => run.status === "running" || run.status === "waiting"),
      );

      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("command:hermes-delegate-finish-original"),
        threadId: parentThreadId,
        requestId: requestFor(waiting).id,
        decision: "accept",
      });
      const originalCompleted = yield* waitForProjection(
        parentThreadId,
        (projection) =>
          projection.runs.find((run) => run.id === originalRun.id)?.status === "completed",
      );
      assert.equal(originalCompleted.subagents[0]?.status, "running");
      assert.isUndefined(
        originalCompleted.runs.find((run) => run.delegatedCompletion !== undefined),
      );

      yield* Deferred.succeed(lostPromptReleased, undefined);
      const failedChild = yield* waitForProjection(
        childThreadId,
        (projection) => projection.runs[0]?.status === "failed",
      );
      const failureItem = failedChild.turnItems.find((item) => item.type === "error");
      assert.include(failureItem?.failure?.message, "gateway_restart_lost_prompt");

      const releasedParent = yield* waitForProjection(parentThreadId, (projection) => {
        const currentTask = projection.subagents.find((candidate) => candidate.id === task.id);
        return currentTask?.status === "failed";
      });
      assert.equal(
        releasedParent.runs.find((run) => run.id === originalRun.id)?.status,
        "completed",
      );
      assert.equal(
        releasedParent.subagents.find((candidate) => candidate.id === task.id)?.status,
        "failed",
      );
      const completionWake = releasedParent.runs.find(
        (run) => run.delegatedCompletion !== undefined,
      )!;
      assert.deepEqual(completionWake.delegatedCompletion?.delivery?.taskIds, [task.id]);
      assert.notEqual(completionWake.status, "queued");
      assert.isTrue(completionWake.queueHeld !== true);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "hermes-restart-recovery:delegate" },
          adapterLayer,
          {
            databaseLayer,
            recoverOnStartup: true,
            continueThreadsAfterServerUpdate: true,
          },
        ),
      ),
      Effect.provideService(Scope.Scope, scope),
      Effect.ensuring(Scope.close(scope, Exit.void)),
    );
  }),
);
