import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  orchestrationV2RunWorkStartedAt,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as T3Host from "./T3Host.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const projectId = ProjectId.make("voice-project");
const threadId = ThreadId.make("voice-thread");
const text = "Change the greeting.\nKeep the punctuation: yes, exactly!";
const resultText = "Verified the requested change.";
const input = (id: string) => ({
  text,
  commandId: CommandId.make(id),
  messageId: MessageId.make(id),
});

const makeFixture = (
  options: {
    runEffectWorker?: boolean;
    driver?: ProviderDriverKind;
    instanceId?: ProviderInstanceId;
    extraInstances?: ReadonlyArray<ProviderInstance>;
  } = {},
) =>
  Effect.gen(function* () {
    const fixtureDriver = options.driver ?? driver;
    const fixtureInstanceId = options.instanceId ?? instanceId;
    const cwd = yield* checkpointWorkspace("orbit-voice-host");
    const started = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2TurnInput>();
    const release = yield* Deferred.make<void>();
    const interrupted = yield* Ref.make(0);
    const steered = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2SteerInput>();
    const eventsReady = yield* Deferred.make<Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>>();
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId: fixtureInstanceId,
      driver: fixtureDriver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (session) =>
        Effect.gen(function* () {
          const runtimeScope = yield* Scope.Scope;
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          yield* Deferred.succeed(eventsReady, events);
          const now = yield* DateTime.now;
          return {
            instanceId: fixtureInstanceId,
            driver: fixtureDriver,
            providerSessionId: session.providerSessionId,
            providerSession: {
              id: session.providerSessionId,
              driver: fixtureDriver,
              providerInstanceId: fixtureInstanceId,
              status: "ready",
              cwd,
              model: session.modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: (request) =>
              Effect.succeed({
                id: ProviderThreadId.make("native-thread"),
                driver: fixtureDriver,
                providerInstanceId: fixtureInstanceId,
                providerSessionId: session.providerSessionId,
                appThreadId: request.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver: fixtureDriver, nativeId: "native", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: (turn) =>
              Effect.gen(function* () {
                const providerTurnId = ProviderTurnId.make(`native-turn-${turn.runOrdinal}`);
                const providerTurn = {
                  id: providerTurnId,
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver: fixtureDriver,
                    nativeId: String(providerTurnId),
                    strength: "strong" as const,
                  },
                  ordinal: turn.providerTurnOrdinal,
                  startedAt: now,
                };
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver: fixtureDriver,
                  providerTurn: { ...providerTurn, status: "running", completedAt: null },
                });
                yield* Deferred.succeed(started, turn);
                yield* Deferred.await(release);
                yield* Queue.offer(events, {
                  type: "message.updated",
                  driver: fixtureDriver,
                  message: {
                    id: MessageId.make(`reply-${turn.runOrdinal}`),
                    threadId: turn.threadId,
                    runId: turn.runId,
                    nodeId: turn.rootNodeId,
                    role: "assistant",
                    text: turn.runOrdinal === 1 ? resultText : "Second task completed.",
                    attachments: [],
                    streaming: false,
                    createdBy: "agent",
                    creationSource: "provider",
                    createdAt: now,
                    updatedAt: now,
                  },
                });
                yield* Queue.offer(events, {
                  type: "turn_item.updated",
                  driver: fixtureDriver,
                  turnItem: {
                    id: TurnItemId.make(`reply-${turn.runOrdinal}`),
                    threadId: turn.threadId,
                    runId: turn.runId,
                    nodeId: turn.rootNodeId,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turn.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                    type: "assistant_message",
                    messageId: MessageId.make(`reply-${turn.runOrdinal}`),
                    text: resultText,
                    streaming: false,
                  },
                });
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver: fixtureDriver,
                  providerTurn: { ...providerTurn, status: "completed", completedAt: now },
                });
                yield* Queue.offer(events, {
                  type: "turn.terminal",
                  driver: fixtureDriver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  runOrdinal: turn.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                });
              }).pipe(Effect.forkIn(runtimeScope), Effect.asVoid),
            steerTurn: (request) => Deferred.succeed(steered, request).pipe(Effect.asVoid),
            interruptTurn: () => Ref.update(interrupted, (count) => count + 1),
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    const instance: ProviderInstance = {
      instanceId: fixtureInstanceId,
      driverKind: fixtureDriver,
      enabled: true,
      displayName: "Fixture Codex",
      continuationIdentity: { driverKind: fixtureDriver, continuationKey: "voice-test" },
      snapshot: {} as ProviderInstance["snapshot"],
      orchestrationAdapter: adapter,
      textGeneration: {} as ProviderInstance["textGeneration"],
    };
    const currentInstance = yield* Ref.make(instance);
    const database = SqlitePersistence.layerMemory;
    const serverConfig = ServerConfig.layerTest(cwd, { prefix: "t3-voice-host-" });
    const orchestration = ProviderReplayHarness.layerWithRegistry(
      { name: "orbit-voice-host", runtimePolicyOverride: { cwd } },
      ProviderAdapterRegistry.layerSingle(adapter),
      { databaseLayer: database, ...options },
    );
    const settings = ServerSettings.layerTest(
      options.instanceId === undefined
        ? {}
        : {
            providerInstances: {
              [options.instanceId]: { driver: fixtureDriver, enabled: true },
            },
          },
    );
    const management = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          orchestration,
          settings,
          CommandReceiptStore.layer.pipe(Layer.provide(database)),
        ),
      ),
    );
    const projects = ProjectStore.layer.pipe(Layer.provide(database));
    const sessions = SessionStore.layer.pipe(
      Layer.provide(database),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(serverConfig),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("voice-fixture")),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );
    const registry = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: () => Ref.get(currentInstance),
      listInstances: Ref.get(currentInstance).pipe(
        Effect.map((value) => [value, ...(options.extraInstances ?? [])]),
      ),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.never,
      subscribeChanges: Effect.never,
    });
    const outbox = EffectOutbox.layer.pipe(Layer.provide(database));
    const dependencies = Layer.mergeAll(
      orchestration,
      management,
      projects,
      sessions,
      registry,
      outbox,
    );
    const context = yield* Layer.build(T3Host.layer.pipe(Layer.provideMerge(dependencies)));
    const seed = Effect.gen(function* () {
      const projectStore = yield* ProjectStore.ProjectStoreV2;
      yield* projectStore.apply({
        sequence: 1,
        eventId: EventId.make("voice-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: "2026-10-11T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Voice fixture",
          workspaceRoot: cwd,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-11T00:00:00.000Z",
          updatedAt: "2026-10-11T00:00:00.000Z",
        },
      });
      yield* (yield* ThreadManagementService.ThreadManagementService).dispatch({
        type: "thread.create",
        commandId: CommandId.make("voice-thread-created"),
        threadId,
        projectId,
        title: "Bound coding task",
        modelSelection: { instanceId: fixtureInstanceId, model: "test-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    });
    yield* seed.pipe(Effect.provide(context));
    return { context, currentInstance, started, release, interrupted, steered, eventsReady, cwd };
  });
const fixture = makeFixture();

it.live("keeps checkpoint finalization working without requesting user attention", () =>
  Effect.gen(function* () {
    const setup = yield* makeFixture({ runEffectWorker: false });
    yield* Effect.gen(function* () {
      const host = yield* T3Host.VoiceHost;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const target = yield* host.bind(threadId);
      const task = yield* host.send(target, input("checkpoint-drain"));
      yield* worker.drain();
      yield* Deferred.await(setup.started);
      yield* Deferred.succeed(setup.release, undefined);
      yield* threads
        .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === task.runId &&
              stored.event.payload.status === "waiting",
          ),
          Stream.runHead,
        );
      const draining = Option.getOrThrow(yield* host.watchTask(target, task).pipe(Stream.runHead));
      assert.strictEqual(draining.state, "working");
      assert.strictEqual(draining.result, null);
      yield* worker.drain();
      const completed = Option.getOrThrow(yield* host.watchTask(target, task).pipe(Stream.runLast));
      assert.strictEqual(completed.state, "completed");
      assert.strictEqual(completed.result, resultText);
    }).pipe(Effect.provide(setup.context));
  }),
);

it.live.each(["approval_request", "user_input_request", "secret_request"] as const)(
  "reports an actual pending %s for the coding run",
  (kind) =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* Effect.gen(function* () {
        const host = yield* T3Host.VoiceHost;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const target = yield* host.bind(threadId);
        const task = yield* host.send(target, input(`pending-${kind}`));
        const turn = yield* Deferred.await(setup.started);
        const events = yield* Deferred.await(setup.eventsReady);
        const now = yield* DateTime.now;
        const requestId = RuntimeRequestId.make(`request-${kind}`);
        const item = {
          id: TurnItemId.make(`item-${kind}`),
          threadId,
          runId: task.runId,
          nodeId: turn.rootNodeId,
          providerThreadId: turn.providerThread.id,
          providerTurnId: ProviderTurnId.make(`native-turn-${turn.runOrdinal}`),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 50,
          status: "waiting" as const,
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          ...(kind === "approval_request"
            ? { type: kind, requestId, requestKind: "command" as const }
            : kind === "user_input_request"
              ? { type: kind, requestId, questions: [] }
              : {
                  type: kind,
                  label: "Test secret",
                  reason: "Fixture request",
                  secretStatus: "pending" as const,
                }),
        };
        const emitItem = (turnItem: OrchestrationV2TurnItem) =>
          Effect.gen(function* () {
            const afterSequence = yield* threads.getThreadEventSequence(threadId);
            yield* Queue.offer(events, { type: "turn_item.updated", driver, turnItem });
            yield* threads
              .streamStoredEventsFrom({ threadId, afterSequence, eventType: "turn-item.updated" })
              .pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "turn-item.updated" &&
                    stored.event.payload.id === turnItem.id,
                ),
                Stream.runHead,
              );
          });
        const other = yield* host.send(target, input(`other-${kind}`));
        const otherRun = (yield* threads.getThreadProjection(threadId)).runs.find(
          (run) => run.id === other.runId,
        )!;
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make(`other-request-${kind}`),
              threadId,
              occurredAt: now,
              type: "turn-item.updated",
              payload: {
                ...item,
                id: TurnItemId.make(`other-item-${kind}`),
                runId: other.runId,
                nodeId: otherRun.rootNodeId,
                providerTurnId: null,
                ordinal: 51,
              },
            },
          ],
        });
        assert.strictEqual(
          Option.getOrThrow(yield* host.watchTask(target, task).pipe(Stream.runHead)).state,
          "working",
        );
        assert.strictEqual(
          Option.getOrThrow(yield* host.watchTask(target, other).pipe(Stream.runHead)).state,
          "queued",
        );
        yield* emitItem(item);
        const waiting = Option.getOrThrow(yield* host.watchTask(target, task).pipe(Stream.runHead));
        assert.strictEqual(waiting.state, "waiting");
        assert.strictEqual(waiting.result, null);
        const run = (yield* threads.getThreadProjection(threadId)).runs.find(
          (entry) => entry.id === task.runId,
        )!;
        assert.strictEqual(
          DateTime.toEpochMillis(waiting.startedAt),
          DateTime.toEpochMillis(orchestrationV2RunWorkStartedAt(run)),
        );
        yield* emitItem({
          ...item,
          status: "completed",
          completedAt: now,
          ...(item.type === "secret_request" ? { secretStatus: "saved" as const } : {}),
        });
        assert.strictEqual(
          Option.getOrThrow(yield* host.watchTask(target, task).pipe(Stream.runHead)).state,
          "working",
        );
      }).pipe(Effect.provide(setup.context));
    }),
);

