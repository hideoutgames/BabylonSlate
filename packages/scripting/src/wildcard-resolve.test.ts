import { describe, expect, it } from "vitest";
import {
  pinTypeKey,
  resolveWildcardPinTypes,
  type WildcardGraph,
} from "./wildcard-resolve";
import {
  BOXED_WILDCARD,
  FLOAT,
  INT,
  RESOLVING_WILDCARD,
  STRING,
  arrayOf,
  mapOf,
  pinTypeEquals,
  type PinType,
} from "./types";

const T = RESOLVING_WILDCARD;
const K: PinType = { kind: "resolvingWildcard", group: "K" };
const V: PinType = { kind: "resolvingWildcard", group: "V" };

function typeAt(
  map: Map<string, PinType>,
  nodeId: string,
  pinId: string,
): PinType {
  const type = map.get(pinTypeKey(nodeId, pinId));
  expect(type, `${nodeId}.${pinId}`).toBeDefined();
  return type!;
}

function arrayGetGraph(edges: WildcardGraph["edges"]): WildcardGraph {
  return {
    nodes: [
      {
        id: "src",
        pins: [{ id: "out", type: arrayOf(FLOAT) }],
      },
      {
        id: "get",
        pins: [
          { id: "array", type: arrayOf(T) },
          { id: "index", type: INT },
          { id: "out", type: T },
        ],
      },
    ],
    edges,
  };
}

function appendGraph(edges: WildcardGraph["edges"]): WildcardGraph {
  return {
    nodes: [
      { id: "itemSrc", pins: [{ id: "out", type: FLOAT }] },
      { id: "arraySrc", pins: [{ id: "out", type: arrayOf(STRING) }] },
      {
        id: "append",
        pins: [
          { id: "array", type: arrayOf(T) },
          { id: "item", type: T },
          { id: "out", type: arrayOf(T) },
        ],
      },
    ],
    edges,
  };
}

