import type { ProviderInstanceId } from "@t3tools/contracts";

// Pure availability logic, kept free of React/expo imports so it stays unit-testable
// under vitest without native module globals.
export interface VoiceAvailabilityInput {
  readonly providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driver: string;
    readonly enabled: boolean;
  }> | null;
  readonly providerInstanceId: ProviderInstanceId | undefined;
  readonly permitted: boolean;
}

export function voiceUnavailableReason(input: VoiceAvailabilityInput): string | null {
  if (input.providers === null) return "Checking voice availability…";
  const provider = input.providers.find((entry) => entry.instanceId === input.providerInstanceId);
  if (!provider || (provider.driver !== "codex" && provider.driver !== "pi"))
    return "Voice is available in Codex and Pi threads.";
  if (!provider.enabled) return "Enable this provider in Settings to use voice.";
  // pi threads borrow a Codex runtime for the speech bridge (audio/STT/TTS).
  if (
    provider.driver === "pi" &&
    !input.providers.some((entry) => entry.driver === "codex" && entry.enabled)
  )
    return "Voice needs an enabled Codex provider for speech.";
  if (!input.permitted) return "This connection needs permission to control the thread.";
  return null;
}
