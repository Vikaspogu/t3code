import * as Schema from "effect/Schema";

import { ProviderThreadId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const HermesPluginTarget = {
  threadId: ThreadId,
  providerThreadId: ProviderThreadId,
};

export const HermesPluginListToolsInput = Schema.Struct(HermesPluginTarget);
export type HermesPluginListToolsInput = typeof HermesPluginListToolsInput.Type;

export const HermesPluginTool = Schema.Struct({
  name: Schema.String,
  toolset: Schema.String,
  description: Schema.String,
});
export type HermesPluginTool = typeof HermesPluginTool.Type;

export const HermesPluginListToolsResult = Schema.Struct({
  tools: Schema.Array(HermesPluginTool),
});
export type HermesPluginListToolsResult = typeof HermesPluginListToolsResult.Type;

export const HermesPluginInvokeInput = Schema.Struct({
  ...HermesPluginTarget,
  method: TrimmedNonEmptyString,
  params: Schema.Unknown,
});
export type HermesPluginInvokeInput = typeof HermesPluginInvokeInput.Type;

export const HermesPluginInvokeResult = Schema.Struct({
  result: Schema.Unknown,
});
export type HermesPluginInvokeResult = typeof HermesPluginInvokeResult.Type;

export const HermesPluginRequestErrorReason = Schema.Literals([
  "thread-not-found",
  "provider-unsupported",
  "session-stopped",
  "disabled",
  "invalid-method",
  "request-failed",
]);
export type HermesPluginRequestErrorReason = typeof HermesPluginRequestErrorReason.Type;

export class HermesPluginRequestError extends Schema.TaggedError<HermesPluginRequestError>()(
  "HermesPluginRequestError",
  {
    threadId: ThreadId,
    reason: HermesPluginRequestErrorReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "thread-not-found":
        return "The Hermes thread could not be found.";
      case "provider-unsupported":
        return "This thread does not support Hermes plugin requests.";
      case "session-stopped":
        return "The Hermes session is not running. Send a message, then try again.";
      case "disabled":
        return "Hermes plugin RPC is disabled in provider settings.";
      case "invalid-method":
        return "Plugin methods must use plugin.<plugin_id>.<method>.";
      case "request-failed":
        return "The Hermes plugin request failed.";
    }
  }
}
