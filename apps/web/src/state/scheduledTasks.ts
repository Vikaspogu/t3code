import {
  scheduledTaskThreadMode,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import { environmentAtomList } from "./environmentAtomList";
import { serverEnvironment } from "./server";

export const scheduledTasksListAtom = environmentAtomList(
  "web-scheduled-tasks-list",
  (environmentId) => serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
);

type ScheduledBinding = Pick<ScheduledTask, "id" | "title" | "threadId" | "threadMode"> & {
  readonly schedule: Pick<ScheduledTask["schedule"], "type">;
};

export function indexScheduledTaskBindings(
  environments: ReadonlyArray<readonly [EnvironmentId, readonly ScheduledBinding[]]>,
) {
  const index = new Map<EnvironmentId, Map<ThreadId, ScheduledBinding[]>>();
  for (const [environmentId, tasks] of environments) {
    const byThread = new Map<ThreadId, ScheduledBinding[]>();
    for (const task of tasks) {
      if (task.threadId === null || scheduledTaskThreadMode(task) === "new_thread") continue;
      const bindings = byThread.get(task.threadId);
      if (bindings) bindings.push(task);
      else byThread.set(task.threadId, [task]);
    }
    if (byThread.size > 0) index.set(environmentId, byThread);
  }
  return index;
}
