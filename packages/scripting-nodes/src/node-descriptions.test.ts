import { describe, expect, it } from "vitest";
import { allNodeDefinitions } from "./index";
import { NODE_DESCRIPTIONS } from "./node-descriptions";

describe("node tooltips", () => {
  const definitions = allNodeDefinitions();

  it("gives each listed node its short description", () => {
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    for (const [id, description] of Object.entries(NODE_DESCRIPTIONS)) {
      // An entry for a node that is gone, or that describes itself, is dead.
      expect(byId.get(id)?.description, id).toBe(description);
    }
  });

  it("keeps every tooltip to plain punctuation, and the listed ones short", () => {
    for (const definition of definitions) {
      expect(definition.description ?? "", definition.id).not.toMatch(/[‒-―]/);
    }
    for (const [id, description] of Object.entries(NODE_DESCRIPTIONS)) {
      expect(description.length, id).toBeLessThanOrEqual(80);
    }
  });
});
