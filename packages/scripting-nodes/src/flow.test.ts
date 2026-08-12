import { describe, expect, it } from "vitest";
import { flowNodes } from "./flow";

describe("flow nodes", () => {
  it("exports at least one node definition", () => {
    expect(flowNodes.length).toBeGreaterThan(0);
    expect(flowNodes[0]?.id).toBeTruthy();
    expect(flowNodes[0]?.category).toBeTruthy();
  });

  it("registers a custom event entry node", () => {
    const custom = flowNodes.find((node) => node.id === "flow.event.custom");
    expect(custom?.title).toBe("Event Custom");
    expect(custom?.pins({}).some((pin) => pin.kind === "exec" && pin.direction === "out")).toBe(
      true,
    );
  });
});
