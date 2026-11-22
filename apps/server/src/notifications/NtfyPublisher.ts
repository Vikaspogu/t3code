import { isListedThreadLineage, type RuntimeRequestId, type ThreadId } from "@t3tools/contracts";
import {
  type AgentAwarenessState,
  type SubagentRequestAwareness,
  projectThreadAwarenessV2,
  subagentAwaitsUser,
} from "@t3tools/shared/agentAwareness";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  makeAgentAwarenessPublishWorker,
  resolveAgentAwarenessRelayActiveThreadIds,
  shouldPublishAgentAwarenessEvent,
  snoozedCompletion,
} from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";

const KINDS = ["approval", "input", "failed", "completed"] as const;
type AlertKind = (typeof KINDS)[number];
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const HEADLINES = {
  approval: "Needs approval",
  input: "Needs input",
  failed: "Failed",
  completed: "Finished",
};

class NtfyConfigError extends Schema.TaggedError<NtfyConfigError>()("NtfyConfigError", {}) {}

export const readConfig = Effect.gen(function* () {
  const configuredUrl = yield* Config.String("T3CODE_NTFY_URL").pipe(Config.option);
  if (Option.isNone(configuredUrl)) return null;
  const url = yield* Effect.try({
    try: () => new URL(configuredUrl.value),
    catch: () => new NtfyConfigError(),
  });
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return yield* new NtfyConfigError();
  const topic = (yield* Config.String("T3CODE_NTFY_TOPIC")).trim();
  const tokenFile = yield* Config.String("T3CODE_NTFY_TOKEN_FILE");
  const configuredEvents = yield* Config.String("T3CODE_NTFY_EVENTS").pipe(
    Config.withDefault(KINDS.join(",")),
  );
  const events = new Set<AlertKind>();
  for (const event of configuredEvents.split(",").map((value) => value.trim())) {
    const kind = KINDS.find((kind) => kind === event);
    if (kind === undefined) return yield* new NtfyConfigError();
    events.add(kind);
  }
  const fs = yield* FileSystem.FileSystem;
  const token = (yield* fs.readFileString(tokenFile)).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(topic) || token.length === 0) {
    return yield* new NtfyConfigError();
  }
  return { url: url.href.replace(/\/+$/, ""), topic, token: Redacted.make(token), events };
});

function decideNtfyAlert(input: {
  readonly state: AgentAwarenessState | null;
  readonly thread: AgentAwarenessThread;
  readonly pending: SubagentRequestAwareness | null;
  readonly startedAt: number;
  readonly events: ReadonlySet<AlertKind>;
}): { readonly key: string; readonly kind: AlertKind; readonly hold: boolean } | null {
  const { state, thread, pending, startedAt, events } = input;
  let kind: AlertKind;
  let key: string;
  switch (state?.phase) {
    case "waiting_for_approval":
    case "waiting_for_input": {
      const requestId =
        (thread.pendingRuntimeRequest?.kind === "auth_refresh"
          ? undefined
          : thread.pendingRuntimeRequest?.id) ?? pending?.requestId;
      if (requestId === undefined) return null;
      kind = state.phase === "waiting_for_input" ? "input" : "approval";
      key = `wait:${requestId}`;
      break;
    }
    case "completed":
    case "failed":
      if (
        thread.latestRunId === null ||
        thread.latestRunCompletedAt == null ||
        DateTime.toEpochMillis(thread.latestRunCompletedAt) <= startedAt ||
        snoozedCompletion(thread, state)
      )
        return null;
      kind = state.phase;
      key = `${kind}:${thread.latestRunId}`;
      break;
    default:
      return null;
  }
  return events.has(kind) ? { key, kind, hold: kind === "completed" } : null;
}

