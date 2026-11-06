import type { OrbitVoiceSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  VoiceCallController,
  voiceCallStatus,
  type VoiceAudioSink,
  type VoiceCallPlatform,
  type VoiceCallView,
  type VoiceMediaStream,
  type VoiceMediaTrack,
  type VoicePeerConnection,
  type VoiceRpc,
} from "./controller.ts";

const target = { environmentId: "environment-a", threadId: "thread-a" } as ScopedThreadRef;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const track = { enabled: true, stop: vi.fn(), onended: null as (() => void) | null };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as VoiceMediaStream;
  const channel = {
    onmessage: null as ((event: { data: string }) => void) | null,
    close: vi.fn(),
    readyState: "open",
    onopen: null,
    onclose: null,
    onerror: null,
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
    onconnectionstatechange: null as (() => void) | null,
    ontrack: null as
      | ((event: { streams: VoiceMediaStream[]; track: VoiceMediaTrack }) => void)
      | null,
  };
  const audio = { play: vi.fn(async () => {}), pause: vi.fn(), srcObject: null, autoplay: false };
  const rpc = {
    start: vi.fn(async () => ({ answerSdp: "answer", snapshot: initial })),
    submit: vi.fn(async () => initial),
    end: vi.fn(async () => ({ ...initial, state: "ended" as const })),
    renewPresence: vi.fn(async () => initial),
    snapshot: vi.fn(() => new Promise<OrbitVoiceSnapshot>(() => {})),
  } satisfies VoiceRpc;
  const platform = {
    microphone: vi.fn(async () => stream),
    peer: vi.fn(() => peer as unknown as VoicePeerConnection),
    audio: () => audio as unknown as VoiceAudioSink,
    callId: () => "call-a",
    remoteStream: vi.fn(
      (remoteTrack: VoiceMediaTrack) =>
        ({
          getTracks: () => [remoteTrack],
          getAudioTracks: () => [remoteTrack],
        }) satisfies VoiceMediaStream,
    ),
  } satisfies VoiceCallPlatform;
  const controller = new VoiceCallController(rpc, platform);
  const userTurn = (id: string, transcript: string) =>
    channel.onmessage?.({
      data: JSON.stringify({ type: "turn.done", turn: { id, role: "user", transcript } }),
    });
  return { controller, rpc, platform, track, stream, peer, channel, audio, userTurn };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("voice call", () => {
  it("times out before microphone permission settles and releases a late stream", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const permission = deferred<VoiceMediaStream>();
    f.platform.microphone.mockReturnValue(permission.promise);
    const starting = f.controller.start(target);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.controller.getSnapshot().state).toBe("error");
    permission.resolve(f.stream);
    await starting;
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.rpc.start).not.toHaveBeenCalled();
  });

  it("stamps connectedAt once and keeps it across reconnects", async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(f.controller.getSnapshot().connectedAt).toBeNull();
    await f.controller.start(target);
    const first = f.controller.getSnapshot().connectedAt;
    expect(typeof first).toBe("string");
    await vi.advanceTimersByTimeAsync(5_000);
    f.peer.onconnectionstatechange?.();
    expect(f.controller.getSnapshot().connectedAt).toBe(first);
  });

  it("renews presence during a pending snapshot without blocking End or changing the destination", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const snapshot = deferred<OrbitVoiceSnapshot>();
    f.rpc.snapshot.mockReturnValue(snapshot.promise);
    const route = { ...target };
    await f.controller.start(route);
    route.threadId = "thread-b" as ScopedThreadRef["threadId"];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.rpc.renewPresence).toHaveBeenCalledWith(target, "call-a");
    expect(f.rpc.snapshot).toHaveBeenCalledTimes(1);
    f.controller.end();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.rpc.end).toHaveBeenCalledWith(target, "call-a");
    snapshot.resolve({ ...initial, sequence: 5 });
    await Promise.resolve();
    expect(f.controller.getSnapshot().state).toBe("ended");
  });

  it("fails a stalled snapshot instead of displaying an indefinitely live call", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(target);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(f.controller.getSnapshot().state).toBe("error");
    expect(f.track.stop).toHaveBeenCalledOnce();
  });

  it("only explicit mute changes the microphone while coding work remains pending", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.rpc.submit.mockResolvedValue({ ...initial, sequence: 3, routing: true });
    await f.controller.start(target);
    f.userTurn("audio-1", "Change the title");
    await Promise.resolve();
    expect(f.track.enabled).toBe(true);
    f.controller.toggleMute();
    expect(f.track.enabled).toBe(false);
    expect(f.controller.getSnapshot().muted).toBe(true);
    f.controller.toggleMute();
    expect(f.track.enabled).toBe(true);
    f.controller.end();
  });

  it("marks the call as thinking after a final user transcript until the turn settles", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(target);
    const finalUser = (transcript: string) =>
      f.channel.onmessage?.({
        data: JSON.stringify({
          type: "input_transcript.added",
          item: { type: "message", role: "user", id: "msg-1", transcript, is_final: true },
        }),
      });
    expect(f.controller.getSnapshot().activity).toBe("listening");
    finalUser("Change the title");
    expect(f.controller.getSnapshot().activity).toBe("thinking");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.controller.getSnapshot().activity).toBe("listening");
    finalUser("Change the title");
    expect(f.controller.getSnapshot().activity).toBe("thinking");
    f.userTurn("audio-1", "Change the title");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.getSnapshot().activity).toBe("listening");
    f.controller.end();
  });
  it("connects remote audio and exposes a blocked playback action that can recover", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.audio.play.mockRejectedValueOnce(new Error("Autoplay blocked"));
    await f.controller.start(target);
    f.peer.ontrack?.({ streams: [f.stream], track: f.track as unknown as VoiceMediaTrack });
    await Promise.resolve();
    expect(f.audio.srcObject).toBe(f.stream);
    expect(f.controller.getSnapshot().playbackBlocked).toBe(true);
    await f.controller.retryPlayback();
    expect(f.controller.getSnapshot().playbackBlocked).toBe(false);
    f.controller.end();
    expect(f.audio.pause).toHaveBeenCalledOnce();
    expect(f.audio.srcObject).toBeNull();
  });

  it("stops media and ignores further input when permission is revoked", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(target);
    f.controller.permissionRevoked();
    f.userTurn("late-audio", "Make another change");
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.rpc.submit).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().state).toBe("error");
  });

  it("never replaces newer captions with an older submit reply", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.rpc.submit.mockResolvedValue({ ...initial, sequence: 0 });
    await f.controller.start(target);
    f.userTurn("audio-1", "How is it going?");
    await Promise.resolve();
    expect(f.controller.getSnapshot().snapshot?.sequence).toBe(1);
    f.controller.end();
  });

  it("stops a late microphone stream after End without starting a server call", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const permission = deferred<VoiceMediaStream>();
    f.platform.microphone.mockReturnValue(permission.promise);
    const starting = f.controller.start(target);
    f.controller.end();
    permission.resolve(f.stream);
    await starting;
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.rpc.start).not.toHaveBeenCalled();
  });

  it("closes local resources immediately and ends a late server start again", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const server = deferred<{ answerSdp: string; snapshot: OrbitVoiceSnapshot }>();
    const requested = deferred<void>();
    f.rpc.start.mockImplementation(() => {
      requested.resolve();
      return server.promise;
    });
    const starting = f.controller.start(target);
    await requested.promise;
    f.controller.end();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.peer.close).toHaveBeenCalledOnce();
    server.resolve({ answerSdp: "answer", snapshot: initial });
    await starting;
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.rpc.end).toHaveBeenLastCalledWith(target, "call-a");
    expect(f.rpc.end).toHaveBeenCalledTimes(2);
  });

  it("submits exact final user text once and keeps listening while routing is pending", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = deferred<OrbitVoiceSnapshot>();
    f.rpc.submit.mockReturnValue(pending.promise);
    await f.controller.start(target);
    f.userTurn("audio-1", "  Fix the button.\nKeep its label.  ");
    f.userTurn("audio-1", "  Fix the button.\nKeep its label.  ");
    f.channel.onmessage?.({
      data: JSON.stringify({
        type: "turn.done",
        turn: { id: "assistant", role: "assistant", transcript: "I will fix it." },
      }),
    });
    f.channel.onmessage?.({
      data: JSON.stringify({ type: "delegation.created", input_transcript: "Rewritten task" }),
    });
    f.userTurn("audio-2", "How is it going?");
    expect(f.rpc.submit.mock.calls).toEqual([
      [
        target,
        {
          callId: "call-a",
          audioTurnId: "audio-1",
          transcript: "  Fix the button.\nKeep its label.  ",
        },
      ],
      [target, { callId: "call-a", audioTurnId: "audio-2", transcript: "How is it going?" }],
    ]);
    expect(f.track.enabled).toBe(true);
    expect(f.track.stop).not.toHaveBeenCalled();
    f.controller.end();
  });
});

