import { describe, expect, it } from "vitest";
import { pinTypeKey } from "@babylonslate/scripting";
import { displayPinTypesForGraph } from "./wildcard-display";
import type { SerializedPin } from "./graph-types";

const floatOut: SerializedPin = {
  id: "out",
  name: "out",
  kind: "data",
  direction: "out",
  type: { kind: "float" },
};

const printValue: SerializedPin = {
  id: "value",
  name: "value",
  kind: "data",
  direction: "in",
  type: { kind: "boxedWildcard" },
};

const arrayFloatOut: SerializedPin = {
  id: "out",
  name: "out",
  kind: "data",
  direction: "out",
  type: { kind: "array", element: { kind: "float" } },
};

const arrayGetPins: SerializedPin[] = [
  {
    id: "array",
    name: "array",
    kind: "data",
    direction: "in",
    type: { kind: "array", element: { kind: "resolvingWildcard" } },
  },
  {
    id: "out",
    name: "out",
    kind: "data",
    direction: "out",
    type: { kind: "resolvingWildcard" },
  },
];

describe("displayPinTypesForGraph", () => {
  it("leaves an unconnected boxed wildcard as boxedWildcard", () => {
    const display = displayPinTypesForGraph(
      [
        {
          id: "print",
          data: { __pins: [printValue] },
        },
      ],
      [],
    );
    expect(display.get(pinTypeKey("print", "value"))).toEqual({
      kind: "boxedWildcard",
    });
  });

  it("displays a boxed wildcard as the connected peer type", () => {
    const display = displayPinTypesForGraph(
      [
        { id: "src", data: { __pins: [floatOut] } },
        { id: "print", data: { __pins: [printValue] } },
      ],
      [
        {
          source: "src",
          target: "print",
          sourceHandle: "out",
          targetHandle: "value",
        },
      ],
    );
    expect(display.get(pinTypeKey("print", "value"))).toEqual({
      kind: "float",
    });
  });

  it("displays Array Get out as the array element type", () => {
    const display = displayPinTypesForGraph(
      [
        { id: "src", data: { __pins: [arrayFloatOut] } },
        { id: "get", data: { __pins: arrayGetPins } },
      ],
      [
        {
          source: "src",
          target: "get",
          sourceHandle: "out",
          targetHandle: "array",
        },
      ],
    );
    expect(display.get(pinTypeKey("get", "out"))).toEqual({ kind: "float" });
    expect(display.get(pinTypeKey("get", "array"))).toEqual({
      kind: "array",
      element: { kind: "float" },
    });
  });

  it("displays For Each Element as the wired array element type", () => {
    const display = displayPinTypesForGraph(
      [
        { id: "get", data: { __pins: [arrayFloatOut] } },
        {
          id: "foreach",
          data: {
            __pins: [
              {
                id: "array",
                name: "array",
                kind: "data",
                direction: "in",
                type: { kind: "array", element: { kind: "resolvingWildcard" } },
              },
              {
                id: "element",
                name: "element",
                kind: "data",
                direction: "out",
                type: { kind: "resolvingWildcard" },
              },
            ],
          },
        },
      ],
      [
        {
          source: "get",
          target: "foreach",
          sourceHandle: "out",
          targetHandle: "array",
        },
      ],
    );
    expect(display.get(pinTypeKey("foreach", "element"))).toEqual({
      kind: "float",
    });
  });

  it("does not mutate declared pin types on the input nodes", () => {
    const nodes = [
      { id: "src", data: { __pins: [floatOut] } },
      { id: "print", data: { __pins: [printValue] } },
    ];
    displayPinTypesForGraph(nodes, [
      {
        source: "src",
        target: "print",
        sourceHandle: "out",
        targetHandle: "value",
      },
    ]);
    expect(nodes[1]?.data.__pins[0]?.type).toEqual({ kind: "boxedWildcard" });
  });
});
