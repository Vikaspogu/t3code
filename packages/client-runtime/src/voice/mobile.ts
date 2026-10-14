// @effect-diagnostics globalDate:off globalTimers:off cryptoRandomUUID:off globalRandom:off - React Native platform adapter, runs outside an Effect runtime.
import type {
  VoiceAudioSink,
  VoiceCallPlatform,
  VoiceMediaStream,
  VoiceMediaTrack,
  VoicePeerConnection,
} from "./controller.js";

// react-native-webrtc is a native module. Loading it in a binary built without it (an
// older store build that receives an OTA JS update) throws at module scope and would take
// down every screen importing this file, so it is required lazily and voice degrades to
// "unavailable" instead of crashing.
declare function require(id: string): unknown;
// Minimal structural typing for the optional native module: it is only resolvable from
// apps/mobile, not from this package, so only the members this adapter touches are typed.
interface WebrtcModule {
  readonly mediaDevices: { getUserMedia(constraints: unknown): Promise<unknown> };
  readonly RTCPeerConnection: new (configuration?: unknown) => unknown;
  readonly MediaStream: new (tracks: unknown[]) => unknown;
}

let cached: WebrtcModule | null | undefined;

function loadWebrtc(): WebrtcModule | null {
  if (cached === undefined) {
    try {
      cached = require("react-native-webrtc") as WebrtcModule;
    } catch {
      cached = null;
    }
  }
  return cached;
}

/** False when the running binary lacks the WebRTC native module; voice UI must stay hidden. */
export function isMobileVoiceSupported(): boolean {
  return loadWebrtc() !== null;
}

class MobileAudioSink implements VoiceAudioSink {
  // react-native-webrtc plays remote audio natively once the track arrives; the sink
  // only records the assignment so playback state stays observable.
  autoplay = false;

  srcObject: VoiceMediaStream | null = null;

  play() {
    return Promise.resolve();
  }

  pause() {}
}

export function createMobileVoicePlatform(): VoiceCallPlatform {
  const webrtc = loadWebrtc();
  // The platform is constructed during render, before availability is known, so the
  // missing-module error is deferred to the moment a call actually starts.
  const requireWebrtc = (): WebrtcModule => {
    if (webrtc === null) {
      throw new Error("Voice requires an app build with the WebRTC native module.");
    }
    return webrtc;
  };
  const audio = new MobileAudioSink();
  let counter = 0;
  return {
    microphone: () =>
      requireWebrtc().mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      }) as unknown as Promise<VoiceMediaStream>,
    peer: () =>
      new (requireWebrtc().RTCPeerConnection)({
        iceServers: [],
      }) as unknown as VoicePeerConnection,
    audio: () => audio,
    callId: () =>
      globalThis.crypto?.randomUUID() ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${(counter++).toString(36)}`,
    remoteStream: (track: VoiceMediaTrack) =>
      new (requireWebrtc().MediaStream)([track]) as unknown as VoiceMediaStream,
  };
}