const attentionFixture = Effect.gen(function* () {
  const setup = yield* makeFixture({ runEffectWorker: false });
  const threads = Context.get(setup.context, ThreadManagementService.ThreadManagementService);
  const sink = Context.get(setup.context, EventSink.EventSinkV2);
  const originalHost = Context.get(setup.context, T3Host.VoiceHost);
  const originalTarget = yield* originalHost.bind(threadId);
  const task = yield* originalHost.send(originalTarget, input("attention-task"));
  yield* Context.get(setup.context, EffectWorker.OrchestrationEffectWorkerV2).drain();
  const turn = yield* Deferred.await(setup.started);
  yield* threads
    .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType: "provider-turn.updated" })
    .pipe(
      Stream.filter((stored) => stored.event.type === "provider-turn.updated"),
      Stream.runHead,
    );
  const now = yield* DateTime.now;
  const projection = yield* threads.getThreadProjection(threadId);
  const providerTurn = projection.providerTurns.find(
    (value) => value.runAttemptId === turn.attemptId,
  )!;
  const pending = (
    kind: "approval_request" | "user_input_request" | "secret_request",
    nodeId: NodeId | null,
    providerTurnId: ProviderTurnId | null,
  ): OrchestrationV2TurnItem => ({
    id: TurnItemId.make(`attention-${kind}`),
    threadId,
    runId: task.runId,
    nodeId,
    providerThreadId: turn.providerThread.id,
    providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 50,
    status: "waiting",
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    ...(kind === "approval_request"
      ? {
          type: kind,
          requestId: RuntimeRequestId.make("approval"),
          requestKind: "command" as const,
        }
      : kind === "user_input_request"
        ? { type: kind, requestId: RuntimeRequestId.make("question"), questions: [] }
        : { type: kind, label: "Secret", reason: "Fixture", secretStatus: "pending" as const }),
  });
  let eventOrdinal = 0;
  const writeItem = (item: OrchestrationV2TurnItem) =>
    sink.write({
      events: [
        {
          id: EventId.make(`attention-item-${eventOrdinal++}`),
          threadId,
          occurredAt: now,
          type: "turn-item.updated",
          payload: item,
        },
      ],
    });
  const restart = threads.dispatch({
    type: "message.dispatch",
    threadId,
    commandId: CommandId.make("restart-attention-task"),
    messageId: MessageId.make("restart-attention-message"),
    text: "Restart the current task.",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "restart_active", targetRunId: task.runId },
  });
  const observe = (
    beforeRead: (fields: ReadonlyArray<string>) => Effect.Effect<void> = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      const reads: Array<ReadonlyArray<string>> = [];
      const boundary = ThreadManagementService.ThreadManagementService.of({
        ...threads,
        getProjectThreadRecords: (request, fields, filter) =>
          Effect.gen(function* () {
            reads.push(fields);
            yield* beforeRead(fields);
            return yield* threads.getProjectThreadRecords(request, fields, filter);
          }),
      });
      const context = yield* Layer.build(
        T3Host.layer.pipe(
          Layer.provide(
            Layer.succeedContext(
              Context.add(setup.context, ThreadManagementService.ThreadManagementService, boundary),
            ),
          ),
        ),
      );
      const host = Context.get(context, T3Host.VoiceHost);
      const target = yield* host.bind(threadId);
      const read = host.watchTask(target, task).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      return { read, reads };
    });
  return {
    ...setup,
    threads,
    sink,
    task,
    turn,
    providerTurn,
    now,
    pending,
    writeItem,
    restart,
    observe,
  };
});

