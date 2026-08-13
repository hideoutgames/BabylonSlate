import { describe, expect, it } from "vitest";
import { SEARCH_CATALOG_CLASS_IDS } from "./search-catalog";

describe("search catalog class ids", () => {
  it("does not advertise unbuilt Tilemap, behaviour-tree, nav, or world-space Widget", () => {
    expect(SEARCH_CATALOG_CLASS_IDS).not.toContain("TilemapComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).not.toContain("BehaviourTreeComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).not.toContain("NavAgentComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).not.toContain("WidgetComponent");
  });

  it("still indexes shipped engine classes", () => {
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("Actor");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("SpriteComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("RigidBodyComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("AnimationGraphComponent");
  });
});
