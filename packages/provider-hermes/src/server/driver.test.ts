// @effect-diagnostics processEnvInEffect:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HermesDriver } from "./driver.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layerTest)("HermesDriver", (it) => {
  it.effect("expands a saved home-relative state directory before probing", () =>
    Effect.gen(function* () {
      globalThis.fetch = async () => new Response("denied", { status: 401 });
      const config = {
        ...HermesDriver.defaultConfig(),
        endpoint: "ws://hermes.test/api/ws",
        profileId: "/profile",
        principalId: "uid:1000",
      };
      const instance = yield* HermesDriver.create({
        instanceId: ProviderInstanceId.make("hermes-test"),
        displayName: "Hermes test",
        enabled: true,
        config,
        environment: [
          { name: "HERMES_SESSION_TOKEN", value: "secret", sensitive: true },
          { name: "HERMES_GATEWAY_URL", value: config.endpoint, sensitive: true },
          { name: "HERMES_STATE_DIR", value: "~/.hermes/t3", sensitive: true },
          { name: "HERMES_ALLOW_CLEARTEXT", value: "1", sensitive: false },
        ],
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, "/home/ada"));

      const snapshot = yield* instance.snapshot.refresh;
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("401");
      expect(snapshot.message).not.toContain("HERMES_STATE_DIR");
    }),
  );

  it.effect("does not inherit process Hermes secrets for an instance endpoint", () =>
    Effect.gen(function* () {
      process.env.HERMES_SESSION_TOKEN = "global-secret";
      process.env.HERMES_GATEWAY_URL = "ws://global.test/api/ws";
      process.env.HERMES_STATE_DIR = "/external/global-hermes";
      process.env.HERMES_ALLOW_CLEARTEXT = "1";
      try {
        const config = {
          ...HermesDriver.defaultConfig(),
          endpoint: "ws://instance.test/api/ws",
          profileId: "/profile",
          principalId: "uid:1000",
        };
        const instance = yield* HermesDriver.create({
          instanceId: ProviderInstanceId.make("hermes-test"),
          displayName: "Hermes test",
          enabled: true,
          config,
          environment: [
            { name: "HERMES_GATEWAY_URL", value: config.endpoint, sensitive: true },
            { name: "HERMES_STATE_DIR", value: "/external/instance-hermes", sensitive: true },
          ],
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, "/home/ada"));

        const snapshot = yield* instance.snapshot.refresh;
        expect(snapshot.status).toBe("warning");
        expect(snapshot.message).toContain("Set the Hermes token");
      } finally {
        delete process.env.HERMES_SESSION_TOKEN;
        delete process.env.HERMES_GATEWAY_URL;
        delete process.env.HERMES_STATE_DIR;
        delete process.env.HERMES_ALLOW_CLEARTEXT;
      }
    }),
  );
});
