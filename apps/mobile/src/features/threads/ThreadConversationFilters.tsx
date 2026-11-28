import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  attachedHermesHomes,
  conversationHomeKey,
  type ConversationLens,
} from "@t3tools/client-runtime/state/conversation-organization";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { resolveHermesHomeModel } from "../../lib/modelOptions";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { createNewTaskDraft, waitForComposerDraftsLoaded } from "../../state/use-composer-drafts";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { environmentCatalog } from "../../connection/catalog";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import type { ThreadListV2Layout } from "./threadListV2";

const selectionAtom = Atom.make<{ homeKey: string | null; lens: ConversationLens }>({
  homeKey: null,
  lens: "all",
}).pipe(Atom.keepAlive);
const noConversationEnvironmentsAtom = Atom.make(null);
const conversationEnvironmentsAtom = Atom.make((get) => {
  const configs = get(environmentServerConfigsAtom);
  const environmentIds = enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom));
  const liveEnvironmentIds = new Set<EnvironmentId>();
  const homes = attachedHermesHomes(
    environmentIds.flatMap((id) => {
      if (get(environmentShell.statusAtom(id)) === "live") liveEnvironmentIds.add(id);
      const settings = configs.get(id)?.settings;
      return settings ? [[id, settings] as const] : [];
    }),
  );
  return { homes, liveEnvironmentIds };
});

export function useThreadConversationFilters(
  enabled: boolean,
  environmentId: EnvironmentId | null,
) {
  const environments = useAtomValue(
    enabled ? conversationEnvironmentsAtom : noConversationEnvironmentsAtom,
  );
  const selection = useAtomValue(selectionAtom);
  return useMemo(() => {
    if (!environments) return null;
    const homes = environments.homes.filter(
      (home) => environmentId === null || home.environmentId === environmentId,
    );
    const home = homes.find(
      (home) => conversationHomeKey(home.environmentId, home.instanceId) === selection.homeKey,
    );
    return {
      filter: { ...environments, homeKey: home ? selection.homeKey : null, lens: selection.lens },
      homes,
      home,
      setHomeKey: (homeKey: string | null) =>
        appAtomRegistry.update(selectionAtom, (current) => ({ ...current, homeKey })),
      setLens: (lens: ConversationLens) =>
        appAtomRegistry.update(selectionAtom, (current) => ({ ...current, lens })),
    };
  }, [environments, environmentId, selection]);
}

export function ThreadConversationFilters(props: {
  readonly controller: NonNullable<ReturnType<typeof useThreadConversationFilters>>;
  readonly counts: NonNullable<ThreadListV2Layout["conversationCounts"]>;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}) {
  const gt = useGT();
  const selectDetail = useSelectWorkspaceDetail();
  const openScratch = useAtomCommand(projectEnvironment.openScratch);
  const starting = useRef(false);
  const [isStarting, setIsStarting] = useState(false);
  const { controller, counts } = props;
  const { homeKey, lens } = controller.filter;
  const configs = useAtomValue(environmentServerConfigsAtom);
  const homeLabel = (home: (typeof controller.homes)[number]) => {
    const environment = props.environments.find(
      (entry) => entry.environmentId === home.environmentId,
    );
    const label =
      environment && props.environments.length > 1
        ? gt("{name} on {environment}", { name: home.displayName, environment: environment.label })
        : home.displayName;
    return resolveHermesHomeModel(
      configs.get(home.environmentId),
      home.instanceId,
      null,
      controller.filter.liveEnvironmentIds.has(home.environmentId),
    ) !== null
      ? label
      : gt("{name} (unavailable)", { name: label });
  };
  const lenses = [
    { id: "all", title: gt("All", { $context: "conversation activity filter" }) },
    { id: "needs-you", title: gt("Needs you ({count})", { count: counts["needs-you"] }) },
    { id: "running", title: gt("Running ({count})", { count: counts.running }) },
  ] as const;
  const lensTitle = lenses.find((item) => item.id === lens)?.title ?? lenses[0].title;
  const coding = gt("Coding");
  const currentHome = controller.home ? homeLabel(controller.home) : coding;
  const selectedHome = controller.home;
  const canOperate = useEnvironmentScope(
    selectedHome?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canStart =
    selectedHome !== undefined &&
    canOperate &&
    resolveHermesHomeModel(
      configs.get(selectedHome.environmentId),
      selectedHome.instanceId,
      null,
      controller.filter.liveEnvironmentIds.has(selectedHome.environmentId),
    ) !== null;

  async function startConversation() {
    if (!selectedHome || !canStart || starting.current) return;
    const { environmentId, instanceId } = selectedHome;
    starting.current = true;
    setIsStarting(true);
    const isLiveAndAllowed = () =>
      appAtomRegistry.get(environmentShell.statusAtom(environmentId)) === "live" &&
      readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
    const readConfig = () => appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
    await (async () => {
      await waitForComposerDraftsLoaded();
      if (!resolveHermesHomeModel(readConfig(), instanceId, null, isLiveAndAllowed())) return;
      const result = await openScratch({ environmentId, input: {} });
      if (result._tag === "Failure") return;
      const project = result.value;
      const selection = resolveHermesHomeModel(
        readConfig(),
        instanceId,
        project.id,
        isLiveAndAllowed(),
      );
      if (project.environmentId !== environmentId || !selection) {
        Dialog.alert(gt("Provider unavailable"));
        return;
      }
      const draftId = createNewTaskDraft({ environmentId, projectId: project.id }, selection);
      selectDetail({
        name: "Thread",
        params: { draft: { draftId, title: selectedHome.displayName } },
      });
    })()
      .catch(() => {
        Dialog.alert(gt("Could not open draft"));
      })
      .finally(() => {
        starting.current = false;
        setIsStarting(false);
      });
  }
  return (
    <ScrollView
      className="grow-0"
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="items-center gap-2 px-3 py-1.5"
    >
      {controller.homes.length > 0 ? (
        <ListFilterMenu
          label={currentHome}
          accessibilityLabel={gt("Conversation home: {name}", { name: currentHome })}
          active={homeKey !== null}
          actions={[
            { id: "coding", title: coding, state: homeKey === null ? "on" : "off" },
            ...controller.homes.map((home) => {
              const id = conversationHomeKey(home.environmentId, home.instanceId);
              return {
                id,
                title: homeLabel(home),
                state: id === homeKey ? ("on" as const) : ("off" as const),
              };
            }),
          ]}
          onSelect={(id) => controller.setHomeKey(id === "coding" ? null : id)}
        />
      ) : null}
      <ListFilterMenu
        label={lensTitle}
        accessibilityLabel={gt("Conversation activity: {view}", { view: lensTitle })}
        active={lens !== "all"}
        actions={lenses.map((item) => ({ ...item, state: item.id === lens ? "on" : "off" }))}
        onSelect={(id) => {
          const next = lenses.find((item) => item.id === id);
          if (next) controller.setLens(next.id);
        }}
      />
      {counts.unknown > 0 ? (
        <Text className="text-sm text-muted-foreground">
          {gt("Not checked ({count})", { count: counts.unknown })}
        </Text>
      ) : null}
      {selectedHome ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("New conversation with {provider}", {
            provider: selectedHome.displayName,
          })}
          disabled={!canStart || isStarting}
          className="min-h-[44px] justify-center px-2 disabled:opacity-50"
          onPress={() => void startConversation()}
        >
          <Text className="text-sm text-foreground">{gt("New conversation")}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
