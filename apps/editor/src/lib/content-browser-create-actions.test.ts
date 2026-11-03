import { describe, expect, it } from "vitest";
import { PARTICLE_SYSTEM_MAX_EMITTERS, ensureTilesetTiles, normalizeTilesetPayload } from "@haptic/assets";
import { validateMaterialDocument, type MaterialDocument } from "@haptic/shader-graph";
import {
  buildModelPrefabAssetResult,
  buildParticleSystemAssetResult,
  buildRenderTargetTextureAssetResult,
  buildSpriteAssetResult,
  buildTextureMaterialAssetResult,
  buildTilemapAssetResult,
  componentsForAssets,
  dataDefinitionFromStructure,
  materialTextureGroups,
  textureMaterialDocument,
} from "./content-browser-create-actions";

function tileset(textureGuid: string, size: number, tile: number) {
  return ensureTilesetTiles(normalizeTilesetPayload({ textureGuid, atlasWidth: size, atlasHeight: size, tileWidth: tile, tileHeight: tile }));
}

/** The output pin each wired input reaches, as `pin ← source node type`. */
function outputWiring(document: MaterialDocument): string[] {
  const output = document.nodes.find((node) => node.type === "output.surface")!;
  return document.edges
    .filter((edge) => edge.targetNodeId === output.id)
    .map((edge) => `${edge.targetPinId} ← ${document.nodes.find((node) => node.id === edge.sourceNodeId)?.type}`)
    .sort();
}

