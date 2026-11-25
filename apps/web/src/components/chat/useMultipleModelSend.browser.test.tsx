import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { ENVIRONMENT_ID, PROJECT_ID } from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

const start = vi.hoisted(() => vi.fn());
vi.mock("../../state/use-orchestration-command", () => ({ useOrchestrationCommand: () => start }));

import { useMultipleModelSend } from "./useMultipleModelSend";

it("keeps the draft if a secondary provider disappears during an upload", async () => {
  start.mockResolvedValue(AsyncResult.success(undefined));
  const selections = [
    { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    { instanceId: ProviderInstanceId.make("cluster-assistant"), model: "cluster-model" },
  ];
  const targets = selections.map((selection, index) => ({
    selection,
    driver: ProviderDriverKind.make(index === 0 ? "codex" : "hermes"),
    text: "Check the cluster",
  }));
  const threadId = ThreadId.make("fanout-draft");
  const routeThreadKey = "fanout-draft";
  const promptRef = { current: "Check the cluster" };
  const setThreadError = vi.fn();
  const resetLocalDispatch = vi.fn();
  const attachments = Promise.withResolvers<[]>();
  const createdAt = "2026-01-01T00:00:00.000Z";
  let hermesAvailable = true;
  const readTargetBlockReason = vi.fn(({ driver }: (typeof targets)[number]) =>
    driver === "hermes" && !hermesAvailable ? "Provider unavailable" : null,
  );
  const input: Parameters<ReturnType<typeof useMultipleModelSend>>[0] = {
    threadId,
    project: {
      id: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      title: "Workspace",
      workspaceRoot: "/workspace/render",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
    branch: "main",
    selections,
    targets,
    sendSnapshot: {
      messageText: promptRef.current,
      draftText: promptRef.current,
      attachments: [],
      images: [],
      files: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      environmentContexts: [],
      replyTo: null,
    },
    createdAt,
    attachmentsPromise: attachments.promise,
    usesAttachmentUploads: true,
    readFileBlockReason: () => null,
    readTargetBlockReason,
    buildOutgoingMessageContext: () => undefined,
    isCurrentSend: () => true,
    draftChangedDuringPreparation: () => false,
  };
  const sent = Promise.withResolvers<void>();
  function Harness() {
    const send = useMultipleModelSend({
      environmentId: ENVIRONMENT_ID,
      routeThreadKey,
      currentRouteThreadKeyRef: { current: routeThreadKey },
      draftId: null,
      composerDraftTarget: scopeThreadRef(ENVIRONMENT_ID, threadId),
      composerRef: { current: null },
      promptRef,
      runtimeMode: "full-access",
      startFromOrigin: false,
      worktreeRepositories: undefined,
      resetLocalDispatch,
      setThreadError,
    });
    return (
      <button type="button" onClick={() => void send(input).then(sent.resolve, sent.reject)}>
        Send
      </button>
    );
  }
  await using screen = await render(<Harness />);
  await screen.getByRole("button", { name: "Send" }).click();
  expect(readTargetBlockReason).not.toHaveBeenCalled();
  hermesAvailable = false;
  attachments.resolve([]);
  await sent.promise;
  expect(readTargetBlockReason.mock.calls.map(([target]) => target)).toEqual(targets);
  expect(start).not.toHaveBeenCalled();
  expect(setThreadError).toHaveBeenCalledWith(threadId, "Provider unavailable");
  expect(promptRef.current).toBe("Check the cluster");
  expect(resetLocalDispatch).toHaveBeenCalledOnce();
});