it.live.each(["approval_request", "user_input_request", "secret_request"] as const)(
  "ignores a pending %s from a superseded attempt of the same run",
  (kind) =>
    Effect.gen(function* () {
      const setup = yield* attentionFixture;
      const card = setup.pending(kind, setup.turn.rootNodeId, setup.providerTurn.id);
      yield* setup.writeItem(card);
      yield* setup.restart;
      const current = yield* setup.threads.getThreadProjection(threadId);
      assert.strictEqual(current.runs.length, 1);
      assert.notStrictEqual(current.runs[0]!.activeAttemptId, setup.turn.attemptId);
      assert.strictEqual(current.turnItems.find((item) => item.id === card.id)?.status, "waiting");
      const observed = yield* setup.observe();
      assert.strictEqual((yield* observed.read).state, "working");
      assert.strictEqual(observed.reads.length, 2);
      assert.isFalse(observed.reads[0]!.includes("providerTurns"));
      assert.isTrue(observed.reads[1]!.includes("providerTurns"));
      const root = current.runs[0]!.rootNodeId;
      yield* setup.writeItem({ ...card, nodeId: root, providerTurnId: null });
      const currentCard = yield* setup.observe();
      assert.strictEqual((yield* currentCard.read).state, "waiting");
      assert.strictEqual(currentCard.reads.length, 1);
    }),
);

