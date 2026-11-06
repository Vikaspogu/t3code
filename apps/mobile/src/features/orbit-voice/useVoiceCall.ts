import type { ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  VoiceCallController,
  type VoiceCallView,
  type VoiceRpc,
} from "@t3tools/client-runtime/voice";
import { createMobileVoicePlatform } from "@t3tools/client-runtime/voice/mobile";
import { useMemo, useSyncExternalStore } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { useVoiceAvailability } from "./availability";
import { voiceCommands } from "./commands";

export function toErrorMessage(error: unknown) {
  return error instanceof Error && error.message !== "" ? error.message : "Something went wrong";
}

function valueOrThrow<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

// Hook consumers share the app registry but create distinct RPC wrappers.
const controllers = new Map<string, VoiceCallController>();

export function getVoiceController(target: ScopedThreadRef, rpc: VoiceRpc): VoiceCallController {
  const key = `${target.environmentId}:${target.threadId}`;
  let controller = controllers.get(key);
  if (!controller) {
    controller = new VoiceCallController(rpc, createMobileVoicePlatform());
    controllers.set(key, controller);
  }
  return controller;
}

function useVoiceRpc(): VoiceRpc {
  const start = useAtomCommand(voiceCommands.start, { reportFailure: false });
  const submit = useAtomCommand(voiceCommands.submit, { reportFailure: false });
  const end = useAtomCommand(voiceCommands.end, { reportFailure: false });
  const renewPresence = useAtomCommand(voiceCommands.renewPresence, { reportFailure: false });
  const snapshot = useAtomCommand(voiceCommands.snapshot, { reportFailure: false });
  return useMemo<VoiceRpc>(
    () => ({
      start: async (target, input) =>
        valueOrThrow(
          await start({
            environmentId: target.environmentId,
            input: { ...input, threadId: target.threadId },
          }),
        ),
      submit: async (target, input) =>
        valueOrThrow(await submit({ environmentId: target.environmentId, input })),
      end: async (target, callId) =>
        valueOrThrow(await end({ environmentId: target.environmentId, input: { callId } })),
      renewPresence: async (target, callId) =>
        valueOrThrow(
          await renewPresence({ environmentId: target.environmentId, input: { callId } }),
        ),
      snapshot: async (target, callId, afterSequence) =>
        valueOrThrow(
          await snapshot({
            environmentId: target.environmentId,
            input: { callId, afterSequence },
          }),
        ),
    }),
    [start, submit, end, renewPresence, snapshot],
  );
}

/**
 * Shared call state for one thread. The controller is created even when voice is
 * unavailable so the call surfaces can render uniformly; only starting is gated by
 * `unavailable`.
 */
export function useVoiceCall(
  target: ScopedThreadRef,
  providerInstanceId: ProviderInstanceId | undefined,
): {
  readonly controller: VoiceCallController;
  readonly view: VoiceCallView;
  readonly unavailable: string | null;
} {
  const rpc = useVoiceRpc();
  const unavailable = useVoiceAvailability(target, providerInstanceId);
  const controller = useMemo(() => getVoiceController(target, rpc), [rpc, target]);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { controller, view, unavailable };
}
