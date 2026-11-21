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
  },
  { order: ["endpoint", "profileId", "principalId", "model"] },
);
export type HermesSettings = typeof HermesSettings.Type;
