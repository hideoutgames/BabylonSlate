import { describe, expect, it } from "vitest";
import { SEARCH_CATALOG_CLASS_IDS } from "./search-catalog";

describe("search catalog class ids", () => {
  it("advertises BehaviourTree and NavAgent but not Place-Actor-only NavMesh", () => {
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("TilemapComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("BehaviourTreeComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("BTTask");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("NavAgentComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).not.toContain("NavMeshComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).not.toContain("NavMeshBlockerComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).not.toContain("BlockingVolumeComponent");
  });

  it("advertises Audio, Skybox, and Particle once they are addable", () => {
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("AudioComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("SkyboxComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("Text3DComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("ParticleComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("SceneLayerActor");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("2DButtonComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("2DTextComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("2DRichTextComponent");
  });

  it("still indexes shipped engine classes", () => {
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("Actor");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("SpriteComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("RigidBodyComponent");
    expect(SEARCH_CATALOG_CLASS_IDS).toContain("AnimationGraphComponent");
  });
});
