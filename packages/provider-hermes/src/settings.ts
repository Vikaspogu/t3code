import { makeProviderSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const text = (fallback: string) =>
  Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(fallback)));

export const HermesSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    endpoint: text("ws://127.0.0.1:9119/api/ws").pipe(
      Schema.annotateKey({
        title: "Gateway WebSocket",
        description: "Canonical Hermes Gateway WebSocket endpoint.",
        providerSettingsForm: { placeholder: "ws://hermes:9119/api/ws" },
      }),
    ),
    profileId: text("t3").pipe(
      Schema.annotateKey({ title: "Hermes profile", providerSettingsForm: { placeholder: "t3" } }),
    ),
    principalId: text("").pipe(
      Schema.annotateKey({
        title: "Pinned principal",
        description: "Expected uid:<Gateway POSIX UID>. Token rotation must not change it.",
        providerSettingsForm: { placeholder: "uid:1000" },
      }),
    ),
    model: text("default").pipe(
      Schema.annotateKey({ title: "Model", providerSettingsForm: { placeholder: "default" } }),
    ),
    pluginsEnabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Plugins",
        description: "Expose Hermes profile toolsets and plugins to new sessions.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    toolsets: text("").pipe(
      Schema.annotateKey({
        title: "Toolsets",
        description:
          "Optional comma-separated toolset names. Empty uses the Hermes profile defaults.",
        providerSettingsForm: { placeholder: "trek, ivan_paperless" },
      }),
    ),
    pluginRpcEnabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Plugin RPC",
        description: "Require the gateway plugin-rpc-v1 capability for plugin method calls.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
  },
  {
    order: [
      "endpoint",
      "profileId",
      "principalId",
      "model",
      "pluginsEnabled",
      "toolsets",
      "pluginRpcEnabled",
    ],
  },
);
export type HermesSettings = typeof HermesSettings.Type;
