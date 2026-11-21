// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off
import * as NodePath from "node:path";
import {
  ProviderDriverKind,
  ProviderThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { HermesSettings, type HermesSettings as HermesSettingsValue } from "../settings.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HermesGateway, HermesSessionStore, hermesOrigin } from "./gateway.ts";

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

export const makeHermesAdapterV2 = (input: {
  readonly instanceId: ProviderAdapter.ProviderAdapterV2["Service"]["instanceId"];
  readonly settings?: HermesSettingsValue;
}): ProviderAdapter.ProviderAdapterV2["Service"] => {
  const settings = { ...DEFAULT_SETTINGS, ...input.settings };

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: input.instanceId,
    driver: HERMES_PROVIDER,
    getCapabilities: Effect.fn("HermesAdapterV2.getCapabilities")(function () {
      return Effect.succeed(HermesProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("HermesAdapterV2.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("HermesAdapterV2.openSession")(function* (
      openInput: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const cwd = openInput.runtimePolicy.cwd;
      const endpoint = settings.endpoint;
      const configuredEndpoint = process.env.HERMES_GATEWAY_URL;
      const token = process.env.HERMES_SESSION_TOKEN;
      const stateDirectory = process.env.HERMES_STATE_DIR;
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
          "Hermes requires cwd, matching HERMES_GATEWAY_URL, session token, external HERMES_STATE_DIR, profile ID, and pinned gateway UID",
        );
      }
      const gateway = yield* HermesGateway.connect(endpoint, token, hermesOrigin(endpoint)).pipe(
        Effect.mapError((cause) =>
          protocolError("Could not open canonical Hermes listener", cause),
        ),
      );
      const request = (method: string, params: Record<string, unknown>) =>
        gateway
          .request(method, params)
          .pipe(Effect.mapError((cause) => protocolError(`Hermes ${method} failed`, cause)));
      const store = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new HermesSessionStore(NodePath.join(stateDirectory!, "sessions.sqlite3")),
          catch: (cause) => protocolError("Could not open project-local Hermes state", cause),
        }),
        (value) => Effect.sync(() => value.close()),
      );
      const describe = Effect.fnUntraced(function* () {
        const raw = yield* request("runtime.describe", {});
        return yield* Effect.try({
          try: () => asRuntimeDescription(raw),
          catch: (cause) => protocolError("Invalid Hermes runtime identity", cause),
        });
      });
      yield* describe();
      const now = yield* DateTime.now;

      return {
        instanceId: input.instanceId,
        driver: HERMES_PROVIDER,
        providerSessionId: openInput.providerSessionId,
        providerSession: {
          id: openInput.providerSessionId,
          driver: HERMES_PROVIDER,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd,
          model: openInput.modelSelection.model,
          capabilities: HermesProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        canResumeAfterRestart: true,
        events: Stream.empty,
        ensureThread: Effect.fn("HermesAdapterV2.ensureThread")(function* (
          ensureInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
        ) {
          const threadId = ensureInput.existingProviderThread?.appThreadId ?? ensureInput.threadId;
          const providerThreadId =
            ensureInput.existingProviderThread?.id ??
            ProviderThreadId.make(`provider-thread:${threadId}`);
          const runtime = yield* describe();
          if (runtime.profile_id !== profileId) {
            return yield* protocolError("Hermes profile does not match provider configuration");
          }
          const reservation = yield* Effect.try({
            try: () =>
              store.reserve({
                threadId,
                profileId: runtime.profile_id,
                instanceId: runtime.instance_id,
                principalId,
                authorityEpoch: runtime.authority_epoch,
              }),
            catch: (cause) =>
              protocolError("Hermes session identity does not match durable state", cause),
          });
          const adoptedSessionId = ensureInput.existingProviderThread?.nativeThreadRef?.nativeId;
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
              try: () => sessionIdOf(resumed),
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
          let sessionId = reservation.sessionId ?? adoptedSessionId ?? null;
          if (!sessionId) {
            const created = yield* request("session.create", {
              request_id: reservation.requestId,
              source: "cli",
              cwd,
              toolsets: [],
            });
            const createdSessionId = yield* Effect.try({
              try: () => sessionIdOf(created),
              catch: (cause) => protocolError("Invalid Hermes session.create response", cause),
            });
            yield* Effect.try({
              try: () => store.bind(threadId, reservation.requestId, createdSessionId),
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
          const runtime = yield* describe();
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
            try: () => sessionIdOf(resumed),
            catch: (cause) => protocolError("Invalid Hermes session.resume response", cause),
          });
          if (resumedId !== stored.sessionId) {
            return yield* protocolError("Hermes resumed a different session");
          }
          return providerThread;
        }),
        startTurn: () => Effect.fail(protocolError("Hermes turns are unavailable until G2")),
        steerTurn: () => Effect.fail(protocolError("Hermes turns are unavailable until G2")),
        interruptTurn: () => Effect.fail(protocolError("Hermes turns are unavailable until G2")),
        respondToRuntimeRequest: () =>
          Effect.fail(protocolError("Hermes runtime requests are unavailable until G2")),
        readThreadSnapshot: ({ providerThread }) =>
          Effect.succeed({ providerThread, providerTurns: [], messages: [], runtimeRequests: [] }),
        rollbackThread: () => Effect.fail(protocolError("Hermes rollback is not supported")),
        forkThread: () => Effect.fail(protocolError("Hermes fork is not supported")),
      };
    }),
  });
};
