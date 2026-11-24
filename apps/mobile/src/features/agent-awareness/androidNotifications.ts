import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { Linking, Platform } from "react-native";
import * as Schema from "effect/Schema";

interface AndroidAgentNotifications {
  configure(deviceId: string, userId: string, scheme: string, ongoingEnabled: boolean): void;
  clear(): void;
  setThreadOnScreen?(path: string | null): void;
  openLiveUpdateSettings?(): boolean;
  showShowcaseActivity?(scheme: string, data: Record<string, string>): void;
  getSelfHostedPushStatus?(): string;
  configureSelfHostedPush?(environmentId: string, ntfyOrigin: string, scheme: string): void;
  disableSelfHostedPush?(environmentId: string): void;
  removeSelfHostedPush?(environmentId: string): void;
  getSelfHostedPushEnrollment?(environmentId: string): string;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidAgentNotifications>("T3AgentNotifications")
    : null;

export function supportsAndroidAgentNotifications(): boolean {
  return typeof native?.configure === "function" && typeof native?.clear === "function";
}

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code";
}

export function configureAndroidAgentNotifications(
  deviceId: string,
  userId: string,
  ongoingEnabled: boolean,
): void {
  native?.configure?.(deviceId, userId, appScheme(), ongoingEnabled);
}

export function showAndroidShowcaseAgentActivity(data: Record<string, string>): boolean {
  if (!native?.showShowcaseActivity) return false;
  native.showShowcaseActivity(appScheme(), data);
  return true;
}

export function clearAndroidAgentNotifications(): void {
  native?.clear?.();
}

export function setAndroidThreadOnScreen(path: string | null): void {
  native?.setThreadOnScreen?.(path);
}

export function supportsAndroidLiveUpdateSettings(): boolean {
  return Platform.OS === "android" && Number(Platform.Version) >= 36;
}

export async function openAndroidLiveUpdateSettings(): Promise<void> {
  if (!native?.openLiveUpdateSettings?.()) {
    await Linking.openSettings();
  }
}

export function supportsSelfHostedPush(): boolean {
  return (
    typeof native?.getSelfHostedPushStatus === "function" &&
    typeof native.configureSelfHostedPush === "function" &&
    typeof native.disableSelfHostedPush === "function" &&
    typeof native.removeSelfHostedPush === "function" &&
    typeof native.getSelfHostedPushEnrollment === "function"
  );
}

// React Native's URL parser does not validate authorities. Kotlin checks the host again with URI.
export function canonicalSelfHostedPushOrigin(input: string): string | null {
  const match = /^https:\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?\/?$/i.exec(input.trim());
  if (!match?.[1]) return null;
  const port = match[2] === undefined ? 443 : Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return `https://${match[1].toLowerCase()}${port === 443 ? "" : `:${port}`}`;
}

const SelfHostedPushStatus = Schema.Struct({
  installationId: Schema.NonEmptyString,
  environments: Schema.Array(
    Schema.Struct({
      environmentId: Schema.NonEmptyString,
      ntfyOrigin: Schema.String,
      enabled: Schema.Boolean,
      state: Schema.Literals(["disabled", "registering", "needsAcl", "verified", "error"]),
      lastReceivedAt: Schema.Int,
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type SelfHostedPushStatus = typeof SelfHostedPushStatus.Type;
export type SelfHostedPushEnvironment = SelfHostedPushStatus["environments"][number];

const SelfHostedPushEnrollment = Schema.Struct({
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  installationId: Schema.NonEmptyString,
  environmentId: Schema.NonEmptyString,
});

const decodeStatus = Schema.decodeUnknownSync(Schema.fromJsonString(SelfHostedPushStatus), {
  onExcessProperty: "error",
});
const decodeEnrollment = Schema.decodeUnknownSync(Schema.fromJsonString(SelfHostedPushEnrollment), {
  onExcessProperty: "error",
});

function decodeBridgeJson<A>(decode: (value: string) => A, value: string, message: string): A {
  try {
    return decode(value);
  } catch {
    throw new Error(message);
  }
}

export function getSelfHostedPushStatus(): SelfHostedPushStatus | null {
  if (!native?.getSelfHostedPushStatus) return null;
  const message = "Invalid self-hosted push status";
  const status = decodeBridgeJson(decodeStatus, native.getSelfHostedPushStatus(), message);
  const origin = status.environments[0]?.ntfyOrigin;
  const ids = new Set<string>();
  for (const entry of status.environments) {
    if (
      ids.has(entry.environmentId) ||
      entry.ntfyOrigin !== origin ||
      canonicalSelfHostedPushOrigin(entry.ntfyOrigin) !== entry.ntfyOrigin ||
      (entry.enabled && entry.state === "disabled") ||
      (!entry.enabled && entry.state !== "disabled" && entry.state !== "error") ||
      entry.lastReceivedAt < 0 ||
      (entry.state === "verified" && entry.lastReceivedAt === 0)
    ) {
      throw new Error(message);
    }
    ids.add(entry.environmentId);
  }
  return status;
}

export function configureSelfHostedPush(environmentId: string, input: string): void {
  const origin = canonicalSelfHostedPushOrigin(input);
  if (!origin) throw new Error("SelfHostedPushInvalidOrigin");
  if (!native?.configureSelfHostedPush) throw new Error("SelfHostedPushUnavailable");
  native.configureSelfHostedPush(environmentId, origin, appScheme());
}

export function disableSelfHostedPush(environmentId: string): void {
  if (!native?.disableSelfHostedPush) throw new Error("SelfHostedPushUnavailable");
  native.disableSelfHostedPush(environmentId);
}

export function removeSelfHostedPush(environmentId: string): void {
  if (!native?.removeSelfHostedPush) throw new Error("SelfHostedPushUnavailable");
  native.removeSelfHostedPush(environmentId);
}

export function getSelfHostedPushEnrollment(environmentId: string): string {
  const status = getSelfHostedPushStatus();
  const binding = status?.environments.find((entry) => entry.environmentId === environmentId);
  const message = "Invalid self-hosted push enrollment";
  if (!status || !binding?.enabled || !native?.getSelfHostedPushEnrollment)
    throw new Error(message);
  const enrollment = decodeBridgeJson(
    decodeEnrollment,
    native.getSelfHostedPushEnrollment(environmentId),
    message,
  );
  const endpoint = /^(https:\/\/[^/]+)(\/up[A-Za-z0-9]{12}\?up=1)$/.exec(enrollment.endpoint);
  if (
    enrollment.installationId !== status.installationId ||
    enrollment.environmentId !== environmentId ||
    !endpoint ||
    enrollment.endpoint !== `${binding.ntfyOrigin}${endpoint[2]}` ||
    !/^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]$/.test(enrollment.p256dh) ||
    !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(enrollment.auth)
  ) {
    throw new Error(message);
  }
  return JSON.stringify(enrollment);
}

export function reconcileSelfHostedPushEnvironments(catalog: {
  readonly isReady: boolean;
  readonly entries: ReadonlyMap<string, unknown>;
}): void {
  if (!catalog.isReady) return;
  for (const { environmentId } of getSelfHostedPushStatus()?.environments ?? []) {
    if (!catalog.entries.has(environmentId)) removeSelfHostedPush(environmentId);
  }
}
