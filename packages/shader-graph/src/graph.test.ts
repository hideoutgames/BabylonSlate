import { describe, expect, it } from "vitest";
import {
  compileShaderGraph,
  createDefaultShaderGraph,
  shouldRecompilePreview,
  validateShaderGraph,
  shaderGraphToSerialized,
  serializedToShaderGraph,
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
});
