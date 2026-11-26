import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T, useGT, Var } from "gt-react-native";
import { useState } from "react";
import { useEnvironmentScope } from "../../state/session";
import { ScrollView, View } from "react-native";
import Animated, { useAnimatedStyle, type DerivedValue } from "react-native-reanimated";
import { AppText } from "../../components/ui/AppText";
import {
  childThreadApprovalsAtom,
  environmentThreadDetails,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import * as Option from "effect/Option";
import { resolveConversationRequestProvider } from "@t3tools/client-runtime/state/conversation-organization";
import { isHermesProviderUnavailable } from "../../lib/modelOptions";
import { appAtomRegistry } from "../../state/atom-registry";
import { sidebarPinnedStatusEnabledAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { PendingApprovalCard } from "./PendingApprovalCard";

function ChildApproval({ entry }: { entry: ChildThreadApproval }) {
  const gt = useGT();
  const canRespond = useEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { environmentId } = entry.thread;
  const detailAtom = environmentThreadDetails.stateAtom(entry.thread);
  const statusAtom = environmentShell.statusAtom(environmentId);
  const enabled = useAtomValue(sidebarPinnedStatusEnabledAtom);
  const detail = useAtomValue(detailAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const status = useAtomValue(statusAtom);
  const providerBlocked = (
    currentDetail: typeof detail,
    currentConfigs: typeof configs,
    currentStatus: typeof status,
  ) => {
    const projection = Option.getOrNull(currentDetail.data);
    const target = resolveConversationRequestProvider(projection, entry.approval.requestId);
    if (entry.approval.responseCapability !== "live") return false;
    if (!projection || !target) return true;
    return isHermesProviderUnavailable(
      currentConfigs.get(environmentId),
      target.providerInstanceId,
      projection.thread.projectId,
      currentStatus === "live",
      target.driver,
    );
  };
  const unavailable = enabled && providerBlocked(detail, configs, status);
  return (
    <View className="mx-3.5 my-2 gap-2">
      <AppText className="font-t3-bold text-sm text-foreground">
        <T>
          Approval from <Var>{entry.title}</Var>
        </T>
      </AppText>
      {unavailable ? (
        <AppText className="text-warning-foreground">{gt("Provider unavailable")}</AppText>
      ) : null}
      <PendingApprovalCard
        canOperateThread={canRespond && !unavailable}
        approval={entry.approval}
        respondingApprovalId={responding ? entry.approval.requestId : null}
        onRespond={async (requestId, decision) => {
          if (!canRespond || responding) return;
          if (
            appAtomRegistry.get(sidebarPinnedStatusEnabledAtom) &&
            providerBlocked(
              appAtomRegistry.get(detailAtom),
              appAtomRegistry.get(environmentServerConfigsAtom),
              appAtomRegistry.get(statusAtom),
            )
          )
            return;
          setResponding(true);
          setError(null);
          const result = await respond({
            environmentId: entry.thread.environmentId,
            input: { threadId: entry.thread.threadId, requestId, decision },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            setError(
              failure instanceof Error
                ? failure.message
                : gt("Failed to submit approval decision."),
            );
          }
          setResponding(false);
          return result;
        }}
      />
      {error !== null ? (
        <AppText
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </AppText>
      ) : null}
    </View>
  );
}

export function ChildThreadApprovals({
  threadRef,
  maxHeight,
}: {
  threadRef: ScopedThreadRef | null;
  maxHeight: DerivedValue<number>;
}) {
  const approvals = useAtomValue(childThreadApprovalsAtom(threadRef));
  const heightStyle = useAnimatedStyle(() => ({ maxHeight: Math.min(320, maxHeight.value / 2) }));
  if (approvals.length === 0) return null;
  return (
    <Animated.View style={heightStyle} className="overflow-hidden">
      <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled style={{ flexShrink: 1 }}>
        {approvals.map((entry) => (
          <ChildApproval
            key={JSON.stringify([
              entry.thread.environmentId,
              entry.thread.threadId,
              entry.approval.requestId,
            ])}
            entry={entry}
          />
        ))}
      </ScrollView>
    </Animated.View>
  );
}
