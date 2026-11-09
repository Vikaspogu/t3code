import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const { fromPartition, setProxy } = vi.hoisted(() => {
  const setProxy = vi.fn(async () => {});
  return {
    setProxy,
    fromPartition: vi.fn(() => ({
      setProxy,
      closeAllConnections: async () => {},
      fetch: async () => new Response(),
    })),
  };
});

vi.mock("electron", () => ({ session: { fromPartition } }));

import * as ElectronApp from "./ElectronApp.ts";
import * as ElectronMediaSession from "./ElectronMediaSession.ts";

it.effect("routes isolated media through the public proxy's numeric port", () =>
  Effect.gen(function* () {
    yield* ElectronMediaSession.ElectronMediaSession;
    expect(fromPartition).toHaveBeenCalledWith("t3-public-media", { cache: false });
    expect(setProxy).toHaveBeenCalledWith({
      mode: "fixed_servers",
      proxyRules: expect.stringMatching(/^socks5:\/\/127\.0\.0\.1:\d+$/),
      proxyBypassRules: "<-loopback>",
    });
  }).pipe(
    Effect.provide(ElectronMediaSession.layer),
    Effect.provideService(ElectronApp.ElectronApp, {
      whenReady: Effect.void,
    } as unknown as ElectronApp.ElectronApp["Service"]),
    Effect.scoped,
  ),
);
