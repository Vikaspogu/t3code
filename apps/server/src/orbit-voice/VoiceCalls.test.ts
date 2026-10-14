import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  MessageId,
  RunId,
  OrbitVoiceError,
  type OrbitVoiceSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NativeVoice from "./NativeVoice.ts";
import * as T3Host from "./T3Host.ts";
import * as VoiceCalls from "./VoiceCalls.ts";

const owner = AuthSessionId.make("owner");
const target = {
  threadId: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("selected"),
  model: "gpt-5.4",
  cwd: "/fixture",
  threadTitle: "Original thread",
  speech: { instanceId: ProviderInstanceId.make("selected"), model: "gpt-5.4" },
};
const makeTestLayer = (
  host: Partial<T3Host.VoiceHost["Service"]> = {},
  native: Partial<NativeVoice.NativeVoice["Service"]> = {},
) =>
  VoiceCalls.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.succeed(T3Host.VoiceHost, {
          authorize: () => Effect.void,
          awaitRevocation: () => Effect.never,
          bind: () => Effect.succeed(target),
          readActiveRun: () => Effect.succeed(null),
          send: (_target, input) =>
            Effect.gen(function* () {
              return {
                messageId: input.messageId,
                runId: RunId.make("run"),
                title: "Fix the icon",
                state: "queued" as const,
                startedAt: yield* DateTime.now,
                result: null,
                activity: null,
                steps: [],
                completedAt: null,
              };
            }),
          watchTask: () => Stream.never,
          readActiveTask: () => Effect.succeed(null),
          watchActiveTask: () => Stream.never,
          ...host,
        }),
        Layer.succeed(NativeVoice.NativeVoice, {
          open: () =>
            Effect.succeed({
              answerSdp: "answer",
              classify: () => Effect.succeed("task"),
              speak: () => Effect.void,
            }),
          ...native,
        }),
      ),
    ),
  );
const testLayer = makeTestLayer();

