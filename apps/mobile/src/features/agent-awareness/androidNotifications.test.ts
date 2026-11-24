import { describe, expect, it, vi } from "vite-plus/test";

import * as notifications from "./androidNotifications";

const native = vi.hoisted(() => ({
  getSelfHostedPushStatus: vi.fn<() => string>(),
  configureSelfHostedPush: vi.fn(),
  disableSelfHostedPush: vi.fn(),
  removeSelfHostedPush: vi.fn(),
  getSelfHostedPushEnrollment: vi.fn<() => string>(),
}));

vi.mock("expo-constants", () => ({ default: { expoConfig: { scheme: "test-t3" } } }));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => native }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

const ntfyOrigin = "https://ntfy.example.test";
const enrollment = {
  endpoint: `${ntfyOrigin}/up0123456789ab?up=1`,
  p256dh: `BA${"A".repeat(85)}`,
  auth: "A".repeat(22),
  installationId: "installation-1",
  environmentId: "env-1",
};
const environment = {
  environmentId: enrollment.environmentId,
  ntfyOrigin,
  enabled: true,
  state: "needsAcl",
  lastReceivedAt: 0,
  error: null,
};

function setStatus(environments: ReadonlyArray<object> = [environment]) {
  native.getSelfHostedPushStatus.mockReturnValue(
    JSON.stringify({ installationId: enrollment.installationId, environments }),
  );
}

describe("Android self-hosted push bridge", () => {
  it("exports only a validated enrollment for the bound environment and origin", () => {
    setStatus();
    native.getSelfHostedPushEnrollment.mockReturnValue(JSON.stringify(enrollment));
    expect(JSON.parse(notifications.getSelfHostedPushEnrollment("env-1"))).toEqual(enrollment);
    expect(notifications.getSelfHostedPushStatus()?.environments[0]).toEqual(environment);

    for (const invalid of [
      { ...enrollment, endpoint: "https://other.example.test/up1?up=1" },
      { ...enrollment, endpoint: `${ntfyOrigin}/up1?up=1#fragment` },
      { ...enrollment, environmentId: "env-2" },
      { ...enrollment, installationId: "installation-2" },
      { ...enrollment, auth: "invalid" },
      { ...enrollment, auth: `${enrollment.auth}==` },
      { ...enrollment, token: "fake-publisher-token" },
    ]) {
      native.getSelfHostedPushEnrollment.mockReturnValue(JSON.stringify(invalid));
      expect(() => notifications.getSelfHostedPushEnrollment("env-1")).toThrow(
        "Invalid self-hosted push enrollment",
      );
    }
    setStatus([{ ...environment, enabled: false, state: "disabled" }]);
    expect(() => notifications.getSelfHostedPushEnrollment("env-1")).toThrow();
  });

  it("does not trust verified status without a positive native receipt timestamp", () => {
    setStatus([{ ...environment, state: "verified" }]);
    expect(() => notifications.getSelfHostedPushStatus()).toThrow(
      "Invalid self-hosted push status",
    );
    setStatus([{ ...environment, state: "verified", lastReceivedAt: 1 }]);
    expect(notifications.getSelfHostedPushStatus()?.environments[0]?.lastReceivedAt).toBe(1);
  });

  it("rejects non-origin URLs before configuring native registration", () => {
    setStatus([]);
    native.configureSelfHostedPush.mockClear();
    for (const invalid of [
      "http://ntfy.example.test",
      `${ntfyOrigin}/path/..`,
      `${ntfyOrigin}?`,
      "https://user:pass@ntfy.example.test",
      "https://ntfy.example.test:65536",
    ]) {
      expect(() => notifications.configureSelfHostedPush("env-1", invalid)).toThrow();
    }
    expect(native.configureSelfHostedPush).not.toHaveBeenCalled();
    notifications.configureSelfHostedPush("env-1", `${ntfyOrigin}/`);
    expect(native.configureSelfHostedPush).toHaveBeenCalledWith("env-1", ntfyOrigin, "test-t3");
  });

  it("revokes missing bindings at startup and on catalog removal, not during hydration", () => {
    const disabled = { ...environment, enabled: false, state: "disabled" };
    setStatus([disabled, { ...environment, environmentId: "env-2" }]);
    native.removeSelfHostedPush.mockClear();
    notifications.reconcileSelfHostedPushEnvironments({ isReady: false, entries: new Map() });
    expect(native.removeSelfHostedPush).not.toHaveBeenCalled();
    notifications.reconcileSelfHostedPushEnvironments({
      isReady: true,
      entries: new Map([["env-2", {}]]),
    });
    expect(native.removeSelfHostedPush.mock.calls).toEqual([["env-1"]]);
    setStatus([{ ...environment, environmentId: "env-2" }]);
    notifications.reconcileSelfHostedPushEnvironments({ isReady: true, entries: new Map() });
    expect(native.removeSelfHostedPush.mock.calls).toEqual([["env-1"], ["env-2"]]);
  });
});
