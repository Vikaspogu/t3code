import { useAtomValue } from "@effect/atom-react";
import type { ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { voiceUnavailableReason } from "./availabilityReason";
import { voiceCommands } from "./commands";

import { isMobileVoiceSupported } from "@t3tools/client-runtime/voice/mobile";

export { voiceUnavailableReason } from "./availabilityReason";
export type { VoiceAvailabilityInput } from "./availabilityReason";

/** Null when a voice call may start on this thread, otherwise the reason to show. */
export function useVoiceAvailability(
  target: ScopedThreadRef,
  providerInstanceId: ProviderInstanceId | undefined,
): string | null {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(target.environmentId));
  const permitted = useAtomValue(voiceCommands.start.permissionAtom(target.environmentId));
  if (!isMobileVoiceSupported()) return "Voice needs an app build with the WebRTC module.";
  return voiceUnavailableReason({ providers, providerInstanceId, permitted });
}