describe("voice calls", () => {
  it.effect(
    "keeps the native closure reason when classification then reports a routing failure",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const reason = "The voice router lost its turn acknowledgement. Start a new call.";
        yield* Effect.gen(function* () {
          const calls = yield* VoiceCalls.VoiceCalls;
          yield* calls.start(owner, {
            callId: "call",
            threadId: target.threadId,
            offerSdp: "offer",
          });
          yield* calls.submit(owner, {
            callId: "call",
            audioTurnId: "audio",
            transcript: "Fix the button.",
          });
          yield* Deferred.await(entered);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(closed);
          const snapshot = yield* calls.snapshot(owner, "call", 0);
          expect(snapshot.state).toBe("error");
          expect(snapshot.message).toBe(reason);
          expect(snapshot.routing).toBe(false);
          expect(snapshot.tasks).toHaveLength(0);
        }).pipe(
          Effect.provide(
            makeTestLayer(
              {},
              {
                open: (_input, onEvent) =>
                  Effect.gen(function* () {
                    yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
                    return {
                      answerSdp: "answer",
                      classify: () =>
                        Effect.gen(function* () {
                          yield* Deferred.succeed(entered, undefined);
                          yield* Deferred.await(release);
                          yield* onEvent({ type: "closed", message: reason });
                          return yield* new OrbitVoiceError({
                            code: "routing-timeout",
                            message:
                              "I could not decide how to handle that request. Please try again.",
                          });
                        }),
                      speak: () => Effect.void,
                    };
                  }),
              },
            ),
          ),
        );
      }),
  );

  it.effect("surfaces a task the user typed in chat while the call is live", () =>
    Effect.gen(function* () {
      const calls = yield* VoiceCalls.VoiceCalls;
      const started = yield* calls.start(owner, {
        callId: "call",
        threadId: target.threadId,
        offerSdp: "offer",
      });
      // The ambient fiber may publish before start() resolves, so check the
      // initial snapshot before polling for a later change.
      const seen =
        started.snapshot.tasks.length > 0
          ? started.snapshot
          : yield* Stream.unfold(started.snapshot.sequence, (sequence) =>
              calls
                .snapshot(owner, "call", sequence)
                .pipe(Effect.map((snapshot) => [snapshot, snapshot.sequence] as const)),
            ).pipe(
              Stream.filter((snapshot) => snapshot.tasks.length > 0),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
      expect(seen.tasks[0]).toMatchObject({
        messageId: "msg-ambient",
        runId: "run-ambient",
        title: "Ambient chat task",
        state: "working",
      });
    }).pipe(
      Effect.provide(
        makeTestLayer(
          {
            watchActiveTask: () =>
              Stream.fromEffect(
                Effect.gen(function* () {
                  return {
                    messageId: MessageId.make("msg-ambient"),
                    runId: RunId.make("run-ambient"),
                    title: "Ambient chat task",
                    state: "working" as const,
                    startedAt: yield* DateTime.now,
                    result: null,
                    activity: null,
                    steps: [],
                    completedAt: null,
                  };
                }),
              ),
          },
          {
            open: () =>
              Effect.succeed({
                answerSdp: "answer",
                classify: () => Effect.succeed("task" as const),
                speak: () => Effect.void,
              }),
          },
        ),
      ),
    ),
  );
  it.effect.each([
    ["speech", "ended"],
    ["speech", "error"],
    ["watch", "ended"],
    ["watch", "error"],
  ] as const)("keeps the terminal snapshot when %s fails after %s", ([failure, ending]) =>
    Effect.gen(function* () {
      const service = yield* Deferred.make<VoiceCalls.VoiceCalls["Service"]>();
      const listener = yield* Deferred.make<NativeVoice.NativeVoiceListener>();
      const terminal = yield* Deferred.make<OrbitVoiceSnapshot>();
      const closed = yield* Deferred.make<void>();
      const lateFailure = Effect.gen(function* () {
        const calls = yield* Deferred.await(service);
        if (ending === "ended") yield* calls.end(owner, "call");
        else
          yield* (yield* Deferred.await(listener))({
            type: "closed",
            message: "The native connection ended.",
          });
        yield* Deferred.succeed(terminal, yield* calls.snapshot(owner, "call", 0));
        return yield* new OrbitVoiceError({ code: "unavailable", message: "Late typed failure." });
      });
      yield* Effect.gen(function* () {
        const calls = yield* VoiceCalls.VoiceCalls;
        yield* Deferred.succeed(service, calls);
        yield* calls.start(owner, { callId: "call", threadId: target.threadId, offerSdp: "offer" });
        yield* calls.submit(owner, {
          callId: "call",
          audioTurnId: "audio",
          transcript: "Fix the button.",
        });
        const before = yield* Deferred.await(terminal);
        expect(before.state).toBe(ending);
        expect(before.message).toBe(ending === "ended" ? null : "The native connection ended.");
        expect(before.routing).toBe(false);
        yield* Deferred.await(closed);
        expect(yield* calls.snapshot(owner, "call", 0)).toEqual(before);
      }).pipe(
        Effect.provide(
          makeTestLayer(
            {
              watchTask: () =>
                failure === "watch" ? Stream.fromEffect(lateFailure) : Stream.never,
            },
            {
              open: (_input, onEvent) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(listener, onEvent);
                  yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
                  return {
                    answerSdp: "answer",
                    classify: () => Effect.succeed("task"),
                    speak: () => (failure === "speech" ? lateFailure : Effect.void),
                  };
                }),
            },
          ),
        ),
      );
    }),
  );
  it.effect.each(["speech", "watch"] as const)(
    "reports a %s failure while the call is still connected",
    (failure) =>
      Effect.gen(function* () {
        const typedFailure = Effect.fail(
          new OrbitVoiceError({ code: "unavailable", message: "Typed failure." }),
        );
        yield* Effect.gen(function* () {
          const calls = yield* VoiceCalls.VoiceCalls;
          yield* calls.start(owner, {
            callId: "call",
            threadId: target.threadId,
            offerSdp: "offer",
          });
          const accepted = yield* calls.submit(owner, {
            callId: "call",
            audioTurnId: "audio",
            transcript: "Fix the button.",
          });
          const warning = yield* Stream.unfold(accepted.sequence, (sequence) =>
            calls
              .snapshot(owner, "call", sequence)
              .pipe(Effect.map((snapshot) => [snapshot, snapshot.sequence] as const)),
          ).pipe(
            Stream.filter((snapshot) => snapshot.message !== null),
            Stream.runHead,
          );
          expect(warning).toMatchObject({
            value: {
              state: "connected",
              message:
                failure === "speech"
                  ? "The spoken reply failed. You can still read the task status."
                  : "Task updates stopped. Check the original coding thread.",
            },
          });
        }).pipe(
          Effect.provide(
            makeTestLayer(
              {
                watchTask: () =>
                  failure === "watch" ? Stream.fromEffect(typedFailure) : Stream.never,
              },
              {
                open: () =>
                  Effect.succeed({
                    answerSdp: "answer",
                    classify: () => Effect.succeed("task"),
                    speak: () => (failure === "speech" ? typedFailure : Effect.void),
                  }),
              },
            ),
          ),
        );
      }),
  );
  it.effect("retries an unconfirmed task-result speech and publishes a written fallback", () =>
    Effect.gen(function* () {
      let resultSpeaks = 0;
      yield* Effect.gen(function* () {
        const calls = yield* VoiceCalls.VoiceCalls;
        yield* calls.start(owner, { callId: "call", threadId: target.threadId, offerSdp: "offer" });
        yield* calls.submit(owner, {
          callId: "call",
          audioTurnId: "audio",
          transcript: "Fix the button.",
        });
        for (let index = 0; index < 200 && resultSpeaks < 1; index++) yield* Effect.yieldNow;
        expect(resultSpeaks).toBe(1);
        for (let index = 0; index < 10 && resultSpeaks < 2; index++) {
          yield* Effect.yieldNow;
          yield* TestClock.adjust("10 seconds");
        }
        expect(resultSpeaks).toBe(2);
        let message: string | null = null;
        for (let index = 0; index < 10 && message === null; index++) {
          yield* Effect.yieldNow;
          yield* TestClock.adjust("10 seconds");
          message = (yield* calls.snapshot(owner, "call", 0)).message;
        }
        expect(message).toBe(
          "The spoken task result is delayed. Check the coding thread for details.",
        );
        expect(resultSpeaks).toBe(2);
      }).pipe(
        Effect.provide(
          makeTestLayer(
            {
              watchTask: (_target, task) =>
                Stream.make({ ...task, state: "completed" as const, result: "Fixed." }),
            },
            {
              open: () =>
                Effect.succeed({
                  answerSdp: "answer",
                  classify: () => Effect.succeed("task" as const),
                  speak: (text: string) =>
                    Effect.sync(() => {
                      if (text.startsWith("The coding task completed")) resultSpeaks += 1;
                    }),
                }),
            },
          ),
        ),
      );
    }),
  );
  it.effect("does not retry a task-result speech once an assistant caption confirms it", () =>
    Effect.gen(function* () {
      let resultSpeaks = 0;
      const listener = yield* Deferred.make<NativeVoice.NativeVoiceListener>();
      yield* Effect.gen(function* () {
        const calls = yield* VoiceCalls.VoiceCalls;
        yield* calls.start(owner, { callId: "call", threadId: target.threadId, offerSdp: "offer" });
        yield* calls.submit(owner, {
          callId: "call",
          audioTurnId: "audio",
          transcript: "Fix the button.",
        });
        for (let index = 0; index < 200 && resultSpeaks < 1; index++) yield* Effect.yieldNow;
        expect(resultSpeaks).toBe(1);
        yield* (yield* Deferred.await(listener))({
          type: "caption",
          role: "assistant",
          text: "The coding task completed. Fixed.",
        });
        for (let index = 0; index < 10; index++) yield* Effect.yieldNow;
        yield* TestClock.adjust("20 seconds");
        yield* Effect.yieldNow;
        const snapshot = yield* calls.snapshot(owner, "call", 0);
        expect(resultSpeaks).toBe(1);
        expect(snapshot.message).toBeNull();
      }).pipe(
        Effect.provide(
          makeTestLayer(
            {
              watchTask: (_target, task) =>
                Stream.make({ ...task, state: "completed" as const, result: "Fixed." }),
            },
            {
              open: (_input, onEvent) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(listener, onEvent);
                  return {
                    answerSdp: "answer",
                    classify: () => Effect.succeed("task" as const),
                    speak: (text: string) =>
                      Effect.sync(() => {
                        if (text.startsWith("The coding task completed")) resultSpeaks += 1;
                      }),
                  };
                }),
            },
          ),
        ),
      );
    }),
  );
  it.effect("reserves one call per owner when concurrent starts pause before registration", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const bothReadingTime = yield* Deferred.make<void>();
      const releaseTime = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<string>();
      let timeReads = 0;
      const opened: string[] = [];
      const gatedClock: Clock.Clock = {
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
        currentTimeMillis: Effect.gen(function* () {
          timeReads++;
          if (timeReads <= 2) {
            if (timeReads === 2) yield* Deferred.succeed(bothReadingTime, undefined);
            yield* Deferred.await(releaseTime);
          }
          return yield* clock.currentTimeMillis;
        }),
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        currentTimeNanos: clock.currentTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) => clock.sleep(duration),
      };
      yield* Effect.gen(function* () {
        const calls = yield* VoiceCalls.VoiceCalls;
        const starting = yield* Effect.all(
          ["first", "second"].map((callId) =>
            calls
              .start(owner, { callId, threadId: target.threadId, offerSdp: "offer" })
              .pipe(Effect.exit, Effect.provideService(Clock.Clock, gatedClock)),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* Deferred.await(bothReadingTime);
        yield* Deferred.succeed(releaseTime, undefined);
        const results = yield* Fiber.join(starting);
        expect(opened).toHaveLength(1);
        const accepted = results.filter(Exit.isSuccess);
        const rejected = results.filter(Exit.isFailure);
        expect(accepted).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(Cause.squash(rejected[0]!.cause)).toMatchObject({ code: "call-exists" });
        const callId = accepted[0]!.value.snapshot.callId;
        expect(opened).toEqual([callId]);
        expect((yield* calls.snapshot(owner, callId, 0)).state).toBe("connected");
        expect((yield* calls.end(owner, callId)).state).toBe("ended");
        expect(yield* Deferred.await(closed)).toBe(callId);
        expect((yield* calls.snapshot(owner, callId, 0)).state).toBe("ended");
      }).pipe(
        Effect.provide(
          makeTestLayer(
            {},
            {
              open: (input) =>
                Effect.gen(function* () {
                  opened.push(input.callId);
                  yield* Effect.addFinalizer(() => Deferred.succeed(closed, input.callId));
                  return {
                    answerSdp: "answer",
                    classify: () => Effect.succeed("chat"),
                    speak: () => Effect.void,
                  };
                }),
            },
          ),
        ),
      );
    }),
  );
  it.effect("routes the native speech session through the target's speech binding", () =>
    Effect.gen(function* () {
      const opened = yield* Deferred.make<NativeVoice.NativeVoiceInput>();
      const piTarget = {
        ...target,
        instanceId: ProviderInstanceId.make("pi-instance"),
        model: "pi-model",
        speech: { instanceId: ProviderInstanceId.make("codex-instance"), model: null },
      };
      yield* Effect.gen(function* () {
        const calls = yield* VoiceCalls.VoiceCalls;
        yield* calls.start(owner, {
          callId: "call",
          threadId: piTarget.threadId,
          offerSdp: "offer",
        });
        const input = yield* Deferred.await(opened);
        expect(input.instanceId).toBe(piTarget.speech.instanceId);
        expect(input.model).toBeNull();
        expect(input.threadId).toBe(piTarget.threadId);
        expect(input.cwd).toBe(piTarget.cwd);
        expect(input.callId).toBe("call");
        expect(input.offerSdp).toBe("offer");
      }).pipe(
        Effect.provide(
          makeTestLayer(
            { bind: () => Effect.succeed(piTarget) },
            {
              open: (input) =>
                Deferred.succeed(opened, input).pipe(
                  Effect.as({
                    answerSdp: "answer",
                    classify: () => Effect.succeed("chat"),
                    speak: () => Effect.void,
                  }),
                ),
            },
          ),
        ),
      );
    }),
  );
  it.effect("bounds native-origin multibyte captions by count and UTF-8 bytes", () =>
    Effect.gen(function* () {
      const listener = yield* Deferred.make<NativeVoice.NativeVoiceListener>();
      yield* Effect.gen(function* () {
        const calls = yield* VoiceCalls.VoiceCalls;
        yield* calls.start(owner, { callId: "call", threadId: target.threadId, offerSdp: "offer" });
        const emit = yield* Deferred.await(listener);
        for (let index = 0; index < 300; index++) {
          yield* emit({ type: "caption", role: "assistant", text: `音声 ${index}` });
        }
        const countBounded = yield* calls.snapshot(owner, "call", 0);
        expect(countBounded.captions).toHaveLength(256);
        expect(countBounded.captions.at(-1)?.text).toBe("音声 299");
        const longCaption = "語".repeat(8000);
        for (let index = 0; index < 20; index++) {
          yield* emit({ type: "caption", role: "assistant", text: `${longCaption} ${index}` });
        }
        const byteBounded = yield* calls.snapshot(owner, "call", 0);
        expect(byteBounded.captions.length).toBeGreaterThan(0);
        expect(byteBounded.captions.length).toBeLessThanOrEqual(256);
        expect(
          new TextEncoder().encode(byteBounded.captions.map((caption) => caption.text).join(""))
            .length,
        ).toBeLessThanOrEqual(65_536);
        expect(byteBounded.captions.at(-1)?.text).toBe(`${longCaption} 19`);
      }).pipe(
        Effect.provide(
          makeTestLayer(
            {},
            {
              open: (_input, onEvent) =>
                Deferred.succeed(listener, onEvent).pipe(
                  Effect.as({
                    answerSdp: "answer",
                    classify: () => Effect.succeed("chat"),
                    speak: () => Effect.void,
                  }),
                ),
            },
          ),
        ),
      );
    }),
  );
  it.effect("rejects access revoked during native startup and closes the opened native call", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      let revoked = false;
      yield* Effect.gen(function* () {
        const calls = yield* VoiceCalls.VoiceCalls;
        const starting = yield* calls
          .start(owner, { callId: "call", threadId: target.threadId, offerSdp: "offer" })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(entered);
        revoked = true;
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(starting);
        expect(Exit.isFailure(result)).toBe(true);
        yield* Deferred.await(closed);
        revoked = false;
        expect((yield* calls.snapshot(owner, "call", 0)).state).toBe("error");
      }).pipe(
        Effect.provide(
          makeTestLayer(
            {
              authorize: () =>
                Effect.suspend(() =>
                  revoked
                    ? Effect.fail(
                        new OrbitVoiceError({ code: "forbidden", message: "Access was revoked." }),
                      )
                    : Effect.void,
                ),
            },
            {
              open: () =>
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return {
                    answerSdp: "answer",
                    classify: () => Effect.succeed("chat"),
                    speak: () => Effect.void,
                  };
                }),
            },
          ),
        ),
      );
    }),
  );
  it.effect("sends the recognized text unchanged once and rejects a changed duplicate", () =>
    Effect.gen(function* () {
      const sent = yield* Deferred.make<Parameters<T3Host.VoiceHost["Service"]["send"]>>();
      let sends = 0;
      const text = "  Change greeting.js.\nKeep the exact punctuation!  ";
      yield* Effect.gen(function* () {
        const calls = yield* VoiceCalls.VoiceCalls;
        yield* calls.start(owner, { callId: "call", threadId: target.threadId, offerSdp: "offer" });
        const input = { callId: "call", audioTurnId: "audio", transcript: text };
        yield* calls.submit(owner, input);
        const [destination, command] = yield* Deferred.await(sent);
        expect(destination).toBe(target);
        expect(command.text).toBe(text);
        yield* calls.submit(owner, input);
        const conflict = yield* calls
          .submit(owner, { ...input, transcript: "different" })
          .pipe(Effect.flip);
        expect(conflict.code).toBe("turn-conflict");
        expect(sends).toBe(1);
        expect((yield* calls.end(owner, "call")).state).toBe("ended");
      }).pipe(
        Effect.provide(
          makeTestLayer({
            send: (...args) =>
              Effect.gen(function* () {
                sends++;
                yield* Deferred.succeed(sent, args);
                return {
                  messageId: args[1].messageId,
                  runId: RunId.make("job"),
                  title: "Do the job",
                  state: "queued" as const,
                  startedAt: yield* DateTime.now,
                  result: null,
                  activity: null,
                  steps: [],
                  completedAt: null,
                };
              }),
          }),
        ),
      );
    }),
  );
  it.effect(
    "rejects empty and oversized UTF-8 transcripts before routing or retaining captions",
    () =>
      Effect.gen(function* () {
        const calls = yield* VoiceCalls.VoiceCalls;
        yield* calls.start(owner, { callId: "call", threadId: target.threadId, offerSdp: "offer" });
        for (const transcript of [" \n ", "語".repeat(6000)]) {
          const error = yield* calls
            .submit(owner, { callId: "call", audioTurnId: "audio", transcript })
            .pipe(Effect.flip);
          expect(error.code).toBe("invalid-input");
        }
        const snapshot = yield* calls.snapshot(owner, "call", 0);
        expect(snapshot.routing).toBe(false);
        expect(snapshot.captions).toHaveLength(0);
        expect(snapshot.tasks).toHaveLength(0);
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect("ends a call during classification without sending a late task", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      let sends = 0;
      yield* Effect.gen(function* () {
        const calls = yield* VoiceCalls.VoiceCalls;
        yield* calls.start(owner, { callId: "call", threadId: target.threadId, offerSdp: "offer" });
        yield* calls.submit(owner, {
          callId: "call",
          audioTurnId: "audio",
          transcript: "Change greeting.js",
        });
        yield* Deferred.await(entered);
        yield* calls.end(owner, "call");
        yield* Deferred.await(closed);
        expect(sends).toBe(0);
        expect((yield* calls.snapshot(owner, "call", 0)).state).toBe("ended");
      }).pipe(
        Effect.provide(
          makeTestLayer(
            {
              send: () =>
                Effect.sync(() => {
                  sends++;
                  throw new Error("Late dispatch");
                }),
            },
            {
              open: () =>
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
                  return {
                    answerSdp: "answer",
                    classify: () =>
                      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                    speak: () => Effect.void,
                  };
                }),
            },
          ),
        ),
      );
    }),
  );
  it.effect("speaks a routing failure when classification fails", () =>
    Effect.gen(function* () {
      const spoken = yield* Deferred.make<string>();
      yield* Effect.gen(function* () {
        const calls = yield* VoiceCalls.VoiceCalls;
        yield* calls.start(owner, { callId: "call", threadId: target.threadId, offerSdp: "offer" });
        yield* calls.submit(owner, {
          callId: "call",
          audioTurnId: "audio",
          transcript: "Change greeting.js",
        });
        const text = yield* Deferred.await(spoken);
        expect(text).toBe("The voice router took too long. Please try again.");
        const snapshot = yield* calls.snapshot(owner, "call", 0);
        expect(snapshot.message).toBe("The voice router took too long. Please try again.");
      }).pipe(
        Effect.provide(
          makeTestLayer(
            {},
            {
              open: () =>
                Effect.succeed({
                  answerSdp: "answer",
                  classify: () =>
                    Effect.fail(
                      new OrbitVoiceError({
                        code: "native_voice",
                        message: "The voice router took too long. Please try again.",
                      }),
                    ),
                  speak: (text: string) => Deferred.succeed(spoken, text).pipe(Effect.asVoid),
                }),
            },
          ),
        ),
      );
    }),
  );
  it.effect("rejects another owner's captions and closes an orphaned call", () =>
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const calls = yield* VoiceCalls.VoiceCalls;
        yield* calls.start(owner, { callId: "call", threadId: target.threadId, offerSdp: "offer" });
        const other = yield* calls
          .snapshot(AuthSessionId.make("other"), "call", 0)
          .pipe(Effect.flip);
        expect(other.code).toBe("not-found");
        yield* TestClock.adjust("31 seconds");
        yield* Deferred.await(closed);
        expect((yield* calls.snapshot(owner, "call", 0)).state).toBe("ended");
      }).pipe(
        Effect.provide(
          makeTestLayer(
            {},
            {
              open: () =>
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
                  return {
                    answerSdp: "answer",
                    classify: () => Effect.succeed("chat"),
                    speak: () => Effect.void,
                  };
                }),
            },
          ),
        ),
      );
    }),
  );
  it.effect("acknowledges transcript routing without waiting for the coding job", () =>
    Effect.gen(function* () {
      const calls = yield* VoiceCalls.VoiceCalls;
      yield* calls.start(owner, { callId: "call", threadId: target.threadId, offerSdp: "offer" });
      const result = yield* calls.submit(owner, {
        callId: "call",
        audioTurnId: "audio-1",
        transcript: "Change the greeting.",
      });
      expect(result.routing).toBe(true);
      expect(result.state).toBe("connected");
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("opens an owned call with an immutable destination", () =>
    Effect.gen(function* () {
      const calls = yield* VoiceCalls.VoiceCalls;
      const result = yield* calls
        .start(AuthSessionId.make("owner"), {
          callId: "call",
          threadId: ThreadId.make("thread"),
          offerSdp: "offer",
        })
        .pipe(Effect.exit);
      expect(Exit.isSuccess(result)).toBe(true);
      if (Exit.isSuccess(result)) {
        expect(result.value.answerSdp).toBe("answer");
        expect(result.value.snapshot.threadId).toBe(target.threadId);
        expect(result.value.snapshot.threadTitle).toBe("Original thread");
      }
    }).pipe(Effect.provide(testLayer)),
  );
});
