import { describe, expect, it } from "vitest";
import {
  compileShaderGraph,
  createDefaultShaderGraph,
  shouldRecompilePreview,
  validateShaderGraph,
  shaderGraphToSerialized,
  serializedToShaderGraph,
  hydrateShaderGraphForEditor,
  shaderPaletteNodes,
  SHADER_CATALOG,
} from "./index";

describe("shader graph", () => {
  it("compiles a default surface graph without post-process cost", () => {
    const doc = createDefaultShaderGraph();
    expect(validateShaderGraph(doc)).toEqual([]);
    const compiled = compileShaderGraph(doc);
    expect(compiled.fragmentOutputNodeId).toBe("out");
    expect(compiled.postProcess).toBe(false);
    expect(compiled.ipadCostWarning).toBe(false);
  });

  it("flags post-process graphs as iPad-costly", () => {
    const doc = createDefaultShaderGraph();
    doc.postProcess = true;
    doc.nodes[1]!.type = "output.postProcess";
    const warnings = validateShaderGraph(doc);
    expect(warnings.some((row) => row.code === "shader.ipadCost")).toBe(true);
    expect(compileShaderGraph(doc).ipadCostWarning).toBe(true);
  });

  it("throttles live preview recompiles", () => {
    expect(shouldRecompilePreview(0, 249)).toBe(false);
    expect(shouldRecompilePreview(0, 250)).toBe(true);
  });

  it("round-trips through the graph-ui serialized shape", () => {
    const doc = createDefaultShaderGraph();
    const next = serializedToShaderGraph(shaderGraphToSerialized(doc), doc);
    expect(next.nodes.map((node) => node.type)).toEqual(
      doc.nodes.map((node) => node.type),
    );
  });

  it("errors when the graph has no output or a dangling edge", () => {
    const empty = createDefaultShaderGraph();
    empty.nodes = [];
    empty.edges = [
      {
        id: "ghost",
        sourceNodeId: "missing",
        sourcePinId: "out",
        targetNodeId: "also-missing",
        targetPinId: "in",
      },
    ];
    const codes = validateShaderGraph(empty).map((row) => row.code);
    expect(codes).toContain("shader.noOutput");
    expect(codes).toContain("shader.danglingEdge");
  });

  it("records sampled textures and custom blocks", () => {
    const doc = createDefaultShaderGraph();
    doc.nodes.push({
      id: "tex",
      type: "texture.sample",
      position: { x: 40, y: 80 },
      properties: { textureGuid: "tex-1" },
    });
    doc.nodes.push({
      id: "custom",
      type: "custom",
      position: { x: 40, y: 160 },
      properties: { code: "float n = 1.0;" },
    });
    const compiled = compileShaderGraph(doc);
    expect(compiled.sampledTextures).toContain("tex-1");
    expect(compiled.customBlocks).toContain("float n = 1.0;");
  });

  it("hydrates catalog pins so Add Node is not an empty box", () => {
    const hydrated = hydrateShaderGraphForEditor(
      shaderGraphToSerialized(createDefaultShaderGraph()),
    );
    const uv = hydrated.nodes.find((node) => node.type === "input.uv");
    const pins = uv?.data.__pins as Array<{ id: string; direction: string }>;
    expect(pins.some((pin) => pin.id === "uv" && pin.direction === "out")).toBe(
      true,
    );
    const frag = hydrated.nodes.find((node) => node.type === "output.fragment");
    const fragPins = frag?.data.__pins as Array<{ id: string; direction: string }>;
    expect(
      fragPins.some((pin) => pin.id === "color" && pin.direction === "in"),
    ).toBe(true);
  });

  it("embeds catalog pins on every Add Node palette entry", () => {
    const palette = shaderPaletteNodes();
    expect(palette.map((entry) => entry.id)).toEqual(
      SHADER_CATALOG.map((entry) => entry.type),
    );
    const multiply = palette.find((entry) => entry.id === "math.multiply");
    expect(
      multiply?.pins.some((pin) => pin.id === "a" && pin.direction === "in"),
    ).toBe(true);
    expect(
      multiply?.pins.some((pin) => pin.id === "out" && pin.direction === "out"),
    ).toBe(true);
  });

  it("strips editor __pins when converting back to IR", () => {
    const hydrated = hydrateShaderGraphForEditor(
      shaderGraphToSerialized(createDefaultShaderGraph()),
    );
    const ir = serializedToShaderGraph(hydrated);
    expect(ir.nodes[0]?.properties.__pins).toBeUndefined();
  });
});
