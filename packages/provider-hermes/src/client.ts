import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import { HermesSettings } from "./settings.ts";

export const hermesClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("hermes"),
  label: "Hermes",
  modelFamilies: ["Hermes"],
  settingsSchema: HermesSettings,
});
