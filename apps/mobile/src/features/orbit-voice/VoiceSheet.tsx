import type { ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
import {
  selectVoiceTask,
  voiceCallStatus,
  voiceTaskCompletedSeconds,
  voiceTaskStatusLabel,
} from "@t3tools/client-runtime/voice";
import { formatCallClock } from "@t3tools/shared/orchestrationTiming";
import { DateTime } from "effect";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerToolbarButton } from "../../components/ComposerToolbar";
import { useVoiceCall } from "./useVoiceCall";
import { CallTimer, WorkingTimer } from "./WorkingTimer";

/**
 * Full voice panel as a sheet: call status, live task card, transcript, and
 * Mute/End (or Start when idle). Mirrors the web thread-details Voice section.
 */
export function VoiceSheet({
  target,
  providerInstanceId,
}: {
  readonly target: ScopedThreadRef;
  readonly providerInstanceId: ProviderInstanceId | undefined;
}) {
  const { controller, view, unavailable } = useVoiceCall(target, providerInstanceId);
  const active = view.state === "starting" || view.state === "connected";
  const snapshot = view.snapshot;
  const captions = snapshot?.captions ?? [];
  const tasks = snapshot?.tasks ?? [];
  const task = selectVoiceTask(tasks);
  const pendingCount = tasks.filter(
    (entry) => entry.state === "queued" || entry.state === "working" || entry.state === "waiting",
  ).length;
  const completedSeconds = task ? voiceTaskCompletedSeconds(task) : null;
  const notice = view.message ?? (active ? snapshot?.message : null);
  const status = view.state === "idle" && unavailable ? "Voice unavailable" : voiceCallStatus(view);
  const title = snapshot?.threadTitle || "This thread";

  return (
    <View className="flex-1 bg-screen">
      <ScrollView contentContainerClassName="gap-4 px-4 pt-4 pb-6">
        <View className="flex-row items-center gap-3">
          <View className="size-10 shrink-0 items-center justify-center rounded-full bg-subtle-strong">
            <SymbolView
              name={active && view.muted ? "mic.slash.fill" : "mic.fill"}
              tintColorClassName="accent-foreground"
              size={20}
            />
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-base font-medium text-foreground">{status}</Text>
            <Text numberOfLines={1} className="text-sm text-foreground-secondary">
              {title}
            </Text>
          </View>
          {view.state === "connected" && view.connectedAt !== null ? (
            <View className="flex-row items-center gap-1 rounded-full bg-subtle-strong px-2 py-1">
              <SymbolView name="clock" tintColorClassName="accent-foreground-secondary" size={11} />
              <CallTimer
                createdAt={view.connectedAt}
                className="text-xs text-foreground-secondary"
              />
            </View>
          ) : null}
        </View>

        {notice ? (
          <View className="flex-row items-center gap-2 rounded-xl border border-border bg-subtle px-3 py-2">
            <SymbolView
              name="info.circle"
              tintColorClassName="accent-foreground-secondary"
              size={14}
            />
            <Text className="flex-1 text-xs text-foreground-secondary">{notice}</Text>
          </View>
        ) : null}

        {task?.state === "waiting" ? (
          <View className="flex-row items-center gap-2 rounded-xl bg-warning px-3 py-2">
            <SymbolView
              name="exclamationmark.triangle"
              tintColorClassName="accent-warning-foreground"
              size={14}
            />
            <Text className="flex-1 text-xs text-warning-foreground">
              Paused — approval waiting in the thread. Close this sheet to review it.
            </Text>
          </View>
        ) : null}

        {task ? (
          <View className="gap-2 rounded-2xl border border-border bg-card p-3">
            <View className="flex-row items-center gap-2">
              {task.state === "working" || task.state === "waiting" ? (
                <ActivityIndicator size="small" colorClassName="accent-foreground-secondary" />
              ) : (
                <SymbolView
                  name={task.state === "completed" ? "checkmark" : "xmark"}
                  tintColorClassName={
                    task.state === "completed" ? "accent-adaptive-emerald-600-400" : "accent-danger"
                  }
                  size={13}
                />
              )}
              <Text
                numberOfLines={2}
                className="min-w-0 flex-1 text-sm font-medium text-foreground"
              >
                {task.title}
              </Text>
              {pendingCount > 1 ? (
                <Text className="shrink-0 text-xs text-foreground-tertiary">
                  +{pendingCount - 1} queued
                </Text>
              ) : null}
            </View>
            <Text className="text-xs text-foreground-tertiary">
              {voiceTaskStatusLabel(task.state)}
            </Text>
            {task.state === "working" || task.state === "waiting" ? (
              <Text className="text-xs text-foreground-secondary">
                Working for{" "}
                <WorkingTimer
                  createdAt={DateTime.formatIso(task.startedAt)}
                  className="text-xs text-foreground-secondary"
                />
              </Text>
            ) : null}
            {completedSeconds !== null ? (
              <Text className="text-xs text-foreground-secondary">
                Completed for {formatCallClock(completedSeconds)}
              </Text>
            ) : null}
            {task.state === "completed" && task.result ? (
              <Text numberOfLines={3} className="text-xs text-foreground-secondary">
                {task.result}
              </Text>
            ) : null}
            {task.activity ? (
              <Text numberOfLines={1} className="text-xs text-foreground-tertiary">
                {task.activity}
              </Text>
            ) : null}
            {task.steps.length > 0 ? (
              <View className="gap-1">
                {task.steps.map((step, index) => (
                  <View key={`${index}:${step}`} className="flex-row items-center gap-1.5">
                    <SymbolView
                      name="checkmark"
                      tintColorClassName="accent-foreground-tertiary"
                      size={10}
                    />
                    <Text numberOfLines={1} className="flex-1 text-xs text-foreground-tertiary">
                      {step}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {captions.length > 0 ? (
          <View className="gap-2">
            <Text className="text-sm text-foreground-tertiary">Transcript</Text>
            {captions.map((caption) => (
              <View key={caption.sequence} className="gap-0.5">
                <Text className="text-xs text-foreground-tertiary">
                  {caption.role === "user" ? "You" : "Codex"}
                </Text>
                <Text
                  className={
                    caption.role === "user"
                      ? "text-sm text-foreground"
                      : "text-sm text-foreground-secondary"
                  }
                >
                  {caption.text}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View className="flex-row items-center justify-center gap-3 border-t border-border px-4 py-3">
        {active ? (
          <>
            <ComposerToolbarButton
              icon={view.muted ? "mic.slash.fill" : "mic.fill"}
              label={view.muted ? "Unmute" : "Mute"}
              active={view.muted}
              showChevron={false}
              minWidth={120}
              onPress={controller.toggleMute}
            />
            <ComposerToolbarButton
              icon="phone.down.fill"
              label="End"
              variant="danger"
              showChevron={false}
              minWidth={120}
              onPress={() => void controller.end()}
            />
          </>
        ) : (
          <ComposerToolbarButton
            icon="mic.fill"
            label={
              view.state === "starting"
                ? "Connecting…"
                : view.state === "ended" || view.state === "error"
                  ? "Start again"
                  : "Start voice call"
            }
            variant="primary"
            showChevron={false}
            minWidth={180}
            disabled={view.state === "starting" || (view.state === "idle" && unavailable !== null)}
            onPress={() => void controller.start(target)}
          />
        )}
      </View>
      {view.state === "idle" && unavailable ? (
        <Text className="px-4 pb-3 text-center text-xs text-foreground-tertiary">
          {unavailable}
        </Text>
      ) : null}
    </View>
  );
}
