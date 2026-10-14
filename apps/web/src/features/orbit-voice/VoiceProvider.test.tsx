// @vitest-environment jsdom

import { act, useContext, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { VoiceContext, VoiceProvider } from "./VoiceProvider";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    params,
    to: _to,
    ...props
  }: ComponentProps<"a"> & { params: ScopedThreadRef; to: string }) => (
    <a {...props} href={`/${params.environmentId}/${params.threadId}`} />
  ),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./commands", () => ({
  voiceCommands: {
    start: { permissionAtom: () => null },
    submit: {},
    end: {},
    renewPresence: {},
    snapshot: {},
  },
}));

const target = { environmentId: "environment-a", threadId: "thread-a" } as ScopedThreadRef;
function CallStarter() {
  const voice = useContext(VoiceContext)!;
  return <button onClick={() => void voice.controller.start(target)}>Start</button>;
}

it("keeps End reachable on chat home and releases microphone permission that arrives after ending", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let grantPermission!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    grantPermission = resolve;
  });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => permission } });
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <VoiceProvider showFallback={false}>
          <CallStarter />
        </VoiceProvider>,
      ),
    );
    await act(async () => container.querySelector("button")!.click());
    await act(async () =>
      root.render(
        <VoiceProvider showFallback>
          <div>Choose a thread</div>
        </VoiceProvider>,
      ),
    );
    expect(container.querySelector('a[href="/environment-a/thread-a"]')).not.toBeNull();
    const end = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("End call"),
    );
    expect(end, "Call can be ended after leaving the thread").toBeDefined();
    await act(async () => end!.click());
    await act(async () => grantPermission(stream));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("End call");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("home Mute pauses the acquired microphone and End releases it while connecting", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const track = { enabled: true, stop: vi.fn(), onended: null };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => stream } });
  const channel = { close: vi.fn() };
  const peer = {
    addTrack: vi.fn(),
    createDataChannel: () => channel,
    createOffer: () => new Promise<RTCSessionDescriptionInit>(() => {}),
    close: vi.fn(),
  };
  const audio = { pause: vi.fn(), srcObject: null, autoplay: false };
  vi.stubGlobal("RTCPeerConnection", function () {
    return peer;
  });
  vi.stubGlobal("Audio", function () {
    return audio;
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (name: string) => {
    const found = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === name,
    );
    expect(found, `Expected ${name}`).toBeDefined();
    return found!;
  };
  try {
    await act(async () =>
      root.render(
        <VoiceProvider showFallback>
          <CallStarter />
        </VoiceProvider>,
      ),
    );
    await act(async () => button("Start").click());
    expect(track.enabled).toBe(true);
    await act(async () => button("Mute").click());
    expect(track.enabled).toBe(false);
    await act(async () => button("Unmute").click());
    expect(track.enabled).toBe(true);
    await act(async () => button("End call").click());
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-label="Active voice call"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
