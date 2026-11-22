import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationV2AppThread,
  EnvironmentId,
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as NtfyPublisher from "./NtfyPublisher.ts";

const THREAD_ID = ThreadId.make("ntfy-thread");
const PROJECT_ID = ProjectId.make("ntfy-project");
const unused = () => Effect.die("Unexpected test dependency call");
const ENV = {
  T3CODE_NTFY_URL: "https://ntfy.example.test///",
  T3CODE_NTFY_TOPIC: "t3code-host",
  T3CODE_NTFY_TOKEN_FILE: "/run/secrets/ntfy",
};
const configLayer = (env: Record<string, string> = ENV) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }));
const fileSystemLayer = (token = "  tk_secret\n") =>
  FileSystem.layerNoop({
    readFileString: () => Effect.succeed(token),
  });

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread 🔔",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}
const wait = (id = "request-1", kind: "command" | "user_input" = "command") =>
  shell({
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make(id),
      kind,
      createdAt: DateTime.makeUnsafe(0),
    },
  });
const terminal = (status: "completed" | "failed" = "completed") =>
  shell({
    status,
    latestRunId: RunId.make("run-1"),
    latestRunCompletedAt: DateTime.makeUnsafe(1),
  });
const payloadSchema = Schema.Struct({
  topic: Schema.String,
  title: Schema.String,
  message: Schema.String,
  priority: Schema.Number,
  click: Schema.String,
  tags: Schema.Array(Schema.String),
});
const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(payloadSchema));
const appThread = Schema.decodeUnknownSync(OrchestrationV2AppThread);

