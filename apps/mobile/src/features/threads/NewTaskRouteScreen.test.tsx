import type { ReactNode } from "react";
import { act } from "react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { retargetSavedNewTaskDraft } from "../../state/use-composer-drafts";

const environmentId = EnvironmentId.make("env-1");

function project(id: string, workspaceRoot: string): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: "worktree",
    scripts: [],
    createdAt: "2026-10-26T00:00:00Z",
    updatedAt: "2026-10-26T00:00:00Z",
  };
}

const regular = project("app", "/repo/app");
const scratch = project("scratch", "/scratch");

const harness = vi.hoisted(() => ({
  setProject: vi.fn(),
  openScratch: vi.fn(),
  createDraft: vi.fn(),
  hermesEnabled: false,
  hermesReady: true,
  hermesLive: true,
  hermesOperate: true,
  previousDraft: false,
  platform: "ios" as "ios" | "android",
  afterDraftsLoaded: null as null | (() => void),
  showEnvironmentLabel: true,
  duplicateEnvironment: false,
  selectedProjectKey: null as string | null,
  hideProjects: false,
  selectDetail: vi.fn(),
  navigation: {
    goBack: vi.fn(),
    getState: () => ({
      routeNames: ["Thread", "NewTaskProject"],
      index: 1,
      routes: [
        {
          name: "Thread",
          params: { draft: harness.previousDraft ? {} : undefined },
        },
        { name: "NewTaskProject" },
      ],
    }),
    getParent: () => undefined,
    canGoBack: () => true,
    dispatch: vi.fn(),
    navigate: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return harness.platform;
    },
  },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    accessibilityLabel: string;
    disabled?: boolean;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("gt-react-native", () => ({
  msg: (text: string) => text,
  T: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useGT: () => (text: string, variables?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (match, key: string) => variables?.[key] ?? match),
  useMessages: () => (text: string) => text,
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: (name: string) => ({ type: "PUSH", name }) },
  useFocusEffect: (effect: () => () => void) => React.useEffect(effect, [effect]),
  useIsFocused: () => true,
  useNavigation: () => harness.navigation,
}));
vi.mock("../../components/ui/NavigationRow", () => ({
  NavigationRow: (props: {
    title: string;
    subtitle?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      aria-label={[props.title, props.subtitle].filter(Boolean).join(", ")}
      disabled={props.disabled === true}
      onClick={props.onPress}
    >
      {props.title}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button aria-label={label} disabled={disabled === true} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../connection/environmentStatusText", () => ({ runtimeConnectionErrorText: () => null }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [regular, scratch],
  useServerConfigs: () => {
    const config = {
      scratchWorkspaceRoot: "/scratch",
      providers: [
        {
          instanceId: "hermes-1",
          driver: "hermes",
          displayName: "Hermes",
          environmentId,
          enabled: harness.hermesEnabled,
        },
      ],
      settings: {
        providerInstances: {
          "hermes-1": {
            driver: "hermes",
            displayName: "Hermes",
            enabled: harness.hermesEnabled,
          },
        },
      },
    };
    return new Map([
      [environmentId, config],
      ...(harness.duplicateEnvironment ? [[EnvironmentId.make("env-2"), config] as const] : []),
    ]);
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => new Set(harness.hermesLive ? [environmentId] : []),
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: string) =>
      atom === "configs" ? new Map() : harness.hermesLive ? "live" : "offline",
  },
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../../state/shell", () => ({ environmentShell: { statusAtom: () => "status" } }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { openScratch: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.openScratch }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => harness.hermesOperate,
  useEnvironmentsWithScope: () => new Set(harness.hermesOperate ? [environmentId] : []),
}));
vi.mock("../../lib/modelOptions", () => ({
  resolveHermesHomeModel: (
    _config: unknown,
    _instanceId: string,
    _projectId: string | null,
    liveAndAllowed: boolean,
  ) =>
    harness.hermesEnabled && harness.hermesReady && liveAndAllowed
      ? { instanceId: "hermes-1", model: "default" }
      : null,
}));
vi.mock("../../state/use-composer-drafts", () => ({
  createNewTaskDraft: harness.createDraft,
  retargetSavedNewTaskDraft: vi.fn(),
  waitForComposerDraftsLoaded: async () => harness.afterDraftsLoaded?.(),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: harness.showEnvironmentLabel
      ? [
          { environmentId, environmentLabel: "Moonbase", connectionState: "connected" },
          ...(harness.duplicateEnvironment
            ? [
                {
                  environmentId: EnvironmentId.make("env-2"),
                  environmentLabel: "Moonbase",
                  connectionState: "connected",
                },
              ]
            : []),
        ]
      : [],
  }),
}));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({ state: { hasReadyEnvironment: true } }),
}));
vi.mock("../sharing/IncomingShareProvider", () => ({
  useIncomingShare: () => ({ getShare: () => null, releaseShareReservation: vi.fn() }),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => harness.selectDetail,
}));
vi.mock("./new-task-flow-provider", () => ({
  useNewTaskFlow: () => ({
    projectScopes: harness.hideProjects
      ? []
      : [
          {
            key: "app",
            title: "app",
            representative: regular,
            projects: [regular],
            projectRefs: [],
            pinned: false,
            archived: false,
          },
        ],
    selectedEnvironmentId: environmentId,
    selectedProjectKey: harness.selectedProjectKey,
    setProject: harness.setProject,
  }),
}));

