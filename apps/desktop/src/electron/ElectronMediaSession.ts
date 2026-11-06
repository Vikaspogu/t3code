import { publicProxy } from "@t3tools/shared/publicProxy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";

import * as ElectronApp from "./ElectronApp.ts";

export class ElectronMediaSession extends Context.Service<
  ElectronMediaSession,
  Pick<Electron.Session, "fetch">
>()("@t3tools/desktop/electron/ElectronMediaSession") {}

export const layer = Layer.effect(
  ElectronMediaSession,
  Effect.gen(function* () {
    yield* (yield* ElectronApp.ElectronApp).whenReady;
    const port = yield* publicProxy;
    const session = Electron.session.fromPartition("t3-public-media", { cache: false });
    yield* Effect.tryPromise(() =>
      session.setProxy({
        mode: "fixed_servers",
        proxyRules: `socks5://127.0.0.1:${port}`,
        proxyBypassRules: "<-loopback>",
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => session.closeAllConnections()));
    return ElectronMediaSession.of({ fetch: (url, options) => session.fetch(url, options) });
  }),
);
