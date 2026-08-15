import { describe, expect, it } from "vitest";
import { BOOL, EXEC, FLOAT, objectRef } from "@babylonslate/scripting";
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

  it("registers editor utility lifecycle events", () => {
    const ids = flowNodes.map((node) => node.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "flow.event.editorStartup",
        "flow.event.sceneOpen",
        "flow.event.sceneSaved",
        "flow.event.editorShutdown",
      ]),
    );
    expect(
      flowNodes.find((node) => node.id === "flow.event.editorStartup")?.title,
    ).toBe("Event On Editor Startup");
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

  it("maps custom event data pins as outputs beside Then", () => {
    const custom = flowNodes.find((node) => node.id === "flow.event.custom");
    const pins = custom?.pins({
      name: "On Hit",
      pins: [
        { name: "amount", typeId: "float", direction: "out" },
        { name: "stunned", typeId: "bool", direction: "out" },
        { name: "then", typeId: "exec", direction: "out" },
      ],
    });
    expect(
      pins?.map((pin) => ({
        id: pin.id,
        direction: pin.direction,
        type: pin.type,
      })),
    ).toEqual([
      { id: "execOut", direction: "out", type: EXEC },
      { id: "amount", direction: "out", type: FLOAT },
      { id: "stunned", direction: "out", type: BOOL },
    ]);
  });

  it("omits Target on same-class Call Custom Event and keeps it for other classes", () => {
    const call = flowNodes.find((node) => node.id === "flow.event.call");
    expect(call?.title).toBe("Call Custom Event");
    const selfPins = call?.pins({
      name: "On Hit",
      classId: "Hero",
      implicitSelf: true,
      pins: [
        { name: "amount", typeId: "float", direction: "out" },
        { name: "then", typeId: "exec", direction: "out" },
      ],
    });
    expect(
      selfPins?.map((pin) => ({
        id: pin.id,
        direction: pin.direction,
        type: pin.type,
      })),
    ).toEqual([
      { id: "execIn", direction: "in", type: EXEC },
      { id: "execOut", direction: "out", type: EXEC },
      { id: "amount", direction: "in", type: FLOAT },
    ]);
    const otherPins = call?.pins({
      name: "On Alert",
      classId: "Guard",
      implicitSelf: false,
      pins: [{ name: "amount", typeId: "float", direction: "out" }],
    });
    expect(otherPins?.some((pin) => pin.id === "target")).toBe(true);
    expect(otherPins?.find((pin) => pin.id === "target")?.type).toEqual(
      objectRef("Guard"),
    );
  });
});
