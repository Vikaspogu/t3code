import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { CODEX_PROVIDER } from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const mocks = vi.hoisted(() => ({
  respond: vi.fn(),
  approvalsAtom: vi.fn(),
  detailAtom: vi.fn(),
  settingsAtom: vi.fn(),
  providersAtom: vi.fn(),
  statusAtom: vi.fn(),
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.respond }));
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    childThreadApprovalsAtom: mocks.approvalsAtom,
    environmentThreadDetails: { ...actual.environmentThreadDetails, stateAtom: mocks.detailAtom },
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: mocks.settingsAtom,
      providersValueAtom: mocks.providersAtom,
    },
  };
});
vi.mock(import("../../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: { ...actual.environmentShell, statusAtom: mocks.statusAtom },
    useEnvironmentShellStatus: () => "live",
  };
});

import { ChildThreadApprovals } from "./ChildThreadApprovals";

function setup() {
  mocks.respond.mockReset();
  mocks.respond
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Child environment offline"))))
    .mockResolvedValueOnce(AsyncResult.success(undefined));
  const thread = {
    environmentId: EnvironmentId.make("child-env"),
    threadId: ThreadId.make("child"),
  };
  const requestId = RuntimeRequestId.make("approval");
  const providerInstanceId = ProviderInstanceId.make("cluster-assistant");
  const driver = ProviderDriverKind.make("hermes");
  const providers = Atom.make([{ ...CODEX_PROVIDER, instanceId: providerInstanceId, driver }]);
  const detail = Atom.make({
    data: Option.some({
      thread: { providerInstanceId, projectId: "test-project", worktreePath: null },
      providerSessions: [{ id: "request-session", providerInstanceId, driver }],
      providerThreads: [],
      runtimeRequests: [
        {
          id: requestId,
          responseCapability: { type: "live", providerSessionId: "request-session" },
        },
      ],
    }),
  });
  mocks.detailAtom.mockReturnValue(detail);
  mocks.settingsAtom.mockReturnValue(
    Atom.make({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [providerInstanceId]: { driver, enabled: true } },
    }),
  );
  mocks.providersAtom.mockReturnValue(providers);
  mocks.statusAtom.mockReturnValue(Atom.make("live"));
  mocks.approvalsAtom.mockReturnValue(
    Atom.make<ReadonlyArray<ChildThreadApproval>>([
      {
        thread,
        title: "Compile task",
        approval: {
          requestId,
          requestKind: "command",
          detail: "Run compiler",
          createdAt: "2026-11-01T00:00:00.000Z",
          responseCapability: "live",
        },
      },
    ]),
  );
  return { thread, providers, detail };
}

it("shows a failed decision and clears the error when the user retries", async () => {
  const { thread } = setup();
  await using screen = await render(<ChildThreadApprovals threadRef={thread} />);
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Child environment offline");
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});

it.each(["provider", "thread details"])(
  "blocks an inline Hermes approval when %s vanish",
  async (lost) => {
    using settings = new DisposableStack();
    settings.defer(() => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS));
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, sidebarPinnedStatusEnabled: true });
    const { thread, providers, detail } = setup();
    await using screen = await render(
      <AppAtomRegistryProvider>
        <ChildThreadApprovals threadRef={thread} />
      </AppAtomRegistryProvider>,
    );
    const approve = screen.getByRole("button", { name: "Approve", exact: true });
    await expect.element(approve).toBeEnabled();
    const button = approve.element();
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing approval button");
    await act(() => {
      if (lost === "provider") appAtomRegistry.set(providers, []);
      else appAtomRegistry.set(detail, { data: Option.none() });
      expect(button.disabled).toBe(false);
      button.click();
    });
    expect(mocks.respond).not.toHaveBeenCalled();
    await expect.element(approve).toBeDisabled();
  },
);
