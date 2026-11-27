import { createHermesPluginEnvironmentAtoms } from "@t3tools/client-runtime/state/hermes-plugins";

import { connectionAtomRuntime } from "../connection/runtime";

export const hermesPluginEnvironment = createHermesPluginEnvironmentAtoms(connectionAtomRuntime);