it.live("resolves child approval across earlier provider turns in the same current attempt", () =>
  Effect.gen(function* () {
    const setup = yield* attentionFixture;
    yield* setup.sink.write({
      events: [
        {
          id: EventId.make("later-provider-turn"),
          threadId,
          occurredAt: setup.now,
          type: "provider-turn.updated",
          payload: {
            ...setup.providerTurn,
            id: ProviderTurnId.make("later-turn"),
            ordinal: setup.providerTurn.ordinal + 1,
          },
        },
      ],
    });
    yield* setup.writeItem(
      setup.pending("approval_request", NodeId.make("child-approval"), setup.providerTurn.id),
    );
    const observed = yield* setup.observe();
    assert.strictEqual((yield* observed.read).state, "waiting");
    assert.strictEqual(observed.reads.length, 2);
  }),
);

it.live("does not infer attention from a card with missing association", () =>
  Effect.gen(function* () {
    const setup = yield* attentionFixture;
    yield* setup.writeItem(setup.pending("secret_request", null, null));
    const observed = yield* setup.observe();
    assert.strictEqual((yield* observed.read).state, "working");
    assert.strictEqual(observed.reads.length, 1);
  }),
);

it.live("reads no provider history without cards and ignores an unknown provider turn", () =>
  Effect.gen(function* () {
    const setup = yield* attentionFixture;
    const withoutCard = yield* setup.observe();
    assert.strictEqual((yield* withoutCard.read).state, "working");
    assert.strictEqual(withoutCard.reads.length, 1);
    assert.isFalse(withoutCard.reads[0]!.includes("providerTurns"));
    yield* setup.writeItem(
      setup.pending(
        "approval_request",
        NodeId.make("unknown-node"),
        ProviderTurnId.make("unknown-turn"),
      ),
    );
    const unknown = yield* setup.observe();
    assert.strictEqual((yield* unknown.read).state, "working");
    assert.strictEqual(unknown.reads.length, 2);
  }),
);

it.live.each(["restart", "failed", "completed"] as const)(
  "uses the whole second snapshot when %s happens between attention reads",
  (change) =>
    Effect.gen(function* () {
      const setup = yield* attentionFixture;
      yield* setup.writeItem(
        setup.pending("approval_request", NodeId.make("child-approval"), setup.providerTurn.id),
      );
      const observed = yield* setup.observe((fields) =>
        Effect.gen(function* () {
          if (!fields.includes("providerTurns")) return;
          if (change === "completed") {
            yield* Deferred.succeed(setup.release, undefined);
            yield* setup.threads
              .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType: "run.updated" })
              .pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "run.updated" &&
                    stored.event.payload.id === setup.task.runId &&
                    stored.event.payload.status === "waiting",
                ),
                Stream.runHead,
                Effect.orDie,
              );
            yield* Context.get(setup.context, EffectWorker.OrchestrationEffectWorkerV2)
              .drain()
              .pipe(Effect.orDie);
            return;
          }
          yield* setup.restart.pipe(Effect.orDie);
          if (change === "failed") {
            const projection = yield* setup.threads
              .getThreadProjection(threadId)
              .pipe(Effect.orDie);
            yield* setup.sink
              .write({
                events: [
                  {
                    id: EventId.make("failed-between-reads"),
                    threadId,
                    occurredAt: setup.now,
                    type: "run.updated",
                    payload: { ...projection.runs[0]!, status: "failed" },
                  },
                ],
              })
              .pipe(Effect.orDie);
          }
        }),
      );
      const result = yield* observed.read;
      assert.strictEqual(result.state, change === "restart" ? "working" : change);
      assert.strictEqual(result.result, change === "completed" ? resultText : null);
      assert.strictEqual(observed.reads.length, 2);
    }),
);

