import type { StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { VoiceSheet } from "./VoiceSheet";

export function VoiceSheetScreen(
  props: StaticScreenProps<{
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId | undefined;
  }>,
) {
  const { environmentId, threadId, providerInstanceId } = props.route.params;
  return (
    <VoiceSheet target={{ environmentId, threadId }} providerInstanceId={providerInstanceId} />
  );
}
