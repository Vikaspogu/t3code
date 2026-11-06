import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { providerRuntimeInstructionsForDriver } from "./RuntimeInstructions.ts";

const driver = ProviderDriverKind.make;

it("providerRuntimeInstructionsForDriver", () => {
  const codex = providerRuntimeInstructionsForDriver(driver("codex"));
  assert.deepEqual(
    codex.sections.map((section) => section.id),
    ["t3_code_runtime", "t3_code_orchestration", "t3_code_browser"],
  );

  const claude = providerRuntimeInstructionsForDriver(driver("claudeAgent"));
  assert.deepEqual(
    claude.sections.map((section) => section.id),
    ["t3_code_runtime", "t3_code_orchestration"],
  );

  // ACP drivers have no system-prompt channel; their context rides the
  // first prompt, which the section titles say out loud.
  const grok = providerRuntimeInstructionsForDriver(driver("grok"));
  assert.deepEqual(
    grok.sections.map((section) => section.id),
    ["t3_code_orchestration", "t3_code_browser"],
  );
  assert.isDefined(grok.sections[0]);
  assert.include(grok.sections[0].title, "sent in the first prompt");
  // Drivers T3 does not orchestrate get an empty list, not a fake section.
  const cursor = providerRuntimeInstructionsForDriver(driver("cursor"));
  assert.deepEqual(cursor.sections, []);

  // Every section carries real text for the settings viewer to render.
  for (const section of [...codex.sections, ...claude.sections, ...grok.sections]) {
    assert.isAbove(section.content.length, 100);
  }
});
