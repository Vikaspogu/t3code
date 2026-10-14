import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { MessageId, NonNegativeInt, RunId, ThreadId } from "./baseSchemas.ts";

const boundedText = (bytes: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (value: string) => value.trim().length > 0 && new TextEncoder().encode(value).length <= bytes,
      { expected: `non-blank text within ${bytes} bytes` },
    ),
  );
const CallId = boundedText(128);

export class OrbitVoiceError extends Schema.TaggedError<OrbitVoiceError>()("OrbitVoiceError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export const OrbitVoiceDecision = Schema.Literals(["task", "steer", "status", "chat", "clarify"]);
export type OrbitVoiceDecision = typeof OrbitVoiceDecision.Type;
export const OrbitVoiceTask = Schema.Struct({
  messageId: MessageId,
  runId: RunId,
  // First line of the user message that started the run; the panel card title.
  title: Schema.String,
  state: Schema.Literals(["queued", "working", "waiting", "completed", "failed", "cancelled"]),
  // Creation time of the user message that started the run; drives the live elapsed timer.
  startedAt: Schema.DateTimeUtc,
  result: Schema.NullOr(Schema.String),
  // Label of the latest in-flight work item (command, edit, search…); null when nothing actionable.
  activity: Schema.NullOr(Schema.String),
  // Up to three most recent completed work-item labels, oldest first.
  steps: Schema.Array(Schema.String),
  // Run completion time for the "Done in …" banner; null while the run is active.
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type OrbitVoiceTask = typeof OrbitVoiceTask.Type;
export const OrbitVoiceSnapshot = Schema.Struct({
  callId: CallId,
  threadId: ThreadId,
  threadTitle: Schema.String,
  state: Schema.Literals(["starting", "connected", "ended", "error"]),
  message: Schema.NullOr(Schema.String),
  sequence: NonNegativeInt,
  captions: Schema.Array(
    Schema.Struct({
      sequence: NonNegativeInt,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
    }),
  ),
  tasks: Schema.Array(OrbitVoiceTask),
  routing: Schema.Boolean,
});
export type OrbitVoiceSnapshot = typeof OrbitVoiceSnapshot.Type;
export const OrbitVoiceStartInput = Schema.Struct({
  threadId: ThreadId,
  callId: CallId,
  offerSdp: boundedText(128 * 1024),
});
export type OrbitVoiceStartInput = typeof OrbitVoiceStartInput.Type;
export const OrbitVoiceSubmitInput = Schema.Struct({
  callId: CallId,
  audioTurnId: boundedText(128),
  transcript: boundedText(16 * 1024),
});
export type OrbitVoiceSubmitInput = typeof OrbitVoiceSubmitInput.Type;
export const OrbitVoiceCallInput = Schema.Struct({ callId: CallId });
export const OrbitVoiceSnapshotInput = Schema.Struct({
  callId: CallId,
  afterSequence: NonNegativeInt,
});
export const OrbitVoiceStartResult = Schema.Struct({
  answerSdp: Schema.String,
  snapshot: OrbitVoiceSnapshot,
});

export const ORBIT_VOICE_METHODS = {
  orbitVoiceStart: "orbitVoice.start",
  orbitVoiceSubmit: "orbitVoice.submit",
  orbitVoiceEnd: "orbitVoice.end",
  orbitVoiceRenewPresence: "orbitVoice.renewPresence",
  orbitVoiceSnapshot: "orbitVoice.snapshot",
} as const;
export const OrbitVoiceRpcs = [
  Rpc.make(ORBIT_VOICE_METHODS.orbitVoiceStart, {
    payload: OrbitVoiceStartInput,
    success: OrbitVoiceStartResult,
    error: OrbitVoiceError,
  }),
  Rpc.make(ORBIT_VOICE_METHODS.orbitVoiceSubmit, {
    payload: OrbitVoiceSubmitInput,
    success: OrbitVoiceSnapshot,
    error: OrbitVoiceError,
  }),
  Rpc.make(ORBIT_VOICE_METHODS.orbitVoiceEnd, {
    payload: OrbitVoiceCallInput,
    success: OrbitVoiceSnapshot,
    error: OrbitVoiceError,
  }),
  Rpc.make(ORBIT_VOICE_METHODS.orbitVoiceRenewPresence, {
    payload: OrbitVoiceCallInput,
    success: OrbitVoiceSnapshot,
    error: OrbitVoiceError,
  }),
  Rpc.make(ORBIT_VOICE_METHODS.orbitVoiceSnapshot, {
    payload: OrbitVoiceSnapshotInput,
    success: OrbitVoiceSnapshot,
    error: OrbitVoiceError,
  }),
] as const;
