import { describe, expect, it } from "vitest";
import {
  buildMinimalGlbFixture,
  embedGlbExternalImages,
  encodeGlbJsonBin,
  parseGlbForBrowse,
  parseGltfJsonForBrowse,
  splitGlbJsonBin,
  stripUnmatchedGltfImageUris,
} from "./glb-parse";
import { importModel } from "./model";

const ONE_BY_ONE_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
  0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function kenneyStyleSidecarGlb(uri = "Textures/colormap.png"): Uint8Array {
  return encodeGlbJsonBin(
    {
      asset: { version: "2.0" },
      buffers: [{ byteLength: 0 }],
      images: [{ name: "colormap", uri }],
      textures: [{ source: 0 }],
      materials: [
        {
          name: "colormap",
          pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
        },
      ],
    },
    new Uint8Array(0),
  );
}

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
    expect(browse!.materials[0]!.unlit).toBe(false);
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
    expect(browse!.materials[0]!.unlit).toBe(false);
  });

  it("marks KHR_materials_unlit as unlit", () => {
    const browse = parseGltfJsonForBrowse(
      JSON.stringify({
        asset: { version: "2.0" },
        materials: [
          {
            name: "Toon",
            pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
            extensions: { KHR_materials_unlit: {} },
          },
        ],
        textures: [{ source: 0 }],
        images: [],
      }),
    );
    expect(browse).not.toBeNull();
    expect(browse!.materials[0]!.unlit).toBe(true);
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
    expect(browse!.boneNames).not.toContain("__root__");
    expect(browse!.animations[0]).toEqual({ name: "idle", durationMs: 500 });
  });

  it("does not invent a hierarchy skeleton for two independent animated meshes", () => {
    const browse = parseGltfJsonForBrowse(
      JSON.stringify({
        asset: { version: "2.0" },
        nodes: [
          { name: "crate", mesh: 0 },
          { name: "door", mesh: 1 },
        ],
        meshes: [{ primitives: [] }, { primitives: [] }],
        animations: [
          {
            name: "props",
            channels: [
              { target: { node: 0, path: "rotation" }, sampler: 0 },
              { target: { node: 1, path: "rotation" }, sampler: 0 },
            ],
            samplers: [{ input: 0, output: 1 }],
          },
        ],
        accessors: [{ componentType: 5126, type: "SCALAR", count: 2, max: [1] }],
      }),
    );
    expect(browse!.rigKind).toBe("none");
    expect(browse!.boneNames).toEqual([]);
  });

  it("limits hierarchy boneNames to the animated parented-mesh tree", () => {
    const browse = parseGltfJsonForBrowse(
      JSON.stringify({
        asset: { version: "2.0" },
        nodes: [
          { name: "character", children: [1] },
          { name: "root", children: [2, 3] },
          { name: "torso", mesh: 0 },
          { name: "head", mesh: 1 },
          { name: "crate", mesh: 2 },
        ],
        meshes: [{ primitives: [] }, { primitives: [] }, { primitives: [] }],
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

  it("omits a glTF node named __root__ from catalog boneNames", () => {
    const browse = parseGltfJsonForBrowse(
      JSON.stringify({
        asset: { version: "2.0" },
        nodes: [
          { name: "__root__", children: [1, 2] },
          { name: "torso", mesh: 0 },
          { name: "head", mesh: 1 },
        ],
        meshes: [{ primitives: [] }, { primitives: [] }],
        animations: [
          {
            name: "idle",
            channels: [
              { target: { node: 1, path: "rotation" }, sampler: 0 },
              { target: { node: 2, path: "rotation" }, sampler: 0 },
            ],
            samplers: [{ input: 0, output: 1 }],
          },
        ],
      }),
    );
    expect(browse!.rigKind).toBe("hierarchy");
    expect(browse!.boneNames).toEqual(["torso", "head"]);
  });

  it("does not invent a hierarchy skeleton from one targeted ancestor and a single mesh descendant", () => {
    const browse = parseGltfJsonForBrowse(
      JSON.stringify({
        asset: { version: "2.0" },
        nodes: [
          { name: "character", children: [1] },
          { name: "empty", children: [2] },
          { name: "torso", mesh: 0 },
        ],
        meshes: [{ primitives: [] }],
        animations: [
          {
            name: "idle",
            channels: [{ target: { node: 0, path: "rotation" }, sampler: 0 }],
            samplers: [{ input: 0, output: 1 }],
          },
        ],
      }),
    );
    // #361: hierarchy needs two or more parented Mesh parts that share an ancestor.
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

  it("extracts a bufferView image when glTF omits byteOffset (default 0)", () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const glb = encodeGlbJsonBin(
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: png.byteLength }],
        bufferViews: [{ buffer: 0, byteLength: png.byteLength }],
        images: [{ mimeType: "image/png", bufferView: 0, name: "Albedo" }],
        textures: [{ source: 0 }],
        materials: [
          {
            name: "Rock",
            pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
          },
        ],
      },
      png,
    );
    const split = splitGlbJsonBin(glb);
    const browse = parseGlbForBrowse(glb);
    expect(browse).not.toBeNull();
    expect(browse!.images).toHaveLength(1);
    expect(browse!.images[0]!.bytes.byteLength).toBe(png.byteLength);
    expect(browse!.images[0]!.bytes).toEqual(png);
    expect(browse!.images[0]!.bytes.buffer).not.toBe(split!.bin.buffer);
    expect(browse!.rigKind).toBe("none");
  });

  it("importModel copies omitted-offset GLB pixels onto a Texture with no Skeleton", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const glb = encodeGlbJsonBin(
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: png.byteLength }],
        bufferViews: [{ buffer: 0, byteLength: png.byteLength }],
        images: [{ mimeType: "image/png", bufferView: 0, name: "Albedo" }],
        textures: [{ source: 0 }],
        materials: [
          {
            name: "Rock",
            pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
          },
        ],
      },
      png,
    );
    const results = await importModel(glb, {
      fileName: "statue.glb",
      existingGuids: new Set(),
    });
    expect(results.some((r) => r.type === "Skeleton")).toBe(false);
    const model = results.find((r) => r.type === "Model")!;
    expect(model.payload.skeletonGuid).toBeNull();
    const texture = results.find((r) => r.type === "Texture")!;
    const pixels = texture.chunks.find((c) => c.kind === "pixels");
    expect(pixels?.data.byteLength).toBe(png.byteLength);
    expect(pixels?.data).toEqual(png);
  });
});

