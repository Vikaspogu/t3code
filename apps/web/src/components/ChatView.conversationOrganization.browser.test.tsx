import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadLaunchInput,
  ProviderThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  answerRpc,
  dispatchedCommands,
  threadWithHistory,
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  PROJECT_ID,
  threadWithQuestion,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("launches a scoped Hermes draft on its selected instance instead of the machine default", async () => {
  const instanceId = ProviderInstanceId.make("cluster-assistant");
  const pausedInstanceId = ProviderInstanceId.make("paused-cluster-assistant");
  const driver = ProviderDriverKind.make("hermes");
  const modelSelection = { instanceId, model: "cluster-model" };
  const pausedThread = {
    ...threadWithQuestion("paused-cluster", "Should the cluster check continue?"),
    modelSelection: { ...modelSelection, instanceId: pausedInstanceId },
  };
  const models = [
    { slug: modelSelection.model, name: "Cluster Model", isCustom: false, capabilities: null },
  ];
  using _environment = installFakeEnvironment([pausedThread], {
    providers: [
      CODEX_PROVIDER,
      { ...CODEX_PROVIDER, instanceId: pausedInstanceId, driver, models },
      { ...CODEX_PROVIDER, instanceId, driver, models },
    ],
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      providerInstances: {
        [instanceId]: { driver, enabled: true },
        [pausedInstanceId]: { driver, enabled: false },
      },
    },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    sidebarPinnedStatusEnabled: true,
  });
  const draftId = DraftId.make("draft-cluster-assistant");
  const threadId = ThreadId.make("thread-cluster-assistant");
  const drafts = useComposerDraftStore.getState();
  drafts.setLogicalProjectDraftThreadId(
    PROJECT_ID,
    scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
    draftId,
    { threadId, providerScope: { environmentId: ENVIRONMENT_ID, providerInstanceId: instanceId } },
  );
  drafts.setModelSelection(draftId, modelSelection, { explicit: true });
  const launches: OrchestrationV2ThreadLaunchInput[] = [];
  using _launch = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.launchThread,
    (input: OrchestrationV2ThreadLaunchInput) => {
      launches.push(input);
      return Effect.interrupt;
    },
  );
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });

  await expect
    .element(page.getByRole("button", { name: "Cluster Model", exact: true }))
    .toBeVisible();
  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Check the cluster{Enter}");
  await vi.waitFor(() =>
    expect(launches[0]).toEqual(
      expect.objectContaining({
        threadId,
        projectId: PROJECT_ID,
        modelSelection,
        initialMessage: expect.objectContaining({ text: "Check the cluster" }),
      }),
    ),
  );

  drafts.setModelSelection(
    scopeThreadRef(ENVIRONMENT_ID, pausedThread.id),
    { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    { explicit: true },
  );
  await router.navigate({ href: `/${ENVIRONMENT_ID}/${pausedThread.id}` });
  await expect.element(page.getByText("Should the cluster check continue?")).toBeVisible();
  await expect.element(page.getByRole("button", { name: /Continue/ })).toBeDisabled();
});

it("requires an explicit switch to send a stopped Hermes thread after its provider was removed", async () => {
  const driver = ProviderDriverKind.make("hermes");
  const instanceId = ProviderInstanceId.make("removed-cluster-assistant");
  const thread = threadWithHistory("removed-hermes", 1, { instanceId, model: "cluster-model" });
  const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const providerThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("removed-hermes-native"),
    driver,
    providerInstanceId: instanceId,
    providerSessionId: null,
    appThreadId: thread.id,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt: at,
    updatedAt: at,
  };
  using _environment = installFakeEnvironment([{ ...thread, providerThreads: [providerThread] }], {
    acceptCommands: true,
    providers: [CODEX_PROVIDER],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    sidebarPinnedStatusEnabled: true,
  });
  const ref = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });

  const unavailable = page.getByRole("button", {
    name: "This provider is unavailable. Choose another provider.",
  });
  await expect.element(unavailable).toBeDisabled();
  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("Keep going{Enter}");
  const messages = () =>
    dispatchedCommands().filter((command) => command.type === "message.dispatch");
  expect(messages()).toEqual([]);

  useComposerDraftStore
    .getState()
    .setModelSelection(
      ref,
      { instanceId: ProviderInstanceId.make(CODEX_PROVIDER.instanceId), model: "gpt-5.4" },
      { explicit: true },
    );
  await expect.element(unavailable).not.toBeInTheDocument();
  const submit = page.getByRole("button", { name: "Submit message" });
  await expect.element(submit).toBeEnabled();
  await userEvent.click(submit);
  await vi.waitFor(() =>
    expect(messages()).toEqual([
      expect.objectContaining({
        text: "Keep going",
        modelSelection: { instanceId: CODEX_PROVIDER.instanceId, model: "gpt-5.4" },
      }),
    ]),
  );
});
