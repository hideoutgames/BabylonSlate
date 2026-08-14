import { describe, expect, it } from "vitest";
import { SEARCH_CATALOG_CLASS_IDS } from "./search-catalog";

describe("search catalog class ids", () => {
  it("does not advertise unbuilt nav or world-space Widget", () => {
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("TilemapComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("BehaviourTreeComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("BTTask");
    expect(SEARCH_CATALOG_CLASS_IDS).not.toContain("NavAgentComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).not.toContain("WidgetComponent");
  });

  it("does not advertise AudioComponent until it is addable", () => {
    expect(SEARCH_CATALOG_CLASS_IDS).not.toContain("AudioComponent");
  });

  it("still indexes shipped engine classes", () => {
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("Actor");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("SpriteComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("RigidBodyComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("AnimationGraphComponent");
  });
});
