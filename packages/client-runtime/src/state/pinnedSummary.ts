export type PinnedSummaryStatus = "attention" | "failed" | "done" | "working" | "idle";

export function summarizeStatuses(statuses: Iterable<PinnedSummaryStatus>) {
  const summary = { attention: 0, failed: 0, done: 0, working: 0 };
  for (const status of statuses) {
    if (status !== "idle") summary[status] += 1;
  }
  return summary;
}
