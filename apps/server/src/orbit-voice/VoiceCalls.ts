import {
  type AuthSessionId,
  type OrbitVoiceSnapshot,
  type OrbitVoiceStartInput,
  OrbitVoiceSubmitInput,
  OrbitVoiceError,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  MessageId,
  type OrbitVoiceTask,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as NativeVoice from "./NativeVoice.ts";
import * as T3Host from "./T3Host.ts";

const decodeSubmission = Schema.decodeEffect(OrbitVoiceSubmitInput);

export class VoiceCalls extends Context.Service<
  VoiceCalls,
  {
    readonly start: (
      owner: AuthSessionId,
      input: OrbitVoiceStartInput,
    ) => Effect.Effect<{ answerSdp: string; snapshot: OrbitVoiceSnapshot }, OrbitVoiceError>;
    readonly submit: (
      owner: AuthSessionId,
      input: OrbitVoiceSubmitInput,
    ) => Effect.Effect<OrbitVoiceSnapshot, OrbitVoiceError>;
    readonly end: (
      owner: AuthSessionId,
      callId: string,
    ) => Effect.Effect<OrbitVoiceSnapshot, OrbitVoiceError>;
    readonly renewPresence: (
      owner: AuthSessionId,
      callId: string,
    ) => Effect.Effect<OrbitVoiceSnapshot, OrbitVoiceError>;
    readonly snapshot: (
      owner: AuthSessionId,
      callId: string,
      afterSequence: number,
    ) => Effect.Effect<OrbitVoiceSnapshot, OrbitVoiceError>;
  }
>()("t3/orbit-voice/VoiceCalls") {}

interface Call {
  owner: AuthSessionId;
  target: T3Host.VoiceTarget;
  scope: Scope.Closeable;
  value: OrbitVoiceSnapshot;
  native?: NativeVoice.NativeVoiceCall;
  changed: Deferred.Deferred<void>;
  lastPresence: number;
  submissions: Map<string, { text: string; commandId: CommandId; messageId: MessageId }>;
  routingCount: number;
  router: Semaphore.Semaphore;
  spokenCount: number;
  spokenWaiters: Array<Deferred.Deferred<void>>;
}

const make = Effect.gen(function* () {
  const host = yield* T3Host.VoiceHost;
  const native = yield* NativeVoice.NativeVoice;
  const serviceScope = yield* Scope.Scope;
  const crypto = yield* Crypto.Crypto;
  const calls = new Map<AuthSessionId, Call>();
  const publish = (call: Call, change: Partial<OrbitVoiceSnapshot>) =>
    Effect.gen(function* () {
      if (!active(call)) return;
      call.value = { ...call.value, ...change, sequence: call.value.sequence + 1 };
      const previous = call.changed;
      call.changed = Deferred.makeUnsafe();
      yield* Deferred.succeed(previous, undefined);
    });
  const active = (call: Call) =>
    call.value.state === "starting" || call.value.state === "connected";
  const close = (call: Call, state: "ended" | "error", message: string | null) =>
    Effect.gen(function* () {
      if (!active(call)) return;
      yield* publish(call, { state, message, routing: false });
      yield* Scope.close(call.scope, Exit.void).pipe(Effect.forkIn(serviceScope));
    });
  const get = (owner: AuthSessionId, callId: string, write = true) =>
    Effect.gen(function* () {
      yield* host.authorize(
        owner,
        write ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
      );
      const call = calls.get(owner);
      if (!call || call.value.callId !== callId)
        return yield* new OrbitVoiceError({
          code: "not-found",
          message: "This voice call is unavailable.",
        });
      return call;
    });
  const caption = (call: Call, role: "user" | "assistant", text: string) => {
    const captions = [
      ...call.value.captions,
      { sequence: call.value.sequence + 1, role, text: text.slice(0, 16_384) },
    ];
    while (
      captions.length > 256 ||
      new TextEncoder().encode(captions.map((item) => item.text).join("")).length > 65_536
    )
      captions.shift();
    return Effect.gen(function* () {
      if (role === "assistant") {
        call.spokenCount++;
        for (const waiter of call.spokenWaiters.splice(0))
          yield* Deferred.succeed(waiter, undefined);
      }
      yield* publish(call, { captions });
    });
  };
  const speak = (call: Call, text: string) =>
    call.native && active(call)
      ? call.native.speak(text).pipe(
          Effect.catch(() =>
            publish(call, {
              message: "The spoken reply failed. You can still read the task status.",
            }),
          ),
        )
      : Effect.void;
  // ponytail: confirms the model actually rendered a task-result speech by waiting for an
  // assistant caption; one retry, then a written note. 10s covers observed caption lag (~4s max).
  const waitSpoken = (call: Call, since: number) =>
    Effect.suspend(() => {
      if (call.spokenCount > since || !active(call)) return Effect.void;
      const waiter = Deferred.makeUnsafe<void>();
      call.spokenWaiters.push(waiter);
      return Effect.ensuring(
        Deferred.await(waiter),
        Effect.sync(() => {
          const index = call.spokenWaiters.indexOf(waiter);
          if (index >= 0) call.spokenWaiters.splice(index, 1);
        }),
      );
    });
  const speakConfirmed = (call: Call, text: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!active(call)) return;
        const since = call.spokenCount;
        yield* speak(call, text);
        const confirmed = yield* waitSpoken(call, since).pipe(
          Effect.as(true),
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.succeed(false),
          }),
        );
        if (confirmed) return;
      }
      yield* publish(call, {
        message: "The spoken task result is delayed. Check the coding thread for details.",
      });
    });
  const updateTask = (call: Call, task: OrbitVoiceTask) =>
    publish(call, {
      tasks: [...call.value.tasks.filter((item) => item.messageId !== task.messageId), task].slice(
        -32,
      ),
    });
  const route = (
    call: Call,
    submission: { text: string; commandId: CommandId; messageId: MessageId },
  ) =>
    Effect.gen(function* () {
      if (!active(call) || !call.native) return;
      yield* host.authorize(call.owner, AuthOrchestrationOperateScope);
      const runId = yield* host.readActiveRun(call.target);
      const decision = yield* call.native
        .classify({
          text: submission.text,
          context: `Active run: ${runId ?? "none"}. Recent task states: ${
            call.value.tasks
              .slice(-8)
              .map((task) => task.state)
              .join(", ") || "none"
          }.`,
        })
        .pipe(
          Effect.timeoutOrElse({
            duration: "20 seconds",
            orElse: () =>
              Effect.fail(
                new OrbitVoiceError({
                  code: "routing-timeout",
                  message: "I could not decide how to handle that request. Please try again.",
                }),
              ),
          }),
        );
      if (!active(call)) return;
      yield* host.authorize(call.owner, AuthOrchestrationOperateScope);
      if (decision === "chat") return;
      if (decision === "clarify" || (decision === "steer" && runId === null)) {
        yield* speak(call, "Please clarify the coding change you want. I have not sent a task.");
        return;
      }
      if (decision === "status") {
        const latest = call.value.tasks.at(-1);
        yield* speak(
          call,
          latest
            ? `The latest coding task is ${latest.state}.${latest.state === "completed" && latest.result ? ` ${latest.result.slice(0, 4000)}` : ""}`
            : "No coding task has been accepted in this call.",
        );
        return;
      }
      const task = yield* host.send(call.target, {
        text: submission.text,
        commandId: submission.commandId,
        messageId: submission.messageId,
        ...(decision === "steer" && runId !== null ? { steerRunId: runId } : {}),
      });
      if (!active(call)) return;
      yield* updateTask(call, task);
      yield* speak(
        call,
        decision === "steer"
          ? "I sent that correction to the current coding task."
          : "The coding task was accepted. We can keep talking while it runs.",
      );
      yield* host.watchTask(call.target, task).pipe(
        Stream.runForEach((update) =>
          Effect.gen(function* () {
            if (!active(call)) return;
            yield* updateTask(call, update);
            if (update.state === "completed")
              yield* speakConfirmed(
                call,
                `The coding task completed. ${update.result?.slice(0, 6000) ?? "See the coding thread for details."}`,
              );
            else if (update.state === "waiting")
              yield* speak(call, "The coding task needs your attention in the thread.");
            else if (update.state === "failed" || update.state === "cancelled")
              yield* speak(
                call,
                `The coding task ${update.state}. Check the coding thread for details.`,
              );
          }),
        ),
        Effect.catch(() =>
          publish(call, { message: "Task updates stopped. Check the original coding thread." }),
        ),
        Effect.forkIn(call.scope),
      );
    }).pipe(
      call.router.withPermit,
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* publish(call, { message: error.message });
          // A voice caller cannot see the panel; say routing failures out loud.
          yield* speak(call, error.message);
        }),
      ),
      Effect.ensuring(
        Effect.suspend(() => {
          call.routingCount--;
          return active(call) ? publish(call, { routing: call.routingCount > 0 }) : Effect.void;
        }),
      ),
    );
  return VoiceCalls.of({
    start: (owner, input) =>
      Effect.gen(function* () {
        yield* host.authorize(owner, AuthOrchestrationOperateScope);
        const target = yield* host.bind(input.threadId);
        const lastPresence = yield* Clock.currentTimeMillis;
        const scope = yield* Scope.fork(serviceScope);
        // Keep the owner check and reservation in one synchronous step.
        const previous = calls.get(owner);
        if (previous && (active(previous) || previous.value.callId === input.callId)) {
          yield* Scope.close(scope, Exit.void);
          return yield* new OrbitVoiceError({
            code: "call-exists",
            message: "End the current voice call before starting another.",
          });
        }
        if (calls.size >= 128 && !previous) {
          const ended = [...calls.entries()].find(([, call]) => !active(call));
          if (ended) calls.delete(ended[0]);
          else {
            yield* Scope.close(scope, Exit.void);
            return yield* new OrbitVoiceError({
              code: "busy",
              message: "The voice service is busy.",
            });
          }
        }
        const call: Call = {
          owner,
          target,
          scope,
          changed: Deferred.makeUnsafe(),
          lastPresence,
          submissions: new Map(),
          routingCount: 0,
          router: Semaphore.makeUnsafe(1),
          spokenCount: 0,
          spokenWaiters: [],
          value: {
            callId: input.callId,
            threadId: target.threadId,
            threadTitle: target.threadTitle,
            state: "starting",
            message: null,
            sequence: 0,
            captions: [],
            tasks: [],
            routing: false,
          },
        };
        calls.set(owner, call);
        const result = yield* native
          .open(
            {
              instanceId: target.speech.instanceId,
              model: target.speech.model,
              threadId: target.threadId,
              cwd: target.cwd,
              callId: input.callId,
              offerSdp: input.offerSdp,
            },
            (event) =>
              !active(call)
                ? Effect.void
                : event.type === "closed"
                  ? close(call, "error", event.message)
                  : caption(call, event.role, event.text),
          )
          .pipe(
            Scope.provide(scope),
            Effect.forkIn(scope),
            Effect.flatMap(Fiber.join),
            Effect.tap(() => host.authorize(owner, AuthOrchestrationOperateScope)),
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () =>
                Effect.fail(
                  new OrbitVoiceError({
                    code: "timeout",
                    message: "Voice did not connect. Try starting a new call.",
                  }),
                ),
            }),
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? close(call, "error", "Voice could not connect.") : Effect.void,
            ),
          );
        if (!active(call))
          return yield* new OrbitVoiceError({
            code: "ended",
            message: "This voice call has ended.",
          });
        call.native = result;
        yield* publish(call, { state: "connected" });
        yield* host.awaitRevocation(owner).pipe(
          Effect.catch(() => Effect.void),
          Effect.andThen(close(call, "error", "Voice ended because access changed.")),
          Effect.forkIn(scope),
        );
        // The card also tracks work the user typed in chat, not only voice-delegated tasks.
        // Updates are silent: spoken task announcements stay in route()'s watcher.
        yield* host.watchActiveTask(call.target).pipe(
          Stream.runForEach((task) => (active(call) ? updateTask(call, task) : Effect.void)),
          Effect.forkIn(scope),
        );
        yield* Effect.gen(function* () {
          while (active(call)) {
            yield* Effect.sleep("10 seconds");
            if ((yield* Clock.currentTimeMillis) - call.lastPresence >= 30_000)
              yield* close(call, "ended", "Voice ended after the connection was lost.");
          }
        }).pipe(Effect.forkIn(scope));
        yield* Effect.sleep("60 minutes").pipe(
          Effect.andThen(close(call, "ended", "Voice reached the one-hour call limit.")),
          Effect.forkIn(scope),
        );
        return { answerSdp: result.answerSdp, snapshot: call.value };
      }),
    submit: (owner, input) =>
      Effect.gen(function* () {
        yield* decodeSubmission(input).pipe(
          Effect.mapError(
            () =>
              new OrbitVoiceError({
                code: "invalid-input",
                message: "The recognized request is empty or too long.",
              }),
          ),
        );
        const commandId = CommandId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
        const messageId = MessageId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
        const call = yield* get(owner, input.callId);
        if (call.value.state !== "connected")
          return yield* new OrbitVoiceError({
            code: "ended",
            message: "This voice call is not connected.",
          });
        const previous = call.submissions.get(input.audioTurnId);
        if (previous) {
          if (previous.text !== input.transcript)
            return yield* new OrbitVoiceError({
              code: "turn-conflict",
              message: "This voice turn was already received with different text.",
            });
          return call.value;
        }
        if (call.routingCount >= 8 || call.submissions.size >= 256)
          return yield* new OrbitVoiceError({
            code: "busy",
            message:
              "The voice request limit was reached. Wait for routing to finish or start a new call.",
          });
        const submission = {
          text: input.transcript,
          commandId,
          messageId,
        };
        call.submissions.set(input.audioTurnId, submission);
        call.routingCount++;
        yield* caption(call, "user", input.transcript);
        yield* publish(call, { routing: true, message: null });
        const accepted = call.value;
        yield* route(call, submission).pipe(Effect.forkIn(call.scope));
        return accepted;
      }),
    end: (owner, callId) =>
      Effect.gen(function* () {
        const call = yield* get(owner, callId);
        yield* close(call, "ended", null);
        return call.value;
      }),
    renewPresence: (owner, callId) =>
      Effect.gen(function* () {
        const call = yield* get(owner, callId);
        call.lastPresence = yield* Clock.currentTimeMillis;
        return call.value;
      }),
    snapshot: (owner, callId, afterSequence) =>
      Effect.gen(function* () {
        const call = yield* get(owner, callId, false);
        if (call.value.sequence <= afterSequence && active(call))
          yield* Deferred.await(call.changed).pipe(Effect.timeoutOption("20 seconds"));
        yield* host.authorize(owner, AuthOrchestrationReadScope);
        return call.value;
      }),
  });
});

export const layer = Layer.effect(VoiceCalls, make);
