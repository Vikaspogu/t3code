import { EnvironmentId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { indexScheduledTaskBindings } from "./scheduledTasks";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const threadId = ThreadId.make("shared-thread");
const task = {
  id: ScheduledTaskId.make("daily"),
  title: "Daily digest",
  threadId,
  schedule: { type: "interval" as const, everyMs: 60_000 },
};

const getBindings = () =>
  indexScheduledTaskBindings([
    [local, [task, { ...task, id: ScheduledTaskId.make("unbound"), threadId: null }]],
    [
      remote,
      [
        { ...task, id: ScheduledTaskId.make("webhook"), schedule: { type: "webhook" } },
        { ...task, id: ScheduledTaskId.make("fresh"), threadMode: "fresh_session" },
        { ...task, id: ScheduledTaskId.make("new"), threadMode: "new_thread" },
      ],
    ],
  ]);

describe("indexScheduledTaskBindings", () => {
  it("keeps equal thread IDs in different environments separate", () => {
    const bindings = getBindings();
    expect(
      bindings
        .get(local)
        ?.get(threadId)
        ?.map(({ id }) => id),
    ).toEqual(["daily"]);
    expect(
      bindings
        .get(remote)
        ?.get(threadId)
        ?.map(({ id }) => id),
    ).toEqual(["webhook", "fresh"]);
  });

  it("does not infer bindings from new-thread tasks or unbound tasks", () => {
    const bindings = indexScheduledTaskBindings([
      [
        local,
        [
          { ...task, threadId: null },
          { ...task, threadMode: "new_thread" },
        ],
      ],
    ]);
    expect(bindings.size).toBe(0);
  });
});
