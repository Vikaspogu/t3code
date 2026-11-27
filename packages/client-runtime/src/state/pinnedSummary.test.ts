import { describe, expect, it } from "vite-plus/test";
import { summarizeStatuses } from "./pinnedSummary.ts";

describe("summarizeStatuses", () => {
  it("counts every visible category and ignores idle", () => {
    expect(
      summarizeStatuses([
        "attention",
        "failed",
        "failed",
        "done",
        "working",
        "working",
        "working",
        "idle",
      ]),
    ).toEqual({ attention: 1, failed: 2, done: 1, working: 3 });
  });

  it("returns zero counts for idle-only and empty input", () => {
    const empty = { attention: 0, failed: 0, done: 0, working: 0 };
    expect(summarizeStatuses(["idle"])).toEqual(empty);
    expect(summarizeStatuses([])).toEqual(empty);
  });
});
