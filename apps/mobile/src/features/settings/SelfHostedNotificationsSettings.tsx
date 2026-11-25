import { useFocusEffect } from "@react-navigation/native";
import * as Effect from "effect/Effect";
import * as Clipboard from "expo-clipboard";
import { useGT } from "gt-react-native";
import { useCallback, useRef, useState } from "react";
import { Linking, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { environmentCatalog } from "../../connection/catalog";
import { subscribeAppActive } from "../../lib/appState";
import { appAtomRegistry } from "../../state/atom-registry";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  canonicalSelfHostedPushOrigin,
  configureSelfHostedPush,
  disableSelfHostedPush,
  getSelfHostedPushEnrollment,
  getSelfHostedPushStatus,
  removeSelfHostedPush,
  supportsSelfHostedPush,
  type SelfHostedPushEnvironment,
  type SelfHostedPushStatus,
} from "../agent-awareness/androidNotifications";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { selectSelfHostedAgentNotifications } from "../agent-awareness/remoteRegistration";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

function readSelfHostedNotificationStatus(): SelfHostedPushStatus | "unreadable" {
  try {
    return getSelfHostedPushStatus() ?? "unreadable";
  } catch {
    return "unreadable";
  }
}

export function useSelfHostedNotificationSettings() {
  const supported = supportsSelfHostedPush();
  const [status, setStatus] = useState<SelfHostedPushStatus | "unreadable" | null>(null);
  const refresh = useCallback(() => {
    if (!supported) return;
    setStatus(readSelfHostedNotificationStatus());
  }, [supported]);
  useFocusEffect(
    useCallback(() => {
      refresh();
      if (!supported) return;
      return subscribeAppActive(refresh);
    }, [refresh, supported]),
  );
  const cloudBlocked =
    supported &&
    (status === null ||
      status === "unreadable" ||
      status.environments.some((entry) => entry.enabled));
  return { supported, status, refresh, cloudBlocked };
}