it.live.each(["queued", "waiting", "failed", "cancelled", "completed"] as const)(
  "does not scan provider turn history for a %s run with an unresolved card",
  (status) =>
    Effect.gen(function* () {
      const setup = yield* attentionFixture;
      yield* setup.writeItem(
        setup.pending("approval_request", NodeId.make("child-approval"), setup.providerTurn.id),
      );
      const projection = yield* setup.threads.getThreadProjection(threadId);
      yield* setup.sink.write({
        events: [
          {
            id: EventId.make("attention-run-state"),
            threadId,
            occurredAt: setup.now,
            type: "run.updated",
            payload: { ...projection.runs[0]!, status },
          },
        ],
      });
      const observed = yield* setup.observe();
      const result = yield* observed.read;
      assert.strictEqual(
        result.state,
        status === "queued" || status === "failed" || status === "cancelled" ? status : "working",
      );
      assert.strictEqual(observed.reads.length, 1);
      assert.isFalse(observed.reads[0]!.includes("providerTurns"));
    }),
);

it.live("sends exact text through T3 and watching does not own the accepted coding job", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    yield* Effect.gen(function* () {
      const host = yield* T3Host.VoiceHost;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const target = yield* host.bind(threadId);
      assert.strictEqual(target.cwd, setup.cwd);
      const task = yield* host.send(target, input("spoken-message"));
      const nativeInput = yield* Deferred.await(setup.started);
      assert.strictEqual(nativeInput.message.text, text);
      assert.strictEqual(nativeInput.runId, task.runId);
      const observed = yield* Deferred.make<void>();
      const watcher = yield* host.watchTask(target, task).pipe(
        Stream.tap(() => Deferred.succeed(observed, undefined)),
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.await(observed);
      yield* Fiber.interrupt(watcher);
      assert.strictEqual(yield* Ref.get(setup.interrupted), 0);
      const terminal = yield* host.watchTask(target, task).pipe(
        Stream.filter((value) => value.state === "completed"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.succeed(setup.release, undefined);
      yield* worker.drain();
      const completed = Option.getOrThrow(yield* Fiber.join(terminal));
      const projection = yield* threads.getThreadProjection(threadId);
      const run = projection.runs.find((value) => value.id === task.runId);
      assert.strictEqual(run?.status, "completed");
      assert.strictEqual(completed.result, resultText);
      assert.strictEqual(
        projection.messages.find((value) => value.id === task.messageId)?.text,
        text,
      );
      assert.strictEqual(
        projection.checkpoints.find((value) => value.id === run?.checkpointId)?.status,
        "ready",
      );
      assert.strictEqual(yield* Ref.get(setup.interrupted), 0);
    }).pipe(Effect.provide(setup.context));
  }),
);

it.live("rejects a replaced instance and an archived bound thread before dispatch", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    yield* Effect.gen(function* () {
      const host = yield* T3Host.VoiceHost;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const target = yield* host.bind(threadId);
      const original = yield* Ref.get(setup.currentInstance);
      yield* Ref.set(setup.currentInstance, { ...original });
      assert.strictEqual(
        (yield* Effect.flip(host.send(target, input("replaced")))).code,
        "target-changed",
      );
      yield* Ref.set(setup.currentInstance, original);
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive"),
        threadId,
      });
      yield* Effect.flip(host.send(target, input("archived")));
      assert.deepEqual((yield* threads.getThreadProjection(threadId)).messages, []);
    }).pipe(Effect.provide(setup.context));
  }),
);

it.live("keeps the captured selection when the thread changes after validation", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    const threads = Context.get(setup.context, ThreadManagementService.ThreadManagementService);
    const options = [{ id: "reasoningEffort", value: "medium" }];
    yield* threads.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("initial-options"),
      threadId,
      modelSelection: { instanceId, model: "test-model", options },
    });
    const paused = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const boundary = ThreadManagementService.ThreadManagementService.of({
      ...threads,
      sendToThread: (request) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(paused, undefined);
          yield* Deferred.await(resume);
          return yield* threads.sendToThread(request);
        }),
    });
    const context = yield* Layer.build(
      T3Host.layer.pipe(
        Layer.provide(
          Layer.succeedContext(
            Context.add(setup.context, ThreadManagementService.ThreadManagementService, boundary),
          ),
        ),
      ),
    );
    const host = Context.get(context, T3Host.VoiceHost);
    const target = yield* host.bind(threadId);
    const sending = yield* host.send(target, input("selection-race")).pipe(Effect.forkScoped);
    yield* Deferred.await(paused);
    yield* threads.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("change-selection"),
      threadId,
      modelSelection: { instanceId, model: "another-model" },
    });
    yield* Deferred.succeed(resume, undefined);
    const task = yield* Fiber.join(sending);
    const received = yield* Deferred.await(setup.started);
    assert.deepEqual(received.modelSelection, {
      instanceId: target.instanceId,
      model: target.model,
      options,
    });
    yield* Deferred.succeed(setup.release, undefined);
    const completed = yield* host.watchTask(target, task).pipe(Stream.runLast);
    assert.strictEqual(Option.getOrThrow(completed).state, "completed");
  }),
);

