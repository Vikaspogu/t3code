import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { relayLayer, relayTracingAllowed } from "./relayTracing.ts";

const tracerFor = (
  policy?: ManagedPolicyDocument,
  environment: NodeJS.ProcessEnv = { T3CODE_TELEMETRY_ENABLED: "true" },
) =>
  Effect.service(RelayTracing.RelayClientTracer).pipe(
    Effect.provide(
      relayLayer(
        { serviceName: "t3code-server", runtime: "node", client: "environment-server" },
        { tracesUrl: "https://traces.example.com", tracesDataset: "relay", tracesToken: "token" },
      ).pipe(
        Layer.provide(ManagedPolicy.layerTest(policy)),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-relay-tracing-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(HostProcess.Environment, environment)),
      ),
    ),
  );

const tracesTo = (policy?: ManagedPolicyDocument) => Effect.map(tracerFor(policy), Option.isSome);

const staysLocal = (environment: NodeJS.ProcessEnv) =>
  Effect.map(
    tracerFor(undefined, environment),
    Option.exists(
      (tracer) =>
        tracer.span({
          name: "relay.test",
          parent: Option.none(),
          annotations: Context.empty(),
          links: [],
          startTime: 0n,
          kind: "internal",
          root: true,
          sampled: true,
        }) instanceof Tracer.NativeSpan,
    ),
  );

it.effect("a policy with telemetry off stops relay tracing to T3 Connect", () =>
  Effect.gen(function* () {
    assert.isTrue(yield* tracesTo());
    assert.isFalse(
      yield* tracesTo({
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { telemetry: false },
      }),
    );
  }),
);

it.effect("keeps relay spans local without opt-in", () =>
  Effect.gen(function* () {
    assert.isTrue(yield* staysLocal({}));
    assert.isFalse(yield* staysLocal({ T3CODE_TELEMETRY_ENABLED: "true" }));
  }),
);

it.effect("keeps relay spans local while desktop consent is unknown", () =>
  Effect.gen(function* () {
    assert.isTrue(
      yield* staysLocal({
        T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1",
        T3CODE_TELEMETRY_ENABLED: "true",
      }),
    );
  }),
);

it.effect("waits for desktop shell discovery and honors a late opt-in", () =>
  Effect.sync(() => {
    const environment: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
    assert.isFalse(relayTracingAllowed(environment));

    delete environment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;
    assert.isFalse(relayTracingAllowed(environment));

    environment.T3CODE_TELEMETRY_ENABLED = "true";
    assert.isTrue(relayTracingAllowed(environment));

    environment.T3CODE_TELEMETRY_ENABLED = "false";
    assert.isFalse(relayTracingAllowed(environment));
  }),
);