export function SelfHostedNotificationsSettings({
  status,
  refresh,
}: Pick<ReturnType<typeof useSelfHostedNotificationSettings>, "status" | "refresh">) {
  const gt = useGT();
  const { savedConnectionsById, isLoadingSavedConnection } = useSavedRemoteConnections();
  const [originInput, setOriginInput] = useState("");
  const [busyEnvironment, setBusyEnvironment] = useState<string | null>(null);
  const inFlight = useRef(false);
  const connections = Object.values(savedConnectionsById);
  const bindings = status === "unreadable" ? [] : (status?.environments ?? []);
  const origin = bindings[0]?.ntfyOrigin ?? canonicalSelfHostedPushOrigin(originInput);
  const busy = busyEnvironment !== null;
  const loading = status === null || isLoadingSavedConnection;

  function describeBinding(binding: SelfHostedPushEnvironment | undefined) {
    switch (binding?.state) {
      case "registering":
        return gt("Registering with ntfy · Not verified");
      case "needsAcl":
        return gt("Server setup needed · Not verified");
      case "verified":
        return gt("Verified · Alert received {time}", {
          time: new Date(binding.lastReceivedAt).toLocaleString(),
        });
      case "error":
        return binding.error === "SelfHostedPushInvalidEndpoint"
          ? gt(
              "Check the default server in ntfy, then use Reset setup below before enabling again.",
            )
          : gt("Could not register with ntfy. Check the ntfy app and try again.");
      default:
        return gt("Off");
    }
  }

  function showSetupError(error: unknown) {
    const message = error instanceof Error ? error.message : "";
    let detail = gt("Could not change self-hosted notifications. Try again.");
    if (
      message.includes("SelfHostedPushDistributorUnavailable") ||
      message.includes("SelfHostedPushUnsupportedDistributor")
    ) {
      detail = gt("Install the ntfy Android app and set its default server to your ntfy origin.");
    } else if (message.includes("SelfHostedPushInvalidOrigin")) {
      detail = gt("Enter an HTTPS ntfy origin without a path, query, or credentials.");
    } else if (message.includes("SelfHostedPushInvalidEnvironment")) {
      detail = gt("Pair an environment to enable self-hosted notifications.");
    } else if (message.includes("SelfHostedPushOriginMismatch")) {
      detail = gt("Reset all existing setups before changing the ntfy origin on this phone.");
    }
    Dialog.alert(gt("Self-hosted notifications unavailable"), detail);
  }

  async function changeEnvironment(environmentId: string, action: "enable" | "disable" | "reset") {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusyEnvironment(environmentId);
    await Promise.resolve()
      .then(async () => {
        if (action === "enable") {
          if (!origin) throw new Error("SelfHostedPushInvalidOrigin");
          const permission = await Effect.runPromise(requestAgentNotificationPermission);
          if (permission.type !== "granted") {
            Dialog.alert(
              gt("Notifications disabled"),
              gt(
                "Allow notifications for T3 Code in Android Settings before enabling this environment.",
              ),
              [
                { text: gt("Cancel"), style: "cancel" },
                { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
              ],
            );
            return;
          }
          const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
          if (!catalog.isReady || ![...catalog.entries.keys()].some((id) => id === environmentId)) {
            throw new Error("SelfHostedPushInvalidEnvironment");
          }
          await Promise.resolve()
            .then(() => configureSelfHostedPush(environmentId, origin))
            .finally(selectSelfHostedAgentNotifications);
        } else if (action === "disable") {
          disableSelfHostedPush(environmentId);
        } else {
          removeSelfHostedPush(environmentId);
        }
      })
      .catch(showSetupError)
      .finally(() => {
        refresh();
        inFlight.current = false;
        setBusyEnvironment(null);
      });
  }

  async function copyEnrollment(environmentId: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusyEnvironment(environmentId);
    await Promise.resolve()
      .then(() =>
        Clipboard.setStringAsync(getSelfHostedPushEnrollment(environmentId), {
          android: { isSensitive: true },
        }),
      )
      .then(() => Dialog.alert(gt("Setup copied")))
      .catch(() =>
        Dialog.alert(gt("Could not copy setup"), gt("Refresh the status and try again.")),
      )
      .finally(() => {
        refresh();
        inFlight.current = false;
        setBusyEnvironment(null);
      });
  }

  return (
    <SettingsSection title={gt("Self-hosted notifications")}>
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">
          {gt(
            "Receive alerts from paired environments using the ntfy Android app. No T3 account is needed.",
          )}
        </Text>
        {loading ? (
          <Text className="text-sm text-foreground-muted">{gt("Checking")}</Text>
        ) : status === "unreadable" ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            {gt("Could not read self-hosted notification status.")}
          </Text>
        ) : connections.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            {gt("Pair an environment to enable self-hosted notifications.")}
          </Text>
        ) : bindings.length > 0 ? (
          <Text className="text-sm text-foreground-muted">
            {gt("ntfy origin: {origin}", { origin: bindings[0]!.ntfyOrigin })}
          </Text>
        ) : (
          <>
            <Text className="text-sm text-foreground-muted">
              {gt("Set this same HTTPS origin as the default server in the ntfy app.")}
            </Text>
            <AppTextInput
              accessibilityLabel={gt("ntfy HTTPS origin")}
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-11 rounded-xl border border-border px-3 py-2 text-base text-foreground"
              editable={!busy}
              inputMode="url"
              maxLength={300}
              onChangeText={setOriginInput}
              placeholder="https://ntfy.example.com"
              value={originInput}
            />
          </>
        )}
      </View>
      {!loading && status !== "unreadable"
        ? connections.map((connection) => {
            const id = connection.environmentId;
            const label = connection.environmentLabel;
            const binding = bindings.find((entry) => entry.environmentId === id);
            return (
              <View key={id}>
                <SettingsSwitchRow
                  icon="bell.badge"
                  label={label}
                  subtitle={busyEnvironment === id ? gt("Working…") : describeBinding(binding)}
                  disabled={busy || (!binding?.enabled && !origin)}
                  value={binding?.enabled ?? false}
                  onValueChange={(enabled) =>
                    void changeEnvironment(id, enabled ? "enable" : "disable")
                  }
                />
                {binding?.enabled &&
                (binding.state === "needsAcl" || binding.state === "verified") ? (
                  <SettingsRow
                    icon="doc.on.doc"
                    label={gt("Copy setup for {environment}", { environment: label })}
                    disabled={busy}
                    onPress={() =>
                      Dialog.confirm({
                        title: gt("Copy sensitive setup?"),
                        message: gt(
                          "This includes notification keys. Paste it only into the protected server enrollment file. Do not share it in chat or tickets, and clear your clipboard after pasting.",
                        ),
                        confirmText: gt("Copy setup"),
                        onConfirm: () => void copyEnrollment(id),
                      })
                    }
                  />
                ) : null}
                {binding?.enabled &&
                binding.state === "error" &&
                binding.error !== "SelfHostedPushInvalidEndpoint" ? (
                  <SettingsRow
                    icon="arrow.clockwise"
                    label={gt("Retry setup for {environment}", { environment: label })}
                    disabled={busy}
                    onPress={() => void changeEnvironment(id, "enable")}
                  />
                ) : null}
                {binding ? (
                  <SettingsRow
                    icon="trash"
                    label={gt("Reset setup for {environment}", { environment: label })}
                    disabled={busy}
                    onPress={() =>
                      Dialog.confirm({
                        title: gt("Reset notification setup?"),
                        message: gt(
                          "This removes the subscription and keys from this phone. Remove the old server enrollment and its ntfy topic permissions separately. You will need a new setup to receive alerts again.",
                        ),
                        confirmText: gt("Reset setup"),
                        destructive: true,
                        onConfirm: () => void changeEnvironment(id, "reset"),
                      })
                    }
                  />
                ) : null}
              </View>
            );
          })
        : null}
      {bindings.some(
        (entry) => entry.enabled && (entry.state === "needsAcl" || entry.state === "verified"),
      ) ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          {gt(
            "On the paired server, set {urlSetting} to the ntfy origin, choose {topicSetting}, and set {tokenSetting} to a protected file containing the publisher token. Restart the server after changing these settings.",
            {
              urlSetting: "T3CODE_NTFY_URL",
              topicSetting: "T3CODE_NTFY_TOPIC",
              tokenSetting: "T3CODE_NTFY_TOKEN_FILE",
            },
          )}
          {"\n\n"}
          {gt(
            "Save the copied setup as the contents of the file specified by {setting} on the paired server. Set its permissions to 0600 and make it readable by the server process.",
            { setting: "T3CODE_NTFY_UP_FILE" },
          )}
          {"\n\n"}
          {gt(
            "Grant the ntfy phone account read-only access and the server publisher write-only access to both {topicSetting} and the generated up… topic in the copied endpoint. Run a turn that finishes in this environment, then refresh here. Only an alert received by this phone verifies setup.",
            { topicSetting: "T3CODE_NTFY_TOPIC" },
          )}
        </Text>
      ) : null}
      {bindings.length > 0 || status === "unreadable" ? (
        <SettingsRow
          icon="arrow.clockwise"
          label={gt("Refresh status")}
          onPress={refresh}
          disabled={busy}
        />
      ) : null}
      {bindings.length > 0 ? (
        <Text className="px-4 pb-3 pt-2 text-sm text-foreground-muted">
          {gt(
            "Turning off alerts stops them on this phone and keeps the setup. The server can keep sending until you remove its enrollment file.",
          )}
        </Text>
      ) : null}
    </SettingsSection>
  );
}
