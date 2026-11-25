import { Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ServerProvider,
  ThreadId,
  ServerSettings,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useHandleNewThread, useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { readProjects, useProjects, useQuietThreadShells } from "../../state/entities";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../../state/environments";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { makeThreadFixture } from "../../test-fixtures";
import type { Project } from "../../types";
import Sidebar from "../Sidebar";
import { SidebarProvider } from "../ui/sidebar";

type Config = Pick<EnvironmentServerConfig, "settings">;
const fixture = vi.hoisted(() => ({
  scheduledTasks: new Map<EnvironmentId, ScheduledTask[]>(),
  configSetters: [] as Array<(configs: ReadonlyMap<EnvironmentId, Config>) => void>,
  providerSetters: [] as Array<
    (providers: ReadonlyMap<EnvironmentId, readonly ServerProvider[]>) => void
  >,
  setConfigs: (configs: ReadonlyMap<EnvironmentId, Config>): void =>
    fixture.configSetters.forEach((set) => set(configs)),
  setProviders: (providers: ReadonlyMap<EnvironmentId, readonly ServerProvider[]>): void =>
    fixture.providerSetters.forEach((set) => set(providers)),
  setLive: (_live: ReadonlySet<EnvironmentId>) => {},
}));

vi.mock("../../state/presentation", async (original) => {
  const actual = await original<typeof import("../../state/presentation")>();
  const { Atom } = await import("effect/reactivity");
  const { EnvironmentId } = await import("@t3tools/contracts");
  const { appAtomRegistry } = await import("../../rpc/atomRegistry");
  const configs = Atom.make<ReadonlyMap<EnvironmentId, Config>>(new Map()).pipe(Atom.keepAlive);
  const providers = Atom.make<ReadonlyMap<EnvironmentId, readonly ServerProvider[]>>(
    new Map(),
  ).pipe(Atom.keepAlive);
  fixture.configSetters.push((value) => appAtomRegistry.set(configs, value));
  fixture.providerSetters.push((value) => appAtomRegistry.set(providers, value));
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      connectedEnvironmentIdsAtom: Atom.make([
        EnvironmentId.make("local"),
        EnvironmentId.make("remote"),
      ]),
    },
    environmentPresentations: {
      ...actual.environmentPresentations,
      serverConfigsAtom: Atom.make(
        (get) =>
          new Map(
            [...get(configs)].map(([environmentId, config]) => [
              environmentId,
              {
                ...config,
                providers: get(providers).get(environmentId) ?? [],
              },
            ]),
          ),
      ),
      providersByEnvironmentAtom: providers,
    },
  };
});
vi.mock("../../state/shell", async (original) => {
  const actual = await original<typeof import("../../state/shell")>();
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("../../rpc/atomRegistry");
  const live = Atom.make<ReadonlySet<EnvironmentId>>(new Set<EnvironmentId>());
  fixture.setLive = (value) => appAtomRegistry.set(live, value);
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      statusAtom: Atom.family((environmentId: EnvironmentId) =>
        Atom.make((get) => (get(live).has(environmentId) ? "live" : "cached")),
      ),
    },
  };
});
vi.mock("../../state/entities", { spy: true });
vi.mock("../../hooks/useHandleNewThread", { spy: true });
vi.mock("../../hooks/useScratchProject", { spy: true });
vi.mock("../../hooks/useThreadRouteTarget", { spy: true });
vi.mock("../../state/session", { spy: true });
vi.mock("../../state/environments", async (original) => {
  const actual = await original<typeof import("../../state/environments")>();
  return {
    ...actual,
    useConnectedEnvironmentIds: vi.fn(actual.useConnectedEnvironmentIds),
    usePrimaryEnvironmentId: vi.fn(actual.usePrimaryEnvironmentId),
  };
});
vi.mock("../../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: vi.fn(async () => null),
  peekT3ProjectFile: vi.fn(() => undefined),
}));
vi.mock("../../state/server", async (original) => {
  const actual = await original<typeof import("../../state/server")>();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const { appAtomRegistry } = await import("../../rpc/atomRegistry");
  const configs = Atom.make<ReadonlyMap<EnvironmentId, Config>>(new Map()).pipe(Atom.keepAlive);
  const providers = Atom.make<ReadonlyMap<EnvironmentId, readonly ServerProvider[]>>(
    new Map(),
  ).pipe(Atom.keepAlive);
  fixture.configSetters.push((value) => appAtomRegistry.set(configs, value));
  fixture.providerSetters.push((value) => appAtomRegistry.set(providers, value));
  const environmentServerConfigsAtom = Atom.make(
    (get) =>
      new Map(
        [...get(configs)].map(([environmentId, config]) => [
          environmentId,
          {
            ...config,
            providers: get(providers).get(environmentId) ?? [],
          },
        ]),
      ),
  );
  return {
    ...actual,
    environmentServerConfigsAtom,
    serverEnvironment: {
      ...actual.serverEnvironment,
      scheduledTasksLive: ({ environmentId }: { environmentId: EnvironmentId }) =>
        Atom.make(AsyncResult.success({ tasks: fixture.scheduledTasks.get(environmentId) ?? [] })),
    },
    primaryServerKeybindingsAtom: Atom.make(
      compileResolvedKeybindingsConfig([
        { key: "f1", command: "thread.jump.1" },
        { key: "f2", command: "thread.jump.2" },
      ]),
    ),
  };
});
vi.mock("../sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const alpha = ProviderInstanceId.make("cluster-alpha");
const beta = ProviderInstanceId.make("cluster-beta");
function project(environmentId = local): Project {
  return {
    environmentId,
    id: ProjectId.make("scratch"),
    title: "No project",
    workspaceRoot: "/scratch",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
function settings(
  instances: Record<string, { driver: "hermes"; displayName: string; enabled?: boolean }>,
): ServerSettings {
  const providerInstances: Record<
    ProviderInstanceId,
    { driver: ProviderDriverKind; displayName: string; enabled?: boolean }
  > = {};
  for (const [id, config] of Object.entries(instances)) {
    providerInstances[ProviderInstanceId.make(id)] = {
      ...config,
      driver: ProviderDriverKind.make(config.driver),
    };
  }
  return { ...DEFAULT_SERVER_SETTINGS, providerInstances };
}
const decodeServerProvider = Schema.decodeSync(ServerProvider);
function snapshot(instanceId: ProviderInstanceId) {
  return decodeServerProvider({
    instanceId,
    driver: "hermes",
    enabled: true,
    installed: true,
    availability: "available",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    version: null,
    models: [{ slug: "m", name: "M", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });
}
const openScratch = vi.fn(async (environmentId: EnvironmentId) => project(environmentId));

const starts: Array<ReturnType<ReturnType<typeof useNewThreadHandler>>> = [];

function setup() {
  fixture.scheduledTasks.clear();
  const previousSettings = getClientSettings();
  const previousCollapse = localStorage.getItem("t3code:sidebar:hermes-collapsed");
  localStorage.removeItem("t3code:sidebar:hermes-collapsed");
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, sidebarPinnedStatusEnabled: true });
  fixture.setConfigs(
    new Map([
      [
        local,
        {
          settings: settings({
            [alpha]: { driver: "hermes", displayName: "Cluster Alpha" },
            [beta]: { driver: "hermes", displayName: "Cluster Beta" },
          }),
        },
      ],
    ]),
  );
  fixture.setProviders(new Map([[local, [snapshot(alpha), snapshot(beta)]]]));
  fixture.setLive(new Set([local, remote]));
  vi.mocked(useProjects).mockReturnValue([project(), project(remote)]);
  vi.mocked(readProjects).mockReturnValue([project(), project(remote)]);
  vi.mocked(useQuietThreadShells).mockReturnValue([]);
  vi.mocked(useThreadRouteTarget).mockReturnValue(null);
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue([local, remote]);
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(local);
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  openScratch.mockReset().mockImplementation(async (environmentId) => project(environmentId));
  starts.length = 0;
  vi.mocked(useScratchProject).mockReturnValue({
    openScratchProject: openScratch,
    scratchWorkspaceRootFor: vi.fn(() => "/scratch"),
    scratchEnvironmentId: vi.fn(() => local),
    startScratchThread: vi.fn(async () => undefined),
  });
  vi.mocked(useHandleNewThread).mockImplementation(() => {
    const handler = useNewThreadHandler();
    const handleNewThread: ReturnType<typeof useNewThreadHandler> = (projectRef, options) => {
      const result = handler(projectRef, options);
      starts.push(result);
      return result;
    };
    return {
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId: local, projectId: project().id },
      defaultProjectFallbackReady: true,
      handleNewThread,
      routeDraftId: null,
      routeThreadRef: null,
    };
  });
  return {
    [Symbol.dispose]() {
      __setClientSettingsForTests(previousSettings);
      vi.restoreAllMocks();
      if (previousCollapse === null) localStorage.removeItem("t3code:sidebar:hermes-collapsed");
      else localStorage.setItem("t3code:sidebar:hermes-collapsed", previousCollapse);
    },
  };
}

function sidebarElement() {
  return (
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>
    </AppAtomRegistryProvider>
  );
}

async function mount() {
  return render(sidebarElement());
}

it("shows trigger text only for directly bound T3 tasks in the row's environment", async () => {
  using _fixture = setup();
  const threadId = ThreadId.make("alert-thread");
  const task: ScheduledTask = {
    id: ScheduledTaskId.make("daily"),
    title: "Daily digest",
    prompt: "Read the daily alerts",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: project().id,
    threadId,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: alpha, model: "m" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
  fixture.scheduledTasks.set(local, [task]);
  fixture.scheduledTasks.set(remote, [
    { ...task, title: "Unbound digest", threadMode: "new_thread" },
  ]);
  vi.mocked(useQuietThreadShells).mockReturnValue(
    [local, remote].map((environmentId) =>
      makeThreadFixture({
        id: threadId,
        environmentId,
        projectId: project(environmentId).id,
        modelSelection: { instanceId: alpha, model: "m" },
        title: `Alerts on ${environmentId}`,
      }),
    ),
  );
  await using screen = await mount();
  await expect.element(screen.getByText("Alerts on remote")).toBeVisible();
  await expect.element(screen.getByText("Schedule: Daily digest")).toBeVisible();
  await expect.element(screen.getByText("Schedule: Unbound digest")).not.toBeInTheDocument();
});
it("opens attached homes without creating scratch resources and preserves legacy-off rendering", async () => {
  using _fixture = setup();
  const previous = getClientSettings();
  using _settings = { [Symbol.dispose]: () => __setClientSettingsForTests(previous) };
  await using screen = await mount();
  await expect
    .element(screen.getByRole("button", { name: "Cluster Alpha conversations" }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Cluster Alpha conversations" }));
  expect(openScratch).not.toHaveBeenCalled();
  await screen.unmount();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, sidebarPinnedStatusEnabled: false });
  await using legacy = await mount();
  await expect.element(legacy.getByTestId("sidebar-hermes-home")).not.toBeInTheDocument();
});

it("creates separate scoped drafts for two instances in one scratch project and the same instance in another environment", async () => {
  using _fixture = setup();
  const initial = useComposerDraftStore.getState();
  using _drafts = { [Symbol.dispose]: () => useComposerDraftStore.setState(initial, true) };
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  fixture.setConfigs(
    new Map([
      [
        local,
        {
          settings: settings({
            [alpha]: { driver: "hermes", displayName: "Cluster Alpha" },
            [beta]: { driver: "hermes", displayName: "Cluster Beta" },
          }),
        },
      ],
      [
        remote,
        { settings: settings({ [alpha]: { driver: "hermes", displayName: "Remote Alpha" } }) },
      ],
    ]),
  );
  fixture.setProviders(
    new Map([
      [local, [snapshot(alpha), snapshot(beta)]],
      [remote, [snapshot(alpha)]],
    ]),
  );
  await using screen = await mount();
  await userEvent.click(
    screen.getByRole("button", { name: "New conversation with Cluster Alpha" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "New conversation with Cluster Beta" }));
  await userEvent.click(screen.getByRole("button", { name: "New conversation with Remote Alpha" }));
  await act(async () => {
    await Promise.all(starts);
  });
  expect(openScratch.mock.calls.map(([environmentId]) => environmentId)).toEqual([
    local,
    local,
    remote,
  ]);
  const sessions = Object.values(useComposerDraftStore.getState().draftThreadsByThreadKey);
  expect(sessions).toHaveLength(3);
  expect(new Set(sessions.map((draft) => draft.threadId)).size).toBe(3);
  expect(new Set(sessions.map((draft) => draft.projectId))).toEqual(new Set([project().id]));
  expect(
    Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey).map(
      (draftId) => useComposerDraftStore.getState().draftsByThreadKey[draftId]?.activeProvider,
    ),
  ).toEqual([alpha, beta, alpha]);
  await userEvent.click(
    screen.getByRole("button", { name: "New conversation with Cluster Alpha" }),
  );
  await act(async () => {
    await Promise.all(starts);
  });
  expect(Object.values(useComposerDraftStore.getState().draftThreadsByThreadKey)).toHaveLength(3);
});

it("keeps attached disabled and cached homes, blocks creation, and removes only detached homes", async () => {
  using _fixture = setup();
  await using screen = await mount();
  await act(() => {
    fixture.setConfigs(
      new Map([
        [
          local,
          {
            settings: settings({
              [alpha]: { driver: "hermes", displayName: "Cluster Alpha", enabled: false },
              [beta]: { driver: "hermes", displayName: "Cluster Beta" },
            }),
          },
        ],
      ]),
    );
    fixture.setLive(new Set());
  });
  await expect
    .element(screen.getByRole("button", { name: "Cluster Alpha conversations" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "New conversation with Cluster Alpha" }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "New conversation with Cluster Beta" }))
    .toBeDisabled();
  await act(() =>
    fixture.setConfigs(
      new Map([
        [
          local,
          { settings: settings({ [beta]: { driver: "hermes", displayName: "Cluster Beta" } }) },
        ],
      ]),
    ),
  );
  await expect
    .element(screen.getByRole("button", { name: "Cluster Alpha conversations" }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Cluster Beta conversations" }))
    .toBeVisible();
  expect(openScratch).not.toHaveBeenCalled();
});

it("removes deleted conversations from Hermes groups, pinned and settled shelves, and search", async () => {
  using _fixture = setup();
  const selection = { instanceId: alpha, model: "m" };
  vi.mocked(useQuietThreadShells).mockReturnValue([
    makeThreadFixture({
      id: ThreadId.make("active-cluster"),
      environmentId: local,
      projectId: project().id,
      modelSelection: selection,
      title: "Active cluster alert",
    }),
    makeThreadFixture({
      id: ThreadId.make("pinned-cluster"),
      environmentId: local,
      projectId: project().id,
      modelSelection: selection,
      title: "Pinned cluster alert",
      pinnedAt: "2026-01-01T00:00:00.000Z",
    }),
    makeThreadFixture({
      id: ThreadId.make("settled-cluster"),
      environmentId: local,
      projectId: project().id,
      modelSelection: selection,
      title: "Settled cluster alert",
      settledAt: "2026-01-01T00:00:00.000Z",
    }),
  ]);
  await using screen = await mount();
  await expect.element(screen.getByText("Active cluster alert")).toBeVisible();
  await expect.element(screen.getByText("Pinned cluster alert")).toBeVisible();
  await userEvent.click(screen.getByTestId("sidebar-settled-shelf-toggle"));
  await expect.element(screen.getByText("Settled cluster alert")).toBeVisible();

  const search = screen.getByRole("combobox", { name: "Search threads" });
  await userEvent.fill(search, "cluster alert");
  for (const title of ["Active cluster alert", "Pinned cluster alert", "Settled cluster alert"]) {
    await expect.element(screen.getByRole("option", { name: new RegExp(title) })).toBeVisible();
  }
  await userEvent.fill(search, "");
  vi.mocked(useQuietThreadShells).mockReturnValue([]);
  await screen.rerender(sidebarElement());
  for (const title of ["Active cluster alert", "Pinned cluster alert", "Settled cluster alert"]) {
    await expect.element(screen.getByText(title)).not.toBeInTheDocument();
  }

  await userEvent.fill(search, "cluster alert");
  for (const title of ["Active cluster alert", "Pinned cluster alert", "Settled cluster alert"]) {
    await expect
      .element(screen.getByRole("option", { name: new RegExp(title) }))
      .not.toBeInTheDocument();
  }
});

it("changes cached unknown attention to canonical live requests without acknowledging them", async () => {
  using _fixture = setup();
  vi.mocked(useQuietThreadShells).mockReturnValue([
    makeThreadFixture({
      environmentId: local,
      id: ThreadId.make("waiting"),
      projectId: project().id,
      providerInstanceId: alpha,
      hasPendingUserInput: true,
    }),
  ]);
  fixture.setLive(new Set());
  await using screen = await mount();
  await expect.element(screen.getByText("1 not checked")).toBeVisible();
  await act(() => fixture.setLive(new Set([local])));
  await expect.element(screen.getByText("1 needs you")).toBeVisible();
  await expect.element(screen.getByText("1 not checked")).not.toBeInTheDocument();
  expect(openScratch).not.toHaveBeenCalled();
});

it("filters live requests across Hermes and coding without changing collapse state", async () => {
  using _fixture = setup();
  const coding = makeThreadFixture({
    environmentId: local,
    id: ThreadId.make("coding-request"),
    projectId: project().id,
    title: "Coding request",
    hasPendingApprovals: true,
  });
  const hermes = makeThreadFixture({
    environmentId: local,
    id: ThreadId.make("hermes-request"),
    projectId: project().id,
    providerInstanceId: alpha,
    title: "Hermes request",
    hasPendingUserInput: true,
  });
  const idle = makeThreadFixture({
    environmentId: local,
    id: ThreadId.make("hermes-idle"),
    projectId: project().id,
    providerInstanceId: beta,
    title: "Hermes idle",
  });
  const running = makeThreadFixture({
    environmentId: local,
    id: ThreadId.make("hermes-running"),
    projectId: project().id,
    providerInstanceId: beta,
    title: "Hermes working",
    runtime: {
      status: "running",
      activeRunId: null,
      providerInstanceId: beta,
      providerName: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  const limited = makeThreadFixture({
    environmentId: local,
    id: ThreadId.make("hermes-limited"),
    projectId: project().id,
    providerInstanceId: alpha,
    title: "Hermes usage limit",
    runtime: {
      status: "failed",
      activeRunId: null,
      providerInstanceId: alpha,
      providerName: null,
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  vi.mocked(useQuietThreadShells).mockReturnValue([coding, hermes, idle, running, limited]);
  await using screen = await mount();
  await expect.element(screen.getByText("Hermes usage limit", { exact: true })).toBeVisible();
  expect(screen.getByText("1 needs you", { exact: true }).elements()).toHaveLength(1);
  expect(screen.getByText("2 need you", { exact: true }).elements()).toHaveLength(0);
  const needsYou = screen.getByRole("button", { name: /^Needs you/ });
  await expect.element(needsYou).toBeVisible();
  await userEvent.click(needsYou);
  await expect.element(screen.getByText("Coding request")).toBeVisible();
  await expect.element(screen.getByText("Hermes request")).toBeVisible();
  await expect.element(screen.getByText("Hermes idle")).not.toBeInTheDocument();
  const alphaHome = screen.getByRole("button", { name: "Cluster Alpha conversations" });
  await userEvent.click(alphaHome);
  await expect.element(screen.getByText("Hermes request")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^Running/ }));
  await expect.element(screen.getByText("Coding request")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Hermes working")).toBeVisible();
  vi.mocked(useThreadRouteTarget).mockReturnValue({
    kind: "server",
    threadRef: scopeThreadRef(local, idle.id),
  });
  await screen.rerender(sidebarElement());
  await expect.element(screen.getByText("Hermes idle")).toBeVisible();
  await expect
    .element(screen.getByText("The open conversation stays visible outside the filter."))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "All" }));
  await expect.element(alphaHome).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("Hermes idle")).toBeVisible();
  expect(openScratch).not.toHaveBeenCalled();
});

it("jumps to visible conversations in sidebar order when a Hermes home collapses", async () => {
  using _fixture = setup();
  const initial = useComposerDraftStore.getState();
  using _drafts = { [Symbol.dispose]: () => useComposerDraftStore.setState(initial, true) };
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const projectId = project().id;
  const draftId = DraftId.make("cluster-shortcut-draft");
  const drafts = useComposerDraftStore.getState();
  drafts.setLogicalProjectDraftThreadId(projectId, scopeProjectRef(local, projectId), draftId);
  drafts.setModelSelection(draftId, { instanceId: alpha, model: "m" });
  drafts.setPrompt(draftId, "Unsent cluster check");
  const pinned = makeThreadFixture({
    environmentId: local,
    projectId,
    id: ThreadId.make("pinned-shortcut"),
    title: "Pinned conversation",
    pinnedAt: "2026-01-01T00:00:00.000Z",
  });
  const coding = makeThreadFixture({
    environmentId: local,
    projectId,
    id: ThreadId.make("coding-shortcut"),
    title: "Coding conversation",
  });
  vi.mocked(useQuietThreadShells).mockReturnValue([pinned, coding]);
  await using screen = await mount();
  using navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
  await expect.element(screen.getByText("Unsent cluster check")).toBeVisible();
  await userEvent.keyboard("{F1}{F2}");
  expect(navigate).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ params: { environmentId: local, threadId: pinned.id } }),
  );
  expect(navigate).toHaveBeenNthCalledWith(2, { to: "/draft/$draftId", params: { draftId } });

  await userEvent.click(screen.getByRole("button", { name: "Cluster Alpha conversations" }));
  await expect.element(screen.getByText("Unsent cluster check")).not.toBeInTheDocument();
  await userEvent.keyboard("{F2}");
  expect(navigate).toHaveBeenLastCalledWith(
    expect.objectContaining({ params: { environmentId: local, threadId: coding.id } }),
  );
});

it("does not create a draft when operation permission is revoked while scratch is opening", async () => {
  using _fixture = setup();
  const initial = useComposerDraftStore.getState();
  using _drafts = { [Symbol.dispose]: () => useComposerDraftStore.setState(initial, true) };
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  openScratch.mockImplementationOnce(async (environmentId) => {
    vi.mocked(readEnvironmentScope).mockReturnValue(false);
    return project(environmentId);
  });
  await using screen = await mount();
  await userEvent.click(
    screen.getByRole("button", { name: "New conversation with Cluster Alpha" }),
  );
  await act(async () => {
    await Promise.all(starts);
  });
  expect(openScratch).toHaveBeenCalledTimes(1);
  expect(Object.values(useComposerDraftStore.getState().draftThreadsByThreadKey)).toHaveLength(0);
});

it("preserves typed scoped drafts when their current provider changes and is detached", async () => {
  using _fixture = setup();
  const initial = useComposerDraftStore.getState();
  using _drafts = { [Symbol.dispose]: () => useComposerDraftStore.setState(initial, true) };
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  await using screen = await mount();
  await userEvent.click(
    screen.getByRole("button", { name: "New conversation with Cluster Alpha" }),
  );
  await act(async () => {
    await Promise.all(starts);
  });
  const [draftId] = Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey);
  expect(draftId).toBeDefined();
  const id = DraftId.make(draftId!);
  await act(() => useComposerDraftStore.getState().setPrompt(id, "Keep this conversation intact"));
  const row = screen.getByTestId("sidebar-draft-row");
  await expect.element(row).toHaveAccessibleName("Keep this conversation intact, Unsent draft");
  await act(() =>
    useComposerDraftStore.getState().setModelSelection(id, { instanceId: beta, model: "m" }),
  );
  await expect
    .element(row)
    .toHaveAttribute("data-sidebar-parent", `hermes:${JSON.stringify([local, beta])}`);
  await userEvent.click(
    screen.getByRole("button", { name: "New conversation with Cluster Alpha" }),
  );
  await act(async () => {
    await Promise.all(starts);
  });
  expect(Object.values(useComposerDraftStore.getState().draftThreadsByThreadKey)).toHaveLength(2);
  await act(() =>
    fixture.setConfigs(
      new Map([
        [
          local,
          { settings: settings({ [alpha]: { driver: "hermes", displayName: "Cluster Alpha" } }) },
        ],
      ]),
    ),
  );
  await expect.element(row).not.toHaveAttribute("data-sidebar-parent");
  await expect
    .element(row)
    .toHaveAccessibleName("Keep this conversation intact, Unsent draft, No project");
  expect(useComposerDraftStore.getState().getComposerDraft(id)?.activeProvider).toBe(beta);
});

it("honors project provider overrides received while scratch is opening without falling back", async () => {
  using _fixture = setup();
  const initial = useComposerDraftStore.getState();
  using _drafts = { [Symbol.dispose]: () => useComposerDraftStore.setState(initial, true) };
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  openScratch.mockImplementationOnce(async (environmentId) => {
    const current = settings({ [alpha]: { driver: "hermes", displayName: "Cluster Alpha" } });
    fixture.setConfigs(
      new Map([
        [
          local,
          {
            settings: {
              ...current,
              defaultModelSelection: { instanceId: beta, model: "m" },
              fallbackModelSelection: { instanceId: beta, model: "m" },
              projectSettingsOverrides: {
                [project().id]: { providerInstances: { [alpha]: { enabled: false } } },
              },
            },
          },
        ],
      ]),
    );
    return project(environmentId);
  });
  await using screen = await mount();
  await userEvent.click(
    screen.getByRole("button", { name: "New conversation with Cluster Alpha" }),
  );
  const results = await Promise.allSettled(starts);
  expect(results).toHaveLength(1);
  expect(results[0]?.status).toBe("rejected");
  expect(Object.values(useComposerDraftStore.getState().draftThreadsByThreadKey)).toHaveLength(0);
});
