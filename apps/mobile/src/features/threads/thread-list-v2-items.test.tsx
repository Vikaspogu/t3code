import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.hoisted(() => {
  vi.stubGlobal("__DEV__", false);
});

vi.mock("expo", () => ({ requireNativeModule: () => ({}) }));
vi.mock("expo-crypto", () => ({ digestStringAsync: vi.fn() }));
vi.mock("expo-constants", () => ({ default: { expoConfig: {} } }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: (props: {
    readonly children?: ReactNode;
    readonly accessibilityLabel?: string;
    readonly className?: string;
    readonly accessibilityHint?: string;
    readonly disabled?: boolean;
    readonly onPress?: () => void;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      className={props.className}
      aria-description={props.accessibilityHint}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
  ScrollView: (props: { readonly children?: ReactNode; readonly horizontal?: boolean }) => (
    <div data-horizontal={String(props.horizontal)}>{props.children}</div>
  ),
  Text: (props: {
    readonly children?: ReactNode;
    readonly className?: string;
    readonly style?: ComponentProps<"span">["style"];
  }) => (
    <span data-text="react-native" className={props.className} style={props.style}>
      {props.children}
    </span>
  ),
  useWindowDimensions: () => ({ width: 390, fontScale: 1 }),
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: {
    readonly children?: ReactNode;
    readonly className?: string;
    readonly style?: ComponentProps<"span">["style"];
  }) => (
    <span data-text="app-text" className={props.className} style={props.style}>
      {props.children}
    </span>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("./CustomSnoozeSheet", () => ({ CustomSnoozeSheet: () => null }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: { readonly children?: ReactNode }) => props.children,
}));
vi.mock("../home/thread-swipe-actions", () => ({ ThreadSwipeable: () => null }));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/ProviderIcon", () => ({
  ProviderIcon: () => null,
  ProviderInstanceIcon: () => null,
  providerInstanceNameLabel: () => null,
}));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../../lib/copyThreadReference", () => ({ copyThreadReference: vi.fn() }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/thread-order", () => ({ threadArrangementOpenAtom: {} }));
vi.mock("../../state/threads", () => ({ threadEnvironment: vi.fn() }));
vi.mock("../../state/pending-new-tasks-model", () => ({
  pendingDraftBranchNeedsRefs: vi.fn(),
  resolvePendingDraftBranch: vi.fn(),
}));
vi.mock("../../state/queries", () => ({ useBranches: () => [] }));
vi.mock("./use-new-task-project-defaults", () => ({ useNewTaskProjectDefaults: () => ({}) }));
vi.mock("./turnThreadIntoProject", () => ({
  canTurnThreadIntoProject: () => false,
  turnThreadIntoProject: vi.fn(),
}));
vi.mock("../home/threadArchive", () => ({ threadCanArchive: () => false }));
vi.mock("../../lib/runtime", () => ({ runtime: {} }));
vi.mock("./use-visible-second-clock", () => ({ useVisibleSecondClock: () => 0 }));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: {},
  serverEnvironment: { createGuestShare: { permissionAtom: () => ({}) } },
}));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    readonly children?: ReactNode;
    readonly accessibilityLabel?: string;
    readonly accessibilityHint?: string;
    readonly onPress?: () => void;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-description={props.accessibilityHint}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("./thread-list-v2-row-appearance", () => ({
  THREAD_LIST_V2_MONO_FONT: "monospace",
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME: "row-content",
  THREAD_LIST_V2_ROW_DIVIDERS: false,
  selectedThreadRowColors: {
    foregroundClassName: "selected-foreground",
    mutedForegroundClassName: "selected-muted",
    iconTintClassName: "selected-icon",
    mutedIconTintClassName: "selected-muted-icon",
  },
  getThreadListV2NewBranchMenuTitle: () => "New branch",
  getThreadListV2RowAppearance: () => ({}),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => false }));
vi.mock("../settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 14, lineHeight: 20 }),
}));
vi.mock("./useCanShareWithGuest", () => ({ useCanShareWithGuest: () => false }));
vi.mock("../../state/use-thread-pr", () => ({ useThreadPr: () => null }));
vi.mock("../home/swipe-row-activation", () => ({ useSwipeRowDormant: () => false }));
vi.mock("../../lib/clock", () => ({ useNowAfter: () => Date.parse("2026-06-02T00:00:00.000Z") }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => null }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));

import { ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";

import { makeThreadShellFixture } from "../../test-fixtures";
import { ThreadListV2PinnedShelfHeader, ThreadListV2Row } from "./thread-list-v2-items";

function mount(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    render: (next: ReactNode) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

it("renders the enabled pinned header with accessible counts and horizontal summary scrolling", () => {
  const onToggle = vi.fn();
  const screen = mount(
    <ThreadListV2PinnedShelfHeader
      count={5}
      pane="sidebar"
      expanded={false}
      hiddenCount={3}
      onToggle={onToggle}
      summary={{ attention: 1, failed: 1, done: 1, working: 1 }}
    />,
  );
  try {
    const button = screen.container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe(
      "5 pinned threads, 1 needs you, 1 failed, 1 new, 1 working, 3 of 5 hidden",
    );
    expect(button.textContent).toContain("Pinned 5");
    const label = Array.from(screen.container.querySelectorAll("span")).find(
      (span) => span.textContent === "Pinned 5",
    );
    expect(label?.getAttribute("data-text")).toBe("react-native");
    expect(label?.className).not.toContain("font-t3");
    expect(label?.className).not.toContain("font-sans");
    expect(label?.style.fontWeight).toBe("600");
    expect(label?.style.fontFamily).toBeFalsy();
    expect(label?.className).toContain("text-drawer-foreground-muted");
    expect(button.className).toContain("px-3");
    const summary = screen.container.querySelector("[data-horizontal='true'] span") as HTMLElement;
    expect(summary.style.fontSize).toBe("11px");
    expect(screen.container.querySelector("[data-horizontal='true']")?.textContent).toContain(
      "1 needs you · 1 failed · 1 new · 1 working3 of 5 hidden",
    );
    act(() => button.click());
    expect(onToggle).toHaveBeenCalledOnce();
    screen.render(
      <ThreadListV2PinnedShelfHeader
        count={5}
        expanded
        hiddenCount={0}
        onToggle={onToggle}
        summary={{ attention: 0, failed: 0, done: 0, working: 0 }}
      />,
    );
    const expandedLabel = Array.from(screen.container.querySelectorAll("span")).find(
      (span) => span.textContent === "Pinned",
    );
    expect(expandedLabel?.getAttribute("data-text")).toBe("app-text");
    expect(expandedLabel?.className).toContain("font-t3-medium");
  } finally {
    screen.unmount();
  }
});

it("keeps Failed visible on a visited selected preview and opens it on tap", () => {
  const thread = makeThreadShellFixture({
    id: ThreadId.make("failed"),
    title: "Visited failure",
    lastVisitedAt: "2026-06-02T00:00:00.000Z",
    latestRun: {
      runId: RunId.make("failed-run"),
      status: "failed",
      requestedAt: "2026-06-01T23:59:00.000Z",
      startedAt: "2026-06-01T23:59:00.000Z",
      completedAt: "2026-06-01T23:59:30.000Z",
      assistantMessageId: null,
    },
    runtime: {
      status: "failed",
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: "Run failed",
      updatedAt: "2026-06-02T00:00:00.000Z",
    },
  });
  const onSelectThread = vi.fn();
  const props: ComponentProps<typeof ThreadListV2Row> = {
    thread,
    variant: "card",
    pinned: true,
    selected: true,
    wokeAt: null,
    timeLabel: "Just now",
    snoozePresetMinute: "2026-06-02T00:00:00.000Z",
    project: null,
    providers: undefined,
    providerInstance: null,
    environmentLabel: null,
    onSelectThread,
    onOpenThreadPullRequests: vi.fn(),
    onDeleteThread: vi.fn(),
    onNewThreadOnBranch: vi.fn(),
    onRenameThread: vi.fn(),
    onRegenerateThreadTitle: vi.fn(),
    onSettleThread: vi.fn().mockResolvedValue(true),
    onSnoozeThread: vi.fn(),
    onUnsnoozeThread: vi.fn(),
    onUnsettleThread: vi.fn(),
    onArchiveThread: vi.fn(),
    onPinThread: vi.fn(),
    onUnpinThread: vi.fn(),
    onSetThreadAutoSettle: vi.fn(),
    settlementSupported: false,
    snoozeSupported: false,
    snoozePresets: undefined,
    pinningSupported: true,
    autoSettleOptOutSupported: false,
    titleRegenerationSupported: false,
    onSwipeableWillOpen: vi.fn(),
    onSwipeableClose: vi.fn(),
  };
  const screen = mount(<ThreadListV2Row {...props} preserveFailedStatus />);
  try {
    const button = screen.container.querySelector("button")!;
    expect(button.textContent).toContain("Failed");
    expect(button.getAttribute("aria-label")).toContain("Failed");
    act(() => button.click());
    expect(onSelectThread).toHaveBeenCalledWith(thread);

    screen.render(<ThreadListV2Row {...props} preserveFailedStatus={false} />);
    expect(screen.container.querySelector("button")?.textContent).not.toContain("Failed");
  } finally {
    screen.unmount();
  }
});