it.live("queues a second task and directs a correction to the captured running task", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    yield* Effect.gen(function* () {
      const host = yield* T3Host.VoiceHost;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const options = [{ id: "reasoningEffort", value: "medium" }];
      yield* threads.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("correction-options"),
        threadId,
        modelSelection: { instanceId, model: "test-model", options },
      });
      const target = yield* host.bind(threadId);
      const first = yield* host.send(target, input("first-queued"));
      assert.deepEqual((yield* Deferred.await(setup.started)).modelSelection.options, options);
      yield* threads
        .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType: "provider-turn.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
        );
      const second = yield* host.send(target, { ...input("second-queued"), text: "Second task." });
      assert.notStrictEqual(second.runId, first.runId);
      assert.strictEqual(second.state, "queued");
      assert.strictEqual(yield* host.readActiveRun(target), first.runId);
      const correctionText = "Correction: keep the first line.";
      const correction = yield* host.send(target, {
        ...input("correction"),
        text: correctionText,
        steerRunId: first.runId,
      });
      const delivered = yield* Deferred.await(setup.steered);
      assert.strictEqual(delivered.runId, first.runId);
      assert.strictEqual(delivered.message.text, correctionText);
      assert.strictEqual(correction.runId, first.runId);
      const replay = yield* host.send(target, input("first-queued"));
      assert.strictEqual(replay.runId, first.runId);
      assert.strictEqual(
        (yield* Effect.flip(
          host.send(target, { ...input("first-queued"), text: "Changed replay" }),
        )).code,
        "dispatch-failed",
      );
      const projection = yield* threads.getThreadProjection(threadId);
      assert.deepEqual(projection.thread.modelSelection.options, options);
      assert.strictEqual(projection.runs.length, 2);
      assert.strictEqual(
        projection.messages.filter((message) => message.role === "user").length,
        3,
      );
      yield* Deferred.succeed(setup.release, undefined);
      const completed = yield* host.watchTask(target, second).pipe(Stream.runLast);
      assert.strictEqual(Option.getOrThrow(completed).state, "completed");
      assert.strictEqual(Option.getOrThrow(completed).result, "Second task completed.");
    }).pipe(Effect.provide(setup.context));
  }),
);

it.live("rejects a correction for another run instead of steering the current run", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    yield* Effect.gen(function* () {
      const host = yield* T3Host.VoiceHost;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const target = yield* host.bind(threadId);
      const task = yield* host.send(target, input("first"));
      yield* Deferred.await(setup.started);
      assert.strictEqual(
        (yield* Effect.flip(
          host.send(target, {
            ...input("stale-correction"),
            steerRunId: RunId.make("a-different-run"),
          }),
        )).code,
        "stale-run",
      );
      const messages = (yield* threads.getThreadProjection(threadId)).messages;
      assert.deepEqual(
        messages.filter((value) => value.role === "user").map((value) => value.id),
        [task.messageId],
      );
      yield* Deferred.succeed(setup.release, undefined);
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    }).pipe(Effect.provide(setup.context));
  }),
);

it.live("checks live scopes and observes revocation through the real session store", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    yield* Effect.gen(function* () {
      const host = yield* T3Host.VoiceHost;
      const sessions = yield* SessionStore.SessionStore;
      const reader = yield* sessions.issue({ scopes: [AuthOrchestrationReadScope] });
      yield* host.authorize(reader.sessionId, AuthOrchestrationReadScope);
      assert.strictEqual(
        (yield* Effect.flip(host.authorize(reader.sessionId, AuthOrchestrationOperateScope))).code,
        "forbidden",
      );
      const revoked = yield* host
        .awaitRevocation(reader.sessionId)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* sessions.revoke(reader.sessionId);
      yield* Fiber.join(revoked);
      assert.strictEqual(
        (yield* Effect.flip(host.authorize(reader.sessionId, AuthOrchestrationReadScope))).code,
        "forbidden",
      );
    }).pipe(Effect.provide(setup.context));
  }),
);

