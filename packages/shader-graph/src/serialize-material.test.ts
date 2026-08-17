import { describe, expect, it } from "vitest";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
} from "./document";
import {
  hydrateMaterialGraphForEditor,
  materialGraphToSerialized,
  materialPaletteNodes,
  materialPinsAreCompatible,
  pinsForMaterialNode,
  serializedToMaterialGraph,
} from "./serialize-material";

describe("material graph serialization", () => {
  it("round-trips a document through the graph shell shape", () => {
    const doc = createDefaultMaterialDocument();
    const next = serializedToMaterialGraph(materialGraphToSerialized(doc), doc);
    expect(next.nodes.map((node) => node.id)).toEqual(
      doc.nodes.map((node) => node.id),
    );
    expect(next.edges.map((edge) => edge.id)).toEqual(
      doc.edges.map((edge) => edge.id),
    );
  });

  it("preserves node positions through a round trip", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes[0]!.position = { x: 123, y: -45 };
    const next = serializedToMaterialGraph(materialGraphToSerialized(doc), doc);
    expect(next.nodes[0]?.position).toEqual({ x: 123, y: -45 });
  });

  it("preserves document settings that are not part of the canvas", () => {
    const doc = createDefaultMaterialDocument();
    doc.blendMode = "translucent";
    doc.preview = { mesh: "cube", customMeshGuid: null };
    const next = serializedToMaterialGraph(materialGraphToSerialized(doc), doc);
    expect(next.blendMode).toBe("translucent");
    expect(next.preview.mesh).toBe("cube");
  });

  it("hydrates catalog pins so Add Node is not an empty box", () => {
    const hydrated = hydrateMaterialGraphForEditor(
      materialGraphToSerialized(createDefaultMaterialDocument()),
    );
    const output = hydrated.nodes.find(
      (node) => node.type === "output.surface",
    );
    const pins = output?.data.__pins as Array<{ id: string; direction: string }>;
    expect(pins.some((pin) => pin.id === "baseColor" && pin.direction === "in")).toBe(
      true,
    );
  });

  it("hydrates catalog defaultValue and colorHint onto editor pins", () => {
    const hydrated = hydrateMaterialGraphForEditor(
      materialGraphToSerialized(createDefaultMaterialDocument()),
    );
    const output = hydrated.nodes.find(
      (node) => node.type === "output.surface",
    );
    const pins = output?.data.__pins as Array<{
      id: string;
      defaultValue?: number[];
      colorHint?: boolean;
    }>;
    const roughness = pins.find((pin) => pin.id === "roughness");
    const baseColor = pins.find((pin) => pin.id === "baseColor");
    expect(roughness?.defaultValue).toEqual([0.5]);
    expect(baseColor?.colorHint).toBe(true);
    expect(baseColor?.defaultValue).toEqual([0.8, 0.8, 0.8]);
    expect(output?.data["default:roughness"]).toBeUndefined();
  });

  it("strips editor-only keys when converting back to the document", () => {
    const hydrated = hydrateMaterialGraphForEditor(
      materialGraphToSerialized(createDefaultMaterialDocument()),
    );
    const doc = serializedToMaterialGraph(hydrated);
    expect(doc.nodes[0]?.properties.__pins).toBeUndefined();
    expect(doc.nodes[0]?.properties.__nodeType).toBeUndefined();
  });

  it("hydrates function call pins from the called function interface", () => {
    const fn = createDefaultMaterialFunctionDocument("Tint");
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "call",
      type: "function.call",
      position: { x: 0, y: 0 },
      properties: { functionGuid: "fn-1" },
    });
    const hydrated = hydrateMaterialGraphForEditor(
      materialGraphToSerialized(doc),
      { functions: { "fn-1": fn } },
    );
    const call = hydrated.nodes.find((node) => node.id === "call");
    const pins = call?.data.__pins as Array<{ id: string; direction: string }>;
    expect(pins.some((pin) => pin.id === "in_value" && pin.direction === "in")).toBe(
      true,
    );
    expect(
      pins.some((pin) => pin.id === "out_value" && pin.direction === "out"),
    ).toBe(true);
    expect(call?.data.title).toBe("Tint");
  });

  it("hydrates function plumbing pins from the function interface", () => {
    const fn = createDefaultMaterialFunctionDocument("Tint");
    const pins = pinsForMaterialNode("function.input", { functionInterface: fn });
    expect(pins.map((pin) => pin.id)).toEqual(["in_value"]);
    expect(pins[0]?.direction).toBe("out");
  });

  it("lists palette nodes for the requested domain with pins attached", () => {
    const palette = materialPaletteNodes("surface");
    const multiply = palette.find((entry) => entry.id === "math.multiply");
    expect(multiply?.pins.some((pin) => pin.id === "a")).toBe(true);
    expect(palette.some((entry) => entry.id === "output.postProcess")).toBe(
      false,
    );
  });

  it("lets a Float splat into a vector pin on the canvas", () => {
    const float = {
      id: "out",
      name: "Out",
      kind: "data" as const,
      direction: "out" as const,
      type: { kind: "float" },
    };
    const vec3 = {
      id: "baseColor",
      name: "Base Color",
      kind: "data" as const,
      direction: "in" as const,
      type: { kind: "vec3" },
    };
    expect(materialPinsAreCompatible(float, vec3)).toBe(true);
  });

  it("refuses to truncate a vector on the canvas", () => {
    const vec4 = {
      id: "out",
      name: "Out",
      kind: "data" as const,
      direction: "out" as const,
      type: { kind: "vec4" },
    };
    const vec3 = {
      id: "baseColor",
      name: "Base Color",
      kind: "data" as const,
      direction: "in" as const,
      type: { kind: "vec3" },
    };
    expect(materialPinsAreCompatible(vec4, vec3)).toBe(false);
  });

  it("lets a generic pin accept any numeric value", () => {
    const generic = {
      id: "a",
      name: "A",
      kind: "data" as const,
      direction: "in" as const,
      type: { kind: "generic" },
    };
    const vec2 = {
      id: "out",
      name: "Out",
      kind: "data" as const,
      direction: "out" as const,
      type: { kind: "vec2" },
    };
    expect(materialPinsAreCompatible(vec2, generic)).toBe(true);
  });

  it("never connects a texture to a numeric pin", () => {
    const texture = {
      id: "out",
      name: "Out",
      kind: "data" as const,
      direction: "out" as const,
      type: { kind: "texture" },
    };
    const generic = {
      id: "a",
      name: "A",
      kind: "data" as const,
      direction: "in" as const,
      type: { kind: "generic" },
    };
    expect(materialPinsAreCompatible(texture, generic)).toBe(false);
  });
});
