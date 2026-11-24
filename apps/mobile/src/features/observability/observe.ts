import Constants from "expo-constants";
import { Observe } from "expo-observe";

// Importing expo-observe installs its global JS error handler; reports leave only through the relay.
const relayUrl: unknown = Constants.expoConfig?.extra?.relay?.url;
const appVariant: unknown = Constants.expoConfig?.extra?.appVariant;

export const crashReportingAvailable = typeof relayUrl === "string" && relayUrl.trim() !== "";

interface PromiseRejectionTracker {
  readonly enablePromiseRejectionTracker?: (options: {
    readonly allRejections: boolean;
    readonly onUnhandled: (id: number, rejection: unknown) => void;
  }) => void;
}

// React Native tracks unhandled rejections only in development, for LogBox; Observe has no hook.
if (!__DEV__) {
  const hermes: PromiseRejectionTracker | undefined = Reflect.get(globalThis, "HermesInternal");
  hermes?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id, rejection) => Observe.reportError(rejection),
  });
}

let latestConfiguration = 0;

// Apply consent before dispatch: enabling sends queued reports; disabling drops them without sending.
// Best effort: Observe skips the pass while it is backing off from a failed send.
export async function setCrashReportsEnabled(enabled: boolean) {
  ++latestConfiguration;
  const dispatchingEnabled = crashReportingAvailable && enabled;
  Observe.configure({
    dispatchingEnabled,
    ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
  });
  await Observe.dispatchEvents();
}

if (!crashReportingAvailable) {
  void setCrashReportsEnabled(false);
} else {
  // Upgrades can carry a native dispatchingEnabled=true from before consent was required.
  // Turn it off before reading preferences without counting this as a user configuration change.
  Observe.configure({
    dispatchingEnabled: false,
    ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
  });
  const changedSinceLoad = () => latestConfiguration !== 0;
  void import("../../persistence/imperative")
    .then(({ loadPreferences }) => loadPreferences())
    .then(
      (preferences) =>
        changedSinceLoad()
          ? undefined
          : setCrashReportsEnabled(preferences.crashReportsEnabled === true),
      // Keep the native off state when the stored preference cannot be read.
      (error: unknown) => console.warn("[observe] could not read the crash report setting", error),
    )
    .catch((error: unknown) => {
      console.warn("[observe] could not apply the crash report setting", error);
    });
}
