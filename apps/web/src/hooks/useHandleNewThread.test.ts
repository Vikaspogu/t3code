import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, ProjectId, RuntimeMode } from "@t3tools/contracts";

const testState = vi.hoisted(() => {
  type ProjectFile = { readonly defaultThreadEnvMode?: "local" | "worktree" } | null;
  let completeProjectFileRead: (value: ProjectFile) => void = () => undefined;
  let projectFileRead = Promise.resolve<ProjectFile>(null);
  let draftSession = {
    envMode: "local",
    worktreePath: null,
    branch: null as string | null,
    environmentSelection: undefined as "manual" | undefined,
  };
  let connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
  let targetSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree" | null,
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: null,
    defaultRuntimeMode: "full-access" as RuntimeMode,
  };
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  let openDraftRoute: { readonly kind: "draft"; readonly draftId: string } | null = null;
  let openDraftProviderScope:
    | { readonly environmentId: string; readonly providerInstanceId: string }
    | undefined;
  let scopedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  let composerDrafts: Record<string, Record<string, unknown>> = {};
  let providerConfig: {
    providers: unknown[];
    settings: {
      providerInstances: Record<string, { driver: string; config?: unknown }>;
      projectSettingsOverrides?: object;
    };
  } = { providers: [], settings: { providerInstances: {} } };
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
    buildLocation: (request: { readonly params: { readonly draftId: string } }) => ({
      href: `/draft/${request.params.draftId}`,
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn((draftId: string) => composerDrafts[draftId] ?? { draftId }),
    getDraftSessionByProviderScope: vi.fn(() => scopedDraft),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() =>
      openDraftRoute === null
        ? { ...draftSession, promotedTo: null, startFromOrigin: false }
        : {
            logicalProjectKey: "remote-project",
            promotedTo: null,
            providerScope: openDraftProviderScope,
            threadId: "thread-open",
            createdAt: "2026-01-01T00:00:00.000Z",
            runtimeMode: "full-access",
            interactionMode: "default",
          },
    ),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
    setPrompt: vi.fn(),
  };

  const readySnapshot = (instanceId: string, driver: string) => ({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    availability: "available",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    version: null,
    message: null,
    models: [{ slug: "m", name: "M", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  return {
    readySnapshot,
    configureProviders(
      providers: unknown[],
      providerInstances: Record<string, { driver: string; config?: unknown }>,
    ) {
      providerConfig = { providers, settings: { providerInstances, projectSettingsOverrides: {} } };
    },
    get providerConfig() {
      return providerConfig;
    },
    holdScopedDraft(draftId: string, composer: Record<string, unknown>) {
      scopedDraft = {
        draftId,
        environmentId: "environment-ssh",
        promotedTo: null,
        threadId: "thread-scoped",
      };
      composerDrafts = { [draftId]: { draftId, ...composer } };
    },
    completeProjectFileRead: (value: ProjectFile) => completeProjectFileRead(value),
    discoverBranch(branch: string) {
      draftSession = { ...draftSession, branch };
    },
    keepEarlierManualChoice() {
      draftSession = { ...draftSession, environmentSelection: "manual" };
    },
    pickBranch(branch: string) {
      draftSession = { ...draftSession, branch, environmentSelection: "manual" };
    },
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    get connectedEnvironmentIds() {
      return connectedEnvironmentIds;
    },
    disconnect(environmentId: string) {
      connectedEnvironmentIds = connectedEnvironmentIds.filter((id) => id !== environmentId);
    },
    get openDraftRoute() {
      return openDraftRoute;
    },
    openEmptyDraft(draftId: string, providerScope?: typeof openDraftProviderScope) {
      openDraftRoute = { kind: "draft", draftId };
      openDraftProviderScope = providerScope;
    },
    get targetSettings() {
      return targetSettings;
    },
    reset(
      nextStoredDraft: typeof storedDraft,
      workspaceDefaults = {
        envMode: "local" as "local" | "worktree" | null,
        startFromOrigin: false,
      },
    ) {
      storedDraft = nextStoredDraft;
      openDraftRoute = null;
      openDraftProviderScope = undefined;
      draftSession = {
        envMode: "local",
        worktreePath: null,
        branch: null,
        environmentSelection: undefined,
      };
      connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
      targetSettings = {
        defaultThreadEnvMode: workspaceDefaults.envMode,
        newWorktreesStartFromOrigin: workspaceDefaults.startFromOrigin,
        defaultModelSelection: null,
        defaultRuntimeMode: "full-access",
      };
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      draftStore.setPrompt.mockClear();
      scopedDraft = null;
      composerDrafts = {};
      providerConfig = { providers: [], settings: { providerInstances: {} } };
      draftStore.getDraftSessionByProviderScope.mockClear();
      draftStore.setModelSelection.mockClear();
      draftStore.applyStickyState.mockClear();
      projectFileRead = new Promise<ProjectFile>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

const testServerConfigs = () =>
  new Map([
    [
      "environment-primary",
      {
        settings: {
          ...testState.targetSettings,
          newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin,
        },
      },
    ],
    [
      "environment-ssh",
      {
        settings: { ...testState.targetSettings, ...testState.providerConfig.settings },
        providers: testState.providerConfig.providers,
      },
    ],
  ]);

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "connected-environment-ids"
        ? testState.connectedEnvironmentIds
        : testServerConfigs(),
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
      : testServerConfigs(),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: (ref: { environmentId: string; projectId: string }) =>
    `${ref.environmentId}:${ref.projectId}`,
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/contracts")>()),
  DEFAULT_RUNTIME_MODE: "default",
  DEFAULT_SERVER_SETTINGS: {},
}));
vi.mock("@t3tools/shared/projectSettings", () => ({
  resolveProjectSettings: (
    settings: Record<string, unknown>,
    _projectId: unknown,
    _project: unknown,
    projectFile?: { defaultThreadEnvMode?: "local" | "worktree" } | null,
  ) => ({
    settings:
      projectFile === undefined
        ? settings
        : {
            ...settings,
            defaultThreadEnvMode:
              settings.defaultThreadEnvMode ?? projectFile?.defaultThreadEnvMode ?? "local",
          },
    sources: { defaultModelSelection: "environment", defaultThreadEnvMode: "environment" },
    overrides: {},
  }),
  resolveNewThreadEnvMode: (input: {
    projectSettings: { settings: { defaultThreadEnvMode: "local" | "worktree" } };
  }) => input.projectSettings.settings.defaultThreadEnvMode,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react-dom", () => ({ flushSync: (update: () => void) => update() }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({
  orderItemsByPreferredIds: ({ items }: { items: unknown[] }) => items,
}));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: (draft?: { hasText?: boolean }) => draft?.hasText === true,
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatThreadActions")>()),
  hasExplicitComposerModelSelection: () => false,
  resolveNewThreadModelSelectionOverride: () => null,
}));
vi.mock("../providerInstances", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providerInstances")>()),
  resolveDefaultProviderModelSelection: () => null,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: () => testState.projectFileRead,
  peekT3ProjectFile: () => undefined,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => {
  const project = {
    id: "project-remote",
    environmentId: "environment-ssh",
    workspaceRoot: "/remote/project",
    defaultThreadEnvMode: null,
    defaultModelSelection: null,
  };
  return {
    readProjects: () => [project],
    readThreadShell: () => null,
    readThreadShells: () => [],
    useProjects: () => [],
    useThread: () => null,
  };
});
vi.mock("../state/projects", () => ({ defaultProjectFallbackReadyAtom: () => true }));
vi.mock("../state/olderSettledShelf", () => ({ readUnloadedThreadCount: () => 0 }));
vi.mock("../state/presentation", () => ({
  environmentSummaries: { connectedEnvironmentIdsAtom: "connected-environment-ids" },
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteTarget: () => testState.openDraftRoute,
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ getClientSettings: () => ({}) }));

import {
  readPendingWorkspaceDefault,
  resolveDefaultProjectRef,
  useNewThreadHandler,
} from "./useHandleNewThread";

describe.each([
  ["new", null],
  [
    "reusable",
    {
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
    },
  ],
])("useNewThreadHandler with a %s draft", (_, draft) => {
  it("opens the draft before the project file is read, then applies its workspace default", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(testState.router.navigate).toHaveBeenCalledOnce();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      expect.anything(),
      opened?.draftId,
      expect.objectContaining({ envMode: "local" }),
    );
    testState.draftStore.setDraftThreadContext.mockClear();

    testState.discoverBranch("main");
    const pendingDefault = readPendingWorkspaceDefault(opened!.draftId);
    expect(pendingDefault).not.toBeNull();
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await pendingDefault;

    expect(readPendingWorkspaceDefault(opened!.draftId)).toBeNull();

    expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(opened?.draftId, {
      envMode: "worktree",
      startFromOrigin: false,
    });
  });

  it("applies the project file's default to a draft chosen manually before it opened", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    testState.keepEarlierManualChoice();
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.draftStore.setDraftThreadContext.mockClear();

    const pendingDefault = readPendingWorkspaceDefault(opened!.draftId);
    expect(pendingDefault).not.toBeNull();
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await pendingDefault;

    expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(opened?.draftId, {
      envMode: "worktree",
      startFromOrigin: false,
    });
  });

  it("keeps a branch the user picked while the project file loaded", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.draftStore.setDraftThreadContext.mockClear();

    testState.pickBranch("feature");
    expect(readPendingWorkspaceDefault(opened!.draftId)).toBeNull();
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await testState.projectFileRead;

    expect(testState.draftStore.setDraftThreadContext).not.toHaveBeenCalled();
  });

  it("sets the prompt before the draft shows", async () => {
    testState.reset(draft);
    const opened = await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    expect(testState.draftStore.setPrompt).toHaveBeenCalledWith(
      opened?.draftId,
      "Read the playbook. ",
    );
    expect(testState.draftStore.setPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      testState.router.navigate.mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe("useNewThreadHandler", () => {
  it("seeds the prompt into the empty draft that is already open", async () => {
    testState.reset(null);
    testState.openEmptyDraft("draft-open");

    const opened = await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    expect(opened?.draftId).toBe("draft-open");
    expect(testState.draftStore.setPrompt).toHaveBeenCalledWith(
      "draft-open",
      "Read the playbook. ",
    );
  });

  it("opens the draft without waiting on a project file from an offline machine", async () => {
    testState.reset(null, { envMode: null, startFromOrigin: false });
    testState.disconnect("environment-ssh");

    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(opened).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });
    expect(testState.router.navigate).toHaveBeenCalledOnce();
  });
});

describe("useNewThreadHandler with an explicit provider selection", () => {
  const target = { environmentId: "environment-ssh", projectId: "project-remote" } as never;
  const selection = { instanceId: "hermes_a", model: "m" } as never;
  const scope = { environmentId: "environment-ssh", providerInstanceId: "hermes_a" };
  const configureHermes = () =>
    testState.configureProviders(
      [
        testState.readySnapshot("hermes_a", "hermes"),
        testState.readySnapshot("hermes_b", "hermes"),
        testState.readySnapshot("codex", "codex"),
      ],
      { hermes_a: { driver: "hermes" }, hermes_b: { driver: "hermes" } },
    );
  const open = (override: unknown = selection, providerDraftScope: unknown = scope) =>
    useNewThreadHandler()(target, {
      modelSelectionOverride: override,
      providerDraftScope,
    } as never);
  const expectNothingWritten = () => {
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
    expect(testState.draftStore.setModelSelection).not.toHaveBeenCalled();
    expect(testState.router.navigate).not.toHaveBeenCalled();
  };

  it("creates a scoped draft and applies the explicit selection after sticky state", async () => {
    testState.reset(null);
    configureHermes();

    const opened = await open();

    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      expect.anything(),
      opened?.draftId,
      expect.objectContaining({ providerScope: scope }),
    );
    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
      opened?.draftId,
      selection,
      { replaceOptions: true },
    );
    expect(testState.draftStore.applyStickyState.mock.invocationCallOrder[0]).toBeLessThan(
      testState.draftStore.setModelSelection.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("reuses the empty draft of the same scope whose provider still matches", async () => {
    testState.reset(null);
    configureHermes();
    testState.holdScopedDraft("draft-scoped", {
      activeProvider: "hermes_a",
      modelSelectionByProvider: { hermes_a: selection },
    });

    const opened = await open();

    expect(testState.draftStore.getDraftSessionByProviderScope).toHaveBeenCalledWith(
      "remote-project",
      scope,
    );
    expect(opened).toEqual({ draftId: "draft-scoped", threadId: "thread-scoped" });
  });

  it("does not reuse a scoped draft whose provider was switched", async () => {
    testState.reset(null);
    configureHermes();
    testState.holdScopedDraft("draft-scoped", {
      activeProvider: "codex",
      modelSelectionByProvider: { codex: { instanceId: "codex", model: "m" } },
    });

    const opened = await open();

    expect(opened?.draftId).toBe("draft-delayed");
  });

  it("keeps a scoped draft that holds user text", async () => {
    testState.reset(null);
    configureHermes();
    testState.holdScopedDraft("draft-scoped", {
      activeProvider: "hermes_a",
      modelSelectionByProvider: { hermes_a: selection },
      hasText: true,
    });

    const opened = await open();

    expect(opened?.draftId).toBe("draft-delayed");
    expect(testState.draftStore.setPrompt).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "draft-scoped",
      expect.anything(),
    );
  });

  it("does not reuse an open scoped draft for an unscoped new thread", async () => {
    testState.reset(null);
    testState.openEmptyDraft("draft-scoped", scope);

    const opened = await useNewThreadHandler()(target);

    expect(opened).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });
  });

  it("leaves the unscoped lookup alone when no explicit selection is given", async () => {
    testState.reset(null);

    await useNewThreadHandler()(target);

    expect(testState.draftStore.getDraftSessionByProviderScope).not.toHaveBeenCalled();
    expect(testState.draftStore.getDraftSessionByLogicalProjectKey).toHaveBeenCalled();
  });

  it.each([
    [
      "an instance missing from the environment",
      () =>
        open({ instanceId: "hermes_c", model: "m" }, { ...scope, providerInstanceId: "hermes_c" }),
    ],
    [
      "a scope for another environment",
      () => open(selection, { ...scope, environmentId: "environment-primary" }),
    ],
    [
      "a scope for another instance",
      () => open(selection, { ...scope, providerInstanceId: "hermes_b" }),
    ],
    [
      "an environment without a server config",
      () =>
        useNewThreadHandler()(
          { environmentId: "environment-gone", projectId: "project-remote" } as never,
          { modelSelectionOverride: selection } as never,
        ),
    ],
  ])("rejects %s without writing or falling back", async (_, run) => {
    testState.reset(null);
    configureHermes();

    await expect(run()).rejects.toThrow();

    expectNothingWritten();
  });

  it("rejects an instance whose configured driver differs from its snapshot", async () => {
    testState.reset(null);
    testState.configureProviders([testState.readySnapshot("hermes_a", "codex")], {
      hermes_a: { driver: "hermes" },
    });

    await expect(open()).rejects.toThrow();

    expectNothingWritten();
  });

  it("rejects an instance that is not ready", async () => {
    testState.reset(null);
    testState.configureProviders(
      [{ ...testState.readySnapshot("hermes_a", "hermes"), status: "error" }],
      { hermes_a: { driver: "hermes" } },
    );

    await expect(open()).rejects.toThrow();

    expectNothingWritten();
  });

  it("rejects a model that is neither in the instance catalog nor a custom model", async () => {
    testState.reset(null);
    configureHermes();

    await expect(open({ instanceId: "hermes_a", model: "ghost" })).rejects.toThrow(/model/i);

    expectNothingWritten();
  });

  it("accepts a custom model configured on the instance", async () => {
    testState.reset(null);
    testState.configureProviders([testState.readySnapshot("hermes_a", "hermes")], {
      hermes_a: { driver: "hermes", config: { customModels: ["my-custom"] } },
    });

    const opened = await open({ instanceId: "hermes_a", model: "my-custom" });

    expect(opened?.draftId).toBe("draft-delayed");
    expect(testState.draftStore.setModelSelection).toHaveBeenCalled();
  });

  it("keeps a runtime-catalog model that a refresh briefly omitted", async () => {
    testState.reset(null);
    testState.configureProviders([testState.readySnapshot("pi_a", "pi")], {
      pi_a: { driver: "pi", config: { enabled: true } },
    });

    const opened = await open(
      { instanceId: "pi_a", model: "refreshing" },
      { ...scope, providerInstanceId: "pi_a" },
    );

    expect(opened?.draftId).toBe("draft-delayed");
  });

  it("rejects a scope given without an explicit selection", async () => {
    testState.reset(null);
    configureHermes();

    await expect(
      useNewThreadHandler()(target, { providerDraftScope: scope } as never),
    ).rejects.toThrow();

    expectNothingWritten();
  });
});

describe("default project selection", () => {
  it("prefers the last used project in its environment and falls back when unavailable", () => {
    const projects = [
      { id: "project", environmentId: "first", workspaceRoot: "/first" },
      { id: "project", environmentId: "last-used", workspaceRoot: "/last-used" },
    ].map((project) => ({
      ...project,
      id: project.id as ProjectId,
      environmentId: project.environmentId as EnvironmentId,
      title: project.environmentId,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-09T00:00:00.000Z",
      updatedAt: "2026-11-09T00:00:00.000Z",
    }));
    expect(resolveDefaultProjectRef(projects, [], "last-used:project")).toEqual({
      environmentId: "last-used",
      projectId: "project",
    });
    expect(
      resolveDefaultProjectRef(projects.slice(0, 1), [], "last-used:project", false),
    ).toBeNull();
    expect(resolveDefaultProjectRef(projects.slice(0, 1), [], "last-used:project")).toEqual({
      environmentId: "first",
      projectId: "project",
    });
    expect(
      resolveDefaultProjectRef(
        [projects[0]!, { ...projects[1]!, archivedAt: "2026-11-09T00:00:00.000Z" }],
        [],
        "last-used:project",
      ),
    ).toEqual({ environmentId: "first", projectId: "project" });
  });
});
