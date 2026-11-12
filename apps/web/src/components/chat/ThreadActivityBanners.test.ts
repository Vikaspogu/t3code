import {
  PlanId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2PlanStep,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { taskListBannerItem } from "./ThreadActivityBanners";

const now = DateTime.makeUnsafe("2026-09-04T00:00:00.000Z");

function todoList(id: string, ordinal: number, steps: ReadonlyArray<OrchestrationV2PlanStep>) {
  return {
    id: TurnItemId.make(id),
    threadId: ThreadId.make("thread-tasks"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "todo_list" as const,
    planId: PlanId.make(`plan-${id}`),
    steps,
  } satisfies OrchestrationV2TurnItem;
}

const older = todoList("item-older", 2, [{ id: "a", text: "Old step", status: "running" }]);
const newer = todoList("item-newer", 5, [
  { id: "1", text: "Read code", status: "completed" },
  { id: "2", text: "Write fix", status: "running" },
  { id: "3", text: "Run tests", status: "pending" },
]);

it("shows the newest todo list until every step is done or it is dismissed", () => {
  const dismissed: Array<string> = [];
  const banner = taskListBannerItem({
    turnItems: [newer, older],
    dismissedKey: null,
    onDismiss: (key) => dismissed.push(key),
  });
  expect(banner?.title).toBe("Tasks 1/3");
  expect(banner?.description).toBe("Write fix");

  banner?.onDismiss?.();
  const dismissedKey = dismissed[0] ?? null;
  expect(
    taskListBannerItem({ turnItems: [older, newer], dismissedKey, onDismiss: () => {} }),
  ).toBeNull();

  const progressed = {
    ...newer,
    steps: newer.steps.map((step) =>
      step.id === "2" ? { ...step, status: "completed" as const } : step,
    ),
  };
  expect(
    taskListBannerItem({ turnItems: [older, progressed], dismissedKey, onDismiss: () => {} })
      ?.title,
  ).toBe("Tasks 2/3");

  const finished = {
    ...newer,
    steps: newer.steps.map((step) => ({ ...step, status: "completed" as const })),
  };
  expect(
    taskListBannerItem({ turnItems: [older, finished], dismissedKey: null, onDismiss: () => {} }),
  ).toBeNull();
});
