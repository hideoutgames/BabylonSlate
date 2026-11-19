import { describe, expect, it, vi } from "vitest";
import { engineParentOf } from "@haptic/editor-kit";
import type { SerializedPin } from "@haptic/graph-ui";
import { classHierarchyFromParentOf } from "./graph-class-symbols";
import { scriptCatalogPaletteNode } from "./script-palette";
import { scriptPinConversion } from "./script-pin-conversion";

const USER_PARENTS: Record<string, string> = {
  "Class:pawn": "Actor",
  "Class:grand-pawn": "Class:pawn",
  "Class:mesh": "MeshComponent",
  "Class:mover": "MovementComponent",
};
const hierarchy = classHierarchyFromParentOf((id) => USER_PARENTS[id] ?? engineParentOf(id));

function reference(classId: string): SerializedPin {
  return { id: "ref", name: "Ref", kind: "data", direction: "out", type: { kind: "objectRef", classId } };
}

function input(type: SerializedPin["type"]): SerializedPin {
  return { id: "value", name: "Value", kind: "data", direction: "in", type };
}

const convert = () => scriptPinConversion({ hierarchy, paletteNodeFor: (nodeType) => scriptCatalogPaletteNode(nodeType) });

describe("scriptPinConversion", () => {
  it.each([
    ["Actor", "vec3", "transform.getLocation", "target", "out", "Convert to Vector3"],
    ["Actor", "rotator", "transform.getRotation", "target", "out", "Convert to Rotator"],
    ["Actor", "transform", "transform.get", "target", "out", "Convert to Transform"],
    ["Actor", "string", "actor.getName", "target", "out", "Convert to String"],
    ["Class:grand-pawn", "vec3", "transform.getLocation", "target", "out", "Convert to Vector3"],
    ["MeshComponent", "vec3", "transform.getComponentWorldLocation", "target", "out", "Convert to Vector3"],
    ["MeshComponent", "rotator", "transform.getComponentWorldRotation", "target", "out", "Convert to Rotator"],
    ["MeshComponent", "transform", "transform.getComponentWorldTransform", "target", "out", "Convert to Transform"],
    ["MeshComponent", "string", "object.getDisplayName", "object", "name", "Convert to String"],
    ["Class:mesh", "transform", "transform.getComponentWorldTransform", "target", "out", "Convert to Transform"],
    ["MovementComponent", "string", "object.getDisplayName", "object", "name", "Convert to String"],
  ])("converts %s into a %s input with %s", (classId, kind, nodeType, inPinId, outPinId, label) => {
    const conversion = convert()(reference(classId), input({ kind }));
    expect(conversion).toMatchObject({ label, inPinId, outPinId, paletteNode: { id: nodeType } });
    // The converter is the catalog node Add Node adds, and its pins carry the wire through.
    expect(conversion!.paletteNode).toEqual(scriptCatalogPaletteNode(nodeType));
    const pins = conversion!.paletteNode.pins ?? [];
    expect(pins.find((pin) => pin.id === inPinId)).toMatchObject({ direction: "in", type: { kind: "objectRef" } });
    expect(pins.find((pin) => pin.id === outPinId)).toMatchObject({ direction: "out", type: { kind } });
  });

  it.each([
    ["MovementComponent", "vec3"],
    ["SaveGameComponent", "rotator"],
    ["2DAnchorComponent", "transform"],
    ["Class:mover", "vec3"],
  ])("gives transform-less %s no %s conversion", (classId, kind) => {
    expect(convert()(reference(classId), input({ kind }))).toBeNull();
  });

  it.each<[string, SerializedPin, SerializedPin]>([
    ["a float source", { ...reference("Actor"), type: { kind: "float" } }, input({ kind: "vec3" })],
    ["a class reference", { ...reference("Actor"), type: { kind: "classRef", classId: "Actor" } }, input({ kind: "vec3" })],
    ["a reference that is neither an Actor nor a component", reference("Object"), input({ kind: "vec3" })],
    ["a Float input", reference("Actor"), input({ kind: "float" })],
    ["an Object input", reference("Actor"), input({ kind: "objectRef", classId: "Actor" })],
    ["a Vector3 Array input", reference("Actor"), input({ kind: "array", element: { kind: "vec3" } })],
    ["a wildcard input", reference("Actor"), input({ kind: "resolvingWildcard", group: "T" })],
  ])("converts nothing for %s", (_case, source, target) => {
    expect(convert()(source, target)).toBeNull();
  });

  it("builds each converter's row once and reuses it", () => {
    const paletteNodeFor = vi.fn((nodeType: string) => scriptCatalogPaletteNode(nodeType));
    const conversion = scriptPinConversion({ hierarchy, paletteNodeFor });
    const first = conversion(reference("Actor"), input({ kind: "vec3" }));
    const second = conversion(reference("Class:pawn"), input({ kind: "vec3" }));
    expect(second!.paletteNode).toBe(first!.paletteNode);
    conversion(reference("Actor"), input({ kind: "string" }));
    expect(paletteNodeFor.mock.calls.map(([nodeType]) => nodeType)).toEqual(["transform.getLocation", "actor.getName"]);
  });
});
