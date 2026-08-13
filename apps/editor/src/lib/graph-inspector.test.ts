import { describe, expect, it, vi } from "vitest";
import { COLOR, FLOAT, STRING, VEC2, pin } from "@babylonslate/scripting";
import {
  connectedInputPinIds,
  inspectorLiteralPinDefaults,
  logNodePropertyRows,
  parameterRowsFromPinList,
  parameterTypeFromPin,
  pinDefaultPropertyRows,
  pinListFromParameterRows,
  pinTypeFromParameterType,
  pinsFromNodeData,
} from "./graph-inspector";

describe("connectedInputPinIds", () => {
  it("collects target handles on the inspected node", () => {
    expect(
      connectedInputPinIds(
        [
          { target: "add", targetHandle: "a" },
          { target: "add", targetHandle: "b" },
          { target: "other", targetHandle: "a" },
          { target: "add" },
        ],
        "add",
      ),
    ).toEqual(new Set(["a", "b"]));
  });
});

describe("pinsFromNodeData", () => {
  it("reads hydrated __pins and ignores missing metadata", () => {
    const pins = [pin("a", "a", "in", FLOAT), pin("out", "out", "out", FLOAT)];
    expect(pinsFromNodeData({ __pins: pins })).toEqual(pins);
    expect(pinsFromNodeData({})).toEqual([]);
  });
});

describe("inspectorLiteralPinDefaults", () => {
  it("hides defaults for connected applicable inputs", () => {
    const pins = [
      pin("a", "a", "in", FLOAT),
      pin("b", "b", "in", FLOAT),
      pin("out", "out", "out", FLOAT),
    ];
    const listed = inspectorLiteralPinDefaults(
      {
        id: "add",
        data: { __pins: pins, "default:b": 9 },
      },
      [{ target: "add", targetHandle: "a" }],
    );
    expect(listed).toEqual([
      { pinId: "b", name: "b", type: FLOAT, value: 9 },
    ]);
  });
});

describe("pinDefaultPropertyRows", () => {
  it("maps applicable pin defaults onto property-grid rows and writes default: keys", () => {
    const onPatch = vi.fn();
    const rows = pinDefaultPropertyRows(
      [
        { pinId: "a", name: "a", type: FLOAT, value: 2 },
        { pinId: "msg", name: "message", type: STRING, value: "hi" },
        { pinId: "uv", name: "uv", type: VEC2, value: { x: 1, y: 2 } },
        {
          pinId: "tint",
          name: "tint",
          type: COLOR,
          value: { x: 1, y: 0, z: 0, w: 0.5 },
        },
      ],
      onPatch,
    );
    expect(rows).toMatchObject([
      { kind: "number", id: "a", label: "a", value: 2 },
      { kind: "text", id: "msg", label: "message", value: "hi" },
      { kind: "vector3", id: "uv", label: "uv", value: [1, 2, 0], axes: ["X", "Y"] },
      { kind: "color", id: "tint", label: "tint", value: [1, 0, 0] },
    ]);
    const numberRow = rows[0];
    if (numberRow?.kind === "number") numberRow.onChange(4);
    expect(onPatch).toHaveBeenCalledWith({ "default:a": 4 });
    const colorRow = rows[3];
    if (colorRow?.kind === "color") colorRow.onChange([0, 1, 0]);
    expect(onPatch).toHaveBeenCalledWith({
      "default:tint": { x: 0, y: 1, z: 0, w: 0.5 },
    });
  });

  it("turns unconnected action and axis pins into mapping enums", () => {
    const onPatch = vi.fn();
    const rows = pinDefaultPropertyRows(
      [
        { pinId: "action", name: "action", type: STRING, value: "Jump" },
        { pinId: "axis", name: "axis", type: STRING, value: "Move" },
        { pinId: "msg", name: "message", type: STRING, value: "hi" },
      ],
      onPatch,
      {
        actionNames: ["Jump", "Confirm"],
        axisNames: ["Move", "Look"],
      },
    );
    expect(rows).toMatchObject([
      { kind: "enum", id: "action", label: "action", value: "Jump" },
      { kind: "enum", id: "axis", label: "axis", value: "Move" },
      { kind: "text", id: "msg", label: "message", value: "hi" },
    ]);
    const action = rows[0];
    if (action?.kind === "enum") {
      expect(action.options.map((option) => option.value)).toEqual([
        "Jump",
        "Confirm",
      ]);
      action.onChange("Confirm");
    }
    expect(onPatch).toHaveBeenCalledWith({ "default:action": "Confirm" });
  });
});

describe("logNodePropertyRows", () => {
  it("exposes Log severity and category as node properties", () => {
    const onPatch = vi.fn();
    const rows = logNodePropertyRows(
      { severity: "warning", category: "Combat" },
      onPatch,
    );
    expect(rows).toMatchObject([
      { kind: "enum", id: "severity", label: "severity", value: "warning" },
      { kind: "text", id: "category", label: "category", value: "Combat" },
    ]);
    const severity = rows[0];
    if (severity?.kind === "enum") severity.onChange("error");
    expect(onPatch).toHaveBeenCalledWith({ severity: "error" });
  });
});

describe("parameter list conversion", () => {
  it("round-trips ExecuteJavaScript pin types through ParameterRow", () => {
    const rows = parameterRowsFromPinList(
      [
        { name: "health", type: { kind: "float" } },
        { name: "label", type: { kind: "string" } },
      ],
      "in",
    );
    expect(rows).toEqual([
      { id: "in-0-health", name: "health", type: "float" },
      { id: "in-1-label", name: "label", type: "string" },
    ]);
    expect(pinListFromParameterRows(rows)).toEqual([
      { name: "health", type: FLOAT },
      { name: "label", type: STRING },
    ]);
    expect(parameterTypeFromPin("enum")).toBe("enum");
    expect(pinTypeFromParameterType("enum")).toEqual(STRING);
  });
});