describe("resolveWildcardPinTypes", () => {
  it("leaves unconnected resolving pins as resolvingWildcard", () => {
    const result = resolveWildcardPinTypes(arrayGetGraph([]));
    expect(typeAt(result.resolved, "get", "array")).toEqual(arrayOf(T));
    expect(typeAt(result.resolved, "get", "out")).toEqual(T);
    expect(typeAt(result.display, "get", "out")).toEqual(T);
    expect(result.conflicts).toEqual([]);
  });

  it("binds T from array<float> on Array Get and recolors out as float", () => {
    const result = resolveWildcardPinTypes(
      arrayGetGraph([
        {
          sourceNodeId: "src",
          sourcePinId: "out",
          targetNodeId: "get",
          targetPinId: "array",
        },
      ]),
    );
    expect(typeAt(result.resolved, "get", "array")).toEqual(arrayOf(FLOAT));
    expect(typeAt(result.resolved, "get", "out")).toEqual(FLOAT);
    expect(typeAt(result.display, "get", "array")).toEqual(arrayOf(FLOAT));
    expect(typeAt(result.display, "get", "out")).toEqual(FLOAT);
    expect(result.conflicts).toEqual([]);
  });

  it("binds T from a concrete item on Append so array pins become array<T>", () => {
    const result = resolveWildcardPinTypes(
      appendGraph([
        {
          sourceNodeId: "itemSrc",
          sourcePinId: "out",
          targetNodeId: "append",
          targetPinId: "item",
        },
      ]),
    );
    expect(typeAt(result.resolved, "append", "item")).toEqual(FLOAT);
    expect(typeAt(result.resolved, "append", "array")).toEqual(arrayOf(FLOAT));
    expect(typeAt(result.resolved, "append", "out")).toEqual(arrayOf(FLOAT));
    expect(result.conflicts).toEqual([]);
  });

  it("restores unbound T when the connecting edge is gone", () => {
    const connected = resolveWildcardPinTypes(
      arrayGetGraph([
        {
          sourceNodeId: "src",
          sourcePinId: "out",
          targetNodeId: "get",
          targetPinId: "array",
        },
      ]),
    );
    expect(typeAt(connected.resolved, "get", "out")).toEqual(FLOAT);

    const disconnected = resolveWildcardPinTypes(arrayGetGraph([]));
    expect(typeAt(disconnected.resolved, "get", "out")).toEqual(T);
    expect(typeAt(disconnected.display, "get", "out")).toEqual(T);
  });

  it("does not bind T when two incompatible concretes share a group", () => {
    const result = resolveWildcardPinTypes(
      appendGraph([
        {
          sourceNodeId: "itemSrc",
          sourcePinId: "out",
          targetNodeId: "append",
          targetPinId: "item",
        },
        {
          sourceNodeId: "arraySrc",
          sourcePinId: "out",
          targetNodeId: "append",
          targetPinId: "array",
        },
      ]),
    );
    expect(typeAt(result.resolved, "append", "item")).toEqual(T);
    expect(typeAt(result.resolved, "append", "array")).toEqual(arrayOf(T));
    expect(typeAt(result.resolved, "append", "out")).toEqual(arrayOf(T));
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0]?.nodeId).toBe("append");
  });

  it("propagates T from Array Get out into Append item", () => {
    const result = resolveWildcardPinTypes({
      nodes: [
        { id: "src", pins: [{ id: "out", type: arrayOf(FLOAT) }] },
        {
          id: "get",
          pins: [
            { id: "array", type: arrayOf(T) },
            { id: "out", type: T },
          ],
        },
        {
          id: "append",
          pins: [
            { id: "array", type: arrayOf(T) },
            { id: "item", type: T },
            { id: "out", type: arrayOf(T) },
          ],
        },
      ],
      edges: [
        {
          sourceNodeId: "src",
          sourcePinId: "out",
          targetNodeId: "get",
          targetPinId: "array",
        },
        {
          sourceNodeId: "get",
          sourcePinId: "out",
          targetNodeId: "append",
          targetPinId: "item",
        },
      ],
    });
    expect(typeAt(result.resolved, "get", "out")).toEqual(FLOAT);
    expect(typeAt(result.resolved, "append", "item")).toEqual(FLOAT);
    expect(typeAt(result.resolved, "append", "out")).toEqual(arrayOf(FLOAT));
    expect(result.conflicts).toEqual([]);
  });

  it("keeps boxedWildcard resolved type but displays the connected peer type", () => {
    const result = resolveWildcardPinTypes({
      nodes: [
        { id: "src", pins: [{ id: "out", type: FLOAT }] },
        { id: "print", pins: [{ id: "value", type: BOXED_WILDCARD }] },
      ],
      edges: [
        {
          sourceNodeId: "src",
          sourcePinId: "out",
          targetNodeId: "print",
          targetPinId: "value",
        },
      ],
    });
    expect(typeAt(result.resolved, "print", "value")).toEqual(BOXED_WILDCARD);
    expect(typeAt(result.display, "print", "value")).toEqual(FLOAT);
    expect(result.conflicts).toEqual([]);
  });

  it("allows int into an already-bound float group without conflict", () => {
    const result = resolveWildcardPinTypes({
      nodes: [
        { id: "floatSrc", pins: [{ id: "out", type: FLOAT }] },
        { id: "intSrc", pins: [{ id: "out", type: INT }] },
        {
          id: "select",
          pins: [
            { id: "a", type: T },
            { id: "b", type: T },
            { id: "out", type: T },
          ],
        },
      ],
      edges: [
        {
          sourceNodeId: "floatSrc",
          sourcePinId: "out",
          targetNodeId: "select",
          targetPinId: "a",
        },
        {
          sourceNodeId: "intSrc",
          sourcePinId: "out",
          targetNodeId: "select",
          targetPinId: "b",
        },
      ],
    });
    expect(typeAt(result.resolved, "select", "a")).toEqual(FLOAT);
    expect(typeAt(result.resolved, "select", "b")).toEqual(FLOAT);
    expect(typeAt(result.resolved, "select", "out")).toEqual(FLOAT);
    expect(result.conflicts).toEqual([]);
  });

  it("keeps independent groups K and V on the same node", () => {
    const result = resolveWildcardPinTypes({
      nodes: [
        {
          id: "src",
          pins: [{ id: "out", type: mapOf(STRING, FLOAT) }],
        },
        {
          id: "find",
          pins: [
            { id: "map", type: mapOf(K, V) },
            { id: "key", type: K },
            { id: "value", type: V },
          ],
        },
      ],
      edges: [
        {
          sourceNodeId: "src",
          sourcePinId: "out",
          targetNodeId: "find",
          targetPinId: "map",
        },
      ],
    });
    expect(pinTypeEquals(typeAt(result.resolved, "find", "key"), STRING)).toBe(
      true,
    );
    expect(pinTypeEquals(typeAt(result.resolved, "find", "value"), FLOAT)).toBe(
      true,
    );
    expect(typeAt(result.resolved, "find", "map")).toEqual(mapOf(STRING, FLOAT));
  });
});
