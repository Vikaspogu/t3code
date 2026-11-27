// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  ProviderDriverKind,
  ProviderThreadId,
  RuntimeRequestId,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { isProviderNativeImageAttachment } from "@t3tools/provider-core/server/attachmentPrompt";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { HermesSettings, type HermesSettings as HermesSettingsValue } from "../settings.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  HermesGateway,
  HermesSessionStore,
  decodeTextTurnReceipt,
  hermesOrigin,
  decodeImageAttachResult,
  type HermesTextTurnReceipt,
  type HermesPendingImage,
  type HermesThreadRecord,
  isHermesGatewayError,
  type HermesGatewayError,
} from "./gateway.ts";

export const HERMES_PROVIDER = ProviderDriverKind.make("hermes");
const AcpCapabilities = structuredClone(AcpProviderCapabilitiesV2);
const HermesProviderCapabilitiesV2 = {
  ...AcpCapabilities,
  sessions: { ...AcpCapabilities.sessions, supportsProviderSwitchingViaHandoff: false },
  threads: { ...AcpCapabilities.threads, canReadThreadSnapshot: false, canRollbackThread: false },
  turns: {
    ...AcpCapabilities.turns,
    emitsTurnStarted: false,
    emitsTurnCompleted: false,
    supportsInterrupt: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "weak" as const,
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: false,
  },
  tools: {
    ...AcpCapabilities.tools,
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    ...AcpCapabilities.planning,
    emitsPlanUpdated: false,
    emitsTodoList: false,
    supportsStructuredQuestions: false,
  },
  context: {
    ...AcpCapabilities.context,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
};
const DEFAULT_SETTINGS = Schema.decodeSync(HermesSettings)({});
const restartRecoveryPending = "gateway_restart_recovery_pending";
const protocolError = (detail: string, cause?: unknown): ProviderAdapter.ProviderAdapterV2Error =>
  new ProviderAdapter.ProviderAdapterProtocolError({
    driver: HERMES_PROVIDER,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

type RuntimeDescription = {
  readonly profile_id: string;
  readonly instance_id: string;
  readonly authority_epoch: number;
  readonly capabilities: ReadonlyArray<string>;
};

export const asRuntimeDescription = (value: unknown): RuntimeDescription => {
  const runtime = value as Partial<RuntimeDescription>;
  if (
    typeof runtime.profile_id !== "string" ||
    !NodePath.posix.isAbsolute(runtime.profile_id) ||
    typeof runtime.instance_id !== "string" ||
    typeof runtime.authority_epoch !== "number" ||
    !Array.isArray(runtime.capabilities)
  ) {
    throw new Error("Invalid runtime.describe response");
  }
  for (const capability of ["durable-admission-v1", "event-replay-v1"]) {
    if (!runtime.capabilities.includes(capability))
      throw new Error(`Missing Hermes capability: ${capability}`);
  }
  return runtime as RuntimeDescription;
};

const sessionIdOf = (value: unknown): string => {
  const id = (value as { session_id?: unknown }).session_id;
  if (typeof id !== "string" || id.length === 0) throw new Error("Hermes returned no session_id");
  return id;
};

const resumedSessionIdOf = (value: unknown, expectedEpoch: number): string => {
  const id = sessionIdOf(value);
  if ((value as { authority_epoch?: unknown }).authority_epoch !== expectedEpoch) {
    throw new Error("Hermes session.resume authority epoch does not match runtime.describe");
  }
  return id;
};

interface ActiveHermesTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly authorityEpoch: number;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly startedAt: DateTime.Utc;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  receipt: HermesTextTurnReceipt | null;
  observedAdmissionId: string | null;
  observedGeneration: number | null;
  cursor: { epoch: string; sequence: number } | null;
  text: string;
  finalText: string | null;
  completionStatus: "complete" | "interrupted" | "error" | "queued-cancelled" | null;
  admitted: boolean;
  settled: boolean;
  request:
    | ((
        method: string,
        params: Record<string, unknown>,
      ) => Effect.Effect<unknown, ProviderAdapter.ProviderAdapterV2Error>)
    | null;
  readonly submission: {
    readonly session_id: string;
    readonly input_id: string;
    readonly text: string;
  };
  readonly prompts: Map<string, ActiveHermesPrompt>;
  resumedPrompts: ReadonlyArray<unknown> | null;
  replaying: boolean;
}

interface ActiveHermesPrompt {
  readonly turn: ActiveHermesTurn;
  readonly promptId: string;
  readonly kind: "approval" | "clarify";
  readonly node: OrchestrationV2ExecutionNode;
  readonly item: OrchestrationV2TurnItem;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  responding: boolean;
}

const recordField = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const stringField = (value: unknown, key: string): string | undefined => {
  const field = recordField(value, key);
  return typeof field === "string" ? field : undefined;
};

const integerField = (value: unknown, key: string): number | undefined => {
  const field = recordField(value, key);
  return typeof field === "number" && Number.isInteger(field) ? field : undefined;
};

const customSelectionUnavailable =
  "Hermes model and reasoning changes are unavailable in T3. Use the configured Hermes profile defaults.";

const isProfileSelection = (
  selection: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"],
) =>
  selection.model === "default" &&
  (selection.options ?? []).every((option) => option.value === "default");

export const makeHermesAdapterV2 = (input: {
  readonly instanceId: ProviderAdapter.ProviderAdapterV2["Service"]["instanceId"];
  readonly settings?: HermesSettingsValue;
  readonly environment?: NodeJS.ProcessEnv;
  // HermesDriver opts in; direct adapter consumers keep the conservative default.
  readonly enableTextTurns?: boolean;
  readonly resolveAttachmentPath?: (
    attachment: ProviderAdapter.ProviderAdapterV2TurnMessage["attachments"][number],
  ) => string | null;
}): ProviderAdapter.ProviderAdapterV2["Service"] => {
  const settings = { ...DEFAULT_SETTINGS, ...input.settings };
  const textTurnsEnabled = input.enableTextTurns === true;
  const environment = input.environment ?? process.env;
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: input.instanceId,
    driver: HERMES_PROVIDER,
    getCapabilities: Effect.fn("HermesAdapterV2.getCapabilities")(function () {
      return Effect.succeed(HermesProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("HermesAdapterV2.planSelectionTransition")(function ({
      target,
    }) {
      return Effect.succeed(
        isProfileSelection(target)
          ? turnScopedSelectionTransition()
          : { type: "reject" as const, reason: customSelectionUnavailable },
      );
    }),
    openSession: Effect.fn("HermesAdapterV2.openSession")(function* (
      openInput: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const cwd = openInput.runtimePolicy.cwd;
      const endpoint = settings.endpoint;
      const configuredEndpoint = environment.HERMES_GATEWAY_URL;
      const token = environment.HERMES_SESSION_TOKEN;
      const stateDirectory = HermesSessionStore.stateDirectoryFromEnv(environment);
      const profileId = settings.profileId;
      const principalId = settings.principalId;
      const stateRelative = stateDirectory && cwd ? NodePath.relative(cwd, stateDirectory) : "";
      const stateIsExternal =
        !!stateDirectory &&
        NodePath.isAbsolute(stateDirectory) &&
        (stateRelative === ".." || stateRelative.startsWith(`..${NodePath.sep}`)) &&
        !NodePath.isAbsolute(stateRelative);
      if (
        !cwd ||
        !endpoint ||
        configuredEndpoint !== endpoint ||
        !token ||
        !stateIsExternal ||
        !profileId ||
        !principalId.startsWith("uid:")
      ) {
        return yield* protocolError(
          "Hermes requires cwd, matching HERMES_GATEWAY_URL, session token, absolute external HERMES_STATE_DIR, profile ID, and pinned gateway UID",
        );
      }
      const gateway = yield* HermesGateway.connect(
        endpoint,
        token,
        hermesOrigin(endpoint),
        environment,
      ).pipe(
        Effect.mapError((cause) =>
          protocolError("Could not open canonical Hermes listener", cause),
        ),
      );
      const requestOn =
        (connection: Effect.Success<typeof gateway.connection>) =>
        (method: string, params: Record<string, unknown>) =>
          connection
            .request(method, params)
            .pipe(Effect.mapError((cause) => protocolError(`Hermes ${method} failed`, cause)));
      const connectRequest = gateway.connection.pipe(
        Effect.mapError((cause) =>
          protocolError("Could not acquire canonical Hermes connection", cause),
        ),
        Effect.map(requestOn),
      );
      const store = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new HermesSessionStore(NodePath.join(stateDirectory!, "sessions.sqlite3")),
          catch: (cause) => protocolError("Could not open project-local Hermes state", cause),
        }),
        (value) => Effect.sync(() => value.close()),
      );
      const describe = Effect.fnUntraced(function* (
        request: Effect.Success<typeof connectRequest>,
      ) {
        const raw = yield* request("runtime.describe", {});
        return yield* Effect.try({
          try: () => asRuntimeDescription(raw),
          catch: (cause) => protocolError("Invalid Hermes runtime identity", cause),
        });
      });
      yield* describe(yield* connectRequest);
      const now = yield* DateTime.now;

      const scope = yield* Scope.Scope;
      const output = yield* Effect.acquireRelease(
        Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>(),
        (queue) => Queue.shutdown(queue),
      );
      const activeTurns = new Map<string, ActiveHermesTurn>();
      const ordinaryLostTurns = new Set<string>();
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(output, event).pipe(Effect.asVoid);
      const settledPrompts = new Map<string, ActiveHermesPrompt>();

      const verifyTurnRuntime = Effect.fnUntraced(function* (
        request: ReturnType<typeof requestOn>,
        stored: HermesThreadRecord,
      ) {
        const runtime = yield* describe(request);
        if (
          runtime.profile_id !== stored.profileId ||
          runtime.instance_id !== stored.instanceId ||
          runtime.authority_epoch !== stored.authorityEpoch ||
          principalId !== stored.principalId
        ) {
          return yield* protocolError(
            "Hermes runtime identity changed; recovery must fence this session",
          );
        }
        return runtime;
      });

      const currentProviderTurn = (
        turn: ActiveHermesTurn,
        status: OrchestrationV2ProviderTurn["status"],
        completedAt: DateTime.Utc | null,
      ): OrchestrationV2ProviderTurn => ({
        ...turn.providerTurn,
        nativeTurnRef: {
          driver: HERMES_PROVIDER,
          nativeId: turn.receipt?.admission_id ?? turn.inputId,
          strength: turn.receipt ? "strong" : "weak",
        },
        status,
        completedAt,
      });

      const emitRunning = Effect.fnUntraced(function* (turn: ActiveHermesTurn) {
        const updatedAt = yield* DateTime.now;
        yield* emit({
          type: "provider_turn.updated",
          driver: HERMES_PROVIDER,
          threadId: turn.input.threadId,
          providerTurn: currentProviderTurn(turn, "running", null),
        });
        yield* emit({
          type: "provider_thread.updated",
          driver: HERMES_PROVIDER,
          providerThread: {
            ...turn.input.providerThread,
            status: "active",
            firstRunOrdinal: turn.input.providerThread.firstRunOrdinal ?? turn.input.runOrdinal,
            lastRunOrdinal: turn.input.runOrdinal,
            updatedAt,
          },
        });
      });

      const emitAssistant = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        text: string,
        streaming: boolean,
      ) {
        if (!turn.admitted) return;
        const admissionId = turn.receipt?.admission_id;
        if (!admissionId) return yield* protocolError("Hermes output has no admission identity");
        const nativeItemId = `${admissionId}:assistant`;
        const messageId = IdAllocator.derive.messageFromProviderItem({
          driver: HERMES_PROVIDER,
          nativeItemId,
        });
        const itemId = IdAllocator.derive.turnItemFromProviderItem({
          driver: HERMES_PROVIDER,
          nativeItemId,
        });
        const nativeItemRef = {
          driver: HERMES_PROVIDER,
          nativeId: nativeItemId,
          strength: "strong",
        } as const;
        const ordinal = turn.input.providerTurnOrdinal * 100 + 1;
        const updatedAt = yield* DateTime.now;
        yield* emit({
          type: "turn_item.updated",
          driver: HERMES_PROVIDER,
          turnItem: {
            id: itemId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: turn.input.rootNodeId,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef,
            parentItemId: null,
            ordinal,
            status: streaming ? "running" : "completed",
            title: null,
            startedAt: turn.startedAt,
            completedAt: streaming ? null : updatedAt,
            updatedAt,
            type: "assistant_message",
            messageId,
            text,
            streaming,
          },
        });
        yield* emit({
          type: "message.updated",
          driver: HERMES_PROVIDER,
          message: {
            id: messageId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: turn.input.rootNodeId,
            role: "assistant",
            text,
            attachments: [],
            streaming,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: turn.startedAt,
            updatedAt,
          },
        });
      });

      const updatePrompt = Effect.fnUntraced(function* (
        prompt: ActiveHermesPrompt,
        requestedStatus: "resolved" | "expired",
        decision?: "accept" | "acceptForSession" | "acceptAlways" | "decline",
        answers?: Record<string, unknown>,
      ) {
        if (prompt.runtimeRequest.status !== "pending") return;
        const status = yield* Effect.try({
          try: () =>
            store.settleTextTurnInteraction(prompt.turn.inputId, prompt.promptId, requestedStatus),
          catch: (cause) => protocolError("Could not persist Hermes prompt settlement", cause),
        });
        const resolvedAt = yield* DateTime.now;
        prompt.runtimeRequest = {
          ...prompt.runtimeRequest,
          status,
          responseCapability: {
            type: "not_resumable" as const,
            reason: "Hermes prompt is settled",
          },
          ...(status === "resolved"
            ? prompt.kind === "approval"
              ? decision
                ? { decision }
                : {}
              : { answers: answers ?? {} }
            : {}),
          resolvedAt,
        };
        yield* emit({
          type: "runtime_request.updated",
          driver: HERMES_PROVIDER,
          threadId: prompt.turn.input.threadId,
          runtimeRequest: prompt.runtimeRequest,
        });
        const itemStatus = status === "resolved" ? "completed" : "cancelled";
        yield* emit({
          type: "node.updated",
          driver: HERMES_PROVIDER,
          node: { ...prompt.node, status: itemStatus, completedAt: resolvedAt },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: HERMES_PROVIDER,
          turnItem: {
            ...prompt.item,
            status: itemStatus,
            completedAt: resolvedAt,
            updatedAt: resolvedAt,
          },
        });
        settledPrompts.set(prompt.runtimeRequest.id, prompt);
      });

      const responseUncertain = Effect.fnUntraced(function* (
        prompt: ActiveHermesPrompt,
        cause: unknown,
      ) {
        if (prompt.runtimeRequest.status === "pending") {
          prompt.runtimeRequest = {
            ...prompt.runtimeRequest,
            responseCapability: {
              type: "not_resumable",
              reason: "Hermes response requires verified recovery before another answer",
            },
          };
          yield* emit({
            type: "runtime_request.updated",
            driver: HERMES_PROVIDER,
            threadId: prompt.turn.input.threadId,
            runtimeRequest: prompt.runtimeRequest,
          });
        }
        return yield* protocolError("Hermes response outcome is uncertain", cause);
      });

      const expirePrompts = Effect.fnUntraced(function* (turn: ActiveHermesTurn) {
        for (const prompt of turn.prompts.values()) yield* updatePrompt(prompt, "expired");
      });

      const projectPrompt = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        raw: unknown,
        admissionId: string,
        reverified = false,
        publish: typeof emit = emit,
      ) {
        const receipt = turn.receipt;
        if (turn.replaying) return;
        if (!receipt) return;
        const kind = recordField(raw, "kind");
        const promptId = stringField(raw, "prompt_id");
        const generation = integerField(raw, "execution_generation");
        if (
          (kind !== "approval" && kind !== "clarify") ||
          !promptId ||
          receipt.status !== "started" ||
          receipt.admission_id !== admissionId ||
          receipt.execution_generation === null ||
          generation !== receipt.execution_generation
        ) {
          return yield* protocolError(
            "Hermes prompt does not match the provider-owned started turn",
          );
        }
        const existing = turn.prompts.get(promptId);
        if (existing) {
          if (existing.kind !== kind || existing.runtimeRequest.status !== "pending") return;
          // A live duplicate must not fence or rearm an in-flight response.
          if (!reverified || !existing.responding) return;
        }
        const interaction = yield* Effect.try({
          try: () => store.recordTextTurnInteraction(turn.inputId, admissionId, raw),
          catch: (cause) => protocolError("Could not journal Hermes prompt identity", cause),
        });
        if (interaction.state !== "pending") {
          if (existing) {
            existing.runtimeRequest = {
              ...existing.runtimeRequest,
              responseCapability: {
                type: "not_resumable",
                reason: "Hermes prompt is no longer open in durable state",
              },
            };
            yield* publish({
              type: "runtime_request.updated",
              driver: HERMES_PROVIDER,
              threadId: turn.input.threadId,
              runtimeRequest: existing.runtimeRequest,
            });
          }
          return;
        }
        const createdAt = yield* DateTime.now;
        const requestId = RuntimeRequestId.make(
          `runtime-request:hermes:${encodeURIComponent(turn.inputId)}:${encodeURIComponent(promptId)}`,
        );
        const nodeId = IdAllocator.derive.approvalNode({ requestId });
        const nativeItemRef = {
          driver: HERMES_PROVIDER,
          nativeId: promptId,
          strength: "strong" as const,
        };
        let runtimeRequest: OrchestrationV2RuntimeRequest;
        let item: OrchestrationV2TurnItem;
        const baseItem = {
          id: IdAllocator.derive.approvalTurnItem({ requestId }),
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          nodeId,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef,
          parentItemId: null,
          ordinal: turn.input.providerTurnOrdinal * 100 + 3 + turn.prompts.size,
          status: "waiting" as const,
          startedAt: existing?.item.startedAt ?? createdAt,
          completedAt: null,
          updatedAt: createdAt,
        };
        if (kind === "approval") {
          const command = stringField(raw, "command");
          const rawChoices = recordField(raw, "choices");
          if (
            !command ||
            !Array.isArray(rawChoices) ||
            !rawChoices.every((v) => typeof v === "string")
          ) {
            return yield* protocolError("Invalid Hermes approval request");
          }
          const decisionFor = {
            once: "accept",
            session: "acceptForSession",
            always: "acceptAlways",
            deny: "decline",
          } as const;
          const options = rawChoices.map((choice) => {
            const decision = decisionFor[choice as keyof typeof decisionFor];
            return decision ? { decision, label: choice } : null;
          });
          if (options.some((option) => option === null)) {
            return yield* protocolError("Hermes approval contains an unsupported choice");
          }
          runtimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: turn.providerTurn.id,
            status: "pending",
            nativeRequestRef: nativeItemRef,
            createdAt: existing?.runtimeRequest.createdAt ?? createdAt,
            resolvedAt: null,
            responseCapability: {
              type: "live",
              providerSessionId: turn.input.providerThread.providerSessionId!,
            },
            kind: "command",
          };
          item = {
            ...baseItem,
            title: null,
            type: "approval_request",
            requestId,
            requestKind: "command",
            prompt: command,
            options: options as NonNullable<
              Extract<OrchestrationV2TurnItem, { type: "approval_request" }>["options"]
            >,
          };
        } else {
          const question = stringField(raw, "question");
          const rawChoices = recordField(raw, "choices");
          if (
            !question ||
            !Array.isArray(rawChoices) ||
            !rawChoices.every((v) => typeof v === "string")
          ) {
            return yield* protocolError("Invalid Hermes clarification request");
          }
          runtimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: turn.providerTurn.id,
            status: "pending",
            nativeRequestRef: nativeItemRef,
            createdAt: existing?.runtimeRequest.createdAt ?? createdAt,
            resolvedAt: null,
            responseCapability: {
              type: "live",
              providerSessionId: turn.input.providerThread.providerSessionId!,
            },
            kind: "user_input",
          };
          item = {
            ...baseItem,
            title: "User input",
            type: "user_input_request",
            requestId,
            questions: [
              {
                id: promptId,
                header: "Hermes",
                question,
                options: rawChoices.map((choice) => ({ label: choice, description: choice })),
                multiSelect: recordField(raw, "multi_select") === true,
              },
            ],
          };
        }
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind: kind === "approval" ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef,
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: existing?.node.startedAt ?? createdAt,
          completedAt: null,
        };
        const prompt: ActiveHermesPrompt = {
          turn,
          promptId,
          kind,
          node,
          item,
          runtimeRequest,
          responding: false,
        };
        turn.prompts.set(promptId, prompt);
        yield* publish({ type: "node.updated", driver: HERMES_PROVIDER, node });
        yield* publish({ type: "turn_item.updated", driver: HERMES_PROVIDER, turnItem: item });
        yield* publish({
          type: "runtime_request.updated",
          driver: HERMES_PROVIDER,
          threadId: turn.input.threadId,
          runtimeRequest,
        });
      });

      const projectFrame = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        frame: unknown,
        request?: ReturnType<typeof requestOn>,
      ) {
        if (stringField(frame, "session_id") !== turn.sessionId) return;
        const epoch = stringField(frame, "replay_epoch");
        const sequence = integerField(frame, "seq");
        const cursor = turn.cursor;
        if (!cursor || !epoch || sequence === undefined) {
          return yield* protocolError("Hermes event has no valid replay identity");
        }
        if (epoch === cursor.epoch && sequence <= cursor.sequence) return;
        if (epoch !== cursor.epoch || sequence !== cursor.sequence + 1) {
          return yield* protocolError("Hermes live event stream is not contiguous with replay");
        }
        turn.cursor = { epoch, sequence };
        const authorityEpoch = integerField(frame, "authority_epoch");
        if (authorityEpoch !== undefined && authorityEpoch !== turn.authorityEpoch) {
          return yield* protocolError("Hermes event authority does not match the active turn");
        }

        const type = stringField(frame, "type");
        if (
          ![
            "message.start",
            "message.delta",
            "message.complete",
            "approval.request",
            "clarify.request",
            "approval.settled",
            "clarify.settled",
          ].includes(type ?? "")
        )
          return;
        const admissionId = stringField(frame, "admission_id");
        if (!admissionId) return yield* protocolError(`Hermes ${type} has no admission ID`);
        if (turn.receipt && admissionId !== turn.receipt.admission_id) {
          return yield* protocolError("Hermes event admission does not match the active turn");
        }
        if (turn.observedAdmissionId && admissionId !== turn.observedAdmissionId) {
          return yield* protocolError("Hermes replay contains more than one turn admission");
        }
        turn.observedAdmissionId = admissionId;
        const generation = integerField(frame, "execution_generation");
        if (generation !== undefined) {
          if (
            turn.receipt?.execution_generation != null &&
            generation !== turn.receipt.execution_generation
          ) {
            return yield* protocolError(
              "Hermes event execution generation does not match the receipt",
            );
          }
          if (turn.observedGeneration != null && generation !== turn.observedGeneration) {
            return yield* protocolError(
              "Hermes replay contains more than one execution generation",
            );
          }
          turn.observedGeneration = generation;
        }
        const payload = recordField(frame, "payload");
        if (type === "message.start") {
          if (request) yield* promoteStartedReceipt(turn, request);
          return;
        }
        if (type === "approval.request" || type === "clarify.request") {
          yield* projectPrompt(turn, payload, admissionId);
          return;
        }
        if (type === "approval.settled" || type === "clarify.settled") {
          const promptId = stringField(payload, "prompt_id");
          const prompt = promptId ? turn.prompts.get(promptId) : undefined;
          if (prompt) yield* updatePrompt(prompt, "resolved");
          return;
        }
        if (turn.completionStatus !== null) {
          return yield* protocolError("Hermes emitted output after message.complete");
        }
        if (type === "message.delta") {
          const delta = recordField(payload, "text");
          if (delta === null) return;
          if (typeof delta !== "string")
            return yield* protocolError("Invalid Hermes message.delta payload");
          turn.text += delta;
          if (turn.admitted) yield* emitAssistant(turn, turn.text, true);
          return;
        }
        const status = stringField(payload, "status");
        // Hermes v0.23.3's queued cancellation has no status or execution generation.
        if (
          recordField(payload, "status") === undefined &&
          stringField(payload, "outcome") === "cancelled" &&
          generation === undefined &&
          turn.observedGeneration === null &&
          turn.receipt?.execution_generation == null &&
          !turn.text
        ) {
          turn.completionStatus = "queued-cancelled";
          return;
        }
        if (status !== "complete" && status !== "interrupted" && status !== "error") {
          return yield* protocolError("Invalid Hermes message.complete status");
        }
        turn.finalText = stringField(payload, "text") ?? turn.text;
        turn.completionStatus = status;
      });

      const matchesPendingIdentity = (entry: unknown, inputId: string, admissionId: string) =>
        stringField(entry, "input_id") === inputId ||
        stringField(entry, "admission_id") === admissionId;
      const verifyResumeAdmission = (
        turn: ActiveHermesTurn,
        resumed: unknown,
        requireCanonicalSnapshot: boolean,
      ): void => {
        const receipt = turn.receipt;
        const pending = recordField(resumed, "pending");
        const prompts = recordField(resumed, "prompts");
        if (!receipt || receipt.status !== "started" || receipt.execution_generation === null) {
          turn.resumedPrompts = Array.isArray(prompts) ? prompts : null;
          return;
        }
        if (!Array.isArray(pending) || !Array.isArray(prompts)) {
          if (!requireCanonicalSnapshot && turn.prompts.size === 0 && prompts === undefined) {
            turn.resumedPrompts = [];
            return;
          }
          throw new Error("Hermes resume has no canonical pending prompt state");
        }
        const matches = pending.filter((entry) =>
          matchesPendingIdentity(entry, turn.inputId, receipt.admission_id),
        );
        if (
          matches.length !== 1 ||
          stringField(matches[0], "input_id") !== turn.inputId ||
          stringField(matches[0], "admission_id") !== receipt.admission_id ||
          stringField(matches[0], "status") !== "started" ||
          integerField(matches[0], "execution_generation") !== receipt.execution_generation ||
          integerField(matches[0], "authority_epoch") !== turn.authorityEpoch ||
          stringField(recordField(matches[0], "ref"), "session_id") !== turn.sessionId ||
          stringField(recordField(matches[0], "ref"), "profile_id") !== receipt.ref.profile_id
        ) {
          throw new Error("Hermes resume admission is foreign or ambiguous");
        }
        turn.resumedPrompts = prompts;
      };

      const reconcileResumedPrompts = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        resumed: unknown,
        requireCanonicalSnapshot = false,
        publish: typeof emit = emit,
      ) {
        // Terminal admissions are absent from pending; finalize verifies their exact receipt.
        if (turn.completionStatus !== null || turn.receipt?.status === "terminal") return;
        yield* Effect.try({
          try: () => verifyResumeAdmission(turn, resumed, requireCanonicalSnapshot),
          catch: (cause) => protocolError("Invalid Hermes pending prompt resume", cause),
        });
        if (!turn.resumedPrompts || !turn.receipt) return;
        const seen = new Set<string>();
        for (const raw of turn.resumedPrompts) {
          const promptId = stringField(raw, "prompt_id");
          if (!promptId || seen.has(promptId)) {
            return yield* protocolError("Hermes resumed prompts are ambiguous");
          }
          seen.add(promptId);
          yield* projectPrompt(turn, raw, turn.receipt.admission_id, true, publish);
        }
        for (const prompt of turn.prompts.values()) {
          if (prompt.runtimeRequest.status === "pending" && !seen.has(prompt.promptId)) {
            yield* updatePrompt(prompt, "expired");
          }
        }
      });

      const attach = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        connection: Effect.Success<typeof gateway.connection>,
        stored: HermesThreadRecord,
      ) {
        const request = requestOn(connection);
        yield* verifyTurnRuntime(request, stored);
        const events = yield* connection
          .subscribeEvents(turn.sessionId)
          .pipe(
            Effect.mapError((cause) =>
              protocolError("Could not subscribe to Hermes events", cause),
            ),
          );
        const resumed = yield* request("session.resume", {
          session_id: turn.sessionId,
          omit_messages: true,
        });
        const resumedId = yield* Effect.try({
          try: () => resumedSessionIdOf(resumed, stored.authorityEpoch),
          catch: (cause) => protocolError("Invalid Hermes session.resume response", cause),
        });
        const epoch = stringField(resumed, "replay_epoch");
        const sequence = integerField(resumed, "last_sequence");
        if (resumedId !== turn.sessionId || !epoch || sequence === undefined) {
          return yield* protocolError("Hermes resume did not return the canonical replay cursor");
        }
        turn.cursor = { epoch, sequence };
        return { request, events, resumed };
      });

      const recoverJournalOnlyTurn = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        stored: HermesThreadRecord,
        resumed: unknown,
        request: ReturnType<typeof requestOn>,
      ) {
        const pending = recordField(resumed, "pending");
        if (!Array.isArray(pending)) {
          return yield* protocolError("Hermes resume has no canonical pending admission state");
        }
        const matches = pending.filter((entry) => stringField(entry, "input_id") === turn.inputId);
        if (matches.length > 1) {
          return yield* protocolError("Hermes resume admission is ambiguous; refusing to resubmit");
        }
        if (matches.length === 1) {
          const receipt = yield* Effect.try({
            try: () => decodeTextTurnReceipt(matches[0]),
            catch: (cause) => protocolError("Invalid Hermes pending admission", cause),
          });
          if (
            !(
              (receipt.status === "started" && receipt.execution_generation !== null) ||
              (receipt.status === "queued" && receipt.execution_generation === null)
            )
          ) {
            return yield* protocolError(
              "Hermes pending admission is not recoverable; refusing to resubmit",
            );
          }
          turn.receipt = receipt;
          yield* Effect.try({
            try: () => verifyResumeAdmission(turn, resumed, true),
            catch: (cause) => protocolError("Invalid Hermes pending prompt resume", cause),
          });
          yield* recordReceipt(turn, receipt);
          return receipt.status === "started";
        }
        // A submit failure is ambiguous: never retry it during journal-only recovery.
        yield* attachImage(request, turn.sessionId, turn.inputId);
        const raw = yield* request("prompt.submit", yield* promptSubmission(turn));
        const submitted = yield* Effect.try({
          try: () => decodeTextTurnReceipt(raw),
          catch: (cause) => protocolError("Invalid Hermes submit receipt", cause),
        });
        if (
          submitted.ref.session_id !== turn.sessionId ||
          submitted.ref.profile_id !== stored.profileId ||
          submitted.authority_epoch !== turn.authorityEpoch
        ) {
          return yield* protocolError("Hermes submit receipt does not match the recovering turn");
        }
        yield* recordReceipt(
          turn,
          submitted.status === "terminal" && submitted.result === undefined
            ? yield* readRecoveryTerminalReceipt(turn, request, submitted)
            : submitted,
        );
        return false;
      });
      const recover = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        stored: HermesThreadRecord,
      ) {
        turn.request = null;
        if (!turn.cursor) return yield* protocolError("Hermes recovery has no replay cursor");
        const connection = yield* gateway.connection.pipe(
          // A crashed Gateway can be briefly offline before its successor is ready.
          Effect.retry({
            schedule: Schedule.spaced("1 second"),
            times: 12,
            while: (gatewayError) => {
              const transportCause = gatewayError.cause;
              return (
                integerField(transportCause, "status") === 503 ||
                stringField(transportCause, "code") === "ECONNREFUSED" ||
                stringField(recordField(transportCause, "cause"), "code") === "ECONNREFUSED"
              );
            },
          }),
          Effect.timeout("15 seconds"),
          Effect.mapError((cause) =>
            protocolError("Could not reacquire canonical Hermes connection", cause),
          ),
        );
        const request = requestOn(connection);
        const runtime = yield* describe(request);
        if (
          runtime.profile_id !== stored.profileId ||
          runtime.instance_id !== stored.instanceId ||
          runtime.authority_epoch !== stored.authorityEpoch ||
          principalId !== stored.principalId
        ) {
          yield* recoverRestarted(turn, stored, connection, runtime);
          return { request, events: Stream.empty, resumed: null };
        }
        const events = yield* connection
          .subscribeEvents(turn.sessionId)
          .pipe(
            Effect.mapError((cause) =>
              protocolError("Could not resubscribe to Hermes events", cause),
            ),
          );
        const replayed = yield* connection
          .replayEvents(turn.sessionId, turn.cursor)
          .pipe(
            Effect.mapError((cause) =>
              protocolError("Hermes replay failed; refusing to re-execute", cause),
            ),
          );
        turn.replaying = true;
        for (const frame of replayed) yield* projectFrame(turn, frame);
        turn.replaying = false;
        const resumed = yield* request("session.resume", {
          session_id: turn.sessionId,
          omit_messages: true,
        });
        const resumedId = yield* Effect.try({
          try: () => resumedSessionIdOf(resumed, stored.authorityEpoch),
          catch: (cause) => protocolError("Invalid Hermes recovery resume response", cause),
        });
        if (
          resumedId !== turn.sessionId ||
          stringField(resumed, "replay_epoch") !== turn.cursor.epoch ||
          (integerField(resumed, "last_sequence") ?? -1) < turn.cursor.sequence
        ) {
          return yield* protocolError("Hermes resume is not contiguous with the recovered replay");
        }
        yield* recoverAbsentPendingReceipt(turn, resumed, request);
        yield* promoteStartedReceipt(turn, request);
        yield* reconcileResumedPrompts(turn, resumed);
        turn.request = request;
        return { request, events, resumed };
      });

      const recoverRestarted = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        stored: HermesThreadRecord,
        connection: Effect.Success<typeof gateway.connection>,
        runtime: RuntimeDescription,
      ) {
        if (
          runtime.profile_id !== stored.profileId ||
          principalId !== stored.principalId ||
          runtime.authority_epoch <= stored.authorityEpoch ||
          runtime.instance_id === stored.instanceId
        ) {
          return yield* protocolError("Hermes restart is not a verified later authority");
        }
        const request = requestOn(connection);
        const resumed = yield* request("session.resume", {
          session_id: turn.sessionId,
          omit_messages: true,
        });
        const original = yield* Effect.try({
          try: () => store.getTextTurnReceipt(turn.inputId),
          catch: (cause) => protocolError("Could not read the journaled Hermes admission", cause),
        });
        if (
          !original ||
          original.status !== "started" ||
          original.execution_generation === null ||
          (yield* Effect.try({
            try: () => resumedSessionIdOf(resumed, runtime.authority_epoch),
            catch: (cause) => protocolError("Invalid Hermes restart resume response", cause),
          })) !== turn.sessionId
        ) {
          return yield* protocolError("Hermes restart has no exact started admission");
        }
        turn.receipt = original;
        const resumedPrompts = recordField(resumed, "prompts");
        const readReceipt = (raw: unknown) =>
          Effect.try({
            try: () => {
              const receipt = decodeTextTurnReceipt(raw);
              if (
                receipt.ref.session_id !== original.ref.session_id ||
                receipt.ref.profile_id !== original.ref.profile_id ||
                receipt.authority_epoch !== original.authority_epoch ||
                receipt.admission_id !== original.admission_id ||
                receipt.execution_generation !== original.execution_generation ||
                receipt.sequence !== original.sequence
              ) {
                throw new Error("Hermes restart receipt has the wrong wire identity");
              }
              return receipt;
            },
            catch: (cause) => protocolError("Invalid Hermes restart receipt", cause),
          });
        let receipt = yield* readReceipt(
          yield* request("prompt.receipt", {
            session_id: turn.sessionId,
            admission_id: original.admission_id,
            include_result: true,
          }),
        );
        const oldPrompts = [...turn.prompts.values()].filter(
          (prompt) => prompt.runtimeRequest.status === "pending",
        );
        const alreadyTerminal = receipt.status === "terminal";
        if (!alreadyTerminal) {
          const admissions = recordField(resumed, "pending");
          const matches = Array.isArray(admissions)
            ? admissions.filter((entry) => stringField(entry, "input_id") === turn.inputId)
            : [];
          const match = matches[0];
          const exactAdmission =
            Array.isArray(resumedPrompts) &&
            resumedPrompts.length === 0 &&
            matches.length === 1 &&
            stringField(match, "admission_id") === receipt.admission_id &&
            stringField(match, "status") === receipt.status &&
            integerField(match, "execution_generation") === receipt.execution_generation &&
            integerField(match, "authority_epoch") === receipt.authority_epoch &&
            integerField(match, "sequence") === receipt.sequence &&
            stringField(recordField(match, "ref"), "session_id") === receipt.ref.session_id &&
            stringField(recordField(match, "ref"), "profile_id") === receipt.ref.profile_id;
          if (receipt.status === "unknown" && oldPrompts.length === 0 && exactAdmission) {
            // An ordinary lost turn may still need an external discard if automatic cleanup fails.
            ordinaryLostTurns.add(turn.inputId);
          }
          if (
            !exactAdmission ||
            oldPrompts.length > 1 ||
            (oldPrompts.length === 0 && receipt.status !== "unknown")
          ) {
            return yield* protocolError(
              `${restartRecoveryPending}: no exact lost Hermes prompt and admission`,
            );
          }
        }
        const cleanupStatus = receipt.status;
        for (let attempt = 0; attempt < 2 && receipt.status !== "terminal"; attempt += 1) {
          if (
            receipt.status !== cleanupStatus ||
            (receipt.status !== "started" && receipt.status !== "unknown")
          ) {
            return yield* protocolError(
              `${restartRecoveryPending}: Hermes admission is unresolved: ${receipt.status}`,
            );
          }
          const method =
            receipt.status === "started" ? "session.interrupt" : "prompt.resolve_unknown";
          const params =
            receipt.status === "started"
              ? {
                  session_id: turn.sessionId,
                  execution_generation: original.execution_generation,
                }
              : {
                  session_id: turn.sessionId,
                  admission_id: original.admission_id,
                  execution_generation: original.execution_generation,
                };
          const cleaned = yield* Effect.result(request(method, params));
          if (cleaned._tag === "Success") {
            if (method === "prompt.resolve_unknown") {
              yield* readReceipt(cleaned.success);
            } else {
              const handle = cleaned.success;
              const ref = recordField(handle, "ref");
              if (
                stringField(ref, "session_id") !== turn.sessionId ||
                stringField(ref, "profile_id") !== original.ref.profile_id ||
                stringField(handle, "instance_id") !== runtime.instance_id ||
                integerField(handle, "authority_epoch") !== runtime.authority_epoch ||
                integerField(handle, "execution_generation") !== original.execution_generation
              ) {
                return yield* protocolError("Hermes restart interrupted a different authority");
              }
            }
          }
          // A lost cleanup response is resolved by an exact receipt read before any bounded retry.
          receipt = yield* readReceipt(
            yield* request("prompt.receipt", {
              session_id: turn.sessionId,
              admission_id: original.admission_id,
              include_result: true,
            }),
          );
        }
        if (receipt.status !== "terminal" || !receipt.outcome) {
          return yield* protocolError(
            `${restartRecoveryPending}: cleanup did not reach a terminal receipt`,
          );
        }
        const terminal = yield* Effect.try({
          try: () =>
            store.migrateTextTurnAuthority(
              {
                threadId: turn.input.threadId,
                inputId: turn.inputId,
                profileId: stored.profileId,
                principalId: stored.principalId,
                instanceId: runtime.instance_id,
                authorityEpoch: runtime.authority_epoch,
              },
              receipt,
            ),
          catch: (cause) => protocolError("Could not durably settle the Hermes restart", cause),
        });
        turn.receipt = terminal;
        ordinaryLostTurns.delete(turn.inputId);
        if (alreadyTerminal || terminal.outcome !== "interrupted") {
          turn.completionStatus = null;
          turn.finalText = null;
          yield* finalize(turn, request);
          return;
        }
        const reason =
          oldPrompts.length > 0
            ? "Hermes restarted while waiting for approval or clarification."
            : "Hermes restarted before this turn completed.";
        const message =
          `gateway_restart_lost_prompt: ${reason} ` +
          "The old admission was interrupted and the original prompt was not re-executed.";
        yield* emitFailure(turn, message, "reusable", message);
      });

      const reconcileDiscardedBeforeReservation = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        stored: HermesThreadRecord,
        reservationCause: unknown,
      ) {
        const failure = (cause: unknown) =>
          protocolError("Could not reserve exact Hermes turn input", cause);
        const candidates = yield* Effect.try({
          try: () =>
            store.getUnresolvedTextTurns({
              threadId: turnInput.threadId,
              sessionId: stored.sessionId!,
              profileId: stored.profileId,
              principalId: stored.principalId,
            }),
          catch: failure,
        });
        const original =
          candidates.length === 1 && ordinaryLostTurns.has(candidates[0]!.inputId)
            ? candidates[0]!.receipt
            : null;
        if (
          !original ||
          original.status !== "started" ||
          original.execution_generation === null ||
          original.authority_epoch !== stored.authorityEpoch ||
          original.ref.session_id !== stored.sessionId ||
          original.ref.profile_id !== stored.profileId
        ) {
          return yield* failure(reservationCause);
        }

        const connection = yield* gateway.connection.pipe(Effect.mapError(failure));
        const request = requestOn(connection);
        const runtime = yield* describe(request).pipe(Effect.mapError(failure));
        if (
          runtime.profile_id !== stored.profileId ||
          principalId !== stored.principalId ||
          runtime.authority_epoch <= stored.authorityEpoch ||
          runtime.instance_id === stored.instanceId
        ) {
          return yield* failure(reservationCause);
        }
        const resumed = yield* request("session.resume", {
          session_id: stored.sessionId,
          omit_messages: true,
        }).pipe(Effect.mapError(failure));
        const resumedId = yield* Effect.try({
          try: () => resumedSessionIdOf(resumed, runtime.authority_epoch),
          catch: failure,
        });
        const pending = recordField(resumed, "pending");
        if (
          resumedId !== stored.sessionId ||
          integerField(resumed, "execution_generation") !== original.execution_generation ||
          !Array.isArray(pending) ||
          pending.length !== 0
        ) {
          return yield* failure(new Error("Hermes discard resume is not exact and quiescent"));
        }
        const raw = yield* request("prompt.receipt", {
          session_id: stored.sessionId,
          admission_id: original.admission_id,
          include_result: true,
        }).pipe(Effect.mapError(failure));
        const receipt = yield* Effect.try({
          try: () => {
            const decoded = decodeTextTurnReceipt(raw);
            if (
              decoded.status !== "terminal" ||
              !decoded.outcome ||
              decoded.ref.session_id !== original.ref.session_id ||
              decoded.ref.profile_id !== original.ref.profile_id ||
              decoded.authority_epoch !== original.authority_epoch ||
              decoded.admission_id !== original.admission_id ||
              decoded.execution_generation !== original.execution_generation ||
              decoded.sequence !== original.sequence
            ) {
              throw new Error("Hermes discard receipt does not match the original admission");
            }
            return decoded;
          },
          catch: failure,
        });
        return yield* Effect.try({
          try: () => {
            store.migrateTextTurnAuthority(
              {
                threadId: turnInput.threadId,
                inputId: candidates[0]!.inputId,
                profileId: stored.profileId,
                principalId: stored.principalId,
                instanceId: runtime.instance_id,
                authorityEpoch: runtime.authority_epoch,
              },
              receipt,
            );
            ordinaryLostTurns.delete(candidates[0]!.inputId);
            const migrated = store.get(turnInput.threadId);
            if (!migrated) throw new Error("Hermes discarded turn migration lost the session");
            return migrated;
          },
          catch: failure,
        });
      });
      const readHermesImage = Effect.fnUntraced(function* (
        attachment?: ProviderAdapter.ProviderAdapterV2TurnMessage["attachments"][number],
      ) {
        if (!attachment) return undefined;
        if (!isProviderNativeImageAttachment(attachment)) {
          return yield* protocolError("Hermes image MIME is not supported");
        }
        const path = input.resolveAttachmentPath?.(attachment);
        if (!path) return yield* protocolError("Hermes image attachment is missing");
        return yield* Effect.tryPromise({
          try: async () => {
            if (attachment.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
              throw new Error("Hermes image exceeds the 10 MiB T3 limit");
            }
            const file = await NodeFS.promises.open(path, "r");
            try {
              const stat = await file.stat();
              if (
                !stat.isFile() ||
                stat.size < 1 ||
                stat.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES ||
                stat.size !== attachment.sizeBytes
              ) {
                throw new Error("Hermes image size does not match its declared size");
              }
              const buffer = Buffer.alloc(stat.size + 1);
              const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
              if (bytesRead !== stat.size) {
                throw new Error("Hermes image changed or exceeds its declared size");
              }
              // Hermes decodes the bytes; T3 validates the declared and returned MIME exactly.
              return {
                attachmentId: attachment.id,
                filename: NodePath.basename(path),
                mime: attachment.mimeType as HermesPendingImage["mime"],
                contentBase64: buffer.subarray(0, bytesRead).toString("base64"),
              };
            } finally {
              await file.close();
            }
          },
          catch: (cause) => protocolError("Could not read the bounded Hermes image", cause),
        });
      });

      const attachImage = Effect.fnUntraced(function* (
        request: ReturnType<typeof requestOn>,
        sessionId: string,
        inputId: string,
      ) {
        const state = yield* Effect.try({
          try: () => ({
            pending: store.getPendingImage(inputId),
            attached: store.getAttachedImage(inputId),
          }),
          catch: (cause) => protocolError("Could not read the durable Hermes image", cause),
        });
        if (state.attached) return;
        const pending = state.pending;
        if (!pending) return;
        if (pending.uploadClaimed) {
          return yield* protocolError(
            "Hermes image attach has an ambiguous prior result; refusing a duplicate upload",
          );
        }
        const contentBase64 = pending.contentBase64;
        const bytes = Buffer.from(contentBase64, "base64");
        if (bytes.length < 1 || bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          return yield* protocolError("Hermes durable image bytes are invalid");
        }
        yield* Effect.try({
          try: () => store.claimPendingImage(inputId),
          catch: (cause) => protocolError("Could not claim the durable Hermes image upload", cause),
        });
        const raw = yield* request("image.attach_bytes", {
          session_id: sessionId,
          content_base64: contentBase64,
          filename: pending.filename,
        });
        const result = yield* Effect.try({
          try: () => decodeImageAttachResult(raw),
          catch: (cause) =>
            protocolError("Hermes returned an invalid image.attach_bytes response", cause),
        });
        if (result.bytes !== bytes.length) {
          return yield* protocolError("Hermes image attachment byte count does not match");
        }
        if (result.mime !== pending.mime) {
          return yield* protocolError("Hermes image attachment MIME does not match");
        }
        yield* Effect.try({
          try: () =>
            store.recordAttachedImage({
              inputId,
              attachmentId: pending.attachmentId,
              path: result.path,
              mime: result.mime,
              bytes: bytes.length,
            }),
          catch: (cause) => protocolError("Could not journal the Hermes image identity", cause),
        });
      });

      const promptSubmission = Effect.fnUntraced(function* (turn: ActiveHermesTurn) {
        const attached = yield* Effect.try({
          try: () => store.getAttachedImage(turn.inputId),
          catch: (cause) => protocolError("Could not read the durable Hermes image", cause),
        });
        return attached
          ? {
              ...turn.submission,
              attachments: [{ path: attached.path, mime: attached.mime }],
            }
          : turn.submission;
      });

      const recordReceipt = Effect.fnUntraced(function* (turn: ActiveHermesTurn, raw: unknown) {
        const decoded = yield* Effect.try({
          try: () => decodeTextTurnReceipt(raw),
          catch: (cause) =>
            protocolError("Hermes returned an invalid or foreign turn receipt", cause),
        });
        if (
          (turn.observedAdmissionId && decoded.admission_id !== turn.observedAdmissionId) ||
          (turn.observedGeneration != null &&
            decoded.execution_generation !== turn.observedGeneration)
        ) {
          return yield* protocolError("Hermes receipt does not match the replayed turn");
        }
        const receipt = yield* Effect.try({
          try: () => store.recordTextTurnReceipt(turn.inputId, decoded),
          catch: (cause) =>
            protocolError("Hermes returned an invalid or foreign turn receipt", cause),
        });
        turn.receipt = receipt;
        return receipt;
      });

      const readRecoveryTerminalReceipt = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        request: ReturnType<typeof requestOn>,
        original: ReturnType<typeof decodeTextTurnReceipt>,
      ) {
        const raw = yield* request("prompt.receipt", {
          session_id: turn.sessionId,
          admission_id: original.admission_id,
          include_result: true,
        });
        const receipt = yield* Effect.try({
          try: () => decodeTextTurnReceipt(raw),
          catch: (cause) => protocolError("Invalid Hermes recovery receipt", cause),
        });
        if (
          receipt.status !== "terminal" ||
          !["completed", "interrupted", "cancelled", "failed"].includes(receipt.outcome ?? "")
        ) {
          return yield* protocolError(
            "Hermes recovery did not return a supported terminal receipt",
          );
        }
        if (
          receipt.ref.session_id !== original.ref.session_id ||
          receipt.ref.profile_id !== original.ref.profile_id ||
          receipt.authority_epoch !== original.authority_epoch ||
          receipt.admission_id !== original.admission_id ||
          receipt.execution_generation !== original.execution_generation ||
          receipt.sequence !== original.sequence ||
          (original.status === "terminal" && receipt.outcome !== original.outcome)
        ) {
          return yield* protocolError(
            "Hermes recovery receipt does not match the original admission",
          );
        }
        return receipt;
      });
      const recoverAbsentPendingReceipt = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        resumed: unknown,
        request: ReturnType<typeof requestOn>,
      ) {
        const original = turn.receipt;
        if (turn.completionStatus !== null || original?.status !== "started") return;
        const pending = recordField(resumed, "pending");
        if (
          !Array.isArray(pending) ||
          pending.some((entry) =>
            matchesPendingIdentity(entry, turn.inputId, original.admission_id),
          )
        ) {
          return;
        }
        const receipt = yield* readRecoveryTerminalReceipt(turn, request, original);
        yield* recordReceipt(turn, receipt);
      });

      const promoteStartedReceipt = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        request: ReturnType<typeof requestOn>,
      ) {
        const queued = turn.receipt;
        if (queued?.status !== "queued" || turn.observedGeneration == null) return;
        const raw = yield* request("prompt.receipt", {
          session_id: turn.sessionId,
          admission_id: queued.admission_id,
          include_result: true,
        });
        const receipt = yield* Effect.try({
          try: () => decodeTextTurnReceipt(raw),
          catch: (cause) => protocolError("Invalid Hermes started receipt", cause),
        });
        if (
          (receipt.status !== "started" && receipt.status !== "terminal") ||
          receipt.execution_generation !== turn.observedGeneration
        ) {
          return yield* protocolError("Hermes started receipt does not match the execution event");
        }
        yield* recordReceipt(turn, receipt);
      });

      const emitFailure = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        cause: unknown,
        threadDisposition: "reusable" | "broken",
        message?: string,
      ) {
        if (turn.settled) return;
        yield* expirePrompts(turn);
        const occurredAt = yield* DateTime.now;
        const failure: OrchestrationV2ProviderFailure = makeProviderFailure({
          cause,
          class: "provider_error",
          message,
          retryable: false,
        });
        const failureItemOrdinal = turn.input.providerTurnOrdinal * 100 + 2;
        yield* emit({
          type: "provider_turn.updated",
          driver: HERMES_PROVIDER,
          threadId: turn.input.threadId,
          providerTurn: currentProviderTurn(turn, "failed", occurredAt),
        });
        yield* emit({
          type: "provider_thread.updated",
          driver: HERMES_PROVIDER,
          providerThread: { ...turn.input.providerThread, status: "idle", updatedAt: occurredAt },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: HERMES_PROVIDER,
          turnItem: makeProviderFailureTurnItem({
            driver: HERMES_PROVIDER,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: turn.input.rootNodeId,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            itemOrdinal: failureItemOrdinal,
            failure,
            occurredAt,
          }),
        });
        turn.settled = true;
        yield* emit({
          type: "turn.terminal",
          driver: HERMES_PROVIDER,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.input.runOrdinal,
          failureItemOrdinal,
          status: "failed",
          failure,
          threadDisposition,
        });
      });

      const finalize = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        request: ReturnType<typeof requestOn>,
      ) {
        if (turn.settled) return;
        yield* expirePrompts(turn);
        const receipt =
          turn.receipt?.status === "terminal"
            ? turn.receipt
            : yield* recordReceipt(
                turn,
                yield* request("prompt.receipt", {
                  session_id: turn.sessionId,
                  admission_id: turn.receipt!.admission_id,
                  include_result: true,
                }),
              );
        if (receipt.status !== "terminal" || !receipt.outcome) {
          return yield* protocolError("Hermes message.complete has no terminal receipt");
        }
        yield* Effect.try({
          try: () => store.clearPendingImage(turn.inputId),
          catch: (cause) => protocolError("Could not clear the durable Hermes image", cause),
        });
        const completionStatus =
          receipt.outcome === "completed"
            ? "complete"
            : receipt.outcome === "interrupted"
              ? "interrupted"
              : receipt.outcome === "cancelled"
                ? "queued-cancelled"
                : "error";
        if (turn.completionStatus && completionStatus !== turn.completionStatus) {
          return yield* protocolError(
            "Hermes message.complete status does not match the terminal receipt",
          );
        }
        const finalText = turn.finalText ?? stringField(receipt.result, "final_response");
        if (finalText || turn.text) {
          yield* emitAssistant(turn, finalText ?? turn.text, false);
        }
        const completedAt = yield* DateTime.now;
        if (receipt.outcome === "failed") {
          yield* emitFailure(
            turn,
            stringField(receipt.result, "error") ?? "Hermes turn failed",
            "reusable",
          );
          return;
        }
        const status =
          receipt.outcome === "completed"
            ? "completed"
            : receipt.outcome === "cancelled" || receipt.outcome === "interrupted"
              ? "cancelled"
              : null;
        if (!status)
          return yield* protocolError(`Unsupported Hermes turn outcome: ${receipt.outcome}`);
        yield* emit({
          type: "provider_turn.updated",
          driver: HERMES_PROVIDER,
          threadId: turn.input.threadId,
          providerTurn: currentProviderTurn(turn, status, completedAt),
        });
        yield* emit({
          type: "provider_thread.updated",
          driver: HERMES_PROVIDER,
          providerThread: { ...turn.input.providerThread, status: "idle", updatedAt: completedAt },
        });
        yield* emit({
          type: "turn.terminal",
          driver: HERMES_PROVIDER,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.input.runOrdinal,
          status,
          failure: null,
          threadDisposition: "reusable",
        });
        turn.settled = true;
      });

      const monitor = Effect.fnUntraced(function* (
        turn: ActiveHermesTurn,
        stored: HermesThreadRecord,
        initial: {
          request: ReturnType<typeof requestOn>;
          events: Stream.Stream<unknown, HermesGatewayError>;
        },
      ) {
        let attached = initial;
        let recovered = false;
        while (!turn.settled) {
          if (turn.receipt?.status === "terminal" || turn.completionStatus !== null) {
            yield* finalize(turn, attached.request);
            break;
          }
          const result = yield* Stream.runForEachWhile(attached.events, (frame) =>
            Effect.gen(function* () {
              yield* projectFrame(turn, frame, attached.request);
              if (turn.completionStatus !== null) {
                yield* finalize(turn, attached.request);
                return false;
              }
              return true;
            }),
          ).pipe(Effect.result);
          if (turn.settled) break;
          if (result._tag === "Failure") {
            if (result.failure._tag !== "HermesGatewayError") return yield* result.failure;
            if (recovered)
              return yield* protocolError(
                "Hermes stream disconnected again after replay",
                result.failure,
              );
            recovered = true;
            attached = yield* recover(turn, stored);
          } else {
            return yield* protocolError("Hermes event stream ended before the turn settled");
          }
        }
      });
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: input.instanceId,
        driver: HERMES_PROVIDER,
        providerSessionId: openInput.providerSessionId,
        providerSession: {
          id: openInput.providerSessionId,
          driver: HERMES_PROVIDER,
          providerInstanceId: input.instanceId,
          status: "ready",
          // Local orchestration cwd; native Hermes sessions use the verified remote profile home.
          cwd,
          model: openInput.modelSelection.model,
          capabilities: HermesProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        canResumeAfterRestart: textTurnsEnabled,
        events: Stream.fromQueue(output),
        ensureThread: Effect.fn("HermesAdapterV2.ensureThread")(function* (
          ensureInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
        ) {
          const threadId = ensureInput.existingProviderThread?.appThreadId ?? ensureInput.threadId;
          const providerThreadId =
            ensureInput.existingProviderThread?.id ??
            ProviderThreadId.make(`provider-thread:${threadId}`);
          const request = yield* connectRequest;
          const runtime = yield* describe(request);
          if (runtime.profile_id !== profileId) {
            return yield* protocolError("Hermes profile does not match provider configuration");
          }
          const identity = {
            threadId,
            profileId: runtime.profile_id,
            instanceId: runtime.instance_id,
            principalId,
            authorityEpoch: runtime.authority_epoch,
          };
          const reservation = yield* Effect.try({
            try: () =>
              ensureInput.forceNewNativeThread
                ? store.reserveFresh(identity)
                : store.reserve(identity),
            catch: (cause) =>
              protocolError(
                ensureInput.forceNewNativeThread
                  ? "Could not reserve a replacement Hermes session"
                  : "Hermes session identity does not match durable state",
                cause,
              ),
          });
          const adoptedSessionId = ensureInput.forceNewNativeThread
            ? null
            : ensureInput.existingProviderThread?.nativeThreadRef?.nativeId;
          if (
            adoptedSessionId &&
            reservation.sessionId &&
            adoptedSessionId !== reservation.sessionId
          ) {
            return yield* protocolError(
              "Adopted Hermes native session does not match durable state",
            );
          }
          if (adoptedSessionId && !reservation.sessionId) {
            const resumed = yield* request("session.resume", { session_id: adoptedSessionId });
            const resumedId = yield* Effect.try({
              try: () => resumedSessionIdOf(resumed, runtime.authority_epoch),
              catch: (cause) =>
                protocolError("Invalid adopted Hermes session.resume response", cause),
            });
            if (resumedId !== adoptedSessionId) {
              return yield* protocolError("Hermes adopted a different native session");
            }
            yield* Effect.try({
              try: () => store.bind(threadId, reservation.requestId, adoptedSessionId),
              catch: (cause) => protocolError("Could not persist adopted Hermes session", cause),
            });
          }
          let sessionId = ensureInput.forceNewNativeThread
            ? null
            : (reservation.sessionId ?? adoptedSessionId);
          if (!sessionId) {
            const created = yield* request("session.create", {
              request_id: reservation.requestId,
              source: "cli",
              cwd: runtime.profile_id,
              toolsets: [],
            });
            const createdSessionId = yield* Effect.try({
              try: () => sessionIdOf(created),
              catch: (cause) => protocolError("Invalid Hermes session.create response", cause),
            });
            yield* Effect.try({
              try: () =>
                ensureInput.forceNewNativeThread
                  ? store.bindFresh(
                      threadId,
                      reservation.requestId,
                      reservation.sessionId,
                      createdSessionId,
                    )
                  : store.bind(threadId, reservation.requestId, createdSessionId),
              catch: (cause) => protocolError("Could not persist Hermes session mapping", cause),
            });
            sessionId = createdSessionId;
          }
          if (!sessionId) {
            return yield* protocolError("Hermes returned no durable session mapping");
          }
          const timestamp = yield* DateTime.now;
          return {
            id: providerThreadId,
            driver: HERMES_PROVIDER,
            providerInstanceId: input.instanceId,
            providerSessionId: openInput.providerSessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver: HERMES_PROVIDER, nativeId: sessionId, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          } satisfies OrchestrationV2ProviderThread;
        }),
        resumeThread: Effect.fn("HermesAdapterV2.resumeThread")(function* (resumeInput: {
          readonly providerThread: OrchestrationV2ProviderThread;
          readonly threadId?: Parameters<
            ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"]
          >[0]["threadId"];
        }) {
          const { providerThread, threadId } = resumeInput;
          const appThreadId = threadId ?? providerThread.appThreadId;
          if (!appThreadId || !providerThread.nativeThreadRef) {
            return yield* protocolError(
              "Hermes resume requires an app thread and exact native session ID",
            );
          }
          const stored = yield* Effect.try({
            try: () => store.get(appThreadId),
            catch: (cause) => protocolError("Could not read durable Hermes session mapping", cause),
          });
          if (!stored?.sessionId || stored.sessionId !== providerThread.nativeThreadRef.nativeId) {
            return yield* protocolError(
              "Hermes session mapping does not match the requested thread",
            );
          }
          const request = yield* connectRequest;
          const runtime = yield* describe(request);
          if (
            runtime.profile_id !== stored.profileId ||
            runtime.instance_id !== stored.instanceId ||
            runtime.authority_epoch !== stored.authorityEpoch ||
            principalId !== stored.principalId
          ) {
            return yield* protocolError(
              "Hermes runtime identity changed; recovery must fence this session",
            );
          }
          const resumed = yield* request("session.resume", { session_id: stored.sessionId });
          const resumedId = yield* Effect.try({
            try: () => resumedSessionIdOf(resumed, runtime.authority_epoch),
            catch: (cause) => protocolError("Invalid Hermes session.resume response", cause),
          });
          if (resumedId !== stored.sessionId) {
            return yield* protocolError("Hermes resumed a different session");
          }
          return providerThread;
        }),
        startTurn: Effect.fn("HermesAdapterV2.startTurn")(function* (turnInput) {
          if (!textTurnsEnabled) {
            return yield* protocolError(
              "Hermes turns are unavailable until recovery and controls are ready",
            );
          }
          if (!turnInput?.providerThread || !turnInput.message || !turnInput.threadId) {
            return yield* protocolError("Hermes turn requires an exact thread and text input");
          }
          const recovering = turnInput.resume === true;
          if (!recovering && !isProfileSelection(turnInput.modelSelection)) {
            return yield* protocolError(customSelectionUnavailable);
          }
          const appThreadId = turnInput.providerThread.appThreadId ?? turnInput.threadId;
          const sessionId = turnInput.providerThread.nativeThreadRef?.nativeId;
          if (appThreadId !== turnInput.threadId || !sessionId) {
            return yield* protocolError("Hermes turn does not match the canonical native session");
          }
          if (
            turnInput.message.attachments.length > 1 ||
            (turnInput.message.attachments.length === 1 &&
              !isProviderNativeImageAttachment(turnInput.message.attachments[0]!))
          ) {
            return yield* protocolError("Hermes G3 accepts one image attachment per turn");
          }
          const active = activeTurns.get(turnInput.threadId);
          if (active && !active.settled) {
            return yield* protocolError("Hermes thread already has an active turn");
          }
          const storedRecord = yield* Effect.try({
            try: () => store.get(appThreadId),
            catch: (cause) => protocolError("Could not read durable Hermes session mapping", cause),
          });
          if (
            !storedRecord?.sessionId ||
            storedRecord.sessionId !== sessionId ||
            storedRecord.principalId !== principalId ||
            storedRecord.profileId !== profileId
          ) {
            return yield* protocolError("Hermes turn does not match the durable pinned identity");
          }
          let stored = storedRecord;
          const original = recovering
            ? yield* Effect.try({
                try: () =>
                  store.getTextTurnSubmission({
                    threadId: appThreadId,
                    runId: turnInput.runId,
                    attemptId: turnInput.attemptId,
                    sessionId,
                    profileId: stored.profileId,
                    instanceId: stored.instanceId,
                    principalId: stored.principalId,
                    authorityEpoch: stored.authorityEpoch,
                  }),
                catch: (cause) => protocolError("Could not read the original Hermes turn", cause),
              })
            : null;
          const image = recovering
            ? undefined
            : yield* readHermesImage(turnInput.message.attachments[0]);
          if (recovering && !original) {
            return yield* protocolError("Hermes resume does not match the original run");
          }
          const reservation = Effect.try({
            try: () =>
              store.reserveTextTurn({
                threadId: appThreadId,
                profileId: stored.profileId,
                instanceId: stored.instanceId,
                principalId: stored.principalId,
                authorityEpoch: stored.authorityEpoch,
                sessionId,
                runId: turnInput.runId,
                attemptId: turnInput.attemptId,
                text: turnInput.message.text,
                ...(image ? { image } : {}),
              }),
            catch: (cause) => protocolError("Could not reserve exact Hermes turn input", cause),
          });
          const submission = recovering
            ? original!
            : yield* reservation.pipe(
                Effect.catch((cause) =>
                  reconcileDiscardedBeforeReservation(turnInput, stored, cause).pipe(
                    Effect.flatMap((migrated) => {
                      stored = migrated;
                      return reservation;
                    }),
                  ),
                ),
              );
          const journaled = yield* Effect.try({
            try: () => store.getTextTurnReceipt(submission.input_id),
            catch: (cause) => protocolError("Could not read journaled Hermes receipt", cause),
          });
          if (!recovering && journaled?.status === "terminal") return;
          if (
            recovering &&
            journaled !== null &&
            (journaled.status === "unknown" ||
              (journaled.status === "started" && journaled.execution_generation === null) ||
              journaled.authority_epoch !== stored.authorityEpoch ||
              journaled.ref.session_id !== sessionId ||
              journaled.ref.profile_id !== stored.profileId)
          ) {
            return yield* protocolError("Hermes resume requires the exact recoverable receipt");
          }
          if (journaled && !recovering) {
            return yield* protocolError(
              "Unfinished Hermes turn recovery requires the existing run",
            );
          }

          const startedAt = yield* DateTime.now;
          const nativeTurnId = submission.input_id;
          const providerTurn: OrchestrationV2ProviderTurn = {
            id: IdAllocator.derive.providerTurn({ driver: HERMES_PROVIDER, nativeTurnId }),
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: { driver: HERMES_PROVIDER, nativeId: nativeTurnId, strength: "weak" },
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          };
          const turn: ActiveHermesTurn = {
            input: turnInput,
            sessionId,
            inputId: submission.input_id,
            submission,
            startedAt,
            providerTurn,
            receipt: journaled,
            observedAdmissionId: null,
            observedGeneration: null,
            cursor: null,
            text: "",
            finalText: null,
            completionStatus: null,
            admitted: false,
            settled: false,
            request: null,
            prompts: new Map(),
            resumedPrompts: null,
            replaying: false,
            authorityEpoch: stored.authorityEpoch,
            instanceId: stored.instanceId,
          };
          activeTurns.set(turnInput.threadId, turn);
          const admitted = yield* Deferred.make<void, ProviderAdapter.ProviderAdapterV2Error>();
          const program = Effect.scoped(
            Effect.gen(function* () {
              const connection = yield* gateway.connection.pipe(
                Effect.mapError((cause) =>
                  protocolError("Could not acquire canonical Hermes connection", cause),
                ),
              );
              const runtime = yield* describe(requestOn(connection));
              if (
                runtime.profile_id !== stored.profileId ||
                runtime.instance_id !== stored.instanceId ||
                runtime.authority_epoch !== stored.authorityEpoch
              ) {
                return yield* protocolError(
                  recovering
                    ? "Hermes resume requires the same Gateway authority"
                    : "Hermes turn start requires the same Gateway authority",
                );
              }
              let attached = yield* attach(turn, connection, stored);
              const promptEvents: ProviderAdapter.ProviderAdapterV2Event[] = [];
              const bufferPromptEvent: typeof emit = (event) =>
                Effect.sync(() => {
                  promptEvents.push(event);
                });
              if (recovering) {
                yield* recoverAbsentPendingReceipt(turn, attached.resumed, attached.request);
                if (journaled?.status === "queued") {
                  const raw = yield* attached.request("prompt.receipt", {
                    session_id: turn.sessionId,
                    admission_id: journaled.admission_id,
                    include_result: true,
                  });
                  const receipt = yield* recordReceipt(turn, raw);
                  if (receipt.status === "unknown") {
                    return yield* protocolError(
                      "Hermes queued admission no longer has a live execution",
                    );
                  }
                } else if (journaled?.status === "terminal" && journaled.result === undefined) {
                  const receipt = yield* readRecoveryTerminalReceipt(
                    turn,
                    attached.request,
                    journaled,
                  );
                  yield* recordReceipt(turn, receipt);
                }
                if (
                  journaled
                    ? turn.receipt?.status === "started"
                    : yield* recoverJournalOnlyTurn(
                        turn,
                        stored,
                        attached.resumed,
                        attached.request,
                      )
                ) {
                  yield* reconcileResumedPrompts(turn, attached.resumed, true, bufferPromptEvent);
                }
              } else {
                yield* attachImage(attached.request, turn.sessionId, turn.inputId);
                const submitted = yield* Effect.result(
                  attached.request("prompt.submit", yield* promptSubmission(turn)),
                );
                if (submitted._tag === "Failure") {
                  const cause = submitted.failure.cause;
                  if (
                    !isHermesGatewayError(cause) ||
                    !["socket", "decode", "prompt.submit"].includes(cause.operation)
                  ) {
                    return yield* submitted.failure;
                  }
                  attached = yield* recover(turn, stored);
                  yield* recordReceipt(
                    turn,
                    yield* attached.request("prompt.submit", yield* promptSubmission(turn)),
                  );
                } else {
                  yield* recordReceipt(turn, submitted.success);
                }
                if (turn.resumedPrompts) {
                  const resumed = yield* attached.request("session.resume", {
                    session_id: turn.sessionId,
                    omit_messages: true,
                  });
                  yield* reconcileResumedPrompts(turn, resumed);
                }
              }
              turn.request = attached.request;
              turn.admitted = true;
              yield* Deferred.succeed(admitted, void 0);
              yield* emitRunning(turn);
              // Publish only validated prompts, after run routing knows their owning turn.
              for (const event of promptEvents) yield* emit(event);
              if (turn.completionStatus === null && turn.text) {
                yield* emitAssistant(turn, turn.text, true);
              }
              yield* monitor(turn, stored, attached);
            }),
          );
          yield* program.pipe(
            Effect.catch((cause) =>
              turn.admitted
                ? emitFailure(
                    turn,
                    cause,
                    "broken",
                    cause._tag === "ProviderAdapterProtocolError" &&
                      cause.detail.startsWith(`${restartRecoveryPending}:`)
                      ? cause.detail
                      : undefined,
                  )
                : Deferred.fail(admitted, cause).pipe(Effect.asVoid),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (activeTurns.get(turnInput.threadId) === turn) {
                  activeTurns.delete(turnInput.threadId);
                }
              }),
            ),
            Effect.forkIn(scope),
          );
          yield* Deferred.await(admitted);
        }),
        ...(textTurnsEnabled
          ? {
              resumeTurn: (resumeInput: ProviderAdapter.ProviderAdapterV2ResumeTurnInput) =>
                runtime.startTurn(ProviderAdapter.resumeTurnInput(resumeInput)),
            }
          : {}),
        steerTurn: () => Effect.fail(protocolError("Hermes does not support active turn steering")),
        interruptTurn: Effect.fn("HermesAdapterV2.interruptTurn")(function* ({
          providerThread,
          providerTurnId,
          requestRuntimeRestart,
        }) {
          if (!textTurnsEnabled || requestRuntimeRestart) {
            return yield* protocolError("Hermes interruption or runtime restart is unavailable");
          }
          const threadId = providerThread.appThreadId;
          const turn = threadId ? activeTurns.get(threadId) : undefined;
          if (
            !turn?.admitted ||
            turn.settled ||
            turn.completionStatus !== null ||
            turn.providerTurn.id !== providerTurnId ||
            turn.input.providerThread.id !== providerThread.id ||
            providerThread.nativeThreadRef?.nativeId !== turn.sessionId
          ) {
            return yield* protocolError("Hermes interrupt does not match an active turn");
          }
          const { request, receipt } = turn;
          if (!request || receipt?.status !== "started" || receipt.execution_generation === null) {
            return yield* protocolError("Hermes interrupt requires a verified started receipt");
          }
          // A racing completion is safe: Hermes rejects Stop against a later generation.
          const handle = yield* request("session.interrupt", {
            session_id: turn.sessionId,
            execution_generation: receipt.execution_generation,
          });
          const ref = recordField(handle, "ref");
          if (
            stringField(ref, "session_id") !== turn.sessionId ||
            stringField(ref, "profile_id") !== receipt.ref.profile_id ||
            stringField(handle, "instance_id") !== turn.instanceId ||
            integerField(handle, "authority_epoch") !== turn.authorityEpoch ||
            integerField(handle, "execution_generation") !== receipt.execution_generation
          ) {
            return yield* protocolError(
              "Hermes interrupt acknowledged a different runtime or session",
            );
          }
          // The handle acknowledges Stop. Only the monitor can project terminal settlement.
        }),
        respondToRuntimeRequest: Effect.fn("HermesAdapterV2.respondToRuntimeRequest")(function* (
          responseInput: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput,
        ) {
          let prompt: ActiveHermesPrompt | undefined;
          for (const turn of activeTurns.values()) {
            for (const candidate of turn.prompts.values()) {
              if (candidate.runtimeRequest.id === responseInput.requestId) prompt = candidate;
            }
          }
          prompt ??= settledPrompts.get(responseInput.requestId);
          if (!prompt) return yield* protocolError("Hermes runtime request is unknown");
          if (prompt.runtimeRequest.status === "resolved") return;
          if (
            prompt.runtimeRequest.status !== "pending" ||
            prompt.runtimeRequest.responseCapability.type !== "live" ||
            prompt.responding
          ) {
            return yield* protocolError("Hermes runtime request is no longer answerable");
          }
          const { turn } = prompt;
          const receipt = turn.receipt;
          if (
            turn.settled ||
            !turn.request ||
            !turn.admitted ||
            receipt?.status !== "started" ||
            receipt.execution_generation === null
          ) {
            return yield* protocolError("Hermes response requires a verified started turn");
          }
          let response: Record<string, unknown>;
          let decision: "accept" | "acceptForSession" | "acceptAlways" | "decline" | undefined;
          let answers: Record<string, unknown> | undefined;
          if (prompt.kind === "approval") {
            if (!("decision" in responseInput)) {
              return yield* protocolError("Hermes approval requires a security decision");
            }
            if (responseInput.decision === "cancel") {
              return yield* protocolError("Hermes cancellation requires turn interruption");
            }
            decision = responseInput.decision;
            const choice =
              decision === "accept"
                ? "once"
                : decision === "acceptForSession"
                  ? "session"
                  : decision === "acceptAlways"
                    ? "always"
                    : decision === "decline"
                      ? "deny"
                      : null;
            const offered =
              prompt.item.type === "approval_request" &&
              prompt.item.options?.some((option) => option.decision === decision);
            if (!choice || !offered) {
              return yield* protocolError("Hermes approval decision was not offered");
            }
            response = { choice };
          } else {
            if (!("answers" in responseInput)) {
              return yield* protocolError("Hermes clarification requires user input");
            }
            answers = responseInput.answers;
            const answer = answers[prompt.promptId];
            if (
              typeof answer !== "string" &&
              !(Array.isArray(answer) && answer.every((value) => typeof value === "string"))
            ) {
              return yield* protocolError("Hermes clarification requires an exact answer");
            }
            response = { answer: Array.isArray(answer) ? answer.join(", ") : answer };
          }
          prompt.responding = true;
          const raw = yield* turn
            .request(`${prompt.kind}.respond`, {
              session_id: turn.sessionId,
              execution_generation: receipt.execution_generation,
              prompt_id: prompt.promptId,
              ...response,
            })
            .pipe(Effect.catch((cause) => responseUncertain(prompt, cause)));
          const status = stringField(raw, "status");
          if (
            (status !== "resolved" && status !== "already_resolved") ||
            stringField(raw, "prompt_id") !== prompt.promptId
          ) {
            return yield* responseUncertain(
              prompt,
              new Error("Hermes response settled a different prompt"),
            );
          }
          // already_resolved confirms closure, not that Hermes applied this response.
          yield* updatePrompt(
            prompt,
            "resolved",
            status === "resolved" ? decision : undefined,
            status === "resolved" ? answers : undefined,
          ).pipe(Effect.catch((cause) => responseUncertain(prompt, cause)));
        }),
        readThreadSnapshot: ({ providerThread }) =>
          Effect.succeed({ providerThread, providerTurns: [], messages: [], runtimeRequests: [] }),
        rollbackThread: () => Effect.fail(protocolError("Hermes rollback is not supported")),
        forkThread: () => Effect.fail(protocolError("Hermes fork is not supported")),
      };
      return runtime;
    }),
  });
};
