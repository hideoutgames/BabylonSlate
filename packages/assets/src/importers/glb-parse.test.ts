import { describe, expect, it } from "vitest";
import {
  buildMinimalGlbFixture,
  parseGlbForBrowse,
  parseGltfJsonForBrowse,
} from "./glb-parse";
import { importModel } from "./model";

describe("parseGlbForBrowse", () => {
  it("extracts materials, embedded images, and animations from a fixture GLB", () => {
    const glb = buildMinimalGlbFixture({
      materialName: "HeroMat",
      animationName: "Walk",
    });
    const browse = parseGlbForBrowse(glb);
    expect(browse).not.toBeNull();
    expect(browse!.materials).toHaveLength(1);
    expect(browse!.materials[0]!.name).toBe("HeroMat");
    expect(browse!.materials[0]!.albedoImageIndex).toBe(0);
    expect(browse!.images).toHaveLength(1);
    expect(browse!.images[0]!.bytes.byteLength).toBeGreaterThan(0);
    expect(browse!.animations[0]!.name).toBe("Walk");
  });

  it("parses glTF JSON with a data-URI image", () => {
    const png = buildMinimalGlbFixture(); // unused size; craft small data uri
    void png;
    const dataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const browse = parseGltfJsonForBrowse(
      JSON.stringify({
        asset: { version: "2.0" },
        images: [{ name: "Embedded", uri: dataUri }],
        textures: [{ source: 0 }],
        materials: [
          {
            name: "Mat",
            pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
          },
        ],
        animations: [],
      }),
    );
    expect(browse).not.toBeNull();
    expect(browse!.images[0]!.bytes.byteLength).toBeGreaterThan(0);
    expect(browse!.materials[0]!.albedoImageIndex).toBe(0);
  });

  it("rejects non-GLB bytes", () => {
    expect(parseGlbForBrowse(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("classifies a skin rig from skins.joints", () => {
    const browse = parseGltfJsonForBrowse(
      JSON.stringify({
        asset: { version: "2.0" },
        nodes: [{ name: "Hips" }, { name: "Spine" }, { name: "Mesh", mesh: 0, skin: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        skins: [{ name: "Armature", joints: [0, 1] }],
        animations: [
          {
            name: "Walk",
            channels: [{ target: { node: 0, path: "rotation" }, sampler: 0 }],
            samplers: [{ input: 0, output: 1 }],
          },
        ],
        accessors: [
          { componentType: 5126, type: "SCALAR", count: 2, max: [1.25] },
          { componentType: 5126, type: "VEC4", count: 2 },
        ],
      }),
    );
    expect(browse).not.toBeNull();
    expect(browse!.rigKind).toBe("skin");
    expect(browse!.boneNames).toEqual(["Hips", "Spine"]);
    expect(browse!.animations[0]).toEqual({ name: "Walk", durationMs: 1250 });
  });

  it("classifies a hierarchy rig when clips target parented meshes and there is no skin", () => {
    const browse = parseGltfJsonForBrowse(
      JSON.stringify({
        asset: { version: "2.0" },
        nodes: [
          { name: "character", children: [1] },
          { name: "root", children: [2, 3] },
          { name: "torso", mesh: 0 },
          { name: "head", mesh: 1 },
        ],
        meshes: [{ primitives: [] }, { primitives: [] }],
        animations: [
          {
            name: "idle",
            channels: [
              { target: { node: 2, path: "rotation" }, sampler: 0 },
              { target: { node: 3, path: "rotation" }, sampler: 0 },
            ],
            samplers: [{ input: 0, output: 1 }],
          },
        ],
        accessors: [{ componentType: 5126, type: "SCALAR", count: 2, max: [0.5] }],
      }),
    );
    expect(browse!.rigKind).toBe("hierarchy");
    expect(browse!.boneNames).toEqual(["character", "root", "torso", "head"]);
    expect(browse!.animations[0]).toEqual({ name: "idle", durationMs: 500 });
  });

  it("does not invent a skeleton for a one-node object clip", () => {
    const browse = parseGltfJsonForBrowse(
      JSON.stringify({
        asset: { version: "2.0" },
        nodes: [{ name: "crate", mesh: 0 }],
        meshes: [{ primitives: [] }],
        animations: [
          {
            name: "spin",
            channels: [{ target: { node: 0, path: "rotation" }, sampler: 0 }],
            samplers: [{ input: 0, output: 1 }],
          },
        ],
      }),
    );
    expect(browse!.rigKind).toBe("none");
    expect(browse!.boneNames).toEqual([]);
  });

  it("importModel wires browsable dependents with pixel chunks from GLB", async () => {
    const glb = buildMinimalGlbFixture();
    const results = await importModel(glb, {
      fileName: "hero.glb",
      existingGuids: new Set(),
    });
    const types = results.map((r) => r.type);
    expect(types).toContain("Model");
    expect(types).toContain("Material");
    expect(types).toContain("Texture");
    expect(types).toContain("Animation");
    const texture = results.find((r) => r.type === "Texture")!;
    expect(texture.chunks.some((c) => c.kind === "pixels")).toBe(true);
    const model = results.find((r) => r.type === "Model")!;
    expect(model.payload.textureCount).toBeUndefined();
    expect(model.payload.materialCount).toBeUndefined();
    expect(model.payload.animationCount).toBeUndefined();
    expect(model.payload.clipNames).toEqual(["FixtureClip"]);
    const material = results.find((r) => r.type === "Material")!;
    expect(model.payload.materialSlots).toEqual([
      {
        index: 0,
        name: "FixtureMat",
        materialGuid: material.guid,
      },
    ]);
    expect(material.dependencies).toEqual([texture.guid]);
    const sample = (material.payload.nodes as Array<{ type?: string }>).find(
      (node) => node.type === "texture.sample",
    );
    expect(sample).toBeDefined();
    const animation = results.find((r) => r.type === "Animation")!;
    expect(animation.payload).toMatchObject({
      clipName: "FixtureClip",
      modelGuid: model.guid,
      skeletonGuid: null,
    });
    expect(model.payload.skeletonGuid).toBeNull();
    expect(results.some((r) => r.type === "Skeleton")).toBe(false);
  });

  it("does not invent an Animation dependent when the glTF has no clips", async () => {
    const dataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const results = await importModel(
      new TextEncoder().encode(
        JSON.stringify({
          asset: { version: "2.0" },
          images: [{ name: "Embedded", uri: dataUri }],
          textures: [{ source: 0 }],
          materials: [
            {
              name: "Mat",
              pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
            },
          ],
          animations: [],
        }),
      ),
      { fileName: "statue.gltf", existingGuids: new Set() },
    );
    expect(results.map((r) => r.type).sort()).toEqual([
      "Material",
      "Model",
      "Texture",
    ]);
    const model = results.find((r) => r.type === "Model")!;
    expect(model.payload.clipNames).toEqual([]);
    expect(model.payload.skeletonGuid).toBeNull();
  });

  it("imports a Skeleton and Animation rows for a skinned glTF", async () => {
    const results = await importModel(
      new TextEncoder().encode(
        JSON.stringify({
          asset: { version: "2.0" },
          materials: [{ name: "SkinMat" }],
          nodes: [{ name: "Hips" }, { name: "Spine" }, { name: "Body", mesh: 0, skin: 0 }],
          meshes: [{ primitives: [{ attributes: {} }] }],
          skins: [{ joints: [0, 1] }],
          animations: [
            {
              name: "Walk",
              channels: [{ target: { node: 0, path: "rotation" }, sampler: 0 }],
              samplers: [{ input: 0, output: 1 }],
            },
          ],
          accessors: [{ max: [1] }],
        }),
      ),
      { fileName: "hero.gltf", existingGuids: new Set() },
    );
    const model = results.find((r) => r.type === "Model")!;
    const skeleton = results.find((r) => r.type === "Skeleton")!;
    const animation = results.find((r) => r.type === "Animation")!;
    expect(skeleton.payload).toMatchObject({
      modelGuid: model.guid,
      kind: "skin",
      boneNames: ["Hips", "Spine"],
    });
    expect(model.payload.skeletonGuid).toBe(skeleton.guid);
    expect(animation.payload).toMatchObject({
      clipName: "Walk",
      modelGuid: model.guid,
      skeletonGuid: skeleton.guid,
      durationMs: 1000,
    });
    expect(model.dependencies).toContain(skeleton.guid);
    expect(model.dependencies).toContain(animation.guid);
  });

  it("imports a hierarchy Skeleton for parented-mesh clips", async () => {
    const results = await importModel(
      new TextEncoder().encode(
        JSON.stringify({
          asset: { version: "2.0" },
          materials: [{ name: "Parts" }],
          nodes: [
            { name: "character", children: [1] },
            { name: "root", children: [2, 3] },
            { name: "torso", mesh: 0 },
            { name: "head", mesh: 1 },
          ],
          meshes: [{ primitives: [] }, { primitives: [] }],
          animations: [
            {
              name: "idle",
              channels: [
                { target: { node: 2, path: "rotation" }, sampler: 0 },
                { target: { node: 3, path: "rotation" }, sampler: 0 },
              ],
              samplers: [{ input: 0 }],
            },
          ],
          accessors: [{ max: [0.5] }],
        }),
      ),
      { fileName: "mannequin.gltf", existingGuids: new Set() },
    );
    const skeleton = results.find((r) => r.type === "Skeleton")!;
    expect(skeleton.payload).toMatchObject({
      kind: "hierarchy",
      boneNames: ["character", "root", "torso", "head"],
    });
  });

  it("rejects OBJ instead of writing stub Model assets", async () => {
    await expect(
      importModel(new Uint8Array([1]), {
        fileName: "mesh.obj",
        existingGuids: new Set(),
      }),
    ).rejects.toThrow(/GLB or glTF/i);
  });
});
