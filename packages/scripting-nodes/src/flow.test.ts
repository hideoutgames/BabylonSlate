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

  it("maps function Input pins from member inputs as outputs", () => {
    const input = flowNodes.find((node) => node.id === "flow.function.input");
    expect(input?.title).toBe("Input");
    const pins = input?.pins({
      pins: [
        { name: "exec", typeId: "exec", direction: "in" },
        { name: "amount", typeId: "float", direction: "in" },
        { name: "then", typeId: "exec", direction: "out" },
      ],
    });
    expect(pins?.map((pin) => ({ id: pin.id, direction: pin.direction }))).toEqual(
      [
        { id: "exec", direction: "out" },
        { id: "amount", direction: "out" },
      ],
    );
  });

  it("maps function Output pins from member outputs as inputs", () => {
    const output = flowNodes.find((node) => node.id === "flow.function.output");
    expect(output?.title).toBe("Output");
    const pins = output?.pins({
      pins: [
        { name: "exec", typeId: "exec", direction: "in" },
        { name: "then", typeId: "exec", direction: "out" },
        { name: "result", typeId: "float", direction: "out" },
      ],
    });
    expect(pins?.map((pin) => ({ id: pin.id, direction: pin.direction }))).toEqual(
      [
        { id: "then", direction: "in" },
        { id: "result", direction: "in" },
      ],
    );
  });
});
