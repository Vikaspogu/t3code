// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture shares a real HTTP listener with ws.
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HermesSettings } from "@t3tools/provider-hermes/settings";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";
import { HermesSessionStore, makeHermesAdapterV2 } from "@t3tools/provider-hermes/server";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";

const require = NodeModule.createRequire(
  new URL("../../../../packages/provider-hermes/package.json", import.meta.url),
);
const decodeSettings = Schema.decodeSync(HermesSettings);
const { WebSocketServer } = require("ws");

it.live.each([
  { crash: "before the first submit", accepted: false, failFirstRead: false, journaled: undefined },
  {
    crash: "after Gateway acceptance and before the submit reply",
    accepted: true,
    failFirstRead: false,
    journaled: undefined,
  },
  ...(["queued", "started", "terminal"] as const).map((journaled) => ({
    crash: `after journaling a ${journaled} receipt and before projecting the turn`,
    accepted: true,
    failFirstRead: false,
    journaled,
  })),
  {
    crash: "with one failed reservation read",
    accepted: false,
    failFirstRead: true,
    journaled: undefined,
  },
])("rejoins the original T3 run $crash", ({ accepted, failFirstRead, journaled }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspace = yield* checkpointWorkspace("hermes-reservation-crash-probe");
      const stateDir = yield* checkpointWorkspace("hermes-reservation-crash-journal");
      const http = NodeHttp.createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ticket: "fake-ticket" }));
      });
      const sockets = new WebSocketServer({ server: http });
      const blocked = Promise.withResolvers<void>();
      const submitted = Promise.withResolvers<void>();
      let reserved: ReturnType<HermesSessionStore["reserveTextTurn"]> | undefined;
      let hold = true;
      const submissions: unknown[] = [];
      const methods: string[] = [];
      const terminalReceipt = {
        admission_id: "admission-a",
        ref: { profile_id: "/profile", session_id: "session-a" },
        sequence: 1,
        status: "terminal",
        outcome: "completed",
        authority_epoch: 4,
        execution_generation: 1,
        result: { final_response: "done" },
      };
      sockets.on(
        "connection",
        (socket: {
          on(event: "message", receive: (raw: Buffer) => void): void;
          send(frame: string): void;
        }) => {
          socket.on("message", (raw: Buffer) => {
            const { method, id, params } = JSON.parse(String(raw));
            methods.push(method);
            const resultByMethod: Record<string, unknown> = {
              "prompt.receipt": terminalReceipt,
              "runtime.describe": {
                profile_id: "/profile",
                instance_id: "authority-a",
                authority_epoch: 4,
                capabilities: ["event-replay-v1", "durable-admission-v1"],
              },
              "session.create": { session_id: "session-a" },
              "session.resume": {
                session_id: "session-a",
                stored_session_id: "session-a",
                authority_epoch: 4,
                execution_generation: null,
                replay_epoch: "epoch-a",
                last_sequence: 0,
                pending: [],
                prompts: [],
              },
            };
            if (!accepted && reserved && hold && method === "runtime.describe") {
              blocked.resolve();
              return; // Simulate death before the first prompt.submit can be sent.
            }
            if (method === "prompt.submit") {
              submissions.push(params);
              if (hold) {
                blocked.resolve();
                return; // The durable Gateway admission exists but T3 has no receipt.
              }
              socket.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  result: terminalReceipt,
                }),
              );
              submitted.resolve();
            }
            if (method in resultByMethod)
              socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: resultByMethod[method] }));
          });
        },
      );
      const port = yield* Effect.promise(
        () =>
          new Promise<number>((resolve) =>
            http.listen(0, "127.0.0.1", () => {
              const address = http.address();
              if (address && typeof address !== "string") resolve(address.port);
            }),
          ),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const socket of sockets.clients) socket.terminate();
          sockets.close();
          http.close();
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
        }),
      );
      const endpoint = `ws://127.0.0.1:${port}/api/ws`;
      vi.stubEnv("HERMES_SESSION_TOKEN", "fake-token");
      vi.stubEnv("HERMES_GATEWAY_URL", endpoint);
      vi.stubEnv("HERMES_STATE_DIR", stateDir);
      vi.stubEnv("HERMES_ALLOW_CLEARTEXT", "1");
      const realReserve = HermesSessionStore.prototype.reserveTextTurn;
      const reserveTextTurn = vi
        .spyOn(HermesSessionStore.prototype, "reserveTextTurn")
        .mockImplementation(function (this: HermesSessionStore, input) {
          reserved = realReserve.call(this, input);
          return reserved;
        });
      const threadId = ThreadId.make("thread:hermes-reservation-probe");
      const instanceId = ProviderInstanceId.make("hermes-reservation-probe");
      const modelSelection = { instanceId, model: "default" };
      const adapter = makeHermesAdapterV2({
        instanceId,
        settings: decodeSettings({
          enabled: true,
          endpoint,
          profileId: "/profile",
          principalId: "uid:1000",
        }),
        enableTextTurnsForTest: true,
      });
      const adapterLayer = Registry.layerSingle(adapter);
      const databaseLayer = SqlitePersistence.layerFromPath(
        `${workspace}/orchestration.sqlite`,
      ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
      const harness = (name: string) =>
        Harness.layerWithRegistry({ name }, adapterLayer, {
          databaseLayer,
          recoverOnStartup: true,
          continueThreadsAfterServerUpdate: true,
        }).pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ HERMES_STATE_DIR: `${stateDir}/wrong` }),
            ),
          ),
        );
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestration = yield* Orchestrator.OrchestratorV2;
          yield* orchestration.dispatch({
            type: "thread.create",
            commandId: CommandId.make("reservation-probe:create"),
            threadId,
            projectId: ProjectId.make("project:reservation-probe"),
            title: "Hermes reservation probe",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: workspace,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestration.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("reservation-probe:start"),
            threadId,
            messageId: MessageId.make("reservation-probe:message"),
            text: "original input",
            attachments: [],
            createdBy: "user",
            creationSource: "server",
            dispatchMode: { type: "start_immediately" },
            modelSelection,
          });
          yield* Effect.promise(() => blocked.promise).pipe(Effect.timeout("6 seconds"));
          const projection = yield* orchestration.getThreadProjection(threadId);
          assert.lengthOf(projection.runs, 1);
          assert.lengthOf(projection.providerTurns, 0);
          assert.lengthOf(projection.runtimeRequests, 0);
          assert.lengthOf(submissions, accepted ? 1 : 0);
          assert.isDefined(reserved);
          const persisted = new HermesSessionStore(`${stateDir}/sessions.sqlite3`);
          try {
            assert.isNull(persisted.getTextTurnReceipt(reserved!.input_id));
            if (journaled) {
              persisted.recordTextTurnReceipt(reserved!.input_id, {
                ...terminalReceipt,
                status: journaled,
                outcome: journaled === "terminal" ? "completed" : null,
                execution_generation: journaled === "queued" ? null : 1,
                result: undefined,
              });
              submitted.resolve();
            }
            assert.isFalse(
              HermesSessionStore.hasReservedTurn(
                stateDir,
                threadId,
                projection.runs[0]!.id,
                reserved!.session_id,
                "another-attempt",
              ),
              "a different attempt must not adopt the original reservation",
            );
            assert.throws(
              () =>
                realReserve.call(persisted, {
                  ...reserveTextTurn.mock.calls[0]![0],
                  attemptId: "another-attempt",
                }),
              "different input or identity",
            );
          } finally {
            persisted.close();
          }
          return projection.runs[0]!;
        }).pipe(Effect.provide(harness("reservation-probe:first"))),
      );
      hold = false;
      if (failFirstRead) {
        const read = vi.spyOn(HermesSessionStore, "hasReservedTurn").mockImplementationOnce(() => {
          throw new Error("Synthetic reservation read failure");
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => read.mockRestore()));
      }
      const secondScope = yield* Scope.make();
      yield* Effect.gen(function* () {
        const orchestration = yield* Orchestrator.OrchestratorV2;
        yield* Effect.promise(() => submitted.promise).pipe(
          Effect.timeout("4 seconds"),
          Effect.tapError(() =>
            Effect.logError(`No replayed submission; RPCs: ${methods.join(", ")}`),
          ),
        );
        const completion = yield* orchestration
          .streamStoredEventsFrom({ threadId, eventType: "run.updated" })
          .pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.payload.id === first.id &&
                event.payload.status === "completed",
            ),
            Stream.runHead,
            Effect.timeout("4 seconds"),
          );
        assert.equal(completion._tag, "Some");
        const projection = yield* orchestration.getThreadProjection(threadId);
        const sql = yield* SqlClient.SqlClient;
        const effects = yield* sql<{ effect_type: string; status: string }>`
        SELECT effect_type, status FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId} AND effect_type = 'provider-turn.start'
      `;
        assert.deepEqual(effects, [{ effect_type: "provider-turn.start", status: "cancelled" }]);
        assert.deepEqual(
          projection.runs.map(({ id }) => id),
          [first.id],
        );
        assert.deepEqual(
          projection.attempts.map(({ id }) => id),
          [first.activeAttemptId],
        );
        assert.lengthOf(projection.providerTurns, 1);
        assert.equal(reserveTextTurn.mock.calls.length, 1);
        const persisted = new HermesSessionStore(`${stateDir}/sessions.sqlite3`);
        try {
          assert.include(persisted.getTextTurnReceipt(reserved!.input_id), {
            admission_id: "admission-a",
            status: "terminal",
            outcome: "completed",
          });
        } finally {
          persisted.close();
        }
        assert.deepEqual(
          submissions,
          accepted && !journaled ? [reserved, reserved] : [reserved],
          "restart did not submit the exact durable reservation",
        );
      }).pipe(
        Effect.provide(Layer.merge(harness("reservation-probe:restart"), databaseLayer)),
        Effect.provideService(Scope.Scope, secondScope),
        Effect.ensuring(Scope.close(secondScope, Exit.void)),
      );
    }),
  ).pipe(Effect.timeout("20 seconds")),
);
