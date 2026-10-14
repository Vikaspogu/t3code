// @vitest-environment jsdom

import { act, useState, useSyncExternalStore, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import {
  MessageId,
  RunId,
  type OrbitVoiceSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { VoiceButton, VoiceCallBar, VoicePanel } from "./VoiceControls";
import { VoiceContext } from "./VoiceProvider";
import {
  VoiceCallController,
  type VoiceAudioSink,
  type VoiceCallPlatform,
  type VoiceMediaStream,
  type VoiceMediaTrack,
  type VoicePeerConnection,
  type VoiceRpc,
} from "@t3tools/client-runtime/voice";

const availability = vi.hoisted(() => ({
  config: true,
  driver: "codex",
  enabled: true,
  permitted: true,
  codexEnabled: true,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "permission"
      ? availability.permitted
      : availability.config
        ? {
            providers: [
              { instanceId: "codex", driver: availability.driver, enabled: availability.enabled },
              ...(availability.driver === "pi"
                ? [
                    {
                      instanceId: "codex-speech",
                      driver: "codex",
                      enabled: availability.codexEnabled,
                    },
                  ]
                : []),
            ],
          }
        : null,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "config" },
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (target: ScopedThreadRef) => ({
    title: target.threadId === "thread-a" ? "Build the app" : "Another project",
    providerInstanceId: "codex",
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: (id: string) => ({
    label: id === "environment-a" ? "Work laptop" : "Other server",
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./commands", () => ({ voiceCommands: { start: { permissionAtom: () => "permission" } } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    params,
    to: _to,
    ...props
  }: ComponentProps<"a"> & { params: ScopedThreadRef; to: string }) => (
    <a {...props} href={`/${params.environmentId}/${params.threadId}`} />
  ),
}));

const target = { environmentId: "environment-a", threadId: "thread-a" } as ScopedThreadRef;
const otherTarget = { environmentId: "environment-b", threadId: "thread-b" } as ScopedThreadRef;
const initial: OrbitVoiceSnapshot = {
  callId: "call-a",
  threadId: target.threadId,
  threadTitle: "Build the app",
  state: "connected",
  message: null,
  sequence: 1,
  captions: [],
  tasks: [],
  routing: false,
};
const startedAt = DateTime.makeUnsafe(Date.now() - 60_000);
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  Object.assign(availability, {
    config: true,
    driver: "codex",
    enabled: true,
    codexEnabled: true,
    permitted: true,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount(
  options: { composerOnly?: boolean; callBar?: boolean; snapshot?: OrbitVoiceSnapshot } = {},
) {
  const track = { enabled: true, stop: vi.fn(), onended: null };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as VoiceMediaStream;
  const channel = {
    onmessage: null as ((event: { data: string }) => void) | null,
    readyState: "open",
    close: vi.fn(),
  };
  const peer = {
    addTrack: vi.fn(),
    createDataChannel: () => channel,
    createOffer: async () => ({ type: "offer", sdp: "offer" }),
    setLocalDescription: vi.fn(async () => {}),
    localDescription: { sdp: "offer" },
    setRemoteDescription: vi.fn(async () => {}),
    close: vi.fn(),
    connectionState: "connected",
    ontrack: null as
      | ((event: { streams: VoiceMediaStream[]; track: VoiceMediaTrack }) => void)
      | null,
  };
  const audio = { play: vi.fn(async () => {}), pause: vi.fn(), srcObject: null, autoplay: false };
  const rpc = {
    start: vi.fn(async () => ({ answerSdp: "answer", snapshot: options.snapshot ?? initial })),
    submit: vi.fn(async () => initial),
    end: vi.fn(async () => ({ ...initial, state: "ended" as const })),
    renewPresence: vi.fn(async () => initial),
    snapshot: vi.fn(() => new Promise<OrbitVoiceSnapshot>(() => {})),
  } satisfies VoiceRpc;
  const browser = {
    microphone: vi.fn(async () => stream),
    peer: () => peer as unknown as VoicePeerConnection,
    audio: () => audio as unknown as VoiceAudioSink,
    callId: () => "call-a",
    remoteStream: (track: VoiceMediaTrack) =>
      ({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      }) satisfies VoiceMediaStream,
  } satisfies VoiceCallPlatform;
  const controller = new VoiceCallController(rpc, browser);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const opened = vi.fn();
  function Harness({ selected }: { selected: ScopedThreadRef }) {
    const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const [conversationExpanded, setConversationExpanded] = useState(true);
    return (
      <VoiceContext value={{ controller, view, conversationExpanded, setConversationExpanded }}>
        <VoiceButton target={selected} onOpen={opened} />
        {!options.composerOnly ? <VoicePanel target={selected} /> : null}
        {options.callBar ? <VoiceCallBar target={selected} onOpen={opened} /> : null}
      </VoiceContext>
    );
  }
  const render = async (selected = target) => {
    await act(async () => root.render(<Harness selected={selected} />));
  };
  await render();
  cleanups.push(async () => {
    await act(async () => {
      controller.end();
      root.unmount();
    });
    container.remove();
  });
  function button(name: string) {
    const found = Array.from(container.querySelectorAll("button")).find(
      (element) => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === name,
    );
    expect(found, `Expected the ${name} action`).toBeDefined();
    return found!;
  }
  const click = async (name: string) => {
    await act(async () => button(name).click());
  };
  let turn = 0;
  function sendTurn() {
    channel.onmessage?.({
      data: JSON.stringify({
        type: "turn.done",
        turn: { role: "user", id: `turn-${++turn}`, transcript: "A request" },
      }),
    });
  }
  function sendFinalUser(transcript: string) {
    channel.onmessage?.({
      data: JSON.stringify({
        type: "input_transcript.added",
        item: { type: "message", role: "user", id: `final-${++turn}`, transcript, is_final: true },
      }),
    });
  }
  const deliver = async (snapshot: OrbitVoiceSnapshot) => {
    rpc.submit.mockResolvedValueOnce(snapshot);
    await act(async () => sendTurn());
  };
  const start = async () => {
    await act(async () => controller.start(target));
  };
  return {
    audio,
    stream,
    container,
    controller,
    track,
    peer,
    rpc,
    browser,
    opened,
    render,
    button,
    click,
    start,
    deliver,
    sendTurn,
    sendFinalUser,
  };
}

it.each([
  [{ driver: "claude" }, "Voice is available in Codex and Pi threads."],
  [{ enabled: false }, "Enable this provider in Settings to use voice."],
  [{ driver: "pi", codexEnabled: false }, "Voice needs an enabled Codex provider for speech."],
  [{ config: false }, "Checking voice availability…"],
  [{ permitted: false }, "This connection needs permission to control the thread."],
])(
  "opens the unavailable explanation without requesting microphone access: %j",
  async (change, reason) => {
    Object.assign(availability, change);
    const ui = await mount();
    await ui.click("Voice unavailable");
    expect(ui.opened).toHaveBeenCalledOnce();
    expect(ui.container.textContent).toContain(reason);
    expect(ui.button("Start voice call").disabled).toBe(true);
    expect(ui.browser.microphone).not.toHaveBeenCalled();
  },
);

it("composer End releases media while routing is pending and ignores its late reply", async () => {
  const ui = await mount({ composerOnly: true });
  await ui.start();
  let finish!: (snapshot: OrbitVoiceSnapshot) => void;
  ui.rpc.submit.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => ui.sendTurn());
  await ui.click("End call");
  expect(ui.track.stop).toHaveBeenCalledOnce();
  expect(ui.peer.close).toHaveBeenCalledOnce();
  expect(ui.rpc.end).toHaveBeenCalledWith(target, "call-a");
  await act(async () => finish({ ...initial, sequence: 5, routing: true }));
  expect(ui.controller.getSnapshot().state).toBe("ended");
});

it("folding the conversation preserves capture and new captions until it is reopened", async () => {
  const ui = await mount({
    snapshot: { ...initial, captions: [{ sequence: 1, role: "user", text: "First request" }] },
  });
  await ui.start();
  await ui.click("Hide conversation");
  expect(ui.container.querySelector('[role="log"]')).toBeNull();
  await ui.deliver({
    ...initial,
    sequence: 3,
    captions: [
      { sequence: 1, role: "user", text: "First request" },
      { sequence: 2, role: "assistant", text: "I heard your request" },
    ],
  });
  expect(ui.container.querySelector('[role="log"]')).toBeNull();
  expect(ui.track.enabled).toBe(true);
  expect(ui.track.stop).not.toHaveBeenCalled();
  expect(ui.rpc.start).toHaveBeenCalledOnce();
  expect(ui.rpc.end).not.toHaveBeenCalled();
  await ui.click("Show conversation");
  expect(ui.container.querySelector('[role="log"]')?.textContent).toContain("I heard your request");
});

it("preserves manual caption reading and follows new sequence entries at the retention limit", async () => {
  const captions = Array.from({ length: 256 }, (_, index) => ({
    sequence: index,
    role: "user" as const,
    text: `Request ${index}`,
  }));
  const ui = await mount({ snapshot: { ...initial, captions } });
  await ui.start();
  const log = ui.container.querySelector<HTMLElement>('[role="log"]')!;
  Object.defineProperties(log, {
    scrollHeight: { configurable: true, value: 900 },
    clientHeight: { value: 200 },
  });
  log.scrollTop = 100;
  await act(async () => log.dispatchEvent(new Event("scroll", { bubbles: true })));
  await ui.deliver({
    ...initial,
    sequence: 3,
    captions: [...captions.slice(1), { sequence: 256, role: "assistant", text: "New reply" }],
  });
  expect(log.scrollTop).toBe(100);
  await ui.click("Latest");
  expect(log.scrollTop).toBe(900);
  Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
  await ui.deliver({
    ...initial,
    sequence: 4,
    captions: [
      ...captions.slice(2),
      { sequence: 256, role: "assistant", text: "New reply" },
      { sequence: 257, role: "assistant", text: "Latest reply" },
    ],
  });
  expect(log.scrollTop).toBe(1000);
});

it("shows connected warnings separately from microphone state and keeps the terminal reason", async () => {
  const ui = await mount();
  await ui.start();
  await ui.deliver({
    ...initial,
    sequence: 2,
    message: "I could not speak that update. The task is still running.",
  });
  expect(ui.container.textContent).toContain(
    "I could not speak that update. The task is still running.",
  );
  expect(ui.container.textContent).toContain("Listening");
  await ui.deliver({
    ...initial,
    sequence: 3,
    state: "error",
    message: "Voice disconnected. Start a new call.",
  });
  expect(ui.container.textContent).toContain("Voice disconnected. Start a new call.");
  expect(ui.container.textContent).not.toContain("I could not speak that update");
  expect(ui.container.textContent).toContain("Call interrupted");
});

it("keeps the call destination and labels accepted work as history after End", async () => {
  const ui = await mount({
    snapshot: {
      ...initial,
      tasks: [
        {
          messageId: MessageId.make("message-a"),
          runId: RunId.make("run-a"),
          title: "Add a mute shortcut",
          state: "working",
          startedAt,
          activity: null,
          steps: [],
          completedAt: null,
          result: null,
        },
      ],
    },
  });
  await ui.start();
  availability.driver = "claude";
  await ui.render(otherTarget);
  await ui.click("Mute");
  expect(ui.track.enabled).toBe(false);
  await ui.click("End call");
  expect(ui.container.textContent).toContain("Check accepted work in the thread.");
  expect(ui.container.textContent).toContain("Work laptop");
  expect(ui.container.textContent).not.toContain("Working in this thread");
  expect(ui.container.textContent).not.toContain("Working on your task");
  const originalThread = ui.container.querySelector('a[href="/environment-a/thread-a"]');
  expect(originalThread?.textContent).toContain("Build the app");
  expect(ui.rpc.end).toHaveBeenCalledWith(target, "call-a");
});

it("keeps a waiting task visible when a later task is complete without changing microphone state", async () => {
  const ui = await mount({
    snapshot: {
      ...initial,
      tasks: [
        {
          messageId: MessageId.make("message-a"),
          runId: RunId.make("run-a"),
          title: "Add a mute shortcut",
          state: "waiting",
          startedAt,
          activity: null,
          steps: [],
          completedAt: null,
          result: null,
        },
        {
          messageId: MessageId.make("message-b"),
          runId: RunId.make("run-b"),
          title: "Fix the tests",
          state: "completed",
          startedAt,
          activity: null,
          steps: [],
          completedAt: null,
          result: "Done",
        },
      ],
    },
  });
  await ui.start();
  expect(ui.container.textContent).toContain("Paused — approval waiting in the thread.");
  expect(ui.container.textContent).toContain("Listening…");
  await ui.click("Mute");
  expect(ui.track.enabled).toBe(false);
  expect(ui.container.textContent).toContain("Microphone muted");
  expect(ui.container.textContent).toContain("Paused — approval waiting in the thread.");
});

it("recovers blocked speaker playback without pausing microphone capture", async () => {
  const ui = await mount();
  await ui.start();
  ui.audio.play.mockRejectedValueOnce(new Error("Autoplay blocked"));
  await act(async () => ui.peer.ontrack?.({ streams: [ui.stream], track: {} as VoiceMediaTrack }));
  expect(ui.container.textContent).toContain("Speaker audio is blocked.");
  expect(ui.container.textContent).toContain("Listening");
  await ui.click("Enable speaker audio");
  expect(ui.container.textContent).not.toContain("Speaker audio is blocked.");
  expect(ui.track.enabled).toBe(true);
  expect(ui.rpc.start).toHaveBeenCalledOnce();
  expect(ui.track.stop).not.toHaveBeenCalled();
});
it("shows a working timer and thinking status while a task runs", async () => {
  const ui = await mount({
    snapshot: {
      ...initial,
      tasks: [
        {
          messageId: MessageId.make("message-a"),
          runId: RunId.make("run-a"),
          title: "Add a mute shortcut",
          state: "working",
          startedAt,
          activity: null,
          steps: [],
          completedAt: null,
          result: null,
        },
      ],
    },
  });
  await ui.start();
  expect(ui.container.textContent).toContain("Working for");
  expect(ui.container.textContent).toContain("Add a mute shortcut");
  expect(ui.container.textContent).toContain("Listening\u2026");
  await act(async () => ui.sendFinalUser("Change the title"));
  expect(ui.container.textContent).toContain("Codex is thinking\u2026");
  await ui.deliver({ ...initial, sequence: 2 });
  expect(ui.container.textContent).toContain("Listening\u2026");
  expect(ui.container.textContent).not.toContain("Codex is thinking\u2026");
});

it("shows the call timer, thread subtitle, task activity, and completed steps", async () => {
  const ui = await mount({
    snapshot: {
      ...initial,
      tasks: [
        {
          messageId: MessageId.make("message-a"),
          runId: RunId.make("run-a"),
          title: "Add a mute shortcut",
          state: "working",
          startedAt,
          activity: "Edit VoiceControls.tsx",
          steps: ["Read the voice panel", "Draft the change"],
          completedAt: null,
          result: null,
        },
      ],
    },
  });
  await ui.start();
  expect(ui.container.textContent).toContain("for Build the app");
  expect(ui.container.textContent).toMatch(/\d+:\d{2}/);
  expect(ui.container.textContent).toContain("Edit VoiceControls.tsx");
  expect(ui.container.textContent).toContain("Read the voice panel");
  expect(ui.container.textContent).toContain("Draft the change");
});

it("shows a static completed duration for a finished task", async () => {
  const ui = await mount({
    snapshot: {
      ...initial,
      tasks: [
        {
          messageId: MessageId.make("message-a"),
          runId: RunId.make("run-a"),
          title: "Add a mute shortcut",
          state: "completed",
          startedAt,
          activity: null,
          steps: [],
          completedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(startedAt) + 41_000),
          result: "Done",
        },
      ],
    },
  });
  await ui.start();
  expect(ui.container.textContent).toContain("Completed for 0:41");
});

it("shows a slim call bar with mute and end for the active thread", async () => {
  const ui = await mount({
    callBar: true,
    snapshot: {
      ...initial,
      tasks: [
        {
          messageId: MessageId.make("message-a"),
          runId: RunId.make("run-a"),
          title: "Add a mute shortcut",
          state: "working",
          startedAt,
          activity: null,
          steps: [],
          completedAt: null,
          result: null,
        },
      ],
    },
  });
  expect(ui.container.querySelector('[aria-label="End call"]')).toBeNull();
  await ui.start();
  expect(ui.container.textContent).toContain("Working for");
  await ui.click("Open voice controls");
  expect(ui.opened).toHaveBeenCalledOnce();
  await ui.click("Mute");
  expect(ui.track.enabled).toBe(false);
  await ui.click("End call");
  expect(ui.container.textContent).toContain("Start voice call");
});
