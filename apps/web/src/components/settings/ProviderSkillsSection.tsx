"use client";

import { useMemo, useState } from "react";
import {
  providerSupportsSkillToggle,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";
import { resolveProviderSkillSourceKind } from "@t3tools/client-runtime/providerSkills";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

interface ProviderSkillsSectionProps {
  readonly environmentId: EnvironmentId | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind | null;
  readonly provider: ServerProvider | undefined;
  /** Mirrors the Models section: switches go read-only when true. */
  readonly readOnly?: boolean | undefined;
}

const SOURCE_LABELS: Record<string, string> = {
  app: "App",
  repo: "Repo",
  project: "Project",
  personal: "Personal",
  system: "System",
  other: "Other",
};

function snapshotSortKey(snapshot: ServerProviderWorkspaceSnapshot): number {
  const parsed = Date.parse(snapshot.checkedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function SkillRow({
  skill,
  canToggle,
  pending,
  onToggle,
}: {
  readonly skill: ServerProviderSkill;
  readonly canToggle: boolean;
  readonly pending: boolean;
  readonly onToggle: (enabled: boolean) => void;
}) {
  const sourceKind = resolveProviderSkillSourceKind(skill);
  const sourceLabel = SOURCE_LABELS[sourceKind] ?? "Other";
  const title = skill.displayName ?? skill.name;
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <Tooltip>
          <TooltipTrigger render={<p className="min-w-0 truncate text-sm font-medium" />}>
            {title}
          </TooltipTrigger>
          <TooltipPopup>{skill.path}</TooltipPopup>
        </Tooltip>
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {skill.shortDescription ?? skill.description ?? "No description"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="outline">{sourceLabel}</Badge>
        {skill.userInvocationOnly === true ? (
          <Tooltip>
            <TooltipTrigger render={<Badge variant="outline" />}>User-only</TooltipTrigger>
            <TooltipPopup>
              The provider hides this skill from the agent itself; only you can start it.
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <Switch
          aria-label={`Enable ${skill.name}`}
          checked={skill.enabled}
          disabled={!canToggle || pending}
          onCheckedChange={onToggle}
        />
      </div>
    </div>
  );
}

/**
 * "Skills & prompts" for one provider instance: what T3 injects into the
 * provider's turns (runtime instructions, per driver), plus the skills and
 * slash commands discovered in each workspace the provider has scanned.
 * Skills are per-cwd; snapshots fill in as threads run in projects.
 */
export function ProviderSkillsSection({
  environmentId,
  instanceId,
  driverKind,
  provider,
  readOnly = false,
}: ProviderSkillsSectionProps) {
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const [pendingSkills, setPendingSkills] = useState<ReadonlySet<string>>(() => new Set());

  const instructionsQuery = useEnvironmentQuery(
    driverKind === null || environmentId === undefined
      ? null
      : serverEnvironment.providerRuntimeInstructions({
          environmentId,
          input: { driver: driverKind },
        }),
  );

  const setSkillEnabled = useAtomCommand(serverEnvironment.setProviderSkillEnabled);

  const snapshots = useMemo(
    () =>
      provider?.workspaceSnapshots === undefined || provider.workspaceSnapshots.length === 0
        ? []
        : [...provider.workspaceSnapshots].sort((a, b) => snapshotSortKey(b) - snapshotSortKey(a)),
    [provider?.workspaceSnapshots],
  );

  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const activeSnapshot = useMemo(
    () => snapshots.find((snapshot) => snapshot.cwd === selectedCwd) ?? snapshots[0],
    [snapshots, selectedCwd],
  );

  const canToggle =
    !readOnly &&
    environmentId !== undefined &&
    driverKind !== null &&
    providerSupportsSkillToggle(driverKind);

  const handleToggle = (skill: ServerProviderSkill, enabled: boolean) => {
    if (environmentId === undefined || activeSnapshot === undefined) return;
    setPendingSkills((pending) => new Set(pending).add(`${activeSnapshot.cwd}:${skill.name}`));
    void setSkillEnabled({
      environmentId,
      input: { instanceId, cwd: activeSnapshot.cwd, name: skill.name, enabled },
    })
      .catch(() => {
        // The command reports the failure toast; just unblock the row.
      })
      .finally(() =>
        setPendingSkills((pending) => {
          const next = new Set(pending);
          next.delete(`${activeSnapshot.cwd}:${skill.name}`);
          return next;
        }),
      );
  };

  const instructions = instructionsQuery.data?.sections ?? [];
  const disabledSkills = (activeSnapshot?.skills ?? []).filter((skill) => !skill.enabled).length;

  return (
    <div className="space-y-4 px-3 py-3 sm:px-4">
      <div>
        <button
          type="button"
          className="flex w-full items-center justify-between text-left"
          aria-expanded={instructionsExpanded}
          onClick={() => setInstructionsExpanded((expanded) => !expanded)}
        >
          <span className="text-sm font-medium">T3 Code instructions</span>
          <span className="text-xs text-muted-foreground">
            {instructionsExpanded ? "Hide" : "Show"}
          </span>
        </button>
        <p className="mt-1 text-xs text-muted-foreground">
          {instructions.length === 0
            ? driverKind === null
              ? "Unknown provider driver."
              : "T3 Code does not add instructions to this provider's turns."
            : `${instructions.length} instruction ${
                instructions.length === 1 ? "block" : "blocks"
              } T3 adds on top of the provider's own system prompt.`}
        </p>
        {instructionsExpanded ? (
          <div className="mt-2 space-y-3">
            {instructions.map((section) => (
              <div key={section.id} className="rounded-md border border-border p-3">
                {section.title !== undefined ? (
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {section.title}
                  </p>
                ) : null}
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">
                  {section.content}
                </pre>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div>
        <p className="text-sm font-medium">Skills &amp; commands</p>
        {activeSnapshot === undefined ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Skills are discovered per workspace when a thread runs in a project. Open a project
            thread, then revisit this panel to see and toggle what the provider loads.
          </p>
        ) : (
          <>
            {snapshots.length > 1 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {snapshots.map((snapshot) => (
                  <button
                    key={snapshot.cwd}
                    type="button"
                    className={
                      snapshot.cwd === activeSnapshot.cwd
                        ? "rounded-md bg-secondary px-2 py-1 text-xs"
                        : "rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary/50"
                    }
                    onClick={() => setSelectedCwd(snapshot.cwd)}
                  >
                    {snapshot.cwd}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="mt-1">
              <p className="mb-2 text-xs text-muted-foreground">
                {activeSnapshot.skills.length} skills · {activeSnapshot.slashCommands.length} slash
                commands {disabledSkills > 0 ? `· ${disabledSkills} disabled` : ""}
              </p>
              {activeSnapshot.skills.length === 0 ? (
                <p className="text-xs text-muted-foreground">No skills found in this workspace.</p>
              ) : (
                <div className="divide-y divide-border">
                  {activeSnapshot.skills.map((skill) => (
                    <SkillRow
                      key={`${skill.scope ?? ""}:${skill.name}`}
                      skill={skill}
                      canToggle={canToggle}
                      pending={pendingSkills.has(`${activeSnapshot.cwd}:${skill.name}`)}
                      onToggle={(enabled) => handleToggle(skill, enabled)}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