const setup = Effect.fnUntraced(function* (
  options: {
    readonly env?: Record<string, string>;
    readonly respond?: (attempt: number) => Response | Promise<Response>;
    readonly initial?: ReadonlyArray<OrchestrationV2ThreadShell>;
    readonly catchUp?: boolean;
    readonly failCatchUpOnce?: boolean;
  } = {},
) {
  const shells = new Map((options.initial ?? [shell()]).map((value) => [value.id, value]));
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const pulls = yield* Queue.unbounded<void>();
  const sent = yield* Queue.unbounded<void>();
  const snapshots = yield* Queue.unbounded<void>();
  let snapshotReads = 0;
  const threads = ThreadManagement.ThreadManagementService.of({
    getThreadShell: unused,
    getShellSnapshot: unused,
    getAgentAwarenessSnapshot: (threadId) =>
      Effect.gen(function* () {
        if (threadId === undefined) {
          yield* Queue.offer(snapshots, undefined);
          if (options.failCatchUpOnce && snapshotReads++ === 0) {
            return yield* new OrchestratorProjectionError({ threadId: THREAD_ID });
          }
          return {
            snapshotSequence: 1,
            threads: options.catchUp
              ? [...shells.values()].filter((s) => s.lineage.relationshipToParent !== "subagent")
              : [],
          };
        }
        const value = shells.get(threadId);
        return { snapshotSequence: 1, threads: value === undefined ? [] : [value] };
      }),
    listActiveSubagentThreadIds: unused,
    listAppOwnedChildThreadIds: unused,
    countThreads: unused,
    listActiveShellIndex: () =>
      Effect.succeed(
        [...shells.values()].map((thread) => ({
          ...thread,
          mayBeLive: true,
          hasRemoteTasks: false,
        })),
      ),
    listOlderSettledThreads: unused,
    readShellSnapshot: unused,
    getThreadTitles: unused,
    getThreadLinkMetadata: unused,
    ensureLegacyTranscript: unused,
    dispatch: unused,
    searchThread: unused,
    searchThreadStream: () => Stream.empty,
    getThreadHistoryPage: unused,
    getTimelinePage: unused,
    getMessageCount: unused,
    getMessagesById: unused,
    getTurnItem: unused,
    getThreadRecords: unused,
    getThreadProjection: unused,
    getCheckpointContext: unused,
    getThreadSnapshot: unused,
    getThreadTranscript: unused,
    getThreadSnapshotWindow: unused,
    getProjectThreadRecords: unused,
    listProjectThreads: unused,
    sendToThread: unused,
    assertProviderInstanceEnabled: unused,
    isProviderInstanceEnabledForProject: unused,
    hasReceipt: unused,
    waitForThread: unused,
    settleAfterRun: unused,
    settleThread: unused,
    interruptThread: unused,
    stopWorkflow: unused,
    forceStopThread: unused,
    awaitBackgroundTasks: unused,
    stopDelegatedTasks: unused,
    getThreadEventSequence: unused,
    recoverDelegatedTask: unused,
    cancelDelegatedTask: unused,
    delegatedTaskResultPending: unused,
    streamStoredEvents: Stream.empty,
    streamStoredEventsFrom: () => Stream.empty,
    streamDomainEvents: Stream.fromEffectRepeat(
      Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
    ),
  });
  const publications: Array<{
    url: string;
    redirect: string | undefined;
    authorization: string | null;
    body: typeof payloadSchema.Type;
  }> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const body = init?.body;
      if (typeof body !== "string" && !(body instanceof Uint8Array))
        return Promise.reject(new Error("Expected serialized payload"));
      publications.push({
        url: String(input),
        redirect: init?.redirect,
        authorization: new Headers(init?.headers).get("authorization"),
        body: decodePayload(typeof body === "string" ? body : new TextDecoder().decode(body)),
      });
      Queue.offerUnsafe(sent, undefined);
      return Promise.resolve(options.respond?.(publications.length) ?? Response.json({ ok: true }));
    },
    { preconnect: () => {} },
  );
  const project = {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    deletedAt: null,
  };
  const publisher = yield* NtfyPublisher.make.pipe(
    Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("ntfy-environment")),
      getDescriptor: unused(),
    }),
    Effect.provideService(ProjectService.ProjectService, {
      create: unused,
      bootstrap: unused,
      update: unused,
      delete: unused,
      getByWorkspaceRoot: unused,
      workspaceScanDirectory: unused,
      snapshot: Effect.succeed({ projects: [project], updatedAt: project.updatedAt }),
      listPage: unused,
      getShell: unused,
      listShells: unused,
      getById: () => Effect.succeedSome(project),
    }),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provide([configLayer(options.env), fileSystemLayer()]),
  );
  if ((options.env ?? ENV).T3CODE_NTFY_URL !== undefined) yield* Queue.take(pulls);
  const deliver = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    yield* Queue.offer(events, event);
    yield* Queue.take(pulls);
    yield* publisher.drain;
  });
  const rename = (id = THREAD_ID) =>
    deliver({
      id: EventId.make("rename"),
      type: "thread.metadata-updated",
      threadId: id,
      occurredAt: DateTime.makeUnsafe(0),
      payload: appThread(shells.get(id) ?? shell({ id })),
    });
  return { publisher, publications, shells, sent, snapshots, events, pulls, deliver, rename };
});

describe("NtfyPublisher configuration", () => {
  it.effect("is disabled without a URL and validates enabled configuration", () =>
    Effect.gen(function* () {
      assert.isNull(
        yield* NtfyPublisher.readConfig.pipe(Effect.provide([configLayer({}), fileSystemLayer()])),
      );
      const config = yield* NtfyPublisher.readConfig.pipe(
        Effect.provide([configLayer(), fileSystemLayer()]),
      );
      assert.equal(config?.url, "https://ntfy.example.test");
      assert.equal(config === null ? null : Redacted.value(config.token), "tk_secret");
      for (const env of [
        { T3CODE_NTFY_URL: ENV.T3CODE_NTFY_URL },
        { ...ENV, T3CODE_NTFY_URL: "not-a-url" },
        { ...ENV, T3CODE_NTFY_URL: "ftp://example.test" },
        { ...ENV, T3CODE_NTFY_URL: "https://user:password@example.test" },
        { ...ENV, T3CODE_NTFY_TOPIC: "bad/topic" },
        { ...ENV, T3CODE_NTFY_EVENTS: "approval,unknown" },
      ]) {
        assert.isTrue(
          Option.isNone(
            yield* NtfyPublisher.readConfig.pipe(
              Effect.option,
              Effect.provide([configLayer(env), fileSystemLayer()]),
            ),
          ),
        );
      }
      assert.isTrue(
        Option.isNone(
          yield* NtfyPublisher.readConfig.pipe(
            Effect.option,
            Effect.provide([configLayer(), fileSystemLayer(" \n")]),
          ),
        ),
      );
      const disabled = yield* setup({ env: {} });
      yield* disabled.publisher.publishThread(THREAD_ID);
      assert.lengthOf(disabled.publications, 0);
    }).pipe(Effect.scoped),
  );
});