describe("voice delegation fallback", () => {
  const delta = (f: ReturnType<typeof fixture>, text: string, id = "item-1") =>
    f.channel.onmessage?.({
      data: JSON.stringify({ type: "input_transcript.added", item: { id, text } }),
    });
  const delegation = (f: ReturnType<typeof fixture>, id = "del-1") =>
    f.channel.onmessage?.({
      data: JSON.stringify({
        type: "delegation.created",
        item: { type: "delegation", target: "client", id, content: [] },
      }),
    });

  it("dispatches a delegated request that never receives a final transcript", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(target);
    delta(f, "Create hello.text ");
    delegation(f);
    delta(f, "with hello inside");
    await vi.advanceTimersByTimeAsync(3_999);
    expect(f.rpc.submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.rpc.submit.mock.calls).toEqual([
      [
        target,
        {
          callId: "call-a",
          audioTurnId: "fallback:del-1",
          transcript: "Create hello.text with hello inside",
        },
      ],
    ]);
    f.controller.end();
  });

  it("lets a natural final win over a pending delegation fallback", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(target);
    delta(f, "Two plus two");
    delegation(f);
    f.userTurn("audio-9", "Two plus two");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.rpc.submit.mock.calls).toEqual([
      [target, { callId: "call-a", audioTurnId: "audio-9", transcript: "Two plus two" }],
    ]);
    f.controller.end();
  });

  it("ignores a delegation without recognized speech", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(target);
    delegation(f);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.rpc.submit).not.toHaveBeenCalled();
    f.controller.end();
  });

  it("suppresses only an exact late duplicate of a fallback submission", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(target);
    delta(f, "Create the file");
    delegation(f);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(f.rpc.submit).toHaveBeenCalledTimes(1);
    f.userTurn("audio-late", "Create the file");
    expect(f.rpc.submit).toHaveBeenCalledTimes(1);
    f.userTurn("audio-later", "Create the file but DoNotCommit");
    expect(f.rpc.submit.mock.calls[1]).toEqual([
      target,
      {
        callId: "call-a",
        audioTurnId: "audio-later",
        transcript: "Create the file but DoNotCommit",
      },
    ]);
    f.controller.end();
  });

  it("does not submit again for a second delegation of the same utterance", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(target);
    delta(f, "Create the file");
    delegation(f, "del-1");
    await vi.advanceTimersByTimeAsync(4_000);
    delegation(f, "del-2");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.rpc.submit).toHaveBeenCalledTimes(1);
    f.controller.end();
  });

  it("cancels a pending fallback when the call ends", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(target);
    delta(f, "Create the file");
    delegation(f);
    f.controller.end();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.rpc.submit).not.toHaveBeenCalled();
  });

  it("bounds the fallback audio turn id to the contract byte limit", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(target);
    delta(f, "Create the file");
    delegation(f, "é".repeat(200));
    await vi.advanceTimersByTimeAsync(4_000);
    const submittedInput = (
      f.rpc.submit.mock.calls as unknown as ReadonlyArray<[unknown, { audioTurnId: string }]>
    )[0]?.[1];
    if (!submittedInput) throw new Error("expected a fallback submission");
    expect(new TextEncoder().encode(submittedInput.audioTurnId).length).toBeLessThanOrEqual(128);
    expect(submittedInput.audioTurnId.startsWith("fallback~")).toBe(true);
    f.controller.end();
  });

  it("keeps long delegation ids with a shared prefix distinct", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(target);
    delta(f, "First request");
    delegation(f, `${"a".repeat(119)}X`);
    await vi.advanceTimersByTimeAsync(4_000);
    delta(f, "Second request");
    delegation(f, `${"a".repeat(119)}Y`);
    await vi.advanceTimersByTimeAsync(4_000);
    const ids = (
      f.rpc.submit.mock.calls as unknown as ReadonlyArray<[unknown, { audioTurnId: string }]>
    ).map(([, input]) => input.audioTurnId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) {
      expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(128);
    }
    f.controller.end();
  });

  it("keeps short keys that mimic a digested id in the plain namespace", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(target);
    delta(f, "Create the file");
    delegation(f, `~0123456789abcd:${"a".repeat(100)}`);
    await vi.advanceTimersByTimeAsync(4_000);
    const submittedInput = (
      f.rpc.submit.mock.calls as unknown as ReadonlyArray<[unknown, { audioTurnId: string }]>
    )[0]?.[1];
    if (!submittedInput) throw new Error("expected a fallback submission");
    expect(submittedInput.audioTurnId.startsWith("fallback:")).toBe(true);
    f.controller.end();
  });

  it("stops the call when accumulated speech exceeds the input limit", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start(target);
    delta(f, "x".repeat(17 * 1024));
    expect(f.controller.getSnapshot().state).toBe("error");
    expect(f.controller.getSnapshot().message).toBe(
      "This voice call reached its input limit. Start a new call.",
    );
    expect(f.track.stop).toHaveBeenCalledOnce();
  });
});

describe("voiceCallStatus", () => {
  const view = (patch: Partial<VoiceCallView>): VoiceCallView => ({
    state: "idle",
    target: null,
    snapshot: null,
    message: null,
    muted: false,
    playbackBlocked: false,
    microphone: null,
    activity: null,
    connectedAt: null,
    ...patch,
  });
  const microphone = { getTracks: () => [], getAudioTracks: () => [] };

  it("describes every call state for the shared status line", () => {
    expect(voiceCallStatus(view({}))).toBe("Voice with Codex");
    expect(voiceCallStatus(view({ state: "starting" }))).toBe("Allow microphone access");
    expect(voiceCallStatus(view({ state: "starting", microphone }))).toBe("Connecting…");
    expect(voiceCallStatus(view({ state: "connected", activity: "listening" }))).toBe("Listening…");
    expect(voiceCallStatus(view({ state: "connected", activity: "thinking" }))).toBe(
      "Codex is thinking…",
    );
    expect(voiceCallStatus(view({ state: "connected", muted: true }))).toBe("Microphone muted");
    expect(voiceCallStatus(view({ state: "error" }))).toBe("Call interrupted");
    expect(voiceCallStatus(view({ state: "ended" }))).toBe("Call ended");
  });
});
