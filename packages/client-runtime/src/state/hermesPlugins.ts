import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createHermesPluginEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    listToolsQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:hermes-plugins:list-tools",
      tag: WS_METHODS.hermesPluginsListTools,
    }),
    invoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:hermes-plugins:invoke",
      tag: WS_METHODS.hermesPluginsInvoke,
    }),
  };
}
