import {
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
} from "@t3tools/shared/observability";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isRelayTracingEnabled } from "@t3tools/shared/otelEnvironment";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

export const relayTracingAllowed = (environment: Readonly<Record<string, string | undefined>>) =>
  environment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING !== "1" && isRelayTracingEnabled(environment);

/** Relay traces leave the machine for T3 Connect, so a policy with `telemetry: false` stops them. */
export const relayLayer = (
  resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
  tracingConfig?: RelayTracing.RelayClientTracingConfig | null,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const policy = yield* ManagedPolicy.ManagedPolicy;
      const environment = yield* HostProcess.Environment;
      // Build the exporter before shell discovery; its gate blocks spans until consent arrives.
      const resolvedConfig =
        tracingConfig === undefined
          ? resolveRelayClientTracingConfig({ ...environment, T3CODE_TELEMETRY_ENABLED: "true" })
          : tracingConfig;
      return RelayTracing.layer(
        ManagedPolicy.deniedBy(policy, "telemetry") === undefined ? resolvedConfig : null,
        {
          ...resource,
          serviceInstanceId: processServiceInstanceId(config.otelEnvironment.resourceAttributes),
        },
        {
          isEnabled: () => relayTracingAllowed(environment),
        },
      );
    }),
  );
export const layerHeadlessRelayClient = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});
