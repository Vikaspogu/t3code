import { Connection } from "@t3tools/client-runtime/connection";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
} from "@t3tools/client-runtime/state/threads";
import { PullRequestDiffLoader } from "@t3tools/client-runtime/state/pull-requests";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import * as Runtime from "../lib/runtime";
import * as BackgroundActivityReporter from "../lib/backgroundActivityReporter";
import * as ConnectionPlatform from "./platform";

const layerProvidedConnectionPlatform = ConnectionPlatform.layer.pipe(Layer.provide(Runtime.layer));

function resolveRpcTransport(): "ws" | "http" {
  // Manual override for WebSocket-blocked environments (Android Prisma):
  // ?rpcTransport=http persists to localStorage so SPA navigation keeps it,
  // and ?rpcTransport=ws resets the stored choice. Without either, the
  // default WebSocket transport is used.
  const requested = new URLSearchParams(window.location.search).get("rpcTransport");
  if (requested === "http" || requested === "ws") {
    localStorageSet("t3.rpcTransport", requested);
  }
  // Storage can be unavailable (DOM storage disabled in WebViews, private
  // mode); the override is a convenience, so fall back to the default.
  return localStorageGet("t3.rpcTransport") === "http" ? "http" : "ws";
}

function localStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function localStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
const layerSnapshotLoader = Layer.mergeAll(
  BoundedThreadSnapshotLoader.layer,
  ShellSnapshotLoader.layer,
  ThreadHistoryController.layer,
  PullRequestDiffLoader.layer,
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof layerSnapshotLoader
  | typeof Runtime.layer
  | typeof ConnectionPlatform.layer
  | typeof BackgroundActivityReporter.layerObserver
  | typeof BackgroundActivityReporter.layer;

const layerProvidedClientConnection = layerSnapshotLoader.pipe(
  Layer.provideMerge(
    Connection.layerWithOptions({
      environmentThemes: true,
      usageLimitSources: true,
      usageLimitsCommand: true,
      transport: resolveRpcTransport(),
    }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Runtime.layer,
      layerProvidedConnectionPlatform,
      BackgroundActivityReporter.layerObserver,
    ),
  ),
);

const layerConnection = BackgroundActivityReporter.layer.pipe(
  Layer.provideMerge(layerProvidedClientConnection),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(layerConnection);