describe("embedGlbExternalImages", () => {
  it("rewrites an image uri into a bufferView using a sidecar PNG", () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const glb = encodeGlbJsonBin(
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: 0 }],
        images: [{ name: "texture-d", uri: "Textures/texture-d.png" }],
      },
      new Uint8Array(0),
    );
    const embedded = embedGlbExternalImages(glb, {
      "Textures/texture-d.png": png,
    });
    const split = splitGlbJsonBin(embedded);
    expect(split).not.toBeNull();
    const image = (split!.json.images as Array<{ uri?: string; bufferView?: number }>)[0];
    expect(image?.uri).toBeUndefined();
    expect(image?.bufferView).toBe(0);
    const browse = parseGlbForBrowse(embedded);
    expect(browse?.images[0]?.bytes).toEqual(png);
  });

  it("stripUnmatchedGltfImageUris removes relative image URIs so the GLB does not fetch", () => {
    const glb = kenneyStyleSidecarGlb();
    const stripped = stripUnmatchedGltfImageUris(glb);
    const split = splitGlbJsonBin(stripped);
    expect(split).not.toBeNull();
    const images = (split!.json.images as Array<{ uri?: string }>) ?? [];
    expect(images.some((image) => typeof image.uri === "string" && !image.uri.startsWith("data:"))).toBe(
      false,
    );
  });
});

describe("importModel sidecar GLB", () => {
  it("embeds ImportOptions.sidecars before browse so the Texture has pixels and pending encode", async () => {
    const glb = kenneyStyleSidecarGlb();
    const results = await importModel(glb, {
      fileName: "tree.glb",
      existingGuids: new Set(),
      sidecars: { "Textures/colormap.png": ONE_BY_ONE_PNG },
    });
    const model = results.find((result) => result.type === "Model")!;
    const source = model.chunks.find((chunk) => chunk.id === "source")!;
    const split = splitGlbJsonBin(source.data);
    const image = (split!.json.images as Array<{ uri?: string; bufferView?: number }>)[0];
    expect(image?.uri).toBeUndefined();
    expect(image?.bufferView).toBeDefined();
    const texture = results.find((result) => result.type === "Texture")!;
    const pixels = texture.chunks.find((chunk) => chunk.kind === "pixels");
    expect(pixels?.data).toEqual(ONE_BY_ONE_PNG);
    expect(texture.payload.compressionState).toBe("pending");
  });

  it("does not leave Compress pending when a Kenney-style URI has no sidecar", async () => {
    const results = await importModel(kenneyStyleSidecarGlb(), {
      fileName: "tree.glb",
      existingGuids: new Set(),
    });
    const model = results.find((result) => result.type === "Model")!;
    const source = model.chunks.find((chunk) => chunk.id === "source")!;
    const split = splitGlbJsonBin(source.data);
    const images = (split!.json.images as Array<{ uri?: string }>) ?? [];
    expect(
      images.some(
        (image) => typeof image.uri === "string" && !image.uri.startsWith("data:"),
      ),
    ).toBe(false);
    for (const texture of results.filter((result) => result.type === "Texture")) {
      const pixels = texture.chunks.find((chunk) => chunk.kind === "pixels");
      if (!pixels?.data.byteLength) {
        expect(texture.payload.compressionState).not.toBe("pending");
      }
    }
  });
});
