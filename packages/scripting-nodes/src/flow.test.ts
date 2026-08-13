import { describe, expect, it } from "vitest";
import { flowNodes } from "./flow";

describe("flow nodes", () => {
  it("exports at least one node definition", () => {
    expect(flowNodes.length).toBeGreaterThan(0);
    expect(flowNodes[0]?.id).toBeTruthy();
    expect(flowNodes[0]?.category).toBeTruthy();
  });

  it("registers On Command Run pins from the parameter list", () => {
    const command = flowNodes.find((node) => node.id === "flow.event.commandRun");
    expect(command?.title).toBe("Event On Command Run");
    const pins = command?.pins({
      parameters: [{ name: "amount", type: "float" }],
    });
    expect(pins?.some((pin) => pin.id === "amount" && pin.direction === "out")).toBe(
      true,
    );
  });
});
