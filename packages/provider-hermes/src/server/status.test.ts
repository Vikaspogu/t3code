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
});

const settings = Schema.decodeSync(HermesSettings)({
  enabled: true,
  endpoint: "ws://hermes.test/api/ws",
  profileId: "/profile",
  principalId: "uid:1000",
});

const snapshot = (environment: NodeJS.ProcessEnv) =>
  makeHermesSnapshot(settings, environment).pipe(Effect.provide(FileSystem.layerNoop({})));

describe("Hermes provider status", () => {
  it.effect("does not probe without session preconditions", () =>
    Effect.gen(function* () {
      const result = yield* snapshot({
        HERMES_SESSION_TOKEN: "secret",
        HERMES_GATEWAY_URL: settings.endpoint,
      });
      expect(result.status).toBe("warning");
      expect(result.message).toContain("HERMES_STATE_DIR");
    }),
  );

  it.effect("reports ticket authentication failure without an Effect cause dump", () =>
    Effect.gen(function* () {
      globalThis.fetch = async () => new Response("denied", { status: 401 });
      const result = yield* snapshot({
        HERMES_SESSION_TOKEN: "secret",
        HERMES_GATEWAY_URL: settings.endpoint,
        HERMES_STATE_DIR: "/external/hermes",
        HERMES_ALLOW_CLEARTEXT: "1",
      });
      expect(result.status).toBe("error");
      expect(result.auth.status).toBe("unauthenticated");
      expect(result.message).toContain("401");
      expect(result.message).not.toContain("Cause");
    }),
  );
});
