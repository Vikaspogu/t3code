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
import * as NpmRelease from "./cloud/npmRelease.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";
import * as PeerLinkRequests from "./peer/PeerLinkRequests.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as DefectReporter from "./observability/DefectReporter.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import { rpcInstrumentationLayer } from "./observability/RpcInstrumentation.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as SourceControlBuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import { withOutputWindow } from "./terminal/OutputProtocol.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import {
  ServerWsRpcGroup,
  WS_RPC_SERVER_OPTIONS,
  hasCompatibleOrchestrationProtocol,
  layerWsRpc,
  readClientAnalyticsProps,
  readClientOwners,
  readSettingsClient,
} from "./ws.ts";

// Prisma blocks WebSocket upgrades; serve the same RPC group over NDJSON with per-request authentication.
// Session revocation interrupts the response body, which outlives the request handler.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    const serverBrowser = yield* ServerBrowser.ServerBrowser;
    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const npmRelease = yield* NpmRelease.NpmRelease;
    const peerLinks = yield* PeerLinks.PeerLinks;
    const peerLinkRequests = yield* PeerLinkRequests.PeerLinkRequests;
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
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request, "rpc").pipe(
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
        const clientAnalyticsProps = readClientAnalyticsProps(request);
        yield* analytics.recordOwners(readClientOwners(request), "client");
        const reportProfiles = yield* serverBrowser.profileReporter;
        // No per-POST "client.connected" analytics event: one WS connection
        // fires it once, while one HTTP session makes many POSTs.
        const rpcHttpEffect = yield* Effect.gen(function* () {
          // Each POST gets its own protocol instance: RpcServer.make registers
          // its writeRequest on the protocol, so sharing one across requests
          // would reroute earlier requests' messages to the newest server.
          // Fresh-per-request mirrors the per-upgrade isolation of /ws.
          const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffect();
          yield* RpcServer.make(ServerWsRpcGroup, WS_RPC_SERVER_OPTIONS).pipe(
            Effect.provideService(RpcServer.Protocol, withOutputWindow(protocol)),
            Effect.provide(
              Layer.merge(RpcAuthorization.layer(session.scopes), rpcInstrumentationLayer),
            ),
            Effect.forkScoped,
          );
          return httpEffect;
        }).pipe(
          Effect.provide(
            layerWsRpc(
              session,
              clientAnalyticsProps,
              serverBrowser,
              reportProfiles,
              readSettingsClient(requestUrl.value),
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
              Layer.provide(Layer.succeed(NpmRelease.NpmRelease, npmRelease)),
              Layer.provide(Layer.succeed(PeerLinks.PeerLinks, peerLinks)),
              Layer.provide(Layer.succeed(PeerLinkRequests.PeerLinkRequests, peerLinkRequests)),
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
        // Scope presence to body consumption, and interrupt the stream immediately on session revocation.
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
                  ).pipe(
                    Stream.interruptWhen(
                      sessions.awaitInvalidation(session.sessionId, session.proofKeyThumbprint),
                    ),
                  ),
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
  Layer.provide(NpmRelease.layer),
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
