import { useAtomValue } from "@effect/atom-react";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Link } from "@tanstack/react-router";
import { MicIcon, MicOffIcon, PhoneOffIcon, AudioLinesIcon } from "lucide-react";
import { Button } from "../../components/ui/button";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { voiceCommands } from "./commands";
import {
  VoiceCallController,
  selectVoiceTask,
  voiceCallStatus,
  voiceTaskCompletedSeconds,
  voiceTaskStatusLabel,
  type VoiceAudioSink,
  type VoiceCallPlatform,
  type VoiceCallView,
  type VoiceMediaStream,
  type VoiceMediaTrack,
  type VoicePeerConnection,
} from "@t3tools/client-runtime/voice";

export const VoiceContext = createContext<{
  controller: VoiceCallController;
  view: VoiceCallView;
  conversationExpanded: boolean;
  setConversationExpanded: (expanded: boolean) => void;
} | null>(null);

export { selectVoiceTask, voiceCallStatus, voiceTaskCompletedSeconds, voiceTaskStatusLabel };

function value<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export function VoiceProvider({
  children,
  showFallback = false,
}: {
  children: ReactNode;
  showFallback?: boolean;
}) {
  const start = useAtomCommand(voiceCommands.start, { reportFailure: false });
  const submit = useAtomCommand(voiceCommands.submit, { reportFailure: false });
  const end = useAtomCommand(voiceCommands.end, { reportFailure: false });
  const renewPresence = useAtomCommand(voiceCommands.renewPresence, { reportFailure: false });
  const snapshot = useAtomCommand(voiceCommands.snapshot, { reportFailure: false });
  const [controller] = useState(
    () =>
      new VoiceCallController(
        {
          start: async (target, input) =>
            value(
              await start({
                environmentId: target.environmentId,
                input: { ...input, threadId: target.threadId },
              }),
            ),
          submit: async (target, input) =>
            value(await submit({ environmentId: target.environmentId, input })),
          end: async (target, callId) =>
            value(await end({ environmentId: target.environmentId, input: { callId } })),
          renewPresence: async (target, callId) =>
            value(await renewPresence({ environmentId: target.environmentId, input: { callId } })),
          snapshot: async (target, callId, afterSequence) =>
            value(
              await snapshot({
                environmentId: target.environmentId,
                input: { callId, afterSequence },
              }),
            ),
        },
        {
          microphone: () => {
            if (!navigator.mediaDevices?.getUserMedia)
              throw new Error("Voice needs microphone access over HTTPS or localhost.");
            return navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            }) as unknown as Promise<VoiceMediaStream>;
          },
          peer: () => new RTCPeerConnection() as unknown as VoicePeerConnection,
          audio: () => new Audio() as unknown as VoiceAudioSink,
          callId: randomUUID,
          remoteStream: (track: VoiceMediaTrack) =>
            new MediaStream([track as unknown as MediaStreamTrack]) as unknown as VoiceMediaStream,
        } satisfies VoiceCallPlatform,
      ),
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const canOperate = useAtomValue(
    voiceCommands.start.permissionAtom(view.target?.environmentId ?? null),
  );
  useEffect(() => {
    if (view.target && !canOperate) controller.permissionRevoked();
  }, [canOperate, controller, view.target]);
  useEffect(() => {
    const close = () => controller.end();
    window.addEventListener("pagehide", close);
    return () => {
      window.removeEventListener("pagehide", close);
      controller.end();
    };
  }, [controller]);

  const active = view.state === "starting" || view.state === "connected";
  const [conversationPreference, setConversationPreference] = useState<{
    key: string;
    expanded: boolean;
  } | null>(null);
  const conversationKey = `${view.snapshot?.callId ?? "pending"}:${active}`;
  const conversationExpanded =
    conversationPreference?.key === conversationKey ? conversationPreference.expanded : active;
  const setConversationExpanded = useCallback(
    (expanded: boolean) => {
      setConversationPreference({ key: conversationKey, expanded });
    },
    [conversationKey],
  );
  const context = useMemo(
    () => ({ controller, view, conversationExpanded, setConversationExpanded }),
    [controller, view, conversationExpanded, setConversationExpanded],
  );
  return (
    <VoiceContext value={context}>
      {children}
      {showFallback && active ? (
        <section
          aria-label="Active voice call"
          className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-popover p-3"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <AudioLinesIcon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p role="status" className="text-sm font-medium">
                {voiceCallStatus(view)}
              </p>
              {view.target ? (
                <Link
                  to="/$environmentId/$threadId"
                  params={buildThreadRouteParams(view.target)}
                  className="block truncate text-xs text-muted-foreground underline underline-offset-2"
                >
                  {view.snapshot?.threadTitle || "Return to the call’s thread"}
                </Link>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={view.muted ? "secondary" : "outline"}
              size="sm"
              aria-pressed={view.muted}
              onClick={controller.toggleMute}
            >
              {view.muted ? <MicOffIcon /> : <MicIcon />}
              {view.muted ? "Unmute" : "Mute"}
            </Button>
            <Button variant="destructive" size="sm" onClick={controller.end}>
              <PhoneOffIcon />
              End call
            </Button>
          </div>
        </section>
      ) : null}
    </VoiceContext>
  );
}
