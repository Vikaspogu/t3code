import { msg } from "gt-react-native";
import { m, type MessageResolver } from "../../i18n/messages";
import type { ProviderInstanceId } from "@t3tools/contracts";

export interface VoiceAvailabilityInput {
  readonly providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driver: string;
    readonly enabled: boolean;
  }> | null;
  readonly providerInstanceId: ProviderInstanceId | undefined;
  readonly permitted: boolean;
}

export function voiceUnavailableReason(
  input: VoiceAvailabilityInput,
  resolve: MessageResolver = m,
): string | null {
  if (input.providers === null) return resolve(msg("Checking voice availability…"));
  const provider = input.providers.find((entry) => entry.instanceId === input.providerInstanceId);
  if (!provider || (provider.driver !== "codex" && provider.driver !== "pi"))
    return resolve(msg("Voice is available in Codex and Pi threads."));
  if (!provider.enabled) return resolve(msg("Enable this provider in Settings to use voice."));
  // pi threads borrow a Codex runtime for the speech bridge (audio/STT/TTS).
  if (
    provider.driver === "pi" &&
    !input.providers.some((entry) => entry.driver === "codex" && entry.enabled)
  )
    return resolve(msg("Voice needs an enabled Codex provider for speech."));
  if (!input.permitted)
    return resolve(msg("This connection needs permission to control the thread."));
  return null;
}
