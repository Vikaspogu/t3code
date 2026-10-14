import {
  type AuthEnvironmentScope,
  type AuthSessionId,
  type CommandId,
  type MessageId,
  type ModelSelection,
  OrbitVoiceError,
  type OrbitVoiceTask,
  orchestrationV2RunWorkStartedAt,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as SessionStore from "../auth/SessionStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
// Compact label for one work item on the voice card; null skips items that are not work steps.
export const voiceWorkItemLabel = (item: OrchestrationV2TurnItem): string | null => {
  if (item.title) return item.title;
  switch (item.type) {
    case "command_execution":
      return item.input.trim().slice(0, 120) || null;
    case "file_change":
      return `Edited ${item.fileName}`;
    case "reasoning":
      return "Thinking";
    case "web_search":
      return "Searching the web";
    case "file_search":
      return item.pattern ? `Searching files for ${item.pattern}` : "Searching files";
    case "user_input_request":
      return "Waiting for your input";
    case "approval_request":
      return "Waiting for approval";
    case "secret_request":
      return "Waiting for a secret";
    default:
      return null;
  }
};

export interface VoiceTarget {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly cwd: string;
  readonly threadTitle: string;
  // Speech bridge (audio, STT, TTS) for the call: the thread's own instance for Codex
  // threads, or any enabled Codex instance for pi threads. model null = runtime default.
  readonly speech: { readonly instanceId: ProviderInstanceId; readonly model: string | null };
}

export class VoiceHost extends Context.Service<
  VoiceHost,
  {
    readonly bind: (threadId: ThreadId) => Effect.Effect<VoiceTarget, OrbitVoiceError>;
    readonly authorize: (
      sessionId: AuthSessionId,
      scope: AuthEnvironmentScope,
    ) => Effect.Effect<void, OrbitVoiceError>;
    readonly awaitRevocation: (sessionId: AuthSessionId) => Effect.Effect<void, OrbitVoiceError>;
    readonly readActiveRun: (target: VoiceTarget) => Effect.Effect<RunId | null, OrbitVoiceError>;
    readonly readActiveTask: (
      target: VoiceTarget,
    ) => Effect.Effect<OrbitVoiceTask | null, OrbitVoiceError>;
    readonly watchActiveTask: (
      target: VoiceTarget,
    ) => Stream.Stream<OrbitVoiceTask, OrbitVoiceError>;
    readonly send: (
      target: VoiceTarget,
      input: {
        readonly text: string;
        readonly commandId: CommandId;
        readonly messageId: MessageId;
        readonly steerRunId?: RunId;
      },
    ) => Effect.Effect<OrbitVoiceTask, OrbitVoiceError>;
    readonly watchTask: (
      target: VoiceTarget,
      task: OrbitVoiceTask,
    ) => Stream.Stream<OrbitVoiceTask, OrbitVoiceError>;
  }
>()("t3/orbit-voice/T3Host/VoiceHost") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const sessions = yield* SessionStore.SessionStore;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const bindings = new WeakMap<
    VoiceTarget,
    { readonly instance: ProviderInstance; readonly modelSelection: ModelSelection }
  >();

  const readTarget = Effect.fn("VoiceHost.readTarget")(function* (threadId: ThreadId) {
    const { thread } = yield* threads.getThreadRecords(threadId, []).pipe(
      Effect.mapError(
        () =>
          new OrbitVoiceError({
            code: "unavailable",
            message: "The coding thread is unavailable.",
          }),
      ),
    );
    const project = yield* projects
      .get(thread.projectId)
      .pipe(
        Effect.mapError(
          () =>
            new OrbitVoiceError({ code: "unavailable", message: "The project is unavailable." }),
        ),
      );
    const instance = yield* instances.getInstance(thread.modelSelection.instanceId);
    if (
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      Option.isNone(project) ||
      !instance?.enabled ||
      (instance.driverKind !== "codex" && instance.driverKind !== "pi") ||
      !(yield* threads.isProviderInstanceEnabledForProject({
        projectId: thread.projectId,
        instanceId: instance.instanceId,
      }))
    ) {
      return yield* new OrbitVoiceError({
        code: "unavailable",
        message: "This thread is not available for a voice call.",
      });
    }
    return { thread, instance, cwd: thread.worktreePath ?? project.value.workspaceRoot };
  });

  const validate = Effect.fn("VoiceHost.validate")(function* (target: VoiceTarget) {
    const current = yield* readTarget(target.threadId);
    const binding = bindings.get(target);
    if (
      !binding ||
      binding.instance !== current.instance ||
      current.thread.projectId !== target.projectId ||
      !modelSelectionsEqual(current.thread.modelSelection, binding.modelSelection) ||
      current.cwd !== target.cwd
    ) {
      return yield* new OrbitVoiceError({
        code: "target-changed",
        message: "The coding target changed. Start a new voice call.",
      });
    }
    return binding;
  });

  const bind = Effect.fn("VoiceHost.bind")(function* (threadId: ThreadId) {
    const { thread, instance, cwd } = yield* readTarget(threadId);
    // Codex threads speak through their own runtime. pi threads borrow any enabled
    // Codex instance for the speech bridge; dispatch below stays on the pi instance.
    const speechInstance =
      instance.driverKind === "codex"
        ? instance
        : (yield* instances.listInstances).find(
            (candidate) => candidate.driverKind === "codex" && candidate.enabled,
          );
    if (!speechInstance)
      return yield* new OrbitVoiceError({
        code: "unavailable",
        message: "Voice needs an enabled Codex provider for speech.",
      });
    const target = Object.freeze({
      projectId: thread.projectId,
      threadId,
      instanceId: instance.instanceId,
      model: thread.modelSelection.model,
      cwd,
      threadTitle: thread.title,
      speech: Object.freeze({
        instanceId: speechInstance.instanceId,
        // A borrowed Codex runtime uses its own default model, not the pi model slug.
        model: speechInstance === instance ? thread.modelSelection.model : null,
      }),
    });
    bindings.set(target, {
      instance,
      modelSelection: Object.freeze({
        ...thread.modelSelection,
        ...(thread.modelSelection.options === undefined
          ? {}
          : {
              options: Object.freeze(
                thread.modelSelection.options.map((option) => Object.freeze({ ...option })),
              ),
            }),
      }),
    });
    return target;
  });

  const authorize = Effect.fn("VoiceHost.authorize")(function* (
    sessionId: AuthSessionId,
    scope: AuthEnvironmentScope,
  ) {
    const active = yield* sessions.listActive().pipe(
      Effect.mapError(
        () =>
          new OrbitVoiceError({
            code: "forbidden",
            message: "Voice access could not be verified.",
          }),
      ),
    );
    const session = active.find((value) => value.sessionId === sessionId);
    if (!session || !sessionGrantsScope({ ...session, authenticated: true }, scope)) {
      return yield* new OrbitVoiceError({
        code: "forbidden",
        message: "This session does not have access to this voice operation.",
      });
    }
  });

  const readActiveRun = Effect.fn("VoiceHost.readActiveRun")(function* (target: VoiceTarget) {
    yield* validate(target);
    const projection = yield* threads.getProjectThreadRecords(target, ["runs"]).pipe(
      Effect.mapError(
        () =>
          new OrbitVoiceError({
            code: "unavailable",
            message: "The coding task is unavailable.",
          }),
      ),
    );
    return ThreadManagementService.latestActiveRun(projection)?.id ?? null;
  });

  const readTask = Effect.fn("VoiceHost.readTask")(function* (
    target: VoiceTarget,
    task: Pick<OrbitVoiceTask, "messageId" | "runId">,
  ) {
    const read = (includeProviderTurns: boolean) =>
      threads
        .getProjectThreadRecords(
          target,
          [
            "runs",
            "messages",
            "checkpoints",
            "turnItems",
            ...(includeProviderTurns ? ["providerTurns" as const] : []),
          ],
          {
            runIds: [task.runId],
            messageRunIds: [task.runId],
            turnItemRunIds: [task.runId],
            turnItemTypes: ["approval_request", "user_input_request", "secret_request"],
            turnItemStatuses: ["waiting"],
          },
        )
        .pipe(
          Effect.mapError(
            () =>
              new OrbitVoiceError({
                code: "unavailable",
                message: "The coding result is unavailable.",
              }),
          ),
        );
    let projection = yield* read(false);
    const initialRun = projection.runs.find((value) => value.id === task.runId);
    if (
      initialRun &&
      ["preparing", "starting", "running"].includes(initialRun.status) &&
      !projection.checkpoints.some(
        (value) =>
          value.id === initialRun.checkpointId &&
          value.runId === initialRun.id &&
          value.status === "error",
      ) &&
      !projection.turnItems.some(
        (item) => initialRun.rootNodeId !== null && item.nodeId === initialRun.rootNodeId,
      ) &&
      projection.turnItems.some((item) => item.providerTurnId !== null)
    ) {
      // Child requests need attempt association; ordinary updates avoid reading provider-turn history.
      projection = yield* read(true);
    }
    const message = projection.messages.find(
      (value) => value.id === task.messageId && value.role === "user",
    );
    const run = projection.runs.find((value) => value.id === task.runId);
    if (!run || message?.runId !== task.runId) {
      return yield* new OrbitVoiceError({
        code: "unavailable",
        message: "The accepted coding task could not be found.",
      });
    }
    const checkpoint = projection.checkpoints.find(
      (value) => value.id === run.checkpointId && value.runId === run.id,
    );
    const replies = projection.messages.filter(
      (value) => value.role === "assistant" && value.runId === run.id,
    );
    let state: OrbitVoiceTask["state"] = "working";
    let result: string | null = null;
    if (run.status === "queued") state = "queued";
    else if (run.status === "failed" || checkpoint?.status === "error") state = "failed";
    else if (["cancelled", "interrupted", "rolled_back"].includes(run.status)) state = "cancelled";
    else if (
      run.status === "completed" &&
      checkpoint?.status === "ready" &&
      replies.length > 0 &&
      replies.every((value) => !value.streaming)
    ) {
      state = "completed";
      result = replies
        .map((value) => value.text)
        .join("\n")
        .slice(0, 4000);
    } else if (
      ["preparing", "starting", "running"].includes(run.status) &&
      projection.turnItems.some(
        (item) =>
          (run.rootNodeId !== null && item.nodeId === run.rootNodeId) ||
          (run.activeAttemptId !== null &&
            item.providerTurnId !== null &&
            projection.providerTurns?.some(
              (turn) =>
                turn.id === item.providerTurnId && turn.runAttemptId === run.activeAttemptId,
            )),
      )
    ) {
      // Run waiting means checkpoint finalization; only pending request cards need attention.
      state = "waiting";
    }
    let activity: string | null = null;
    let steps: ReadonlyArray<string> = [];
    if (state === "queued" || state === "working" || state === "waiting") {
      // The state machine above reads only pending request cards; work labels need the run's full item set.
      const activityProjection = yield* threads
        .getProjectThreadRecords(target, ["turnItems"], { turnItemRunIds: [task.runId] })
        .pipe(
          Effect.mapError(
            () =>
              new OrbitVoiceError({
                code: "unavailable",
                message: "The coding progress is unavailable.",
              }),
          ),
        );
      const labeled = activityProjection.turnItems
        .flatMap((item) => {
          const label = voiceWorkItemLabel(item);
          return label === null ? [] : [{ item, label }];
        })
        .sort((left, right) => left.item.ordinal - right.item.ordinal);
      activity =
        labeled.findLast((entry) => ["pending", "running", "waiting"].includes(entry.item.status))
          ?.label ?? null;
      steps = labeled
        .filter((entry) => entry.item.status === "completed")
        .slice(-3)
        .map((entry) => entry.label);
    }
    return {
      messageId: task.messageId,
      runId: task.runId,
      title: message.text.trim().split("\n", 1)[0]?.slice(0, 120) ?? "",
      state,
      startedAt: orchestrationV2RunWorkStartedAt(run),
      result,
      activity,
      steps,
      completedAt: run.completedAt,
    };
  });

  const awaitCorrectionDelivery = Effect.fn("VoiceHost.awaitCorrectionDelivery")(
    function* (
      target: VoiceTarget,
      input: Pick<Parameters<VoiceHost["Service"]["send"]>[1], "commandId" | "messageId">,
    ) {
      // Calls last at most one hour; settled outbox rows last seven days. Missing rows never prove delivery.
      // Succeeded means the pinned provider turn accepted delivery, not that the model applied the correction.
      const rows = yield* outbox.listByCommandId(input.commandId).pipe(
        Effect.mapError(
          () =>
            new OrbitVoiceError({
              code: "dispatch-failed",
              message: "The correction delivery receipt could not be read.",
            }),
        ),
      );
      if (rows.length !== 1) {
        return yield* new OrbitVoiceError({
          code: "dispatch-failed",
          message: "The correction has no unique delivery receipt.",
        });
      }
      const original = rows[0]!;
      if (
        original.commandId !== input.commandId ||
        original.threadId !== target.threadId ||
        original.request.type !== "provider-turn.steer" ||
        original.request.messageId !== input.messageId
      ) {
        return yield* new OrbitVoiceError({
          code: "dispatch-failed",
          message: "The correction delivery receipt does not match this request.",
        });
      }
      let current = original;
      for (let reads = 1; reads <= 200; reads++) {
        if (current.status === "succeeded") return;
        if (current.status === "failed" || current.status === "cancelled") {
          return yield* new OrbitVoiceError({
            code: "dispatch-failed",
            message: "The correction was not delivered to that coding task.",
          });
        }
        if (reads === 200) break;
        yield* Effect.sleep("100 millis");
        const next = yield* outbox.get(original.id).pipe(
          Effect.mapError(
            () =>
              new OrbitVoiceError({
                code: "dispatch-failed",
                message: "The correction delivery receipt could not be read.",
              }),
          ),
        );
        if (
          Option.isNone(next) ||
          next.value.id !== original.id ||
          next.value.commandId !== input.commandId ||
          next.value.threadId !== target.threadId ||
          next.value.request.type !== "provider-turn.steer" ||
          next.value.request.messageId !== input.messageId ||
          next.value.request.providerSessionId !== original.request.providerSessionId ||
          next.value.request.providerThreadId !== original.request.providerThreadId ||
          next.value.request.providerTurnId !== original.request.providerTurnId
        ) {
          return yield* new OrbitVoiceError({
            code: "dispatch-failed",
            message: "The correction delivery receipt changed or disappeared.",
          });
        }
        current = next.value;
      }
      return yield* new OrbitVoiceError({
        code: "delivery-unconfirmed",
        message:
          "Correction delivery is not confirmed. Check the original coding thread before trying again.",
      });
    },
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () =>
        Effect.fail(
          new OrbitVoiceError({
            code: "delivery-unconfirmed",
            message:
              "Correction delivery is not confirmed. Check the original coding thread before trying again.",
          }),
        ),
    }),
  );

  const send = Effect.fn("VoiceHost.send")(function* (
    target: VoiceTarget,
    input: Parameters<VoiceHost["Service"]["send"]>[1],
  ) {
    const { modelSelection } = yield* validate(target);
    if (yield* threads.hasReceipt(input.commandId)) {
      const projection = yield* threads
        .getProjectThreadRecords(target, ["messages"], { messageIds: [input.messageId] })
        .pipe(
          Effect.mapError(
            () =>
              new OrbitVoiceError({
                code: "dispatch-failed",
                message: "The coding receipt could not be read.",
              }),
          ),
        );
      const message = projection.messages.find((value) => value.id === input.messageId);
      if (
        !message?.runId ||
        message.text !== input.text ||
        (input.steerRunId !== undefined && message.runId !== input.steerRunId)
      ) {
        return yield* new OrbitVoiceError({
          code: "dispatch-failed",
          message: "This coding request does not match its existing receipt.",
        });
      }
      if (input.steerRunId !== undefined) yield* awaitCorrectionDelivery(target, input);
      return yield* readTask(target, { messageId: input.messageId, runId: message.runId });
    }
    if (input.steerRunId !== undefined) {
      if ((yield* readActiveRun(target)) !== input.steerRunId) {
        return yield* new OrbitVoiceError({
          code: "stale-run",
          message: "That coding task is no longer active. Say the new instruction again.",
        });
      }
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: input.commandId,
          threadId: target.threadId,
          messageId: input.messageId,
          text: input.text,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "steer_active", targetRunId: input.steerRunId, strictTarget: true },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(
          Effect.mapError(
            () =>
              new OrbitVoiceError({
                code: "dispatch-failed",
                message: "The correction could not be sent to that coding task.",
              }),
          ),
        );
      yield* awaitCorrectionDelivery(target, input);
      return yield* readTask(target, { messageId: input.messageId, runId: input.steerRunId });
    }
    const accepted = yield* threads
      .sendToThread({
        ...input,
        projectId: target.projectId,
        threadId: target.threadId,
        modelSelection,
        mode: "queue",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError(
          () =>
            new OrbitVoiceError({
              code: "dispatch-failed",
              message: "The instruction could not be sent to the coding thread.",
            }),
        ),
      );
    return yield* readTask(target, { messageId: accepted.message.id, runId: accepted.run.id });
  });

  const watchTask: VoiceHost["Service"]["watchTask"] = (target, task) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cursor = yield* threads.getThreadEventSequence(target.threadId).pipe(
          Effect.mapError(
            () =>
              new OrbitVoiceError({
                code: "unavailable",
                message: "The coding updates are unavailable.",
              }),
          ),
        );
        const initial = yield* readTask(target, task);
        return Stream.concat(
          Stream.succeed(initial),
          threads.streamStoredEventsFrom({ threadId: target.threadId, afterSequence: cursor }).pipe(
            Stream.mapError(
              () =>
                new OrbitVoiceError({
                  code: "unavailable",
                  message: "The coding updates stopped.",
                }),
            ),
            Stream.mapEffect(() => readTask(target, task)),
          ),
        );
      }),
    ).pipe(
      Stream.changesWith(
        (left, right) =>
          left.state === right.state &&
          left.result === right.result &&
          left.activity === right.activity &&
          left.steps.join("\n") === right.steps.join("\n"),
      ),
      Stream.takeUntil((task) => ["completed", "failed", "cancelled"].includes(task.state)),
    );

  // The panel card also reflects runs the user typed in chat, not only voice-delegated ones.
  const readActiveTask = Effect.fn("VoiceHost.readActiveTask")(function* (target: VoiceTarget) {
    yield* validate(target);
    const projection = yield* threads.getProjectThreadRecords(target, ["runs", "messages"]).pipe(
      Effect.mapError(
        () =>
          new OrbitVoiceError({
            code: "unavailable",
            message: "The coding task is unavailable.",
          }),
      ),
    );
    const run = ThreadManagementService.latestActiveRun(projection);
    if (!run) return null;
    const message = projection.messages.find(
      (value) => value.role === "user" && value.runId === run.id,
    );
    if (!message) return null;
    return yield* readTask(target, { messageId: message.id, runId: run.id });
  });

  const watchActiveTask: VoiceHost["Service"]["watchActiveTask"] = (target) =>
    Stream.fromEffect(readActiveTask(target)).pipe(
      Stream.flatMap((task) =>
        task === null ? Stream.empty : Stream.concat(Stream.succeed(task), watchTask(target, task)),
      ),
    );

  return VoiceHost.of({
    bind,
    authorize,
    readActiveRun,
    send,
    watchTask,
    readActiveTask,
    watchActiveTask,
    awaitRevocation: (sessionId) =>
      sessions.awaitInvalidation(sessionId).pipe(
        Effect.mapError(
          () =>
            new OrbitVoiceError({
              code: "forbidden",
              message: "Voice access could not be verified.",
            }),
        ),
      ),
  });
});

export const layer = Layer.effect(VoiceHost, make);
