import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { hermesPluginEnvironment } from "../../state/hermesPlugins";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomValue } from "@effect/atom-react";
import { useEnvironmentScope } from "../../state/session";

export function useHermesPlugins(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId | undefined;
  readonly providerInstanceId: ProviderInstanceId | undefined;
  readonly providerDriver: string | undefined;
}) {
  const pluginsEnabled = useEnvironmentSettings(input.environmentId, (settings) => {
    const config = input.providerInstanceId
      ? settings.providerInstances[input.providerInstanceId]?.config
      : undefined;
    if (typeof config !== "object" || config === null) return true;
    return (config as Record<string, unknown>).pluginsEnabled !== false;
  });
  const pluginRpcEnabled = useEnvironmentSettings(input.environmentId, (settings) => {
    const config = input.providerInstanceId
      ? settings.providerInstances[input.providerInstanceId]?.config
      : undefined;
    if (typeof config !== "object" || config === null) return true;
    return (config as Record<string, unknown>).pluginRpcEnabled !== false;
  });
  const canRead = useEnvironmentScope(input.environmentId, AuthOrchestrationReadScope);
  const permitted = useAtomValue(
    hermesPluginEnvironment.invoke.permissionAtom(input.environmentId),
  );
  const enabled = input.providerDriver === "hermes" && pluginsEnabled && canRead;
  const canInvoke = enabled && pluginRpcEnabled && permitted;
  const toolsQuery = useEnvironmentQuery(
    enabled && input.providerThreadId
      ? hermesPluginEnvironment.listToolsQuery({
          environmentId: input.environmentId,
          input: { threadId: input.threadId, providerThreadId: input.providerThreadId },
        })
      : null,
  );
  const invokeCommand = useAtomCommand(hermesPluginEnvironment.invoke, {
    label: "invoke Hermes plugin",
    reportFailure: false,
  });
  const invoke = async (method: string, params: Record<string, unknown>) => {
    if (!input.providerThreadId) throw new Error("No active Hermes session.");
    const result = await invokeCommand({
      environmentId: input.environmentId,
      input: {
        threadId: input.threadId,
        providerThreadId: input.providerThreadId,
        method,
        params,
      },
    });
    if (result._tag === "Success") return result.value.result;
    throw squashAtomCommandFailure(result);
  };
  return { enabled, canInvoke, toolsQuery, invoke };
}
