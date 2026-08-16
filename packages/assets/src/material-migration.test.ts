import { describe, expect, it } from "vitest";
import {
  MATERIAL_SCHEMA_VERSION,
  normalizeMaterialDocument,
  validateMaterialDocument,
} from "@babylonslate/shader-graph";
import {
  MATERIAL_PAYLOAD_VERSION,
  createDefaultMigrationRegistry,
  migrateMaterialPayload,
} from "./migration";

const LEGACY_SHADER_V0 = {
  name: "Surface",
  postProcess: false,
  nodes: [
    { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
    {
      id: "out",
      type: "output.fragment",
      position: { x: 280, y: 0 },
      properties: {},
    },
  ],
  edges: [
    {
      id: "e0",
      sourceNodeId: "uv",
      sourcePinId: "uv",
      targetNodeId: "out",
      targetPinId: "color",
    },
  ],
};

describe("material migrations", () => {
  it("registers a chain so Material stops saving at version 0", () => {
    const registry = createDefaultMigrationRegistry();
    expect(registry.currentVersion("Material")).toBe(MATERIAL_PAYLOAD_VERSION);
    expect(registry.currentVersion("Shader")).toBe(MATERIAL_PAYLOAD_VERSION);
    expect(registry.currentVersion("MaterialFunction")).toBe(1);
  });

  it("migrates a legacy Shader payload to a valid Material document", () => {
    const registry = createDefaultMigrationRegistry();
    const result = registry.migrate("Shader", 0, { ...LEGACY_SHADER_V0 });
    expect(result.migrated).toBe(true);
    expect(result.version).toBe(MATERIAL_PAYLOAD_VERSION);
    const doc = normalizeMaterialDocument(result.payload);
    expect(doc.schemaVersion).toBe(MATERIAL_SCHEMA_VERSION);
    expect(validateMaterialDocument(doc)).toEqual([]);
  });

  it("migrates an empty imported Material stub into a valid document", () => {
    const registry = createDefaultMigrationRegistry();
    const result = registry.migrate("Material", 0, {});
    const doc = normalizeMaterialDocument(result.payload);
    expect(doc.domain).toBe("surface");
    expect(validateMaterialDocument(doc)).toEqual([]);
  });

  it("seeds an imported material graph from its albedo texture dependency", () => {
    const payload = migrateMaterialPayload({}, { textureGuids: ["tex-1"] });
    const doc = normalizeMaterialDocument(payload);
    expect(
      doc.nodes.some(
        (node) =>
          node.type === "param.texture" &&
          node.properties.textureGuid === "tex-1",
      ),
    ).toBe(true);
    expect(validateMaterialDocument(doc)).toEqual([]);
  });

  it("leaves an already-canonical Material document unchanged", () => {
    const registry = createDefaultMigrationRegistry();
    const canonical = normalizeMaterialDocument({
      schemaVersion: MATERIAL_SCHEMA_VERSION,
      name: "Rock",
      domain: "surface",
      nodes: [],
      edges: [],
    });
    const result = registry.migrate(
      "Material",
      MATERIAL_PAYLOAD_VERSION,
      canonical as unknown as Record<string, unknown>,
    );
    expect(result.migrated).toBe(false);
    expect(result.payload).toBe(canonical);
  });

  it("refuses a payload written by a newer engine", () => {
    const registry = createDefaultMigrationRegistry();
    expect(() =>
      registry.migrate("Material", MATERIAL_PAYLOAD_VERSION + 1, {}),
    ).toThrow(/newer engine/);
  });

  it("normalizes a material function payload into plumbing nodes", () => {
    const registry = createDefaultMigrationRegistry();
    const result = registry.migrate("MaterialFunction", 0, {
      name: "Tint",
      inputs: [{ id: "in_a", name: "A", type: "vec3" }],
      outputs: [{ id: "out_a", name: "Out", type: "vec3" }],
    });
    const nodes = result.payload.nodes as Array<{ type: string }>;
    expect(nodes.some((node) => node.type === "function.input")).toBe(true);
    expect(nodes.some((node) => node.type === "function.output")).toBe(true);
  });
});
