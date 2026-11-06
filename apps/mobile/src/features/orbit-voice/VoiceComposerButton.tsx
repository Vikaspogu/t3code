import { useNavigation } from "@react-navigation/native";
import type { ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
import { voiceCallStatus } from "@t3tools/client-runtime/voice";
import { Pressable, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useVoiceCall } from "./useVoiceCall";

/** Composer toolbar mic button. Hidden unless voice can start on this thread (Codex/Pi + permissions). */
export function VoiceComposerButton({
  target,
  providerInstanceId,
}: {
  readonly target: ScopedThreadRef;
  readonly providerInstanceId: ProviderInstanceId | null | undefined;
}) {
  const navigation = useNavigation();
  const voice = useVoiceCall(target, providerInstanceId ?? undefined);
  if (voice.unavailable !== null) return null;
  const active = voice.view.state === "starting" || voice.view.state === "connected";
  return (
    <Pressable
      accessibilityLabel={active ? voiceCallStatus(voice.view) : "Start voice call"}
      accessibilityRole="button"
      hitSlop={8}
      onPress={() =>
        navigation.navigate("ThreadVoice", {
          environmentId: target.environmentId,
          threadId: target.threadId,
          providerInstanceId: providerInstanceId ?? undefined,
        })
      }
      className="h-9 w-9 items-center justify-center rounded-full bg-secondary"
    >
      <View className="flex-row items-center gap-1">
        <SymbolView
          name={active ? "phone.fill" : "mic.fill"}
          tintColorClassName="accent-foreground"
          size={15}
        />
        {active ? <View className={`h-1.5 w-1.5 rounded-full bg-success`} /> : null}
      </View>
    </Pressable>
  );
}
