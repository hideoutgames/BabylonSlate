import { describe, expect, it } from "vitest";
import { btNodeStatuses } from "./status";

describe("btNodeStatuses", () => {
  it("marks every node on the stack running, not only the leaf", () => {
    const statuses = btNodeStatuses({
      lastResults: { root: "running", sequence: "running", task: "running" },
      btNodeId: "task",
      stack: [{ nodeId: "root" }, { nodeId: "sequence" }, { nodeId: "task" }],
    });
    expect([...statuses]).toEqual([["root", "running"], ["sequence", "running"], ["task", "running"]]);
  });

  it("keeps a Parallel branch that yielded off the stack running", () => {
    const statuses = btNodeStatuses({
      lastResults: { sequence: "running", task: "running" },
      btNodeId: null,
      stack: [{ nodeId: "root" }],
    });
    expect(Object.fromEntries(statuses)).toEqual({ root: "running", sequence: "running", task: "running" });
  });

  it("shows a finished node's last result and lets running win over a stale one", () => {
    const statuses = btNodeStatuses({
      lastResults: { first: "success", second: "failure", third: "success" },
      btNodeId: null,
      stack: [{ nodeId: "third" }],
    });
    expect(Object.fromEntries(statuses)).toEqual({ first: "success", second: "failure", third: "running" });
  });
});
