import type { ScopedThreadRef } from "@t3tools/contracts";
import type { VoiceMediaStream, VoiceRpc } from "@t3tools/client-runtime/voice";
import { createMobileVoicePlatform } from "@t3tools/client-runtime/voice/mobile";
import { expect, it, vi } from "vite-plus/test";
import { getVoiceController } from "./useVoiceCall";

vi.mock("@t3tools/client-runtime/voice/mobile", () => ({
  createMobileVoicePlatform: vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("./availability", () => ({ useVoiceAvailability: vi.fn() }));
vi.mock("./commands", () => ({ voiceCommands: {} }));

it("keeps a call shared when another control supplies a different RPC wrapper", async () => {
  let grantPermission!: (stream: VoiceMediaStream) => void;
  const permission = new Promise<VoiceMediaStream>((resolve) => {
    grantPermission = resolve;
  });
  const track = { enabled: true, onended: null, stop: vi.fn() };
  vi.mocked(createMobileVoicePlatform).mockReturnValue({
    microphone: () => permission,
    callId: () => "shared-call",
    peer: vi.fn(),
    audio: vi.fn(),
    remoteStream: vi.fn(),
  });
  const rpc = {
    start: vi.fn(),
    submit: vi.fn(),
    end: vi.fn(),
    renewPresence: vi.fn(),
    snapshot: vi.fn(),
  } satisfies VoiceRpc;
  const target = { environmentId: "shared-env", threadId: "shared-thread" } as ScopedThreadRef;
  const first = getVoiceController(target, rpc);
  const starting = first.start(target);
  try {
    const second = getVoiceController(target, { ...rpc });
    expect(second).toBe(first);
    expect(second.getSnapshot().state).toBe("starting");
  } finally {
    await first.end();
    grantPermission({ getTracks: () => [track], getAudioTracks: () => [track] });
    await starting;
  }
  expect(track.stop).toHaveBeenCalledOnce();
  expect(rpc.start).not.toHaveBeenCalled();
});
