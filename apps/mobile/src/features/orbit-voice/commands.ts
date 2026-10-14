import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";

export const voiceCommands = {
  start: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "orbit-voice:start",
    tag: WS_METHODS.orbitVoiceStart,
  }),
  submit: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "orbit-voice:submit",
    tag: WS_METHODS.orbitVoiceSubmit,
  }),
  end: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "orbit-voice:end",
    tag: WS_METHODS.orbitVoiceEnd,
  }),
  renewPresence: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "orbit-voice:renew-presence",
    tag: WS_METHODS.orbitVoiceRenewPresence,
  }),
  snapshot: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "orbit-voice:snapshot",
    tag: WS_METHODS.orbitVoiceSnapshot,
  }),
};
