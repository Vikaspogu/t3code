import { TextGenerationError } from "@t3tools/contracts";
import { HermesSettings, type HermesSettings as HermesSettingsValue } from "../settings.ts";
import { makeHermesAdapterV2, HERMES_PROVIDER } from "./adapter.ts";
import { makeHermesSnapshot } from "./status.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeSettings = Schema.decodeSync(HermesSettings);
const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({ operation, detail: "Hermes does not provide T3 text generation." }),
  );
const textGeneration: ProviderTextGeneration = {
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
  generateReviewGuide: () => unsupported("generateReviewGuide"),
  generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
};

export const HermesDriver: ProviderDriver<HermesSettingsValue, ProviderHost.ProviderHost> = {
  driverKind: HERMES_PROVIDER,
  metadata: { displayName: "Hermes", supportsMultipleInstances: true, hasDefaultInstance: false },
  configSchema: HermesSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("HermesDriver.create")(function* (input) {
    const config = { ...input.config, enabled: input.enabled };
    // Hermes secrets must be instance-scoped: an unset HERMES_* variable stays unset rather
    // than falling back to the server process token for an instance-chosen endpoint.
    const environment = yield* mergeProviderInstanceEnvironment(input.environment, {});
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: HERMES_PROVIDER,
      instanceId: input.instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId: input.instanceId,
      driverKind: HERMES_PROVIDER,
      displayName: input.displayName,
      accentColor: input.accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(config).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: HERMES_PROVIDER,
            instanceId: input.instanceId,
            detail: "Failed to read Hermes settings.",
            cause,
          }),
      ),
    );
    const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
      provider: HERMES_PROVIDER,
      packageName: null,
    });
    const snapshot = yield* makeManagedServerProvider<
      ProviderSnapshotSettings<HermesSettingsValue>
    >({
      resolveMaintenance: () => Effect.succeed(maintenance),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        makeHermesSnapshot(settings.provider, environment).pipe(Effect.map(stampIdentity)),
      checkProvider: makeHermesSnapshot(config, environment).pipe(Effect.map(stampIdentity)),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: HERMES_PROVIDER,
            instanceId: input.instanceId,
            detail: "Failed to build Hermes snapshot.",
            cause,
          }),
      ),
    );
    const host = yield* ProviderHost.ProviderHost;
    const orchestrationAdapter = makeHermesAdapterV2({
      instanceId: input.instanceId,
      settings: config,
      environment,
      enableTextTurns: true,
      resolveAttachmentPath: host.resolveAttachmentPath,
    });
    return {
      instanceId: input.instanceId,
      driverKind: HERMES_PROVIDER,
      continuationIdentity,
      displayName: input.displayName,
      accentColor: input.accentColor,
      enabled: input.enabled,
      snapshot,
      snapshotForCwd: () => snapshot.getSnapshot,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
