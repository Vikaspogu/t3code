// @effect-diagnostics processEnvInEffect:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HermesSettings } from "../settings.ts";
import { makeHermesSnapshot } from "./status.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.HERMES_SESSION_TOKEN;
  delete process.env.HERMES_GATEWAY_URL;
  delete process.env.HERMES_STATE_DIR;
  delete process.env.HERMES_ALLOW_CLEARTEXT;
});

const settings = Schema.decodeSync(HermesSettings)({
  enabled: true,
  endpoint: "ws://hermes.test/api/ws",
  profileId: "/profile",
  principalId: "uid:1000",
});

const snapshot = () => makeHermesSnapshot(settings).pipe(Effect.provide(FileSystem.layerNoop({})));

describe("Hermes provider status", () => {
  it.effect("does not probe without global session preconditions", () =>
    Effect.gen(function* () {
      process.env.HERMES_SESSION_TOKEN = "secret";
      process.env.HERMES_GATEWAY_URL = settings.endpoint;
      const result = yield* snapshot();
      expect(result.status).toBe("warning");
      expect(result.message).toContain("HERMES_STATE_DIR");
    }),
  );

  it.effect("reports ticket authentication failure without an Effect cause dump", () =>
    Effect.gen(function* () {
      process.env.HERMES_SESSION_TOKEN = "secret";
      process.env.HERMES_GATEWAY_URL = settings.endpoint;
      process.env.HERMES_STATE_DIR = "/external/hermes";
      process.env.HERMES_ALLOW_CLEARTEXT = "1";
      globalThis.fetch = async () => new Response("denied", { status: 401 });
      const result = yield* snapshot();
      expect(result.status).toBe("error");
      expect(result.auth.status).toBe("unauthenticated");
      expect(result.message).toContain("401");
      expect(result.message).not.toContain("Cause");
    }),
  );
});