describe("NtfyPublisher", () => {
  it.effect(
    "publishes each approval/input once through domain events with Bearer auth and a thread link",
    () =>
      Effect.gen(function* () {
        const h = yield* setup({ initial: [wait()] });
        yield* h.rename();
        yield* h.rename();
        assert.lengthOf(h.publications, 1);
        assert.deepEqual(h.publications[0], {
          url: "https://ntfy.example.test/",
          redirect: "manual",
          authorization: "Bearer tk_secret",
          body: {
            topic: "t3code-host",
            title: "Thread 🔔",
            message: "Needs approval · Project",
            priority: 4,
            tags: ["t3code", "approval"],
            click: "t3code://threads/ntfy-environment/ntfy-thread",
          },
        });
        h.shells.set(THREAD_ID, wait("request-2", "user_input"));
        yield* h.rename();
        assert.equal(h.publications[1]?.body.message, "Needs input · Project");
        h.shells.set(THREAD_ID, wait());
        yield* h.rename();
        assert.lengthOf(h.publications, 2);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "holds completion for five seconds, survives settling and ignores duplicate/unsettle events",
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* TestClock.adjust(1);
        h.shells.set(THREAD_ID, terminal());
        yield* h.rename();
        assert.lengthOf(h.publications, 0);
        yield* TestClock.adjust("4 seconds");
        yield* h.publisher.drain;
        assert.lengthOf(h.publications, 0);
        h.shells.set(THREAD_ID, { ...terminal(), settledOverride: "settled" });
        yield* h.rename();
        yield* TestClock.adjust("1 second");
        yield* h.publisher.drain;
        assert.equal(h.publications[0]?.body.message, "Finished · Project");
        assert.equal(h.publications[0]?.body.priority, 3);
        yield* h.rename();
        yield* h.deliver({
          id: EventId.make("unsettle"),
          type: "thread.unsettled",
          threadId: THREAD_ID,
          occurredAt: DateTime.makeUnsafe(1),
          payload: appThread(terminal()),
        });
        assert.lengthOf(h.publications, 1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "cancels held completions on continuation and handles completions first observed settled",
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* TestClock.adjust(1);
        h.shells.set(THREAD_ID, terminal());
        yield* h.rename();
        h.shells.set(THREAD_ID, shell());
        yield* h.rename();
        yield* TestClock.adjust("5 seconds");
        yield* h.publisher.drain;
        assert.lengthOf(h.publications, 0);
        h.shells.set(THREAD_ID, { ...terminal(), settledOverride: "settled" });
        yield* h.rename();
        yield* TestClock.adjust("5 seconds");
        yield* h.publisher.drain;
        assert.lengthOf(h.publications, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("catches up pending waits at startup without alerting old terminal runs", () =>
    Effect.gen(function* () {
      const old = terminal("failed");
      const h = yield* setup({
        initial: [
          wait(),
          { ...old, id: ThreadId.make("old"), latestRunCompletedAt: DateTime.makeUnsafe(-1) },
        ],
        catchUp: true,
      });
      yield* Queue.take(h.sent);
      yield* h.publisher.drain;
      assert.lengthOf(h.publications, 1);
      const settled = yield* setup({
        initial: [{ ...terminal("failed"), settledOverride: "settled" }],
        catchUp: true,
      });
      yield* Queue.take(settled.snapshots);
      yield* TestClock.adjust(1);
      yield* settled.publisher.drain;
      assert.lengthOf(settled.publications, 1);
      const subagent = yield* setup({
        initial: [
          shell(),
          {
            ...wait(),
            id: ThreadId.make("catch-up-child"),
            activityRunStatus: "running",
            lineage: {
              rootThreadId: THREAD_ID,
              parentThreadId: THREAD_ID,
              relationshipToParent: "subagent",
            },
          },
        ],
        catchUp: true,
      });
      yield* Queue.take(subagent.snapshots);
      yield* TestClock.adjust(1);
      yield* subagent.publisher.drain;
      assert.equal(subagent.publications[0]?.body.message, "Subagent needs approval · Project");
      const recovering = yield* setup({ initial: [wait()], catchUp: true, failCatchUpOnce: true });
      yield* Queue.take(recovering.snapshots);
      yield* TestClock.adjust("1 second");
      yield* Queue.take(recovering.sent);
      yield* recovering.publisher.drain;
      assert.lengthOf(recovering.publications, 1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "routes concurrent child waits through the parent without re-alerting the older wait",
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        const child = (id: string, request: string) => ({
          ...wait(request),
          id: ThreadId.make(id),
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
          activityRunStatus: "running" as const,
          updatedAt: DateTime.makeUnsafe(request === "a" ? 1 : 2),
          lineage: {
            rootThreadId: THREAD_ID,
            parentThreadId: THREAD_ID,
            relationshipToParent: "subagent" as const,
          },
        });
        const a = child("child-a", "a");
        const b = child("child-b", "b");
        h.shells.set(a.id, a);
        yield* h.rename(a.id);
        h.shells.set(b.id, b);
        yield* h.rename(b.id);
        assert.lengthOf(h.publications, 2);
        assert.equal(h.publications[0]?.body.message, "Subagent needs approval · Project");
        h.shells.set(b.id, { ...b, pendingRuntimeRequest: null });
        yield* h.rename(b.id);
        assert.lengthOf(h.publications, 2);
        h.shells.set(a.id, { ...a, pendingRuntimeRequest: null });
        yield* h.rename(a.id);
        h.shells.set(a.id, child("child-a", "c"));
        yield* h.rename(a.id);
        assert.lengthOf(h.publications, 3);
        const blocked = Promise.withResolvers<Response>();
        const blocker = { ...wait("blocker"), id: ThreadId.make("blocker") };
        const queued = yield* setup({
          initial: [shell(), blocker],
          respond: (attempt) => (attempt === 1 ? blocked.promise : Response.json({ ok: true })),
        });
        yield* Effect.forkChild(queued.publisher.publishThread(blocker.id));
        yield* Queue.take(queued.sent);
        queued.shells.set(THREAD_ID, {
          ...shell(),
          pendingRuntimeRequest: { ...wait().pendingRuntimeRequest!, kind: "auth_refresh" },
        });
        for (const value of [a, b]) {
          queued.shells.set(value.id, value);
          yield* Queue.offer(queued.events, {
            id: EventId.make(value.id),
            type: "thread.metadata-updated",
            threadId: value.id,
            occurredAt: value.updatedAt,
            payload: appThread(value),
          });
          yield* Queue.take(queued.pulls);
        }
        blocked.resolve(Response.json({ ok: true }));
        yield* queued.publisher.drain;
        assert.lengthOf(queued.publications, 3);
        assert.equal(queued.publications[1]?.body.message, "Subagent needs approval · Project");
        const inputChild = {
          ...a,
          pendingRuntimeRequest: {
            ...a.pendingRuntimeRequest!,
            kind: "user_input" as const,
            userOnly: true,
          },
        };
        const filtered = yield* setup({
          env: { ...ENV, T3CODE_NTFY_EVENTS: "input" },
          initial: [wait("disabled-parent-approval"), inputChild, b],
          catchUp: true,
        });
        yield* Queue.take(filtered.snapshots);
        yield* TestClock.adjust(1);
        yield* filtered.publisher.drain;
        assert.lengthOf(filtered.publications, 1);
        assert.equal(filtered.publications[0]?.body.message, "Subagent needs input · Project");
        const many = yield* setup({
          respond: (attempt) => {
            if (attempt > 34) throw new Error("Repeated a live wait");
            return Response.json({ ok: true });
          },
        });
        for (let index = 0; index < 33; index++) {
          const value = child(`many-${index}`, `many-${index}`);
          many.shells.set(value.id, value);
          yield* many.publisher.publishThread(value.id);
        }
        assert.lengthOf(many.publications, 33);
        const resolved = child("many-32", "many-32");
        many.shells.set(resolved.id, { ...resolved, pendingRuntimeRequest: null });
        many.shells.set(THREAD_ID, wait("parent-after-32-children"));
        yield* many.rename(resolved.id);
        yield* many.rename();
        assert.lengthOf(many.publications, 34);
      }).pipe(Effect.scoped),
  );

  it.effect("retries 500 after the completion hold, respects backoff and stops once sent", () =>
    Effect.gen(function* () {
      const h = yield* setup({
        respond: (attempt) => new Response(null, { status: attempt === 1 ? 500 : 200 }),
      });
      yield* TestClock.adjust(1);
      h.shells.set(THREAD_ID, terminal());
      yield* h.rename();
      yield* TestClock.adjust("5 seconds");
      yield* h.publisher.drain;
      assert.lengthOf(h.publications, 1);
      yield* h.rename();
      assert.lengthOf(h.publications, 1);
      yield* TestClock.adjust("1 second");
      yield* h.publisher.drain;
      assert.lengthOf(h.publications, 2);
      yield* TestClock.adjust("30 seconds");
      yield* h.publisher.drain;
      assert.lengthOf(h.publications, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("gives terminal 401 no retries and cancels retries when a request resolves", () =>
    Effect.gen(function* () {
      const h = yield* setup({
        initial: [wait()],
        respond: () => new Response(null, { status: 401 }),
      });
      yield* h.rename();
      yield* h.rename();
      yield* TestClock.adjust("40 seconds");
      yield* h.publisher.drain;
      assert.lengthOf(h.publications, 1);
      const retrying = yield* setup({
        initial: [wait()],
        respond: () => new Response(null, { status: 429 }),
      });
      yield* retrying.rename();
      retrying.shells.set(THREAD_ID, shell());
      yield* TestClock.adjust("1 second");
      yield* retrying.publisher.drain;
      assert.lengthOf(retrying.publications, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not follow redirects or mark them as delivered", () =>
    Effect.gen(function* () {
      const h = yield* setup({
        initial: [wait()],
        respond: () =>
          new Response(null, { status: 302, headers: { location: "https://login.example" } }),
      });
      yield* h.rename();
      assert.equal(h.publications[0]?.redirect, "manual");
      yield* h.rename();
      yield* TestClock.adjust("40 seconds");
      yield* h.publisher.drain;
      assert.lengthOf(h.publications, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps snoozed completions silent after unsnooze and delayed evaluation", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* TestClock.adjust(1);
      const snoozed = {
        ...terminal(),
        snoozedAt: DateTime.makeUnsafe(0),
        snoozedUntil: DateTime.makeUnsafe(60_000),
      };
      h.shells.set(THREAD_ID, snoozed);
      yield* h.rename();
      h.shells.set(THREAD_ID, terminal());
      yield* h.rename();
      yield* TestClock.adjust("5 seconds");
      yield* h.publisher.drain;
      assert.lengthOf(h.publications, 0);
      for (const [untilOffset, completedOffset, shouldPublish] of [
        [4, 2, false],
        [1, 2, true],
        [4, 3, true],
      ] as const) {
        const delayed = yield* setup();
        const start = (yield* DateTime.now).epochMilliseconds;
        const until = start + untilOffset;
        yield* delayed.deliver({
          id: EventId.make("snooze"),
          type: "thread.snoozed",
          threadId: THREAD_ID,
          occurredAt: DateTime.makeUnsafe(start),
          payload: appThread({
            ...shell(),
            snoozedAt: DateTime.makeUnsafe(start),
            snoozedUntil: DateTime.makeUnsafe(until),
          }),
        });
        yield* delayed.deliver({
          id: EventId.make("unsnooze"),
          type: "thread.unsnoozed",
          threadId: THREAD_ID,
          occurredAt: DateTime.makeUnsafe(start + 3),
          payload: appThread(shell()),
        });
        delayed.shells.set(THREAD_ID, {
          ...terminal(),
          latestRunCompletedAt: DateTime.makeUnsafe(start + completedOffset),
        });
        yield* delayed.rename();
        yield* TestClock.adjust("5 seconds");
        yield* delayed.publisher.drain;
        assert.lengthOf(delayed.publications, shouldPublish ? 1 : 0);
      }
    }).pipe(Effect.scoped),
  );
  it.effect("exhausts a finite retry budget and starts a fresh budget for a new key", () =>
    Effect.gen(function* () {
      const h = yield* setup({
        initial: [wait()],
        respond: () => new Response(null, { status: 503 }),
      });
      yield* h.rename();
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
        yield* TestClock.adjust(delay);
        yield* h.publisher.drain;
      }
      assert.lengthOf(h.publications, 6);
      yield* h.rename();
      yield* TestClock.adjust("60 seconds");
      yield* h.publisher.drain;
      assert.lengthOf(h.publications, 6);
      h.shells.set(THREAD_ID, wait("next"));
      yield* h.rename();
      yield* TestClock.adjust("1 second");
      yield* h.publisher.drain;
      assert.lengthOf(h.publications, 8);
    }).pipe(Effect.scoped),
  );

  it.effect("filters old/snoozed completions and disabled kinds, and drops archived threads", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      h.shells.set(THREAD_ID, { ...terminal(), latestRunCompletedAt: DateTime.makeUnsafe(-1) });
      yield* h.rename();
      yield* TestClock.adjust(1);
      h.shells.set(THREAD_ID, {
        ...terminal(),
        snoozedAt: DateTime.makeUnsafe(0),
        snoozedUntil: DateTime.makeUnsafe(60_000),
      });
      yield* h.rename();
      yield* TestClock.adjust("5 seconds");
      yield* h.publisher.drain;
      assert.lengthOf(h.publications, 0);
      h.shells.set(THREAD_ID, {
        ...terminal(),
        latestRunId: RunId.make("after-snooze"),
        snoozedAt: DateTime.makeUnsafe(0),
        snoozedUntil: DateTime.makeUnsafe(1),
      });
      yield* h.rename();
      yield* TestClock.adjust("5 seconds");
      yield* h.publisher.drain;
      assert.equal(h.publications[0]?.body.message, "Finished · Project");
      h.publications.length = 0;
      h.shells.set(THREAD_ID, terminal("failed"));
      yield* h.rename();
      assert.equal(h.publications[0]?.body.message, "Failed · Project");
      assert.equal(h.publications[0]?.body.priority, 4);
      h.publications.length = 0;
      h.shells.set(THREAD_ID, { ...wait(), archivedAt: DateTime.makeUnsafe(1) });
      yield* h.rename();
      assert.lengthOf(h.publications, 0);
      h.shells.set(THREAD_ID, wait());
      yield* h.rename();
      assert.lengthOf(h.publications, 1);
      h.shells.set(THREAD_ID, { ...wait(), archivedAt: DateTime.makeUnsafe(1) });
      yield* h.rename();
      h.shells.set(THREAD_ID, wait());
      yield* h.rename();
      assert.lengthOf(h.publications, 2);
      const filtered = yield* setup({ env: { ...ENV, T3CODE_NTFY_EVENTS: "approval,input" } });
      filtered.shells.set(THREAD_ID, terminal());
      yield* filtered.rename();
      yield* TestClock.adjust("5 seconds");
      yield* filtered.publisher.drain;
      assert.lengthOf(filtered.publications, 0);
    }).pipe(Effect.scoped),
  );
});
