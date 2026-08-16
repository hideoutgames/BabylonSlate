import { describe, expect, it, vi } from "vitest";
import { COLOR, FLOAT, STRING, VEC2, VEC4, classRef, enumRef, objectRef, pin } from "@babylonslate/scripting";
import {
  collectEnumMemberNames,
  connectedInputPinIds,
  developmentOnlyPropertyRows,
  inspectorLiteralPinDefaults,
  logNodePropertyRows,
  parameterRowsFromPinList,
  parameterTypeFromPin,
  pinDefaultPropertyRows,
  pinListFromParameterRows,
  pinTypeFromParameterType,
  pinsFromNodeData,
  variableDefaultPropertyRows,
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

  it("lists classRef defaults and hides objectRef instance pins", () => {
    const listed = inspectorLiteralPinDefaults(
      {
        id: "spawn",
        data: {
          __pins: [
            pin("classId", "classId", "in", classRef("Actor")),
            pin("target", "target", "in", objectRef("Actor")),
          ],
          "default:classId": "Pawn",
        },
      },
      [],
    );
    expect(listed).toEqual([
      { pinId: "classId", name: "classId", type: classRef("Actor"), value: "Pawn" },
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

  it("maps vec4 to four-axis scrubs and enumRef to member options", () => {
    const onPatch = vi.fn();
    const rows = pinDefaultPropertyRows(
      [
        {
          pinId: "offset",
          name: "offset",
          type: VEC4,
          value: { x: 1, y: 2, z: 3, w: 4 },
        },
        {
          pinId: "state",
          name: "state",
          type: enumRef("enum-1"),
          value: "Idle",
        },
      ],
      onPatch,
      {
        enumMembers: { "enum-1": ["None", "Idle", "Run"] },
      },
    );
    expect(rows).toMatchObject([
      {
        kind: "vector3",
        id: "offset",
        value: [1, 2, 3, 4],
        axes: ["X", "Y", "Z", "W"],
      },
      { kind: "enum", id: "state", label: "state", value: "Idle" },
    ]);
    const vec = rows[0];
    if (vec?.kind === "vector3") {
      vec.onChange([9, 8, 7, 6]);
    }
    expect(onPatch).toHaveBeenCalledWith({
      "default:offset": { x: 9, y: 8, z: 7, w: 6 },
    });
    const state = rows[1];
    if (state?.kind === "enum") {
      expect(state.options.map((option) => option.value)).toEqual([
        "None",
        "Idle",
        "Run",
      ]);
      state.onChange("Run");
    }
    expect(onPatch).toHaveBeenCalledWith({ "default:state": "Run" });
  });

  it("keeps an authored enumRef value that is missing from the member list", () => {
    const rows = pinDefaultPropertyRows(
      [
        {
          pinId: "state",
          name: "state",
          type: enumRef("enum-1"),
          value: "Custom",
        },
      ],
      vi.fn(),
      { enumMembers: { "enum-1": ["Idle"] } },
    );
    const state = rows[0];
    expect(state?.kind).toBe("enum");
    if (state?.kind === "enum") {
      expect(state.options.map((option) => option.value)).toEqual([
        "Idle",
        "Custom",
      ]);
    }
  });

  it("maps classRef defaults to class picker rows and skips object refs", () => {
    const onPatch = vi.fn();
    const onPickClass = vi.fn();
    const rows = pinDefaultPropertyRows(
      [
        {
          pinId: "classId",
          name: "classId",
          type: classRef("Actor"),
          value: "Pawn",
        },
        {
          pinId: "target",
          name: "target",
          type: objectRef("Actor"),
          value: "Hero",
        },
      ],
      onPatch,
      {
        classEntries: [
          { id: "Actor", name: "Actor" },
          { id: "Pawn", name: "Pawn" },
        ],
        onPickClass,
      },
    );
    expect(rows).toMatchObject([
      {
        kind: "asset",
        id: "classId",
        label: "classId",
        value: "Pawn",
        displayLabel: "Pawn",
      },
    ]);
    const row = rows[0];
    if (row?.kind === "asset") row.onPick();
    expect(onPickClass).toHaveBeenCalledWith("classId", "Actor");
  });
});

describe("collectEnumMemberNames", () => {
  it("reads Enum assets and lets open documents override registry members", () => {
    expect(
      collectEnumMemberNames(
        [
          {
            content: {
              kind: "enum",
              guid: "enum-1",
              members: [{ name: "Idle" }, { name: "Run" }],
            },
          },
        ],
        [
          {
            header: {
              guid: "enum-1",
              type: "Enum",
              payload: { members: [{ name: "None" }, { name: "Idle" }] },
            },
          },
          {
            header: {
              guid: "enum-2",
              type: "Enum",
              payload: { members: [{ name: "Red" }, { name: "Blue" }] },
            },
          },
        ],
      ),
    ).toEqual({
      "enum-1": ["Idle", "Run"],
      "enum-2": ["Red", "Blue"],
    });
  });
});

describe("developmentOnlyPropertyRows", () => {
  it("shows Development Only checked for Print by default", () => {
    const onPatch = vi.fn();
    const rows = developmentOnlyPropertyRows("debug.print", {}, onPatch);
    expect(rows).toMatchObject([
      {
        kind: "boolean",
        id: "developmentOnly",
        label: "Development Only",
        value: true,
      },
    ]);
    const row = rows[0];
    if (row?.kind === "boolean") row.onChange(false);
    expect(onPatch).toHaveBeenCalledWith({ developmentOnly: false });
  });

  it("shows Development Only unchecked for Log unless flagged", () => {
    const onPatch = vi.fn();
    const rows = developmentOnlyPropertyRows("debug.log", {}, onPatch);
    expect(rows[0]).toMatchObject({ kind: "boolean", value: false });
    const flagged = developmentOnlyPropertyRows(
      "debug.log",
      { developmentOnly: true },
      onPatch,
    );
    expect(flagged[0]).toMatchObject({ kind: "boolean", value: true });
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

describe("variableDefaultPropertyRows", () => {
  it("maps bool, number, text, and vector defaults onto PropertyGrid rows", () => {
    const onChange = vi.fn();
    const boolRows = variableDefaultPropertyRows("bool", true, onChange);
    expect(boolRows).toMatchObject([
      { kind: "boolean", id: "default", label: "Default", value: true },
    ]);
    const boolRow = boolRows[0];
    if (boolRow?.kind === "boolean") boolRow.onChange(false);
    expect(onChange).toHaveBeenCalledWith(false);

    const numberRows = variableDefaultPropertyRows("float", 8, onChange);
    expect(numberRows).toMatchObject([
      { kind: "number", id: "default", label: "Default", value: 8 },
    ]);

    const textRows = variableDefaultPropertyRows("string", "hello", onChange);
    expect(textRows).toMatchObject([
      { kind: "text", id: "default", label: "Default", value: "hello" },
    ]);
    const textRow = textRows[0];
    if (textRow?.kind === "text") textRow.onChange("world");
    expect(onChange).toHaveBeenCalledWith("world");

    const vecRows = variableDefaultPropertyRows(
      "vec3",
      { x: 1, y: 2, z: 3 },
      onChange,
    );
    expect(vecRows).toMatchObject([
      {
        kind: "vector3",
        id: "default",
        label: "Default",
        value: [1, 2, 3],
        axes: ["X", "Y", "Z"],
      },
    ]);
  });
});
