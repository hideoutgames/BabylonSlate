import { describe, expect, it } from "vitest";
import {
  MATERIAL_SCHEMA_VERSION,
  normalizeMaterialDocument,
} from "@babylonslate/shader-graph";
import {
  MATERIAL_PAYLOAD_VERSION,
  createDefaultMigrationRegistry,
} from "./migration";

describe("material migrations", () => {
  it("registers a chain so Material stops saving at version 0", () => {
    const registry = createDefaultMigrationRegistry();
    expect(registry.currentVersion("Material")).toBe(MATERIAL_PAYLOAD_VERSION);
    expect(registry.currentVersion("MaterialFunction")).toBe(1);
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