export const make = Effect.gen(function* () {
  const config = yield* readConfig.pipe(
    Effect.catch(() =>
      Effect.logError(
        "ntfy publisher disabled; configuration or token file could not be loaded",
      ).pipe(Effect.as(null)),
    ),
  );
  if (config === null) {
    yield* Effect.logDebug("ntfy publisher disabled");
    return { publishThread: (_threadId: ThreadId) => Effect.void, drain: Effect.void };
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const client = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  const startedAt = (yield* DateTime.now).epochMilliseconds;
  const doneKeys = new Map<ThreadId, Set<string>>();
  const holds = new Map<ThreadId, { key: string; deadlineMs: number }>();
  const retries = new Map<ThreadId, { key: string; attempt: number; nextAt: number }>();
  const snoozes = new Map<ThreadId, Pick<AgentAwarenessThread, "snoozedAt" | "snoozedUntil">>();
  const subagentRequests = new Map<
    ThreadId,
    {
      topLevelThreadId: ThreadId;
      requestId: RuntimeRequestId;
    }
  >();
  let enqueue: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;

  // These per-event helpers share evaluate's tracing boundary.
  const readThread = (threadId: ThreadId) =>
    threads
      .getAgentAwarenessSnapshot(threadId)
      .pipe(Effect.map((snapshot) => snapshot.threads[0] ?? null));
  const waitingRequestId = (thread: AgentAwarenessThread | null) =>
    thread !== null && thread.archivedAt === null && subagentAwaitsUser(thread)
      ? thread.pendingRuntimeRequest?.id
      : undefined;
  const findTopLevelThreadId = Effect.fnUntraced(function* (child: AgentAwarenessThread) {
    const seen = new Set<ThreadId>([child.id]);
    let current: AgentAwarenessThread | null = child;
    while (
      current?.lineage.relationshipToParent === "subagent" ||
      current?.lineage.sideChat === true
    ) {
      const parentId: ThreadId | null = current.lineage.parentThreadId;
      if (parentId === null || seen.has(parentId)) return null;
      seen.add(parentId);
      current = yield* readThread(parentId);
    }
    return current?.id ?? null;
  });
  const trackSubagentRequest = Effect.fnUntraced(function* (
    threadId: ThreadId,
    thread: AgentAwarenessThread | null,
  ) {
    const requestId = waitingRequestId(thread);
    const previous = subagentRequests.get(threadId);
    if (thread === null || requestId === undefined) {
      if (previous === undefined) return;
      subagentRequests.delete(threadId);
      yield* enqueue(previous.topLevelThreadId);
      return;
    }
    const topLevelThreadId = previous?.topLevelThreadId ?? (yield* findTopLevelThreadId(thread));
    if (topLevelThreadId === null) return;
    subagentRequests.set(threadId, { topLevelThreadId, requestId });
    yield* enqueue(topLevelThreadId);
  });
  const currentSubagentRequestFor = Effect.fnUntraced(function* (topLevelThreadId: ThreadId) {
    let pending: SubagentRequestAwareness | null = null;
    for (const [childId, entry] of subagentRequests) {
      if (entry.topLevelThreadId !== topLevelThreadId) continue;
      const child = yield* readThread(childId);
      const requestId = waitingRequestId(child);
      if (child === null || requestId === undefined) {
        subagentRequests.delete(childId);
        continue;
      }
      if (requestId !== entry.requestId) subagentRequests.set(childId, { ...entry, requestId });
      if (doneKeys.get(topLevelThreadId)?.has(`wait:${requestId}`)) continue;
      if (
        !config.events.has(
          child.pendingRuntimeRequest?.kind === "user_input" ? "input" : "approval",
        )
      )
        continue;
      if (pending === null || DateTime.isGreaterThan(child.updatedAt, pending.updatedAt)) {
        pending = {
          requestId,
          updatedAt: child.updatedAt,
          waitsForInput: child.pendingRuntimeRequest?.kind === "user_input",
        };
      }
    }
    return pending;
  });
  const wakeAfter = (threadId: ThreadId, delayMs: number) =>
    Effect.forkIn(Effect.sleep(delayMs).pipe(Effect.andThen(enqueue(threadId))), scope).pipe(
      Effect.asVoid,
    );
  const markDone = (threadId: ThreadId, key: string) => {
    const keys = doneKeys.get(threadId) ?? new Set<string>();
    keys.add(key);
    // ponytail: keep 32 recent keys plus every still-pending child wait.
    if (keys.size > 32) {
      const recentKeys = new Set([...keys].slice(-32));
      const liveKeys = new Set(
        [...subagentRequests.values()]
          .filter((entry) => entry.topLevelThreadId === threadId)
          .map((entry) => `wait:${entry.requestId}`),
      );
      for (const previous of keys) {
        if (!recentKeys.has(previous) && !liveKeys.has(previous)) keys.delete(previous);
      }
    }
    doneKeys.set(threadId, keys);
    holds.delete(threadId);
    retries.delete(threadId);
  };

  const evaluate = Effect.fn("NtfyPublisher.evaluate")(
    function* (threadId: ThreadId) {
      let thread = yield* readThread(threadId);
      if (thread?.snoozedAt != null) {
        snoozes.set(threadId, { snoozedAt: thread.snoozedAt, snoozedUntil: thread.snoozedUntil });
      }
      yield* trackSubagentRequest(threadId, thread);
      if (thread !== null && !isListedThreadLineage(thread.lineage)) return;
      const project =
        thread === null || thread.archivedAt !== null
          ? Option.none()
          : yield* projects.getById(thread.projectId);
      if (thread === null || Option.isNone(project)) {
        doneKeys.delete(threadId);
        holds.delete(threadId);
        retries.delete(threadId);
        snoozes.delete(threadId);
        for (const [childId, entry] of subagentRequests) {
          if (entry.topLevelThreadId === threadId) subagentRequests.delete(childId);
        }
        return;
      }
      const pending = yield* currentSubagentRequestFor(threadId);
      if (
        pending !== null &&
        thread.pendingRuntimeRequest !== null &&
        !config.events.has(
          thread.pendingRuntimeRequest.kind === "user_input" ? "input" : "approval",
        )
      )
        thread = { ...thread, pendingRuntimeRequest: null };
      const projectState = (shell: AgentAwarenessThread) =>
        projectThreadAwarenessV2({
          environmentId,
          project: project.value,
          thread: shell,
          pendingSubagentRequest: pending,
        });
      let state = projectState(thread);
      let decision = decideNtfyAlert({ state, thread, pending, startedAt, events: config.events });
      if (decision === null && thread.settledOverride === "settled") {
        state = projectState({ ...thread, settledOverride: null });
        decision = decideNtfyAlert({ state, thread, pending, startedAt, events: config.events });
      }
      if (
        state?.phase === "completed" &&
        thread.latestRunId !== null &&
        snoozedCompletion({ ...thread, ...snoozes.get(threadId) }, state)
      ) {
        markDone(threadId, `completed:${thread.latestRunId}`);
        return;
      }
      if (decision === null || state === null) {
        holds.delete(threadId);
        retries.delete(threadId);
        return;
      }
      if (doneKeys.get(threadId)?.has(decision.key)) {
        holds.delete(threadId);
        return;
      }
      const now = (yield* DateTime.now).epochMilliseconds;
      if (retries.get(threadId)?.key !== decision.key) retries.delete(threadId);
      if (decision.hold) {
        const hold = holds.get(threadId);
        if (hold?.key !== decision.key) {
          holds.set(threadId, { key: decision.key, deadlineMs: now + 5_000 });
          yield* wakeAfter(threadId, 5_000);
          return;
        }
        if (now < hold.deadlineMs) return;
      }
      const retry = retries.get(threadId);
      if (retry !== undefined && now < retry.nextAt) return;
      const childWait =
        (thread.pendingRuntimeRequest === null ||
          thread.pendingRuntimeRequest.kind === "auth_refresh") &&
        pending !== null;
      const headline = childWait
        ? `Subagent ${HEADLINES[decision.kind].toLowerCase()}`
        : HEADLINES[decision.kind];
      // ponytail: sequential sends can delay other threads by 10s; add per-thread sends only if observed.
      const status = yield* HttpClientRequest.post(config.url).pipe(
        HttpClientRequest.bearerToken(config.token),
        HttpClientRequest.bodyJson({
          topic: config.topic,
          title: thread.title || "T3 Code",
          message: `${headline} · ${project.value.title}`,
          priority: decision.kind === "completed" ? 3 : 4,
          tags: ["t3code", decision.kind],
          click: `t3code://${state.deepLink.slice(1)}`,
        }),
        Effect.flatMap(client.execute),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.map((response) => response.status),
        Effect.timeout("10 seconds"),
        Effect.catch((error) =>
          Effect.logWarning("ntfy publish failed", { errorTag: error._tag }).pipe(Effect.as(0)),
        ),
      );
      if (status >= 200 && status < 300) {
        markDone(threadId, decision.key);
      } else if (status === 0 || status === 429 || status >= 500) {
        const attempt = retry?.attempt ?? 0;
        const delayMs = RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined) {
          yield* Effect.logWarning("ntfy publish retry budget exhausted", { threadId });
          markDone(threadId, decision.key);
        } else {
          yield* Effect.logWarning("ntfy publish retry scheduled", { status, threadId });
          retries.set(threadId, {
            key: decision.key,
            attempt: attempt + 1,
            nextAt: (yield* DateTime.now).epochMilliseconds + delayMs,
          });
          yield* wakeAfter(threadId, delayMs);
        }
      } else {
        yield* Effect.logError("ntfy publish rejected", { status, threadId });
        markDone(threadId, decision.key);
      }
      if (childWait && doneKeys.get(threadId)?.has(decision.key)) yield* enqueue(threadId);
    },
    Effect.catch(() => Effect.logWarning("ntfy thread evaluation failed")),
  );

  const worker = yield* makeAgentAwarenessPublishWorker(evaluate);
  enqueue = worker.enqueue;
  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) => {
      if (event.type === "thread.snoozed") {
        snoozes.set(event.threadId, {
          snoozedAt: event.payload.snoozedAt,
          snoozedUntil: event.payload.snoozedUntil,
        });
      } else if (event.type === "thread.unsnoozed") {
        const previous = snoozes.get(event.threadId);
        if (previous !== undefined)
          snoozes.set(event.threadId, {
            ...previous,
            snoozedUntil:
              previous.snoozedUntil !== undefined &&
              previous.snoozedUntil !== null &&
              DateTime.isLessThan(previous.snoozedUntil, event.occurredAt)
                ? previous.snoozedUntil
                : event.occurredAt,
          });
      }
      return shouldPublishAgentAwarenessEvent(event) ? enqueue(event.threadId) : Effect.void;
    }),
  );
  const catchUp = Effect.gen(function* () {
    const projectSnapshot = yield* projects.snapshot;
    const snapshot = yield* threads.getAgentAwarenessSnapshot();
    const children = yield* Effect.forEach(
      (yield* threads.listActiveShellIndex()).filter(
        (thread) => thread.lineage.relationshipToParent === "subagent" && thread.mayBeLive,
      ),
      (thread) => readThread(thread.id),
    );
    yield* Effect.forEach(
      resolveAgentAwarenessRelayActiveThreadIds({
        environmentId,
        startedAt,
        projects: projectSnapshot.projects,
        threads: [...snapshot.threads, ...children.filter((thread) => thread !== null)].map(
          (thread) =>
            thread.settledOverride === "settled" ? { ...thread, settledOverride: null } : thread,
        ),
      }),
      enqueue,
      { discard: true },
    );
  });
  yield* forkParked(
    catchUp.pipe(
      Effect.retry({ schedule: Schedule.exponential("1 second"), times: 5 }),
      Effect.catch(() => Effect.logWarning("ntfy startup catch-up failed")),
    ),
  );
  return {
    publishThread: (threadId: ThreadId) => enqueue(threadId).pipe(Effect.andThen(worker.drain)),
    drain: worker.drain,
  };
}).pipe(Effect.provide(FetchHttpClient.layer));

export const layer = Layer.effectDiscard(make);
