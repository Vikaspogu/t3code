import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import { fullAccessOverrideExplanation } from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";
import { useEnvironmentScope } from "../../state/session";
import {
  childThreadApprovalsAtom,
  environmentThreadDetails,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import * as Option from "effect/Option";
import { resolveConversationRequestProvider } from "@t3tools/client-runtime/state/conversation-organization";
import { resolveProvidersForCwd } from "@t3tools/client-runtime/providerSkills";
import { getClientSettings, useClientSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { environmentShell, useEnvironmentShellStatus } from "../../state/shell";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { getProviderScopeSendBlockReason } from "../ChatView.logic";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

function ChildApproval({ entry }: { entry: ChildThreadApproval }) {
  const canRespond = useEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const gt = useGT();
  const messages = useMessages();
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { approval } = entry;
  const { environmentId } = entry.thread;
  const enabled = useClientSettings((settings) => settings.sidebarPinnedStatusEnabled);
  const settingsAtom = serverEnvironment.settingsValueAtom(environmentId);
  const providersAtom = serverEnvironment.providersValueAtom(environmentId);
  const detailAtom = environmentThreadDetails.stateAtom(entry.thread);
  const settings = useAtomValue(settingsAtom);
  const providers = useAtomValue(providersAtom);
  const detail = useAtomValue(detailAtom);
  const shell = useEnvironmentShellStatus(environmentId);
  const providerBlocked = (
    currentDetail: typeof detail,
    currentSettings: typeof settings,
    currentProviders: typeof providers,
    shellStatus: typeof shell,
  ) => {
    const projection = Option.getOrNull(currentDetail.data);
    const target = resolveConversationRequestProvider(projection, approval.requestId);
    if (approval.responseCapability !== "live") return false;
    if (!projection || !target) return true;
    return (
      getProviderScopeSendBlockReason({
        providerScope: undefined,
        draftEnvironmentId: environmentId,
        requestedProviderInstanceId: target.providerInstanceId,
        requestedProviderDriver: target.driver,
        explicitProviderInstanceId: undefined,
        resolvedProviderInstanceId: target.providerInstanceId,
        attachedHermesInstanceIds: Object.entries(currentSettings?.providerInstances ?? {})
          .filter(([, config]) => config.driver === "hermes")
          .map(([id]) => id),
        entries:
          currentSettings && currentProviders
            ? providerInstanceEntriesFor(
                resolveProvidersForCwd(currentProviders, projection.thread.worktreePath),
                currentSettings,
                projection.thread.projectId,
              )
            : [],
        shellStatus,
      }) !== null
    );
  };
  const unavailable = enabled && providerBlocked(detail, settings, providers, shell);
  return (
    <section
      aria-label={gt("Approval from {title}", { title: entry.title })}
      className="rounded-lg border border-border bg-background p-3 text-xs"
    >
      <p className="mb-2 font-medium">
        <T>
          Approval needed from <Var>{entry.title}</Var>
        </T>
      </p>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono">
        {approval.detail || approval.requestKind}
      </pre>
      {approval.appName ? <p className="mt-2 text-muted-foreground">{approval.appName}</p> : null}
      {approval.responseCapability !== "live" ? (
        <p className="mt-2 text-warning">
          <T>Provider process is gone. Interrupt or restart the child thread to respond.</T>
        </p>
      ) : null}
      {unavailable ? <p className="mt-2 text-warning">{gt("Provider unavailable")}</p> : null}
      {approval.reason ? <p className="mt-2 text-muted-foreground">{approval.reason}</p> : null}
      {approval.fullAccessOverride ? (
        <p className="mt-2 text-muted-foreground">
          {fullAccessOverrideExplanation(approval.fullAccessOverride, messages)}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <ComposerPendingApprovalActions
          presentation="inline"
          requestId={approval.requestId}
          isResponding={responding}
          canRespond={approval.responseCapability === "live"}
          disabled={!canRespond || unavailable}
          options={approval.options}
          onRespondToApproval={async (requestId, decision) => {
            if (!canRespond || responding) return;
            if (
              getClientSettings().sidebarPinnedStatusEnabled &&
              providerBlocked(
                appAtomRegistry.get(detailAtom),
                appAtomRegistry.get(settingsAtom),
                appAtomRegistry.get(providersAtom),
                appAtomRegistry.get(environmentShell.statusAtom(environmentId)),
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
      </div>
      {error !== null ? (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function ChildThreadApprovals({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const approvals = useAtomValue(childThreadApprovalsAtom(threadRef));
  if (approvals.length === 0) return null;
  return (
    <div className="mb-2 flex max-h-80 flex-col gap-2 overflow-auto">
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
    </div>
  );
}
