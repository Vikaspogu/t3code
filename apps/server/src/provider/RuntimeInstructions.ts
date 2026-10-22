import type { ProviderDriverKind, ServerProviderRuntimeInstructions } from "@t3tools/contracts";
import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

/**
 * What T3 Code itself injects into a provider's turns, per driver. Rendered for
 * the settings UI so users can see the system-prompt additions T3 makes
 * without diffing source. Everything else in the prompt comes from the
 * provider's own harness, not from us.
 *
 * Sections are condition-labeled because attachment depends on per-turn state
 * (whether the t3-code MCP server and preview tools are connected); the titles
 * name the condition instead of hiding it.
 */

const WHEN_MCP_ATTACHED = "attached when the t3-code MCP server is connected to the thread";

const HARNESS_LABELS = {
  codex: "Codex",
  claudeAgent: "Claude Code",
} as const satisfies Record<string, string>;

/** Drivers whose turns carry T3 instructions in some form. */
const ORCHESTRATED_DRIVERS = new Set<ProviderDriverKind>([
  "codex" as ProviderDriverKind,
  "claudeAgent" as ProviderDriverKind,
  "antigravity" as ProviderDriverKind,
  "grok" as ProviderDriverKind,
]);

/** ACP drivers have no system-prompt channel, so T3 context rides the first prompt. */
const ACP_PROMPT_DRIVERS = new Set<ProviderDriverKind>([
  "antigravity" as ProviderDriverKind,
  "grok" as ProviderDriverKind,
]);

/** Drivers whose turns get the collaborative-browser instructions. */
const BROWSER_DRIVERS = new Set<ProviderDriverKind>([
  "codex" as ProviderDriverKind,
  "antigravity" as ProviderDriverKind,
  "grok" as ProviderDriverKind,
]);

export function providerRuntimeInstructionsForDriver(
  driver: ProviderDriverKind,
): ServerProviderRuntimeInstructions {
  if (!ORCHESTRATED_DRIVERS.has(driver)) return { sections: [] };

  const sections = [];
  const harness = HARNESS_LABELS[driver as keyof typeof HARNESS_LABELS];
  if (harness !== undefined) {
    sections.push({
      id: "t3_code_runtime",
      title: "Runtime context (every turn)",
      content: buildRuntimeInstructions({ harness }).trim(),
    });
  }

  const channel = ACP_PROMPT_DRIVERS.has(driver)
    ? "sent in the first prompt"
    : "appended to the system prompt";
  sections.push({
    id: "t3_code_orchestration",
    title: `T3 Code orchestration (${WHEN_MCP_ATTACHED}, ${channel})`,
    content: T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
  });

  if (BROWSER_DRIVERS.has(driver)) {
    sections.push({
      id: "t3_code_browser",
      title: `Collaborative browser (${WHEN_MCP_ATTACHED}, ${channel})`,
      content: T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
    });
  }

  return { sections };
}