import { NewTaskRouteScreen } from "./NewTaskRouteScreen";
import * as Dialog from "../../components/ui/Dialog";

it("keeps the project picked while No project was still opening", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const opening = Promise.withResolvers<unknown>();
  harness.previousDraft = true;
  harness.openScratch.mockReturnValue(opening.promise);

  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const row = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

  try {
    act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
    act(() => row("No project").click());
    await act(async () => row("app").click());
    await act(async () => opening.resolve({ _tag: "Success", value: scratch }));

    expect(harness.setProject.mock.calls).toEqual([[regular]]);
    expect(harness.navigation.goBack).toHaveBeenCalledTimes(1);
  } finally {
    harness.previousDraft = false;
  }
});

function renderWithSavedDraft() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const opening = Promise.withResolvers<unknown>();
  const retargeting = Promise.withResolvers<boolean>();
  harness.openScratch.mockReturnValue(opening.promise);
  vi.mocked(retargetSavedNewTaskDraft)
    .mockReset()
    .mockImplementation((_draftId, target) =>
      target.projectId === scratch.id ? retargeting.promise : Promise.resolve(true),
    );
  harness.selectDetail.mockClear();

  const container = document.createElement("div");
  const root = createRoot(container);
  const route = { params: { draftId: "existing-draft" } } as never;
  act(() => root.render(<NewTaskRouteScreen key="first" route={route} />));
  return {
    opening,
    retargeting,
    root,
    route,
    row: (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

const appDraftSelection = [
  [
    {
      name: "Thread",
      params: { draft: { environmentId, projectId: regular.id, draftId: "existing-draft" } },
    },
  ],
];

it("keeps the picked project after backing out and reopening while No project is pending", async () => {
  using screen = renderWithSavedDraft();

  act(() => screen.row("No project").click());
  act(() => screen.root.render(null));
  act(() => screen.root.render(<NewTaskRouteScreen key="second" route={screen.route} />));
  await act(async () => screen.row("app").click());
  await act(async () => {
    screen.opening.resolve({ _tag: "Success", value: scratch });
    screen.retargeting.resolve(true);
  });

  expect(harness.selectDetail.mock.calls).toEqual(appDraftSelection);
});

it("cancels the No project draft retarget when another project is picked", async () => {
  using screen = renderWithSavedDraft();

  act(() => screen.row("No project").click());
  await act(async () => screen.opening.resolve({ _tag: "Success", value: scratch }));
  const scratchSignal = vi
    .mocked(retargetSavedNewTaskDraft)
    .mock.calls.find(([, target]) => target.projectId === scratch.id)?.[2];
  expect(scratchSignal?.aborted).toBe(false);
  await act(async () => screen.row("app").click());
  expect(scratchSignal?.aborted).toBe(true);
  await act(async () => screen.retargeting.resolve(true));

  expect(harness.selectDetail.mock.calls).toEqual(appDraftSelection);
});

it("starts a Hermes conversation from the project picker when its provider is enabled", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.selectDetail.mockClear();
  harness.openScratch.mockReset().mockResolvedValue({ _tag: "Success", value: scratch });
  harness.createDraft.mockReset().mockReturnValue("hermes-draft");
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const route = { params: undefined } as never;
  const row = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`);

  act(() => root.render(<NewTaskRouteScreen route={route} />));
  expect(row("Hermes, Moonbase · No project")).toBeNull();

  harness.hermesEnabled = true;
  try {
    act(() => root.render(<NewTaskRouteScreen route={route} />));
    await act(async () => row("Hermes, Moonbase · No project")!.click());
    expect(
      row("No project")!.compareDocumentPosition(row("Hermes, Moonbase · No project")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(harness.openScratch).toHaveBeenCalledWith(
      { environmentId, input: {} },
      { signal: expect.any(AbortSignal) },
    );
    expect(harness.createDraft).toHaveBeenCalledWith(
      { environmentId, projectId: scratch.id },
      { instanceId: "hermes-1", model: "default" },
    );
    expect(harness.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: { draft: { draftId: "hermes-draft", title: "Hermes" } },
    });
  } finally {
    harness.hermesEnabled = false;
  }
});

it("opens Hermes from the normal New chat draft only once for repeated taps", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.hermesEnabled = true;
  harness.previousDraft = true;
  const opening = Promise.withResolvers<unknown>();
  harness.openScratch.mockReset().mockReturnValue(opening.promise);
  harness.createDraft.mockReset().mockReturnValue("hermes-draft");
  harness.selectDetail.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };

  try {
    act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
    const row = container.querySelector<HTMLElement>(
      '[aria-label="Hermes, Moonbase · No project"]',
    )!;
    await act(async () => {
      row.click();
      row.click();
      await Promise.resolve();
    });
    expect(harness.openScratch).toHaveBeenCalledTimes(1);

    await act(async () => opening.resolve({ _tag: "Success", value: scratch }));
    expect(harness.createDraft).toHaveBeenCalledTimes(1);
    expect(harness.selectDetail).toHaveBeenCalledTimes(1);
  } finally {
    harness.hermesEnabled = false;
    harness.previousDraft = false;
  }
});
it("does not open a Hermes draft after leaving the picker", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.hermesEnabled = true;
  const opening = Promise.withResolvers<unknown>();
  harness.openScratch.mockReset().mockReturnValue(opening.promise);
  harness.selectDetail.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Hermes, Moonbase · No project"]')!
        .click(),
    );
    act(() => root.unmount());
    const options = harness.openScratch.mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(true);
    await act(async () => opening.resolve({ _tag: "Success", value: scratch }));
    expect(harness.selectDetail).not.toHaveBeenCalled();
  } finally {
    harness.hermesEnabled = false;
  }
});

it.each(
  (["ios", "android"] as const).flatMap((platform) => [
    { platform, state: "provider is not ready", ready: false, live: true, operate: true },
    { platform, state: "environment is offline", ready: true, live: false, operate: true },
    { platform, state: "operate permission is denied", ready: true, live: true, operate: false },
  ]),
)("$platform: disables Hermes when $state", ({ platform, ready, live, operate }) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.hermesEnabled = true;
  harness.hermesReady = ready;
  harness.hermesLive = live;
  harness.hermesOperate = operate;
  harness.platform = platform;
  harness.openScratch.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };

  try {
    act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
    const row = container.querySelector<HTMLButtonElement>(
      '[aria-label="Hermes, Moonbase · No project"]',
    )!;
    expect(row.disabled).toBe(true);
    act(() => row.click());
    expect(harness.openScratch).not.toHaveBeenCalled();
  } finally {
    harness.hermesEnabled = false;
    harness.hermesReady = true;
    harness.hermesLive = true;
    harness.hermesOperate = true;
    harness.platform = "ios";
  }
});

it("hides Hermes while an active new-task draft exists", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.hermesEnabled = true;
  harness.previousDraft = true;
  harness.selectedProjectKey = "env-1:app";
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };

  try {
    act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
    expect(container.querySelector('[aria-label="Hermes, Moonbase · No project"]')).toBeNull();
  } finally {
    harness.hermesEnabled = false;
    harness.previousDraft = false;
    harness.selectedProjectKey = null;
  }
});

it.each([
  { state: "a saved draft is being retargeted", params: { draftId: "draft-1" } },
  { state: "an incoming share needs a project", params: { incomingShareId: "share-1" } },
])("hides Hermes while $state", ({ params }) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.hermesEnabled = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };

  try {
    act(() => root.render(<NewTaskRouteScreen route={{ params } as never} />));
    expect(container.querySelector('[aria-label="Hermes, Moonbase · No project"]')).toBeNull();
  } finally {
    harness.hermesEnabled = false;
  }
});

it("keeps scratch and add-project actions when the project list is empty", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.hideProjects = true;
  harness.hermesEnabled = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };

  try {
    act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
    expect(container.querySelector('[aria-label="Start without a project"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Add new project"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Hermes, Moonbase · No project"]')).not.toBeNull();
    expect(
      container
        .querySelector('[aria-label="Start without a project"]')!
        .compareDocumentPosition(
          container.querySelector('[aria-label="Hermes, Moonbase · No project"]')!,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  } finally {
    harness.hideProjects = false;
    harness.hermesEnabled = false;
  }
});

it("reports Hermes scratch failures without opening a draft", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.hermesEnabled = true;
  harness.openScratch.mockReset().mockResolvedValue({ _tag: "Failure", cause: null });
  harness.selectDetail.mockClear();
  vi.mocked(Dialog.alert).mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };

  try {
    act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Hermes, Moonbase · No project"]')!
        .click(),
    );
    expect(Dialog.alert).toHaveBeenCalledWith("Could not open draft");
    expect(harness.selectDetail).not.toHaveBeenCalled();
  } finally {
    harness.hermesEnabled = false;
  }
});

it("stops when Hermes becomes unavailable while drafts load", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.hermesEnabled = true;
  harness.afterDraftsLoaded = () => {
    harness.hermesReady = false;
  };
  harness.openScratch.mockClear();
  harness.selectDetail.mockClear();
  vi.mocked(Dialog.alert).mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };

  try {
    act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Hermes, Moonbase · No project"]')!
        .click(),
    );
    expect(Dialog.alert).toHaveBeenCalledWith("Provider unavailable");
    expect(harness.openScratch).not.toHaveBeenCalled();
    expect(harness.selectDetail).not.toHaveBeenCalled();
  } finally {
    harness.hermesEnabled = false;
    harness.hermesReady = true;
    harness.afterDraftsLoaded = null;
  }
});

it("stops when scratch opens in a different environment", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.hermesEnabled = true;
  harness.openScratch.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { ...scratch, environmentId: EnvironmentId.make("env-2") },
  });
  harness.selectDetail.mockClear();
  vi.mocked(Dialog.alert).mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };

  try {
    act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Hermes, Moonbase · No project"]')!
        .click(),
    );
    expect(Dialog.alert).toHaveBeenCalledWith("Provider unavailable");
    expect(harness.selectDetail).not.toHaveBeenCalled();
  } finally {
    harness.hermesEnabled = false;
  }
});

it("uses the environment ID when no friendly label is available", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.hermesEnabled = true;
  harness.showEnvironmentLabel = false;
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };

  try {
    act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
    expect(container.querySelector('[aria-label="Hermes, env-1 · No project"]')).not.toBeNull();
  } finally {
    harness.hermesEnabled = false;
    harness.showEnvironmentLabel = true;
  }
});

it("distinguishes Hermes homes when environment labels match", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.hermesEnabled = true;
  harness.duplicateEnvironment = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };

  try {
    act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
    expect(
      container.querySelector('[aria-label="Hermes, Moonbase (env-1) · No project"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Hermes, Moonbase (env-2) · No project"]'),
    ).not.toBeNull();
  } finally {
    harness.hermesEnabled = false;
    harness.duplicateEnvironment = false;
  }
});
