import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import {
  HttpBody,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as SqlClient from "effect/sql/SqlClient";

import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as DefectReporter from "./observability/DefectReporter.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import { rpcInstrumentationLayer } from "./observability/RpcInstrumentation.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as SourceControlBuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import { withTerminalOutputWindow } from "./terminal/OutputProtocol.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import {
  ServerWsRpcGroup,
  WS_RPC_SERVER_OPTIONS,
  hasCompatibleOrchestrationProtocol,
  layerWsRpc,
  readClientAnalyticsProps,
  readClientConnectionOrigin,
} from "./ws.ts";

/**
 * HTTP fallback transport for the WebSocket RPC group.
 *
 * Android Prisma's browser never completes the /ws upgrade (its proxy holds
 * the request), but streams HTTPS responses fine. This route serves the exact
 * same `ServerWsRpcGroup` over chunked NDJSON POSTs: one POST carries one
 * batch of client messages, responses stream back as newline-delimited JSON.
 *
 * Auth parity with /ws: every POST re-authenticates via the same upgrade
 * authenticator (browser cookie, or a short-lived wsTicket for bearer/DPoP —
 * note tickets are stateless 5-minute HMACs that appear in the URL of every
 * POST, an accepted cost of this fallback), and an open POST's stream is torn
 * down on session revocation: the response body stream is interrupted the
 * moment `awaitInvalidation` fires, mirroring how a /ws socket is torn down.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const serverBrowser = yield* ServerBrowser.ServerBrowser;
    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
    const sql = yield* SqlClient.SqlClient;
    // Server-lifetime instances, shared across all /rpc POSTs so driver
    // caches hit, maintenance single-flights, and scanner concurrency is
    // accounted globally. (Each /ws connection still builds its own set.)
    const agentSessionScanner = yield* AgentSessionScanner.AgentSessionScanner;
    const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
    const otlpEndpointCheck = yield* OtlpEndpointCheck.OtlpEndpointCheck;
    const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    return HttpRouter.add(
      "POST",
      "/rpc",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const requestUrl = HttpServerRequest.toURL(request);
        if (Option.isNone(requestUrl) || !hasCompatibleOrchestrationProtocol(requestUrl.value)) {
          return HttpServerResponse.jsonUnsafe(
            {
              code: "orchestration_protocol_incompatible",
              message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            },
            { status: 426 },
          );
        }
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const clientOrigin = readClientConnectionOrigin(request);
        const clientAnalyticsProps = readClientAnalyticsProps(request);
        yield* sessions.recordClientConnection(session.sessionId, clientOrigin);
        // No per-POST "client.connected" analytics event: one WS connection
        // fires it once, one HTTP session fires many POSTs; the metadata
        // update above already records origin and timestamp.
        const rpcHttpEffect = yield* Effect.gen(function* () {
          // Each POST gets its own protocol instance: RpcServer.make registers
          // its writeRequest on the protocol, so sharing one across requests
          // would reroute earlier requests' messages to the newest server.
          // Fresh-per-request mirrors the per-upgrade isolation of /ws.
          const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffect();
          yield* RpcServer.make(ServerWsRpcGroup, WS_RPC_SERVER_OPTIONS).pipe(
            Effect.provideService(RpcServer.Protocol, withTerminalOutputWindow(protocol)),
            Effect.provide(
              Layer.merge(RpcAuthorization.layer(session.scopes), rpcInstrumentationLayer),
            ),
            Effect.forkScoped,
          );
          // @effect-diagnostics-next-line returnEffectInGen:off
          return httpEffect;
        }).pipe(
          Effect.provide(
            layerWsRpc(
              session,
              clientOrigin,
              clientAnalyticsProps,
              previewAutomationBroker,
              serverBrowser,
            ).pipe(
              Layer.provideMerge(RpcSerialization.layerNdjson),
              // Request fibers run in the handlers' context, so this reporter sees
              // their defects, not the rest of the server's.
              Layer.provide(DefectReporter.layer),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
              Layer.provide(
                Layer.succeed(AgentSessionScanner.AgentSessionScanner, agentSessionScanner),
              ),
              Layer.provide(
                Layer.succeed(
                  ProviderMaintenanceRunner.ProviderMaintenanceRunner,
                  providerMaintenanceRunner,
                ),
              ),
              Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
              // One server-lifetime service means clients share the same PR caches, and a WS
              // mutation invalidates the HTTP diff cache that every client reads from.
              Layer.provide(Layer.succeed(PullRequestService.PullRequestService, pullRequests)),
              Layer.provide(Layer.succeed(OtlpEndpointCheck.OtlpEndpointCheck, otlpEndpointCheck)),
              // Shared like the pull request service, so concurrent generations single-flight.
              Layer.provide(
                Layer.succeed(
                  PullRequestReviewGuideService.PullRequestReviewGuideService,
                  reviewGuides,
                ),
              ),
              Layer.provide(
                Layer.succeed(
                  SourceControlDiscovery.SourceControlDiscovery,
                  sourceControlDiscovery,
                ),
              ),
            ),
          ),
        );
        // The guard must wrap the response body stream, not this handler's
        // effect: httpEffect completes as soon as the batch is decoded, while
        // the NDJSON body keeps streaming to the client afterwards. Presence
        // is registered via a scope-bound finalizer — Channel.unwrap provides
        // the stream's scope, so markConnected runs on first pull, the
        // finalizer fires when the stream ends or is interrupted, and a body
        // that never starts counts nothing. Revocation interrupts the stream
        // through the same awaitInvalidation race a /ws socket gets.
        const response = yield* rpcHttpEffect;
        const guardedResponse =
          response.body._tag === "Stream"
            ? HttpServerResponse.setBody(
                response,
                HttpBody.stream(
                  Stream.unwrap(
                    Effect.gen(function* () {
                      yield* sessions.markConnected(session.sessionId);
                      yield* Effect.addFinalizer(() =>
                        sessions.markDisconnected(session.sessionId),
                      );
                      return (response.body as HttpBody.Stream).stream;
                    }),
                  ).pipe(Stream.interruptWhen(sessions.awaitInvalidation(session.sessionId))),
                  response.body.contentType,
                  response.body.contentLength,
                ),
              )
            : response;
        // Prisma's Android proxy (and nginx in front of the public ingress)
        // buffer responses unless told otherwise; buffering kills streamed
        // NDJSON. The kill-test proved these headers keep chunks incremental.
        return HttpServerResponse.setHeaders(guardedResponse, {
          "x-accel-buffering": "no",
          "cache-control": "no-store",
        });
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
).pipe(
  // Shared instances for the hoisted services above: built once at server
  // startup instead of per POST.
  Layer.provide(
    Layer.mergeAll(
      AgentSessionScanner.layer,
      ProviderMaintenanceRunner.layer,
      OtlpEndpointCheck.layer,
      SourceControlDiscovery.layer.pipe(
        Layer.provide(
          SourceControlProviderRegistry.layer.pipe(
            Layer.provide(SourceControlBuiltInDrivers.layer),
            Layer.provideMerge(GitVcsDriver.layer),
            Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
          ),
        ),
      ),
    ),
  ),
);
