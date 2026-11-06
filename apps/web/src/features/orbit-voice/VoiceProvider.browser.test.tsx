import { useContext } from "react";
import { act, render, stubGlobal } from "../../../test/render";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { VoiceContext, VoiceProvider } from "./VoiceProvider";

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
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
  let grantPermission!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    grantPermission = resolve;
  });
  using _navigator = stubGlobal("navigator", { mediaDevices: { getUserMedia: () => permission } });
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  await using screen = await render(
    <VoiceProvider showFallback={false}>
      <CallStarter />
    </VoiceProvider>,
  );
  const container = screen.container;
  await act(async () => container.querySelector("button")!.click());
  await screen.rerender(
    <VoiceProvider showFallback>
      <div>Choose a thread</div>
    </VoiceProvider>,
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
});

it("home Mute pauses the acquired microphone and End releases it while connecting", async () => {
  const track = { enabled: true, stop: vi.fn(), onended: null };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  using _navigator = stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => stream },
  });
  const channel = { close: vi.fn() };
  const peer = {
    addTrack: vi.fn(),
    createDataChannel: () => channel,
    createOffer: () => new Promise<RTCSessionDescriptionInit>(() => {}),
    close: vi.fn(),
  };
  const audio = { pause: vi.fn(), srcObject: null, autoplay: false };
  using _peer = stubGlobal("RTCPeerConnection", function () {
    return peer;
  });
  using _audio = stubGlobal("Audio", function () {
    return audio;
  });
  await using screen = await render(
    <VoiceProvider showFallback>
      <CallStarter />
    </VoiceProvider>,
  );
  const container = screen.container;
  const button = (name: string) => {
    const found = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === name,
    );
    expect(found, `Expected ${name}`).toBeDefined();
    return found!;
  };
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
});
