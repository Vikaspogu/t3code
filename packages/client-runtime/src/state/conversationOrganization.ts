import {
  ProviderInstanceId,
  type EnvironmentId,
  type RuntimeRequestId,
  type ServerSettings,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell, ThreadStructure } from "./models.ts";
import { isThreadWorking } from "./threadInbox.ts";

export interface HermesConversationHome {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly enabled: boolean;
}

export function conversationHomeKey(environmentId: EnvironmentId, instanceId: ProviderInstanceId) {
  return JSON.stringify([environmentId, instanceId]);
}

export function attachedHermesHomes(
  environments: Iterable<readonly [EnvironmentId, Pick<ServerSettings, "providerInstances">]>,
): readonly HermesConversationHome[] {
  return Array.from(environments).flatMap(([environmentId, settings]) =>
    Object.entries(settings.providerInstances).flatMap(([instanceId, config]) =>
      config.driver === "hermes"
        ? [
            {
              environmentId,
              instanceId: ProviderInstanceId.make(instanceId),
              displayName: config.displayName ?? instanceId,
              enabled: config.enabled !== false,
            },
          ]
        : [],
    ),
  );
}

export function groupConversationsByHome<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly providerInstanceId: ProviderInstanceId;
  },
>(conversations: readonly T[], homes: readonly HermesConversationHome[]) {
  const hermes = homes.map((home) => ({ home, conversations: [] as T[] }));
  const byHome = new Map(
    hermes.map((group) => [
      conversationHomeKey(group.home.environmentId, group.home.instanceId),
      group,
    ]),
  );
  const coding: T[] = [];
  for (const conversation of conversations) {
    const group = byHome.get(
      conversationHomeKey(conversation.environmentId, conversation.providerInstanceId),
    );
    (group?.conversations ?? coding).push(conversation);
  }
  return { hermes, coding };
}

export type ConversationLens = "all" | "needs-you" | "completed" | "running";

type ConversationAttentionInput = Parameters<typeof isThreadWorking>[0] &
  Pick<EnvironmentThreadShell, "pendingGuestMessageCount">;

export function conversationActivity(thread: ConversationAttentionInput, isLive: boolean) {
  if (!isLive) return "unknown";
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingSubagentRequest != null ||
    (thread.pendingGuestMessageCount ?? 0) > 0
  ) {
    return "needs-you";
  }
  return isThreadWorking(thread) ? "running" : "idle";
}

export function resolveConversationProviderDriver(
  projection: Pick<ThreadStructure, "thread" | "providerThreads"> | null | undefined,
  instanceId: ProviderInstanceId | null | undefined,
) {
  const matching = projection?.providerThreads.filter(
    (thread) => thread.providerInstanceId === instanceId,
  );
  return (
    matching?.find((thread) => thread.id === projection?.thread.activeProviderThreadId) ??
    matching?.at(-1)
  )?.driver;
}

// Missing request or provider data is unknown; null is a known non-resumable request.
export function resolveConversationRequestProvider(
  projection:
    | Pick<ThreadStructure, "thread" | "providerThreads" | "providerSessions" | "runtimeRequests">
    | null
    | undefined,
  requestId: RuntimeRequestId,
) {
  const capability = projection?.runtimeRequests.find(
    (request) => request.id === requestId,
  )?.responseCapability;
  if (!projection || !capability) return undefined;
  if (capability.type === "not_resumable") return null;
  if (capability.type === "live") {
    return (
      projection.providerSessions.find((session) => session.id === capability.providerSessionId) ??
      projection.providerThreads.find(
        (thread) => thread.providerSessionId === capability.providerSessionId,
      )
    );
  }
  const providerInstanceId = projection.thread.providerInstanceId;
  return {
    providerInstanceId,
    driver: resolveConversationProviderDriver(projection, providerInstanceId),
  };
}