const correctionReceiptFixture = Effect.gen(function* () {
  const setup = yield* fixture;
  const threads = Context.get(setup.context, ThreadManagementService.ThreadManagementService);
  const host = Context.get(setup.context, T3Host.VoiceHost);
  const target = yield* host.bind(threadId);
  const task = yield* host.send(target, input("receipt-task"));
  yield* Deferred.await(setup.started);
  yield* threads
    .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType: "provider-turn.updated" })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "provider-turn.updated" &&
          stored.event.payload.status === "running",
      ),
      Stream.runHead,
    );
  const correction = { ...input("receipt-correction"), steerRunId: task.runId };
  yield* threads.dispatch({
    type: "message.dispatch",
    threadId,
    commandId: correction.commandId,
    messageId: correction.messageId,
    text: correction.text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "steer_active", targetRunId: task.runId },
  });
  yield* Context.get(setup.context, EffectWorker.OrchestrationEffectWorkerV2).drain();
  yield* Deferred.await(setup.steered);
  const outbox = Context.get(setup.context, EffectOutbox.EffectOutboxV2);
  const rows = yield* outbox.listByCommandId(correction.commandId);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0]!.status, "succeeded");
  const withReceipt = (
    replacement: Pick<EffectOutbox.EffectOutboxV2["Service"], "listByCommandId" | "get">,
  ) =>
    Layer.build(
      T3Host.layer.pipe(
        Layer.provide(
          Layer.succeedContext(
            Context.add(setup.context, EffectOutbox.EffectOutboxV2, { ...outbox, ...replacement }),
          ),
        ),
      ),
    ).pipe(
      Effect.flatMap((context) =>
        Effect.gen(function* () {
          const replacementHost = Context.get(context, T3Host.VoiceHost);
          return { host: replacementHost, target: yield* replacementHost.bind(threadId) };
        }),
      ),
    );
  return { ...setup, correction, task, rows, outbox, withReceipt };
});

it.live.each(["failed", "cancelled"] as const)(
  "does not treat a %s correction receipt as delivery",
  (status) =>
    Effect.gen(function* () {
      const setup = yield* correctionReceiptFixture;
      const rows = setup.rows.map((row) => ({ ...row, status }));
      const { host, target } = yield* setup.withReceipt({
        listByCommandId: () => Effect.succeed(rows),
        get: () => Effect.succeed(Option.some(rows[0]!)),
      });
      const failure = yield* Effect.flip(host.send(target, setup.correction));
      assert.strictEqual(failure.code, "dispatch-failed");
      yield* Deferred.succeed(setup.release, undefined);
    }),
);

it.live.each(["missing", "multiple", "command", "thread", "message"] as const)(
  "rejects a %s correction delivery receipt",
  (variant) =>
    Effect.gen(function* () {
      const setup = yield* correctionReceiptFixture;
      const original = setup.rows[0]!;
      const rows =
        variant === "missing"
          ? []
          : variant === "multiple"
            ? [original, original]
            : [
                {
                  ...original,
                  commandId:
                    variant === "command" ? CommandId.make("wrong-command") : original.commandId,
                  threadId:
                    variant === "thread" ? ThreadId.make("wrong-thread") : original.threadId,
                  request:
                    original.request.type === "provider-turn.steer"
                      ? {
                          ...original.request,
                          messageId:
                            variant === "message"
                              ? MessageId.make("wrong-message")
                              : original.request.messageId,
                        }
                      : original.request,
                },
              ];
      const { host, target } = yield* setup.withReceipt({
        listByCommandId: () => Effect.succeed(rows),
        get: () => Effect.succeed(rows[0] ? Option.some(rows[0]) : Option.none()),
      });
      assert.strictEqual(
        (yield* Effect.flip(host.send(target, setup.correction))).code,
        "dispatch-failed",
      );
      yield* Deferred.succeed(setup.release, undefined);
    }),
);

it.effect("waits for exact delivery and rechecks the same receipt on duplicate requests", () =>
  Effect.gen(function* () {
    const setup = yield* correctionReceiptFixture.pipe(TestClock.withLive);
    const observed = yield* Deferred.make<void>();
    let delivered = false;
    let reads = 0;
    const row = setup.rows[0]!;
    const current = () => ({
      ...row,
      status: delivered ? ("succeeded" as const) : ("running" as const),
    });
    const { host, target } = yield* setup.withReceipt({
      listByCommandId: (commandId) =>
        Effect.gen(function* () {
          assert.strictEqual(commandId, setup.correction.commandId);
          reads++;
          yield* Deferred.succeed(observed, undefined);
          return [current()];
        }),
      get: (effectId) =>
        Effect.sync(() => {
          assert.strictEqual(effectId, row.id);
          reads++;
          return Option.some(current());
        }),
    });
    const sending = yield* host
      .send(target, setup.correction)
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.await(observed);
    assert.isUndefined(sending.pollUnsafe());
    delivered = true;
    yield* TestClock.adjust("100 millis");
    const receipt = yield* Fiber.join(sending);
    assert.strictEqual(receipt.runId, setup.correction.steerRunId);
    assert.strictEqual(receipt.state, "working");
    assert.isNull(receipt.result);
    assert.strictEqual(reads, 2);
    yield* host.send(target, setup.correction);
    assert.strictEqual(reads, 3);
    assert.strictEqual(
      (yield* Context.get(
        setup.context,
        ThreadManagementService.ThreadManagementService,
      ).getThreadProjection(threadId)).messages.filter((message) => message.role === "user").length,
      2,
    );
    assert.strictEqual(
      (yield* Effect.flip(
        host.send(target, { ...setup.correction, steerRunId: RunId.make("wrong-run") }),
      )).code,
      "dispatch-failed",
    );
    yield* Deferred.succeed(setup.release, undefined);
  }),
);

