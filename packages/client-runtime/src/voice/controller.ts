// @effect-diagnostics globalTimers:off globalDate:off - WebRTC call controller, runs outside an Effect runtime.
import type {
  OrbitVoiceSnapshot,
  OrbitVoiceStartInput,
  OrbitVoiceTask,
  OrbitVoiceSubmitInput,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { DateTime } from "effect";

const INPUT_LIMIT_BYTES = 16 * 1024;
// Seconds of user-speech silence after a client delegation before the accumulated
// transcript is submitted. A trailing constraint keeps resetting this window.
const DELEGATION_FALLBACK_MS = 4_000;

// How long the call shows "Codex is thinking…" after a user final without the turn
// settling or a delegation taking over. Only a backstop: both clear it sooner.
const THINKING_TIMEOUT_MS = 15_000;
// The contract bounds audioTurnId to 128 UTF-8 bytes, not characters. Ids that fit are
// used as-is. Longer ids go to a separate "fallback~" namespace carrying a 53-bit
// cyrb53 digest of the whole key plus a byte-bounded prefix, so no short key can spell
// a digested id and distinct long ids cannot collapse into one turn id.
const digest53 = (text: string) => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (const byte of new TextEncoder().encode(text)) {
    h1 = Math.imul(h1 ^ byte, 2654435761);
    h2 = Math.imul(h2 ^ byte, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

const fallbackAudioTurnId = (key: string) => {
  const encoder = new TextEncoder();
  const full = `fallback:${key}`;
  if (encoder.encode(full).length <= 128) return full;
  const head = `fallback~${digest53(key).toString(16).padStart(14, "0")}:`;
  let id = head;
  let bytes = 0;
  for (const char of key) {
    const charBytes = encoder.encode(char).length;
    if (bytes + charBytes > 128 - head.length) break;
    bytes += charBytes;
    id += char;
  }
  return id;
};

export interface VoiceRpc {
  start(
    target: ScopedThreadRef,
    input: Omit<OrbitVoiceStartInput, "threadId">,
  ): Promise<{ answerSdp: string; snapshot: OrbitVoiceSnapshot }>;
  submit(target: ScopedThreadRef, input: OrbitVoiceSubmitInput): Promise<OrbitVoiceSnapshot>;
  end(target: ScopedThreadRef, callId: string): Promise<OrbitVoiceSnapshot>;
  renewPresence(target: ScopedThreadRef, callId: string): Promise<OrbitVoiceSnapshot>;
  snapshot(
    target: ScopedThreadRef,
    callId: string,
    afterSequence: number,
  ): Promise<OrbitVoiceSnapshot>;
}

// Structural platform seam. DOM WebRTC types (MediaStream, RTCPeerConnection, …) are
// globals that do not exist in React Native, so the controller only ever sees these
// shapes. Web (lib.dom) and mobile (react-native-webrtc) adapters satisfy them with
// casts at the boundary; the controller itself never touches a DOM constructor.
export interface VoiceMediaTrack {
  enabled: boolean;
  onended: (() => void) | null;
  stop(): void;
}

export interface VoiceMediaStream {
  getTracks(): VoiceMediaTrack[];
  getAudioTracks(): VoiceMediaTrack[];
}

export interface VoiceDataChannel {
  readyState: string;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface VoiceSessionDescriptionInit {
  type?: string;
  sdp?: string;
}

export interface VoicePeerConnection {
  connectionState: string;
  localDescription: VoiceSessionDescriptionInit | null;
  ontrack: ((event: { track: VoiceMediaTrack; streams: VoiceMediaStream[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  addTrack(track: VoiceMediaTrack, stream: VoiceMediaStream): void;
  createDataChannel(label: string): VoiceDataChannel;
  createOffer(): Promise<VoiceSessionDescriptionInit>;
  setLocalDescription(description?: VoiceSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void>;
  close(): void;
}

export interface VoiceAudioSink {
  autoplay: boolean;
  srcObject: VoiceMediaStream | null;
  play(): Promise<void>;
  pause(): void;
}

export interface VoiceCallPlatform {
  microphone(): Promise<VoiceMediaStream>;
  peer(): VoicePeerConnection;
  audio(): VoiceAudioSink;
  callId(): string;
  // Wrap a lone remote track into a stream when ontrack arrives without one.
  remoteStream(track: VoiceMediaTrack): VoiceMediaStream;
}

export interface VoiceCallView {
  state: "idle" | "starting" | "connected" | "ended" | "error";
  target: ScopedThreadRef | null;
  snapshot: OrbitVoiceSnapshot | null;
  message: string | null;
  muted: boolean;
  playbackBlocked: boolean;
  microphone: VoiceMediaStream | null;
  // Live call phase: "thinking" runs from a final user transcript until the turn settles
  // (its submission) or a delegated task takes over. null when the call cannot hear the
  // user (muted/not connected).
  activity: "listening" | "thinking" | null;
  // Stamped when the call reaches "connected"; drives the panel call-duration chip. Cleared on start.
  connectedAt: string | null;
}

export function voiceCallStatus(view: VoiceCallView) {
  switch (view.state) {
    case "starting":
      return view.microphone ? "Connecting…" : "Allow microphone access";
    case "connected":
      return view.muted
        ? "Microphone muted"
        : view.activity === "thinking"
          ? "Codex is thinking…"
          : "Listening…";
    case "error":
      return "Call interrupted";
    case "ended":
      return "Call ended";
    case "idle":
      return "Voice with Codex";
  }
}

/** Task the panel card should show: attention first, then active work, then the latest run. */
export function selectVoiceTask(tasks: readonly OrbitVoiceTask[]): OrbitVoiceTask | null {
  const pending = tasks.filter(
    (task) => task.state === "queued" || task.state === "working" || task.state === "waiting",
  );
  return (
    pending.find((task) => task.state === "waiting") ??
    pending.find((task) => task.state === "working") ??
    pending[0] ??
    tasks.at(-1) ??
    null
  );
}

export function voiceTaskStatusLabel(state: OrbitVoiceTask["state"]): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "working":
      return "Working in this thread";
    case "waiting":
      return "Needs attention in the thread";
    case "completed":
      return "Task completed";
    case "failed":
      return "Task failed";
    case "cancelled":
      return "Task cancelled";
  }
}

/** Run duration in whole seconds for a completed task; null otherwise. */
export function voiceTaskCompletedSeconds(task: OrbitVoiceTask): number | null {
  if (task.state !== "completed") return null;
  const end = task.completedAt ? DateTime.toEpochMillis(task.completedAt) : Date.now();
  return Math.max(0, Math.round((end - DateTime.toEpochMillis(task.startedAt)) / 1000));
}

type Call = {
  target: ScopedThreadRef;
  callId: string;
  stream?: VoiceMediaStream;
  peer?: VoicePeerConnection;
  channel?: VoiceDataChannel;
  audio?: VoiceAudioSink;
  requested: boolean;
  answered: boolean;
  submitted: Set<string>;
  utterance: string;
  utteranceBytes: number;
  fallbackKey: string | null;
  fallbackTimer?: ReturnType<typeof setTimeout>;
  fallbackTranscript: string | null;
  lastUserFinalAt: number | null;
  thinkingTimer?: ReturnType<typeof setTimeout>;
  timers: Set<ReturnType<typeof setTimeout>>;
  startupTimer?: ReturnType<typeof setTimeout>;
};

export class VoiceCallController {
  private call: Call | null = null;
  private listeners = new Set<() => void>();
  private view: VoiceCallView = {
    state: "idle",
    target: null,
    snapshot: null,
    message: null,
    muted: false,
    playbackBlocked: false,
    microphone: null,
    activity: null,
    connectedAt: null,
  };

  private readonly rpc: VoiceRpc;
  private readonly platform: VoiceCallPlatform;

  constructor(rpc: VoiceRpc, platform: VoiceCallPlatform) {
    this.rpc = rpc;
    this.platform = platform;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.view;

  private activityOf(view: VoiceCallView): VoiceCallView["activity"] {
    if (view.state !== "connected" || view.muted) return null;
    return this.call?.lastUserFinalAt != null ? "thinking" : "listening";
  }

  private update(patch: Partial<VoiceCallView>) {
    const view = { ...this.view, ...patch };
    view.activity = this.activityOf(view);
    this.view = view;
    for (const listener of this.listeners) listener();
  }
  private stop(call: Call, state: "ended" | "error", message: string | null = null) {
    if (this.call !== call) return;
    this.call = null;
    for (const timer of call.timers) clearTimeout(timer);
    call.timers.clear();
    if (call.channel) {
      call.channel.onmessage = null;
      call.channel.onopen = null;
      call.channel.onclose = null;
      call.channel.onerror = null;
      call.channel.close();
    }
    if (call.peer) {
      call.peer.onconnectionstatechange = null;
      call.peer.ontrack = null;
      call.peer.close();
    }
    for (const track of call.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    if (call.audio) {
      call.audio.pause();
      call.audio.srcObject = null;
    }
    this.update({ state, message, microphone: null });
    if (call.requested) this.endRemote(call);
  }

  private endRemote(call: Call) {
    void this.rpc.end(call.target, call.callId).catch(() => {
      // Presence expiry also closes the server call when its connection is unavailable.
    });
  }

  readonly end = () => {
    if (this.call) this.stop(this.call, "ended");
  };

  readonly toggleMute = () => {
    if (!this.call) return;
    const muted = !this.view.muted;
    for (const track of this.call.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.update({ muted });
  };

  readonly retryPlayback = async () => {
    const call = this.call;
    if (!call?.audio) return;
    try {
      await call.audio.play();
      if (this.call === call) this.update({ playbackBlocked: false });
    } catch {
      if (this.call === call) this.update({ playbackBlocked: true });
    }
  };

  readonly permissionRevoked = () => {
    if (this.call)
      this.stop(
        this.call,
        "error",
        "Permission to use voice was removed. Reconnect with permission to control this thread.",
      );
  };

  private schedule(call: Call, action: () => void, delay: number) {
    const timer = setTimeout(() => {
      call.timers.delete(timer);
      if (this.call === call) action();
    }, delay);
    call.timers.add(timer);
    return timer;
  }

  private applySnapshot(call: Call, snapshot: OrbitVoiceSnapshot) {
    if (this.call !== call) return;
    if (snapshot.callId !== call.callId || snapshot.threadId !== call.target.threadId) {
      this.stop(call, "error", "The voice call target changed. Start a new call.");
      return;
    }
    if (snapshot.sequence < (this.view.snapshot?.sequence ?? -1)) return;
    this.update({ snapshot });
    if (snapshot.state === "ended" || snapshot.state === "error") {
      this.stop(call, snapshot.state, snapshot.message);
    }
  }

  private observe(
    call: Call,
    request: Promise<OrbitVoiceSnapshot>,
    timeout: number,
    next?: () => void,
  ) {
    const timer = this.schedule(
      call,
      () => this.stop(call, "error", "The voice connection stopped responding. Start a new call."),
      timeout,
    );
    void request
      .then(
        (snapshot) => {
          this.applySnapshot(call, snapshot);
          if (this.call === call) next?.();
        },
        (error: unknown) =>
          this.stop(
            call,
            "error",
            error instanceof Error
              ? error.message
              : "The voice connection failed. Start a new call.",
          ),
      )
      .finally(() => {
        clearTimeout(timer);
        call.timers.delete(timer);
      });
  }

  private poll(call: Call) {
    this.observe(
      call,
      this.rpc.snapshot(call.target, call.callId, this.view.snapshot?.sequence ?? 0),
      25_000,
      () => this.schedule(call, () => this.poll(call), 250),
    );
  }

  private renew(call: Call) {
    this.observe(call, this.rpc.renewPresence(call.target, call.callId), 12_000, () =>
      this.schedule(call, () => this.renew(call), 10_000),
    );
  }

  private connected(call: Call) {
    if (
      this.call !== call ||
      !call.answered ||
      call.peer?.connectionState !== "connected" ||
      call.channel?.readyState !== "open"
    )
      return;
    if (call.startupTimer) {
      clearTimeout(call.startupTimer);
      call.timers.delete(call.startupTimer);
      delete call.startupTimer;
    }
    this.update({
      state: "connected",
      connectedAt: this.view.connectedAt ?? new Date().toISOString(),
    });
  }

  private receive(call: Call, data: unknown) {
    if (this.call !== call || typeof data !== "string") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!event || typeof event !== "object" || !("type" in event)) return;
    if (event.type === "input_transcript.added") {
      this.delta(call, event);
      return;
    }
    if (event.type === "delegation.created") {
      this.delegated(call, event);
      return;
    }
    if (event.type !== "turn.done" || !("turn" in event)) return;
    const turn = event.turn;
    if (
      !turn ||
      typeof turn !== "object" ||
      !("role" in turn) ||
      turn.role !== "user" ||
      !("id" in turn) ||
      typeof turn.id !== "string" ||
      !("transcript" in turn) ||
      typeof turn.transcript !== "string" ||
      call.submitted.has(turn.id)
    )
      return;
    if (!turn.transcript.trim()) return;
    // A natural final resolves the utterance: cancel any pending fallback.
    if (call.fallbackTimer) {
      clearTimeout(call.fallbackTimer);
      call.timers.delete(call.fallbackTimer);
      delete call.fallbackTimer;
    }
    call.fallbackKey = null;
    call.utterance = "";
    call.utteranceBytes = 0;
    // Suppress only an exact late duplicate of a fallback submission; a changed or
    // extended final can carry a new constraint and must still dispatch.
    if (call.fallbackTranscript !== null) {
      const duplicate = turn.transcript.trim() === call.fallbackTranscript;
      call.fallbackTranscript = null;
      if (duplicate) {
        call.submitted.add(turn.id);
        return;
      }
    }
    if (
      call.submitted.size >= 2048 ||
      new TextEncoder().encode(turn.transcript).length > INPUT_LIMIT_BYTES
    ) {
      this.stop(call, "error", "This voice call reached its input limit. Start a new call.");
      return;
    }
    call.submitted.add(turn.id);
    // Submission settles the utterance; the task section takes over from here.
    this.clearThinking(call);
    this.observe(
      call,
      this.rpc.submit(call.target, {
        callId: call.callId,
        audioTurnId: turn.id,
        transcript: turn.transcript,
      }),
      25_000,
    );
  }

  private delta(call: Call, event: object) {
    if (!("item" in event) || !event.item || typeof event.item !== "object") return;
    const item = event.item;
    // A final input transcript means the user finished speaking; the reply is pending.
    if ("is_final" in item && item.is_final === true) this.thinking(call);
    if (!("text" in item) || typeof item.text !== "string" || !item.text) return;
    const bytes = new TextEncoder().encode(item.text).length;
    if (call.utteranceBytes + bytes > INPUT_LIMIT_BYTES) {
      this.stop(call, "error", "This voice call reached its input limit. Start a new call.");
      return;
    }
    call.utterance += item.text;
    call.utteranceBytes += bytes;
    // New speech means the user is still talking: hold the fallback open.
    if (call.fallbackKey !== null) this.armFallback(call);
  }

  private delegated(call: Call, event: object) {
    // One fallback per utterance: a second delegation is ignored until this resolves.
    if (call.fallbackKey !== null) return;
    if (!("item" in event) || !event.item || typeof event.item !== "object") return;
    const item = event.item;
    if (!("type" in item) || item.type !== "delegation") return;
    if (!("target" in item) || item.target !== "client") return;
    if (!("id" in item) || typeof item.id !== "string" || !item.id.trim()) return;
    call.fallbackKey = item.id;
    this.armFallback(call);
    this.clearThinking(call);
  }

  private armFallback(call: Call) {
    if (call.fallbackTimer) {
      clearTimeout(call.fallbackTimer);
      call.timers.delete(call.fallbackTimer);
    }
    call.fallbackTimer = this.schedule(
      call,
      () => {
        delete call.fallbackTimer;
        const key = call.fallbackKey;
        call.fallbackKey = null;
        const transcript = call.utterance.trim();
        call.utterance = "";
        call.utteranceBytes = 0;
        // A delegation carries no usable instruction; the accumulated user speech is
        // the only authoritative request text on this path.
        if (!key || !transcript) return;
        if (call.submitted.size >= 2048) {
          this.stop(call, "error", "This voice call reached its input limit. Start a new call.");
          return;
        }
        call.fallbackTranscript = transcript;
        const audioTurnId = fallbackAudioTurnId(key);
        call.submitted.add(audioTurnId);
        this.thinking(call);
        this.observe(
          call,
          this.rpc.submit(call.target, { callId: call.callId, audioTurnId, transcript }),
          25_000,
        );
      },
      DELEGATION_FALLBACK_MS,
    );
  }
  private thinking(call: Call) {
    if (call.thinkingTimer) {
      clearTimeout(call.thinkingTimer);
      call.timers.delete(call.thinkingTimer);
    }
    call.lastUserFinalAt = Date.now();
    call.thinkingTimer = this.schedule(
      call,
      () => {
        delete call.thinkingTimer;
        call.lastUserFinalAt = null;
        this.update({});
      },
      THINKING_TIMEOUT_MS,
    );
    this.update({});
  }

  private clearThinking(call: Call) {
    if (call.thinkingTimer) {
      clearTimeout(call.thinkingTimer);
      call.timers.delete(call.thinkingTimer);
      delete call.thinkingTimer;
    }
    call.lastUserFinalAt = null;
    this.update({});
  }

  async start(target: ScopedThreadRef) {
    if (this.call) return;
    const call: Call = {
      target: { ...target },
      callId: this.platform.callId(),
      requested: false,
      answered: false,
      submitted: new Set(),
      utterance: "",
      utteranceBytes: 0,
      fallbackKey: null,
      fallbackTranscript: null,
      timers: new Set(),
      lastUserFinalAt: null,
    };
    this.call = call;
    this.update({
      state: "starting",
      target: call.target,
      snapshot: null,
      message: null,
      muted: false,
      playbackBlocked: false,
      connectedAt: null,
    });
    call.startupTimer = this.schedule(
      call,
      () =>
        this.stop(
          call,
          "error",
          "Voice could not connect. Check microphone permission and try again.",
        ),
      30_000,
    );
    try {
      const stream = await this.platform.microphone();
      if (this.call !== call) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      call.stream = stream;
      this.update({ microphone: stream });
      call.audio = this.platform.audio();
      call.audio.autoplay = true;
      const peer = this.platform.peer();
      call.peer = peer;
      for (const track of stream.getTracks()) {
        track.enabled = !this.view.muted;
        track.onended = () =>
          this.stop(
            call,
            "error",
            "Your microphone disconnected. Connect it and start a new call.",
          );
        peer.addTrack(track, stream);
      }
      peer.ontrack = (event) => {
        if (this.call !== call || !call.audio) return;
        call.audio.srcObject = event.streams[0] ?? this.platform.remoteStream(event.track);
        void this.retryPlayback();
      };
      peer.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          this.stop(call, "error", "Voice disconnected. Start a new call.");
        } else this.connected(call);
      };
      const channel = peer.createDataChannel("oai-events");
      call.channel = channel;
      channel.onmessage = ({ data }) => this.receive(call, data);
      channel.onopen = () => this.connected(call);
      channel.onclose = () =>
        this.stop(call, "error", "The voice connection closed. Start a new call.");
      channel.onerror = () =>
        this.stop(call, "error", "The voice connection failed. Start a new call.");
      await peer.setLocalDescription(await peer.createOffer());
      if (this.call !== call) return;
      const offerSdp = peer.localDescription?.sdp;
      if (!offerSdp) throw new Error("Could not prepare the voice connection.");
      call.requested = true;
      const reply = await this.rpc.start(call.target, { callId: call.callId, offerSdp });
      if (this.call !== call) {
        this.endRemote(call);
        return;
      }
      await peer.setRemoteDescription({ type: "answer", sdp: reply.answerSdp });
      if (this.call !== call) return;
      call.answered = true;
      this.applySnapshot(call, reply.snapshot);
      if (this.call !== call) return;
      this.connected(call);
      this.poll(call);
      this.schedule(call, () => this.renew(call), 10_000);
    } catch (error) {
      this.stop(
        call,
        "error",
        error instanceof Error ? error.message : "Could not start voice. Try again.",
      );
    }
  }
}