describe("Content Browser Create actions", () => {
  it("builds a Sprite of the whole Texture that depends on it", () => {
    expect(buildSpriteAssetResult("hero-tex", "hero", "Hero")).toMatchObject({
      type: "Sprite",
      name: "Hero",
      dependencies: ["hero-tex"],
      payload: { textureGuid: "hero-tex", pixelsPerUnit: 100, pivot: { x: 0.5, y: 0.5 }, atlasTextures: ["hero-tex"] },
    });
  });

  it("builds a Tilemap with every Tileset in order, at the first Tileset's tile size", () => {
    const result = buildTilemapAssetResult(
      [{ guid: "ground", payload: tileset("a", 64, 32) }, { guid: "decor", payload: tileset("b", 64, 16) }],
      "map",
      "Ground",
    );
    expect(result.payload).toMatchObject({
      tileWidth: 32,
      tileHeight: 32,
      // 4 tiles of 32 px, then 16 of 16 px.
      tilesets: [{ guid: "ground", firstGid: 1, tileCount: 4 }, { guid: "decor", firstGid: 5, tileCount: 16 }],
    });
    expect(result.dependencies).toEqual(["ground", "decor"]);
  });

  it("groups Textures into Materials by the name before their map suffix, the first of a map winning", () => {
    const groups = materialTextureGroups([
      { guid: "g", name: "Grass" },
      { guid: "ra", name: "Rock_albedo" },
      { guid: "rc", name: "Rock_color" },
      { guid: "rn", name: "Rock_Normal" },
      { guid: "rr", name: "rock-rough" },
      { guid: "rao", name: "Rock_AO" },
      { guid: "rm", name: "Rock_metallic" },
      { guid: "dn", name: "Door_nrm" },
    ]);
    expect(groups).toEqual([
      { name: "Grass", maps: { baseColor: "g" }, firstGuid: "g" },
      { name: "Rock", maps: { baseColor: "ra", normal: "rn", roughness: "rr", ao: "rao", metallic: "rm" }, firstGuid: "ra" },
      { name: "Door", maps: { normal: "dn" }, firstGuid: "dn" },
    ]);
  });

  it("wires each map into a valid Material, and keeps the default Base Color without a color map", () => {
    const rock = textureMaterialDocument({
      name: "Rock",
      maps: { baseColor: "ra", normal: "rn", roughness: "rr", metallic: "rm", emissive: "re", ao: "rao" },
      firstGuid: "ra",
    });
    expect(validateMaterialDocument(rock).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(outputWiring(rock)).toEqual([
      "baseColor ← texture.sample",
      "emissive ← texture.sample",
      "metallic ← texture.sample",
      "normal ← shading.normalMap",
      "roughness ← texture.sample",
    ]);
    // Materials have no occlusion input: the AO Texture is not sampled.
    expect(rock.nodes.filter((node) => node.type === "param.texture").map((node) => node.properties.textureGuid).sort())
      .toEqual(["ra", "re", "rm", "rn", "rr"]);

    const door = textureMaterialDocument({ name: "Door", maps: { normal: "dn" }, firstGuid: "dn" });
    expect(validateMaterialDocument(door).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(outputWiring(door)).toEqual(["baseColor ← const.color", "normal ← shading.normalMap"]);

    expect(buildTextureMaterialAssetResult({ name: "Rock", maps: { baseColor: "ra", normal: "rn" }, firstGuid: "ra" }, "mat", "Rock"))
      .toMatchObject({ type: "Material", name: "Rock", dependencies: expect.arrayContaining(["ra", "rn"]), payload: { name: "Rock" } });
  });

  it("makes the component each asset gets when placed, skipping other types", () => {
    expect(componentsForAssets([
      { guid: "crate", type: "Model" },
      { guid: "hero", type: "Sprite" },
      { guid: "sparks", type: "ParticleSystem" },
      { guid: "barrel", type: "Model" },
      { guid: "tex", type: "Texture" },
    ], "actor")).toEqual([
      expect.objectContaining({ id: "actor-mesh-1", classId: "MeshComponent", properties: expect.objectContaining({ assetGuid: "crate" }) }),
      expect.objectContaining({ id: "actor-sprite-1", classId: "SpriteComponent", properties: expect.objectContaining({ assetGuid: "hero" }) }),
      expect.objectContaining({
        id: "actor-particle-1",
        classId: "ParticleComponent",
        properties: expect.objectContaining({ particleSystemGuid: "sparks", playOnStart: true }),
      }),
      expect.objectContaining({ id: "actor-mesh-2", classId: "MeshComponent", properties: expect.objectContaining({ assetGuid: "barrel" }) }),
    ]);
  });

  it("builds one Prefab holding every Model and depending on each", () => {
    const result = buildModelPrefabAssetResult(["crate", "barrel"], "props", "Crate");
    const components = (result.payload as { components: Array<{ classId: string; properties: { assetGuid?: string } }> }).components;
    expect(components.map((component) => [component.classId, component.properties.assetGuid])).toEqual([
      ["MeshComponent", "crate"],
      ["MeshComponent", "barrel"],
    ]);
    expect(result.dependencies).toEqual(expect.arrayContaining(["crate", "barrel"]));
  });

  it("builds a Particle System of at most its emitter limit", () => {
    const guids = Array.from({ length: PARTICLE_SYSTEM_MAX_EMITTERS + 2 }, (_unused, index) => `emitter-${index + 1}`);
    const result = buildParticleSystemAssetResult(guids, "fx", "Sparks");
    expect((result.payload as { emitterGuids: string[] }).emitterGuids).toEqual(guids.slice(0, PARTICLE_SYSTEM_MAX_EMITTERS));
  });

  it("starts a Data Definition from a Structure's fields, giving fields without an id a free one", () => {
    const definition = dataDefinitionFromStructure({
      kind: "structure",
      guid: "weapon",
      name: "Weapon",
      fields: [
        { name: "Damage", typeId: "float" },
        { id: "field-1", name: "Name", typeId: "string" },
        { name: "Tags", typeId: "string", container: "array" },
      ],
    });
    expect(definition).toEqual({
      kind: "dataDefinition",
      fields: [
        { id: "field-2", name: "Damage", typeId: "float" },
        { id: "field-1", name: "Name", typeId: "string" },
        { id: "field-3", name: "Tags", typeId: "string", container: "array" },
      ],
    });
  });

  it("binds a Render Target Texture to its Render Target", () => {
    expect(buildRenderTargetTextureAssetResult("mirror", "mirror-tex", "Mirror")).toMatchObject({
      type: "RenderTargetTexture",
      dependencies: ["mirror"],
      payload: { renderTargetGuid: "mirror" },
    });
  });
});
