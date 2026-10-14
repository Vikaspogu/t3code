import type { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { voiceUnavailableReason } from "./availabilityReason";

const codex = {
  instanceId: "provider-1" as ProviderInstanceId,
  driver: "codex",
  enabled: true,
};

describe("voiceUnavailableReason", () => {
  it("is available for an enabled Codex provider with control permission", () => {
    expect(
      voiceUnavailableReason({
        providers: [codex],
        providerInstanceId: codex.instanceId,
        permitted: true,
      }),
    ).toBeNull();
  });

  it("requires a Codex or Pi thread and an enabled provider", () => {
    expect(
      voiceUnavailableReason({
        providers: [{ ...codex, driver: "claude" }],
        providerInstanceId: codex.instanceId,
        permitted: true,
      }),
    ).toBe("Voice is available in Codex and Pi threads.");
    expect(
      voiceUnavailableReason({
        providers: [{ ...codex, enabled: false }],
        providerInstanceId: codex.instanceId,
        permitted: true,
      }),
    ).toBe("Enable this provider in Settings to use voice.");
  });

  it("is available for a Pi thread only when a Codex provider is enabled for speech", () => {
    const pi = { instanceId: "provider-2" as ProviderInstanceId, driver: "pi", enabled: true };
    expect(
      voiceUnavailableReason({
        providers: [pi, codex],
        providerInstanceId: pi.instanceId,
        permitted: true,
      }),
    ).toBeNull();
    expect(
      voiceUnavailableReason({
        providers: [pi, { ...codex, enabled: false }],
        providerInstanceId: pi.instanceId,
        permitted: true,
      }),
    ).toBe("Voice needs an enabled Codex provider for speech.");
  });

  it("waits for the server config and requires control permission", () => {
    expect(
      voiceUnavailableReason({
        providers: null,
        providerInstanceId: codex.instanceId,
        permitted: true,
      }),
    ).toBe("Checking voice availability…");
    expect(
      voiceUnavailableReason({
        providers: [codex],
        providerInstanceId: codex.instanceId,
        permitted: false,
      }),
    ).toBe("This connection needs permission to control the thread.");
  });
});
