import type { ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
import { voiceCallStatus } from "@t3tools/client-runtime/voice";
import { DateTime } from "effect";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ComposerToolbarButton } from "../../components/ComposerToolbar";
import { cn } from "../../lib/cn";
import { useVoiceCall } from "./useVoiceCall";
import { WorkingTimer } from "./WorkingTimer";

/**
 * Slim bar above the composer while a call is active. Mirrors the web call bar:
 * a status/caption line, a live task timer, and Mute/End. Tap opens the voice sheet.
 */
export function VoiceCallBar({
  target,
  providerInstanceId,
  onOpenSheet,
}: {
  readonly target: ScopedThreadRef;
  readonly providerInstanceId: ProviderInstanceId | undefined;
  readonly onOpenSheet: () => void;
}) {
  const { controller, view } = useVoiceCall(target, providerInstanceId);
  if (view.state !== "starting" && view.state !== "connected") return null;

  const tasks = view.snapshot?.tasks ?? [];
  const working = tasks.find((task) => task.state === "working");
  const waiting = tasks.some((task) => task.state === "waiting");
  const latestCaption = view.snapshot?.captions.at(-1);

  return (
    <Pressable
      onPress={onOpenSheet}
      accessibilityRole="button"
      accessibilityLabel="Open voice call"
      className="mx-3 mb-2 flex-row items-center gap-2 rounded-2xl bg-subtle-strong px-3 py-2"
    >
      <View
        className={cn(
          "size-2 shrink-0 rounded-full",
          view.state === "connected" && !view.muted ? "bg-adaptive-emerald-600-400" : "bg-warning",
        )}
      />
      {waiting ? (
        <Text className="shrink-0 text-xs font-medium text-warning">Approval waiting</Text>
      ) : working ? (
        <Text className="shrink-0 text-xs text-foreground-secondary">
          Working{" "}
          <WorkingTimer
            createdAt={DateTime.formatIso(working.startedAt)}
            className="text-xs text-foreground-secondary"
          />
        </Text>
      ) : (
        <Text numberOfLines={1} className="shrink-1 text-xs text-foreground-secondary">
          {latestCaption?.text ?? voiceCallStatus(view)}
        </Text>
      )}
      <View className="flex-1" />
      <ComposerToolbarButton
        icon={view.muted ? "mic.slash.fill" : "mic.fill"}
        accessibilityLabel={view.muted ? "Unmute microphone" : "Mute microphone"}
        active={view.muted}
        showChevron={false}
        onPress={controller.toggleMute}
      />
      <ComposerToolbarButton
        icon="phone.down.fill"
        accessibilityLabel="End call"
        variant="danger"
        showChevron={false}
        onPress={() => void controller.end()}
      />
    </Pressable>
  );
}
