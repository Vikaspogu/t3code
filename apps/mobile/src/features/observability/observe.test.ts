import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  dispatchEvents: vi.fn(),
  loadPreferences: vi.fn(),
}));

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: { relay: { url: "https://relay.example.test" }, appVariant: "test" },
    },
  },
}));

vi.mock("expo-observe", () => ({
  Observe: {
    configure: mocks.configure,
    dispatchEvents: mocks.dispatchEvents,
    reportError: vi.fn(),
  },
}));

vi.mock("../../persistence/imperative", () => ({
  loadPreferences: mocks.loadPreferences,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("__DEV__", true);
  mocks.configure.mockReset();
  mocks.dispatchEvents.mockReset().mockResolvedValue(undefined);
  mocks.loadPreferences.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  { preference: undefined, enabled: false },
  { preference: false, enabled: false },
  { preference: true, enabled: true },
])("applies crash reporting opt-in for preference $preference", async ({ preference, enabled }) => {
  const configured = Promise.withResolvers<void>();
  mocks.configure.mockImplementation(() => {
    if (mocks.configure.mock.calls.length === 2) configured.resolve();
  });
  mocks.loadPreferences.mockResolvedValue({ crashReportsEnabled: preference });

  await import("./observe");
  await configured.promise;

  expect(mocks.configure).toHaveBeenLastCalledWith({
    dispatchingEnabled: enabled,
    environment: "test",
  });
  expect(mocks.dispatchEvents).toHaveBeenCalledTimes(1);
  expect(mocks.configure.mock.invocationCallOrder[1]!).toBeLessThan(
    mocks.dispatchEvents.mock.invocationCallOrder[0]!,
  );
});

it("keeps a crash-report choice made while preferences are loading", async () => {
  const preferences = Promise.withResolvers<{ crashReportsEnabled: boolean }>();
  const preferenceRead = Promise.withResolvers<void>();
  mocks.loadPreferences.mockImplementation(() => {
    preferenceRead.resolve();
    return preferences.promise;
  });

  const observe = await import("./observe");
  await preferenceRead.promise;
  await observe.setCrashReportsEnabled(true);
  preferences.resolve({ crashReportsEnabled: false });
  await preferences.promise;

  expect(mocks.configure).toHaveBeenCalledTimes(2);
  expect(mocks.configure).toHaveBeenNthCalledWith(1, {
    dispatchingEnabled: false,
    environment: "test",
  });
  expect(mocks.configure).toHaveBeenLastCalledWith({
    dispatchingEnabled: true,
    environment: "test",
  });
});

it("disables a persisted native setting when preferences cannot be read", async () => {
  const warning = Promise.withResolvers<void>();
  const warn = vi.spyOn(console, "warn").mockImplementation(warning.resolve);
  mocks.loadPreferences.mockRejectedValue(new Error("read failed"));

  await import("./observe");
  await warning.promise;

  expect(mocks.configure).toHaveBeenCalledExactlyOnceWith({
    dispatchingEnabled: false,
    environment: "test",
  });
  expect(warn).toHaveBeenCalledWith(
    "[observe] could not read the crash report setting",
    expect.any(Error),
  );
});