it.effect.each([false, true])(
  "bounds unconfirmed correction delivery when receipt read hangs=%s",
  (hung) =>
    Effect.gen(function* () {
      const setup = yield* correctionReceiptFixture.pipe(TestClock.withLive);
      const observed = yield* Deferred.make<void>();
      let reads = 0;
      const pending = { ...setup.rows[0]!, status: "pending" as const };
      const { host, target } = yield* setup.withReceipt({
        listByCommandId: () =>
          Effect.gen(function* () {
            reads++;
            yield* Deferred.succeed(observed, undefined);
            return hung ? yield* Effect.never : [pending];
          }),
        get: () =>
          Effect.sync(() => {
            reads++;
            return Option.some(pending);
          }),
      });
      const sending = yield* host
        .send(target, setup.correction)
        .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(observed);
      yield* TestClock.adjust("20 seconds");
      assert.strictEqual((yield* Fiber.join(sending)).code, "delivery-unconfirmed");
      assert.isAtMost(reads, 200);
      assert.strictEqual(reads, hung ? 1 : 200);
      yield* Deferred.succeed(setup.release, undefined);
    }),
);

it.effect.each(["missing", "native-turn"] as const)(
  "rejects a correction receipt that becomes %s while waiting",
  (variant) =>
    Effect.gen(function* () {
      const setup = yield* correctionReceiptFixture.pipe(TestClock.withLive);
      const observed = yield* Deferred.make<void>();
      const pending = { ...setup.rows[0]!, status: "pending" as const };
      const { host, target } = yield* setup.withReceipt({
        listByCommandId: () => Deferred.succeed(observed, undefined).pipe(Effect.as([pending])),
        get: () =>
          Effect.succeed(
            variant === "missing"
              ? Option.none()
              : Option.some({
                  ...pending,
                  request:
                    pending.request.type === "provider-turn.steer"
                      ? {
                          ...pending.request,
                          providerTurnId: ProviderTurnId.make("newer-native-turn"),
                        }
                      : pending.request,
                }),
          ),
      });
      const sending = yield* host
        .send(target, setup.correction)
        .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(observed);
      yield* TestClock.adjust("100 millis");
      assert.strictEqual((yield* Fiber.join(sending)).code, "dispatch-failed");
      yield* Deferred.succeed(setup.release, undefined);
    }),
);

describe("voiceWorkItemLabel", () => {
  const base = {
    id: TurnItemId.make("turn-item-1"),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 50,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(0),
  } as const;

  it("prefers the provider title, then falls back to a per-kind label", () => {
    assert.strictEqual(
      T3Host.voiceWorkItemLabel({
        ...base,
        title: "Fix the bug",
        type: "reasoning",
        text: "",
        streaming: false,
      }),
      "Fix the bug",
    );
    assert.strictEqual(
      T3Host.voiceWorkItemLabel({ ...base, type: "reasoning", text: "", streaming: false }),
      "Thinking",
    );
    assert.strictEqual(
      T3Host.voiceWorkItemLabel({ ...base, type: "command_execution", input: "  vp test  " }),
      "vp test",
    );
    assert.strictEqual(
      T3Host.voiceWorkItemLabel({ ...base, type: "command_execution", input: "   " }),
      null,
    );
    assert.strictEqual(
      T3Host.voiceWorkItemLabel({ ...base, type: "file_change", fileName: "VoiceControls.tsx" }),
      "Edited VoiceControls.tsx",
    );
  });
});

const codexSpeechInstance: ProviderInstance = {
  instanceId: ProviderInstanceId.make("codex-speech"),
  driverKind: ProviderDriverKind.make("codex"),
  enabled: true,
  displayName: "Fixture Speech Codex",
  continuationIdentity: {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: "voice-speech-test",
  },
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
  textGeneration: {} as ProviderInstance["textGeneration"],
};

it.live("binds a pi thread using an enabled Codex instance for the speech bridge", () =>
  Effect.gen(function* () {
    const setup = yield* makeFixture({
      runEffectWorker: false,
      driver: ProviderDriverKind.make("pi"),
      instanceId: ProviderInstanceId.make("pi"),
      extraInstances: [codexSpeechInstance],
    });
    yield* Effect.gen(function* () {
      const host = yield* T3Host.VoiceHost;
      const target = yield* host.bind(threadId);
      assert.strictEqual(target.instanceId, ProviderInstanceId.make("pi"));
      assert.deepStrictEqual(target.speech, {
        instanceId: ProviderInstanceId.make("codex-speech"),
        model: null,
      });
    }).pipe(Effect.provide(setup.context));
  }),
);

it.live("rejects a pi thread voice call without an enabled Codex provider", () =>
  Effect.gen(function* () {
    const setup = yield* makeFixture({
      runEffectWorker: false,
      driver: ProviderDriverKind.make("pi"),
      instanceId: ProviderInstanceId.make("pi"),
    });
    const error = yield* Effect.gen(function* () {
      const host = yield* T3Host.VoiceHost;
      return yield* host.bind(threadId);
    }).pipe(Effect.provide(setup.context), Effect.flip);
    assert.strictEqual(error.code, "unavailable");
    assert.strictEqual(error.message, "Voice needs an enabled Codex provider for speech.");
  }),
);
