import { T, Var, useGT, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { DateTime } from "effect";
import type { OrbitVoiceSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  Volume2Icon,
  CircleCheckIcon,
  AudioLinesIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { ThreadDetailsSection } from "../../components/chat/ThreadDetailsSection";
import { WorkingTimer } from "../../components/chat/WorkingTimer";
import { cn } from "../../lib/utils";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { useThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { voiceCommands } from "./commands";
import { formatCallClock } from "@t3tools/shared/orchestrationTiming";
import {
  VoiceContext,
  selectVoiceTask,
  voiceCallStatus,
  voiceTaskCompletedSeconds,
  voiceTaskStatusLabel,
} from "./VoiceProvider";

function useVoiceAvailability(target: ScopedThreadRef) {
  const gt = useGT();
  const thread = useThreadShell(target);
  const config = useAtomValue(serverEnvironment.configValueAtom(target.environmentId));
  const permitted = useAtomValue(voiceCommands.start.permissionAtom(target.environmentId));
  const provider = config?.providers.find(
    (entry) => entry.instanceId === thread?.providerInstanceId,
  );
  if (!thread) return gt("Send a message in this thread before starting voice.");
  if (!config) return gt("Checking voice availability…");
  if (!provider || (provider.driver !== "codex" && provider.driver !== "pi"))
    return gt("Voice is available in Codex and Pi threads.");
  if (!provider.enabled) return gt("Enable this provider in Settings to use voice.");
  // pi threads borrow a Codex runtime for the speech bridge (audio/STT/TTS).
  if (
    provider.driver === "pi" &&
    !config.providers.some((entry) => entry.driver === "codex" && entry.enabled)
  )
    return gt("Voice needs an enabled Codex provider for speech.");
  if (!permitted) return gt("This connection needs permission to control the thread.");
  return null;
}

export function VoiceButton(props: { target: ScopedThreadRef; onOpen: () => void }) {
  const voice = useContext(VoiceContext);
  return voice ? <BoundVoiceButton {...props} voice={voice} /> : null;
}

function BoundVoiceButton({
  target,
  onOpen,
  voice,
}: {
  target: ScopedThreadRef;
  onOpen: () => void;
  voice: NonNullable<React.ContextType<typeof VoiceContext>>;
}) {
  const messages = useMessages();
  const gt = useGT();
  const unavailable = useVoiceAvailability(target);
  const active = voice.view.state === "starting" || voice.view.state === "connected";
  const label = active
    ? gt("Voice call controls, {status}", {
        status: voiceCallStatus(voice.view, messages).toLowerCase(),
      })
    : unavailable
      ? gt("Voice unavailable")
      : gt("Start voice call");
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={<Button size="icon" variant={active ? "secondary" : "ghost-muted"} />}
          aria-label={label}
          onClick={() => {
            onOpen();
            if (!active && !unavailable) void voice.controller.start(target);
          }}
        >
          {voice.view.muted && active ? <MicOffIcon /> : <AudioLinesIcon />}
        </TooltipTrigger>
        <TooltipPopup>{active ? label : (unavailable ?? label)}</TooltipPopup>
      </Tooltip>
      {active ? (
        <Tooltip>
          <TooltipTrigger
            render={<Button size="icon" variant="ghost-destructive" />}
            aria-label={gt("End call")}
            onClick={voice.controller.end}
          >
            <PhoneOffIcon />
          </TooltipTrigger>
          <TooltipPopup>
            <T>End call</T>
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

// m:ss clock for the call header chip and static durations (Completed for 0:41).

function CallTimer({ createdAt }: { createdAt: string }) {
  const [durationSeconds, setDurationSeconds] = useState(() =>
    Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000)),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Update the active call clock once per second and cancel its timer on unmount.
  useEffect(() => {
    const interval = window.setInterval(() => {
      setDurationSeconds(
        Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000)),
      );
    }, 1000);
    return () => window.clearInterval(interval);
  }, [createdAt]);
  return <>{formatCallClock(durationSeconds)}</>;
}

function VoiceConversation({
  captions,
  active,
  expanded,
  onExpandedChange,
}: {
  captions: OrbitVoiceSnapshot["captions"];
  active: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const gt = useGT();
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const lastSequence = captions.at(-1)?.sequence;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the transcript viewport at the newest caption while following.
  useEffect(() => {
    if (lastSequence !== undefined && expanded && following.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [lastSequence, expanded]);

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(open) => {
        following.current = true;
        setShowLatest(false);
        onExpandedChange(open);
      }}
    >
      <div className="flex items-center justify-between gap-2 border-t border-border/65 pt-2">
        <CollapsibleTrigger
          render={<Button variant="ghost-muted" size="sm" />}
          aria-label={expanded ? gt("Hide conversation") : gt("Show conversation")}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          {active ? gt("Conversation") : gt("Last call conversation")}
          {captions.length > 0 ? (
            <span className="text-2xs tabular-nums">{captions.length}</span>
          ) : null}
        </CollapsibleTrigger>
        {expanded && showLatest ? (
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => {
              following.current = true;
              setShowLatest(false);
              if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
            }}
          >
            <T>Latest</T>
          </Button>
        ) : null}
      </div>
      <CollapsiblePanel animate={false}>
        {expanded ? (
          <div
            ref={viewport}
            role="log"
            aria-label={active ? gt("Voice conversation") : gt("Last call conversation")}
            aria-live={active ? "polite" : "off"}
            tabIndex={0}
            onScroll={(event) => {
              const element = event.currentTarget;
              following.current =
                element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
              setShowLatest(!following.current);
            }}
            className="mt-2 max-h-56 space-y-4 overflow-y-auto overscroll-contain rounded-md px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {captions.length === 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                <T>Your words and Codex replies appear here.</T>
              </p>
            ) : (
              captions.map((caption) => (
                <div key={caption.sequence}>
                  <p className="mb-1 text-2xs font-medium text-muted-foreground">
                    {caption.role === "user" ? gt("You") : "Codex"}
                  </p>
                  <p className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed">
                    {caption.text}
                  </p>
                </div>
              ))
            )}
          </div>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function VoicePanel({ target }: { target: ScopedThreadRef }) {
  const voice = useContext(VoiceContext);
  return voice ? <BoundVoicePanel target={target} voice={voice} /> : null;
}

function BoundVoicePanel({
  target,
  voice,
}: {
  target: ScopedThreadRef;
  voice: NonNullable<React.ContextType<typeof VoiceContext>>;
}) {
  const messages = useMessages();
  const gt = useGT();
  const unavailable = useVoiceAvailability(target);
  const { controller, view } = voice;
  const active = view.state === "starting" || view.state === "connected";
  const destination = view.target ?? target;
  const destinationThread = useThreadShell(destination);
  const environment = useEnvironment(destination.environmentId);
  const anotherThread =
    destination.environmentId !== target.environmentId || destination.threadId !== target.threadId;
  const destinationTitle =
    view.snapshot?.threadTitle || destinationThread?.title || gt("This thread");
  const captions = view.snapshot?.captions ?? [];
  const tasks = view.snapshot?.tasks ?? [];
  const pendingTasks = tasks.filter(
    (task) => task.state === "queued" || task.state === "working" || task.state === "waiting",
  );
  const task = selectVoiceTask(tasks);
  const taskStatus = task ? voiceTaskStatusLabel(task.state, messages) : null;
  const completedDurationSeconds = task ? voiceTaskCompletedSeconds(task) : null;
  const notice = view.message ?? (active ? view.snapshot?.message : null);
  const status =
    view.state === "idle" && unavailable
      ? gt("Voice unavailable")
      : voiceCallStatus(view, messages);

  return (
    <ThreadDetailsSection headingId="orbit-voice-heading" title={gt("Voice")} separated={false}>
      <div className="space-y-4 px-1.5 pt-1 pb-2">
        <div className="flex items-center gap-3">
          <div
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"
          >
            {active && view.muted ? (
              <MicOffIcon className="size-5" />
            ) : (
              <AudioLinesIcon className="size-5" />
            )}
          </div>
          <div className="min-w-0 space-y-0.5">
            <p
              ref={observeVisibleAnimation}
              className={cn(
                "text-base font-medium leading-snug",
                view.activity !== null && "live-tool-shine",
              )}
              role="status"
            >
              {status}
            </p>
            {view.state === "connected" ? (
              <p className="truncate text-xs text-muted-foreground">for {destinationTitle}</p>
            ) : null}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {view.state === "starting"
                ? view.microphone
                  ? gt("Your microphone is ready.")
                  : gt("Check your browser’s microphone prompt.")
                : active
                  ? view.muted
                    ? gt("Unmute when you’re ready to speak.")
                    : gt("Keep talking while your agent works.")
                  : view.state === "idle"
                    ? gt("Talk through an idea or ask for a change.")
                    : gt("Your microphone is off.")}
            </p>
          </div>
          {view.state === "connected" && view.connectedAt !== null ? (
            <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-2xs tabular-nums text-muted-foreground">
              <CallTimer createdAt={view.connectedAt} />
            </span>
          ) : null}
        </div>
        <div className="space-y-0.5">
          <p className="line-clamp-2 wrap-anywhere text-sm font-medium">{destinationTitle}</p>
          <p className="truncate text-xs text-muted-foreground">
            {environment?.label || gt("Call destination")}
          </p>
          {anotherThread || (!active && tasks.length > 0) ? (
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(destination)}
              className="inline-block max-w-full truncate text-xs text-primary underline underline-offset-2"
            >
              <T>
                Return to <Var>{destinationTitle}</Var>
              </T>
            </Link>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active ? (
            <>
              <Button
                variant={view.muted ? "secondary" : "outline"}
                size="default"
                aria-pressed={view.muted}
                onClick={controller.toggleMute}
              >
                {view.muted ? <MicOffIcon /> : <MicIcon />}
                {view.muted ? gt("Unmute") : gt("Mute")}
              </Button>
              <Button variant="destructive" size="default" onClick={controller.end}>
                <PhoneOffIcon />
                <T>End call</T>
              </Button>
            </>
          ) : (
            <Button
              size="default"
              disabled={unavailable !== null}
              onClick={() => void controller.start(target)}
            >
              <AudioLinesIcon />
              {anotherThread ? gt("Start voice here") : gt("Start voice call")}
            </Button>
          )}
        </div>
        {!active && anotherThread ? (
          <p className="text-xs text-muted-foreground">
            <T>A new call uses the thread you are viewing.</T>
          </p>
        ) : null}
        {!active && unavailable ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{unavailable}</p>
        ) : null}
        {notice ? (
          <p
            role={view.state === "error" ? "alert" : "status"}
            className={
              view.state === "error"
                ? "wrap-anywhere text-xs leading-relaxed text-destructive"
                : "wrap-anywhere text-xs leading-relaxed text-muted-foreground"
            }
          >
            {notice}
          </p>
        ) : null}
        {view.playbackBlocked && active ? (
          <div className="space-y-2">
            <p role="status" className="text-xs text-muted-foreground">
              <T>Speaker audio is blocked.</T>
            </p>
            <Button variant="outline" size="sm" onClick={() => void controller.retryPlayback()}>
              <Volume2Icon />
              <T>Enable speaker audio</T>
            </Button>
          </div>
        ) : null}
        {active && (taskStatus || view.snapshot?.routing) ? (
          <div className="space-y-1 border-t border-border/65 pt-3">
            <p className="text-2xs font-medium text-muted-foreground">
              <T>Coding task</T>
            </p>
            <div role="status" className="space-y-1 text-xs leading-relaxed">
              {task?.title ? (
                <p className="line-clamp-2 wrap-anywhere font-medium">{task.title}</p>
              ) : null}
              {view.snapshot?.routing ? (
                <p ref={observeVisibleAnimation} className="live-tool-shine">
                  <T>Understanding your request…</T>
                </p>
              ) : null}
              {task?.state === "working" ? (
                <p className="flex items-center gap-1.5 font-medium">
                  <LoaderCircleIcon
                    aria-hidden="true"
                    ref={observeVisibleAnimation}
                    className="size-3.5 motion-safe:visible-animate-spin text-muted-foreground"
                  />
                  <span ref={observeVisibleAnimation} className="live-tool-shine">
                    <T>
                      Working for{" "}
                      <Var>
                        <WorkingTimer createdAt={DateTime.formatIso(task.startedAt)} />
                      </Var>
                    </T>
                  </span>
                </p>
              ) : task?.state === "waiting" ? (
                <p className="flex items-start gap-1.5 rounded-md bg-warning-surface px-2.5 py-2 text-warning-foreground">
                  <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  <T>Paused. Approval waiting in the thread.</T>
                </p>
              ) : task?.state === "completed" ? (
                <p className="flex items-center gap-1.5 text-success-foreground">
                  <CircleCheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  <T>
                    Completed for <Var>{formatCallClock(completedDurationSeconds ?? 0)}</Var>
                  </T>
                </p>
              ) : task?.state === "failed" ? (
                <p className="flex items-center gap-1.5 text-destructive">
                  <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  <T>Task failed</T>
                </p>
              ) : taskStatus ? (
                <p>{taskStatus}</p>
              ) : null}
              {task &&
              (task.state === "working" || task.state === "waiting") &&
              task.activity !== null ? (
                <p ref={observeVisibleAnimation} className="live-tool-shine truncate">
                  {task.activity}
                </p>
              ) : null}
              {task &&
              (task.state === "working" || task.state === "waiting") &&
              task.steps.length > 0 ? (
                <ul className="space-y-0.5">
                  {[...new Set(task.steps)].map((step) => (
                    <li key={step} className="flex items-center gap-1.5 text-muted-foreground">
                      <CircleCheckIcon
                        aria-hidden="true"
                        className="size-3 shrink-0 text-success-foreground"
                      />
                      <span className="truncate">{step}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {pendingTasks.length > 1 ? (
                <p className="text-muted-foreground">
                  <T>
                    <Var>{pendingTasks.length}</Var> accepted tasks pending
                  </T>
                </p>
              ) : null}
            </div>
          </div>
        ) : !active && pendingTasks.length > 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            <T>Check accepted work in the thread.</T>
          </p>
        ) : null}
        {view.snapshot && (active || captions.length > 0) ? (
          <VoiceConversation
            key={`${view.snapshot.callId}:${active}`}
            captions={captions}
            active={active}
            expanded={voice.conversationExpanded}
            onExpandedChange={voice.setConversationExpanded}
          />
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

export function VoiceCallBar({ target, onOpen }: { target: ScopedThreadRef; onOpen: () => void }) {
  const voice = useContext(VoiceContext);
  return voice ? <BoundVoiceCallBar target={target} onOpen={onOpen} voice={voice} /> : null;
}

function BoundVoiceCallBar({
  target,
  onOpen,
  voice,
}: {
  target: ScopedThreadRef;
  onOpen: () => void;
  voice: NonNullable<React.ContextType<typeof VoiceContext>>;
}) {
  const messages = useMessages();
  const gt = useGT();
  const { controller, view } = voice;
  const active = view.state === "starting" || view.state === "connected";
  const sameThread =
    view.target !== null &&
    view.target.environmentId === target.environmentId &&
    view.target.threadId === target.threadId;
  const tasks = view.snapshot?.tasks ?? [];
  const working = tasks.find((task) => task.state === "working");
  const waiting = tasks.some((task) => task.state === "waiting");
  if (!active || !sameThread) return null;
  const lastCaption = view.snapshot?.captions.at(-1)?.text ?? "";
  return (
    <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1.5 text-xs">
      <button
        type="button"
        aria-label={gt("Open voice controls")}
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-accent"
      >
        {view.muted ? (
          <MicOffIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <AudioLinesIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          ref={observeVisibleAnimation}
          role="status"
          className={cn("shrink-0 font-medium", view.activity !== null && "live-tool-shine")}
        >
          {voiceCallStatus(view, messages)}
        </span>
        {working ? (
          <span className="flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground">
            <LoaderCircleIcon
              aria-hidden="true"
              ref={observeVisibleAnimation}
              className="size-3 motion-safe:visible-animate-spin"
            />
            <WorkingTimer createdAt={DateTime.formatIso(working.startedAt)} />
          </span>
        ) : null}
        {waiting ? (
          <span className="shrink-0 font-medium text-warning-foreground">
            <T>Approval waiting</T>
          </span>
        ) : null}
        {lastCaption ? (
          <span className="min-w-0 truncate text-muted-foreground">{lastCaption}</span>
        ) : null}
      </button>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label={view.muted ? gt("Unmute") : gt("Mute")}
        aria-pressed={view.muted}
        onClick={controller.toggleMute}
      >
        {view.muted ? <MicOffIcon /> : <MicIcon />}
      </Button>
      <Button
        variant="ghost-destructive"
        size="icon-xs"
        aria-label={gt("End call")}
        onClick={controller.end}
      >
        <PhoneOffIcon />
      </Button>
    </div>
  );
}
