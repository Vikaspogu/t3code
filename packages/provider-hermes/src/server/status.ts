// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off
import * as NodePath from "node:path";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { HermesSettings } from "../settings.ts";
import { asRuntimeDescription } from "./adapter.ts";
import { HermesGateway, hermesOrigin } from "./gateway.ts";

export const makeHermesSnapshot = Effect.fn("HermesProvider.snapshot")(function* (
  settings: HermesSettings,
) {
  const token = process.env.HERMES_SESSION_TOKEN;
  const configured = Boolean(
    settings.enabled &&
    token &&
    settings.principalId.startsWith("uid:") &&
    NodePath.isAbsolute(process.env.HERMES_STATE_DIR ?? ""),
  );
  const probe = configured
    ? yield* Effect.scoped(
        Effect.gen(function* () {
          if (!token) {
            throw new Error("Hermes session token is missing");
          }
          if (process.env.HERMES_GATEWAY_URL !== settings.endpoint) {
            throw new Error("Hermes endpoint does not match HERMES_GATEWAY_URL");
          }
          const gateway = yield* HermesGateway.connect(
            settings.endpoint,
            token,
            hermesOrigin(settings.endpoint),
          );
          const connection = yield* gateway.connection;
          const runtime = asRuntimeDescription(yield* connection.request("runtime.describe", {}));
          if (runtime.profile_id !== settings.profileId) {
            throw new Error("Hermes runtime profile does not match provider configuration");
          }
          return {
            installed: true,
            version: null,
            status: "ready" as const,
            auth: { status: "authenticated" as const },
            message: "Hermes canonical Gateway transport is reachable.",
          };
        }),
      ).pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          return Effect.succeed({
            installed: true,
            version: null,
            status: "error" as const,
            auth: {
              status: /401|403|unauthorized|unauthenticated/i.test(String(error))
                ? ("unauthenticated" as const)
                : ("unknown" as const),
            },
            message: error instanceof Error ? error.message : String(error),
          });
        }),
      )
    : {
        installed: false,
        version: null,
        status: "warning" as const,
        auth: { status: "unauthenticated" as const },
        message:
          "Set the Hermes token, absolute HERMES_STATE_DIR, matching HERMES_GATEWAY_URL, and pinned gateway UID.",
      };
  const now = yield* DateTime.now;
  return buildServerProvider({
    presentation: {
      displayName: "Hermes",
      showInteractionModeToggle: false,
      supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
      reportsContextWindow: false,
    },
    enabled: settings.enabled,
    checkedAt: DateTime.formatIso(now),
    models: [
      {
        slug: settings.model || "default",
        name: "Hermes default",
        isCustom: false,
        capabilities: {},
      },
    ],
    probe,
  });
});
