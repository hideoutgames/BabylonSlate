import { describe, expect, it } from "vitest";
import { ASSET_TYPES } from "@babylonslate/core";
import { encodeBabasset } from "../babasset";
import { importAudio, mimeForAudioBytes } from "./audio";
import { importBabasset } from "./babasset";
import { importFont } from "./font";
import { importImage } from "./image";
import { importModel } from "./model";
import { remapImportResultGuids } from "./guid-remap";
import {
  importByExtension,
  importerForExtension,
  registeredImportAccept,
  pickerImportAccept,
} from "./index";
import { buildBoxGlbFixture } from "../glb-geometry";
import { buildMinimalGlbFixture } from "./glb-parse";
import { gifHeader, webpHeader } from "../test-support/image-headers";

describe("importers", () => {
  it("imports images as Texture with pending compression state", async () => {
    const results = await importImage(new Uint8Array([1, 2, 3]), {
      fileName: "albedo.png",
      existingGuids: new Set(),
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe("Texture");
    expect(results[0]!.payload.compressionState).toBe("pending");
    expect(results[0]!.chunks[0]!.kind).toBe("pixels");
  });

  it("records the source size of WebP and GIF imports, as for PNG and JPEG", async () => {
    for (const [fileName, bytes] of [["leaf.webp", webpHeader("VP8L", 30, 20)], ["leaf.gif", gifHeader(30, 20)]] as const) {
      const [texture] = await importImage(bytes, { fileName, existingGuids: new Set() });
      expect(texture!.payload, fileName).toMatchObject({ width: 30, height: 20 });
    }
  });

  it("leaves pixel-art images uncompressed by policy", async () => {
    const results = await importImage(new Uint8Array([1, 2, 3]), {
      fileName: "hero_pixel.png",
      existingGuids: new Set(),
    });
    expect(results[0]!.payload.usage).toBe("pixelArt");
    expect(results[0]!.payload.compressionState).toBeUndefined();
  });

  it("imports lookup tables as uncompressed Color Grading textures", async () => {
    for (const fileName of ["Sunset_LUT.png", "lut-warm.png", "color_grading_teal.png"]) {
      const [texture] = await importImage(new Uint8Array([1, 2, 3]), { fileName, existingGuids: new Set() });
      expect(texture!.payload.usage, fileName).toBe("colorGrading");
      expect(texture!.payload.compressionState, fileName).toBeUndefined();
    }
    const [salute] = await importImage(new Uint8Array([1, 2, 3]), { fileName: "salute.png", existingGuids: new Set() });
    expect(salute!.payload.usage).toBe("albedo");
  });

  it("infers Usage from whole words of the file name only", async () => {
    const usages: Record<string, string> = {
      "rock_normal.png": "normal",
      "RockNormal.png": "normal",
      "abnormal_growth.png": "albedo",
      "normalized_noise.png": "albedo",
      "ok_button.png": "ui",
      "buttonhole.png": "albedo",
      "Hero_Spritesheet.png": "pixelArt",
      "pixelated_sky.png": "albedo",
      "tileset01.png": "pixelArt",
    };
    for (const [fileName, usage] of Object.entries(usages)) {
      const [texture] = await importImage(new Uint8Array([1, 2, 3]), { fileName, existingGuids: new Set() });
      expect(texture!.payload.usage, fileName).toBe(usage);
    }
  });

  it("imports models with material/texture/animation dependents", async () => {
    const results = await importModel(buildMinimalGlbFixture({ animationName: "Walk" }), {
      fileName: "hero.glb",
      existingGuids: new Set(),
    });
    const types = results.map((result) => result.type).sort();
    expect(types).toContain("Model");
    expect(types).toContain("Material");
    expect(types).toContain("Texture");
    expect(types).toContain("Animation");
    const model = results.find((result) => result.type === "Model")!;
    expect(model.dependencies.length).toBeGreaterThan(0);
    expect(model.payload.clipNames).toEqual(["Walk"]);
    expect(model.payload.importScale).toBe(1);
    // Extracted images record their source size like image imports (the fixture's PNG is 1x1).
    expect(results.find((result) => result.type === "Texture")!.payload).toMatchObject({ width: 1, height: 1 });
  });

  it("stamps ImportOptions.modelImportScale onto the Model payload", async () => {
    const results = await importModel(buildMinimalGlbFixture(), {
      fileName: "hero.glb",
      existingGuids: new Set(),
      modelImportScale: 4,
    });
    const model = results.find((result) => result.type === "Model")!;
    expect(model.payload.importScale).toBe(4);
  });

  it("stamps one generated collider on a static mesh import", async () => {
    const results = await importModel(buildBoxGlbFixture(1), {
      fileName: "crate.glb",
      existingGuids: new Set(),
    });
    const model = results.find((result) => result.type === "Model")!;
    expect(model.payload.skeletonGuid).toBeNull();
    const colliders = model.payload.simpleColliders as Array<{ kind: string }>;
    expect(colliders).toHaveLength(1);
    expect(colliders[0]!.kind).toBe("generated");
  });

  it("gives a model whose file has no materials a plain Material, not one sampling an empty Texture", async () => {
    const results = await importModel(buildBoxGlbFixture(1), {
      fileName: "crate.glb",
      existingGuids: new Set(),
    });
    // A sampler with no image reads transparent black, so the model would draw black.
    expect(results.filter((result) => result.type === "Texture")).toEqual([]);
    const material = results.find((result) => result.type === "Material")!;
    expect(material.dependencies).toEqual([]);
    const nodes = (material.payload as { nodes: { type: string }[] }).nodes;
    expect(nodes.map((node) => node.type)).not.toContain("texture.sample");
    expect(nodes.map((node) => node.type)).toContain("const.color");
    const model = results.find((result) => result.type === "Model")!;
    expect(model.dependencies).toEqual([material.guid]);
    expect(model.payload.materialSlots).toEqual([
      expect.objectContaining({ index: 0, materialGuid: material.guid }),
    ]);
  });

  it("leaves simpleColliders empty when the GLB creates a Skeleton", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const bytes = new Uint8Array(
      await readFile(
        resolve("engine-content/kenney-assets/Mannequin/mannequin.glb"),
      ),
    );
    const results = await importModel(bytes, {
      fileName: "mannequin.glb",
      existingGuids: new Set(),
    });
    const model = results.find((result) => result.type === "Model")!;
    expect(model.payload.skeletonGuid).toEqual(expect.any(String));
    expect(model.payload.simpleColliders).toEqual([]);
  });

  it("uniquifies duplicate glTF image names so Kenney Mannequin can import", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const bytes = new Uint8Array(
      await readFile(
        resolve("engine-content/kenney-assets/Mannequin/mannequin.glb"),
      ),
    );
    const results = await importModel(bytes, {
      fileName: "mannequin.glb",
      existingGuids: new Set(),
    });
    const names = results.map((result) => result.name);
    expect(names).toContain("mannequin");
    expect(new Set(names).size).toBe(names.length);
    expect(
      results.find((result) => result.type === "Skeleton")?.payload.kind,
    ).toBe("hierarchy");
    expect(
      results.filter((result) => result.type === "Animation"),
    ).toHaveLength(27);
    expect(
      results.find((result) => result.type === "Material")?.payload.shadingModel,
    ).toBe("unlit");
  });

  it("gives every imported asset a type the Asset Registry nodes can target", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const mannequin = new Uint8Array(
      await readFile(resolve("engine-content/kenney-assets/Mannequin/mannequin.glb")),
    );
    const options = (fileName: string) => ({ fileName, existingGuids: new Set<string>() });
    const imported = [
      ...(await importByExtension("mannequin.glb", mannequin, options("mannequin.glb"))),
      ...(await importByExtension("albedo.png", new Uint8Array([1, 2, 3]), options("albedo.png"))),
      ...(await importByExtension("hit.wav", new Uint8Array([1]), options("hit.wav"))),
      ...(await importByExtension("Ui.woff2", new Uint8Array([1, 2]), options("Ui.woff2"))),
    ];
    // The fixtures reach every kind of asset the importers create.
    expect(new Set(imported.map((result) => result.type))).toEqual(
      new Set(["Model", "Material", "Texture", "Skeleton", "Animation", "Audio", "Font"]),
    );
    for (const result of imported) expect(ASSET_TYPES, result.type).toContain(result.type);
  });

  it("rejects OBJ, STL, FBX, and invalid GLB bytes", async () => {
    await expect(
      importByExtension("mesh.obj", new Uint8Array([1]), {
        fileName: "mesh.obj",
        existingGuids: new Set(),
      }),
    ).rejects.toThrow(/No importer registered/i);
    await expect(
      importModel(new Uint8Array([1]), { fileName: "mesh.obj", existingGuids: new Set() }),
    ).rejects.toThrow(/GLB or glTF/i);
    await expect(
      importByExtension("mesh.stl", new Uint8Array([1]), {
        fileName: "mesh.stl",
        existingGuids: new Set(),
      }),
    ).rejects.toThrow(/No importer registered/i);
    await expect(
      importByExtension("hero.fbx", new Uint8Array([1]), {
        fileName: "hero.fbx",
        existingGuids: new Set(),
      }),
    ).rejects.toThrow(/No importer registered/i);
    await expect(
      importModel(new Uint8Array([9]), {
        fileName: "hero.glb",
        existingGuids: new Set(),
      }),
    ).rejects.toThrow(/GLB or glTF/i);
    expect(importerForExtension("obj")).toBeUndefined();
    expect(importerForExtension("stl")).toBeUndefined();
    expect(importerForExtension("bin")).toBeUndefined();
    expect(importerForExtension("mtl")).toBeUndefined();
    expect(registeredImportAccept()).toMatch(/\.glb/);
    expect(registeredImportAccept()).toMatch(/\.gltf/);
    expect(registeredImportAccept()).not.toMatch(/\.fbx/);
    expect(registeredImportAccept()).not.toMatch(/\.stl/);
    expect(registeredImportAccept()).not.toMatch(/\.bin/);
    expect(registeredImportAccept()).not.toMatch(/\.mtl/);
    expect(pickerImportAccept()).toMatch(/\.obj/);
    expect(pickerImportAccept()).toMatch(/\.bin/);
    expect(pickerImportAccept()).toMatch(/\.mtl/);
    expect(pickerImportAccept()).toMatch(/\.fbx/);
    expect(pickerImportAccept()).toMatch(/\.stl/);
  });

  it("imports audio with the MIME its bytes carry, else its extension's", async () => {
    const results = await importAudio(new Uint8Array([1]), {
      fileName: "hit.wav",
      existingGuids: new Set(),
    });
    expect(results[0]!.type).toBe("Audio");
    expect(results[0]!.chunks[0]!.mime).toBe("audio/wav");
    // An MP3 saved with a .wav name.
    const renamed = await importAudio(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
      fileName: "hit.wav",
      existingGuids: new Set(),
    });
    expect(renamed[0]!.chunks[0]!.mime).toBe("audio/mpeg");
  });

  it("labels preview blobs from WAV, MP3, and OGG bytes", () => {
    const wav = new Uint8Array(12);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    wav.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(mimeForAudioBytes(wav)).toBe("audio/wav");
    expect(mimeForAudioBytes(new Uint8Array([0x49, 0x44, 0x33, 0x04]))).toBe(
      "audio/mpeg",
    );
    expect(mimeForAudioBytes(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe(
      "audio/mpeg",
    );
    expect(
      mimeForAudioBytes(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00])),
    ).toBe("audio/ogg");
  });

  it("imports fonts and attaches facetype JSON to an existing Font", async () => {
    const font = await importFont(new Uint8Array([1, 2]), {
      fileName: "Ui.woff2",
      existingGuids: new Set(),
    });
    expect(font[0]!.type).toBe("Font");
    expect(font[0]!.payload.family).toBe("Ui");
    expect((font[0]!.payload.representations as { source: boolean }).source).toBe(
      true,
    );

    const attached = await importFont(
      new TextEncoder().encode(JSON.stringify({ glyphs: [] })),
      {
        fileName: "Ui.facetype.json",
        existingGuids: new Set([font[0]!.guid]),
        fontGuidsByName: new Map([["Ui", font[0]!.guid]]),
      },
    );
    expect(attached[0]!.attachToGuid).toBe(font[0]!.guid);
    expect(attached[0]!.chunks[0]!.kind).toBe("font-facetype");
    expect(attached[0]!.chunks[0]!.id).toBe("facetype-glyphs");
  });

  it("imports an MSDF JSON+PNG pair as Font chunks, not a Texture", async () => {
    const json = new TextEncoder().encode(
      JSON.stringify({ pages: ["Ui-msdf.png"], chars: [] }),
    );
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const created = await importFont(json, {
      fileName: "Ui-msdf.json",
      existingGuids: new Set(),
      sidecars: { "Ui-msdf.png": png },
    });
    expect(created[0]!.type).toBe("Font");
    expect(created[0]!.attachToGuid).toBeUndefined();
    expect(created[0]!.payload.representations).toMatchObject({
      source: false,
      msdfJson: true,
      msdfPng: true,
      msdf: true,
    });
    expect(created[0]!.chunks.map((chunk) => chunk.id).sort()).toEqual([
      "msdf-atlas",
      "msdf-atlas-png",
    ]);
  });

  it("recognizes font glyph JSON by the generators' shape and rejects other JSON", async () => {
    const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const options = (fileName: string) => ({ fileName, existingGuids: new Set<string>() });
    const [msdf] = await importByExtension("Ui.json", json({ info: { size: 32 }, chars: [] }), options("Ui.json"));
    expect(msdf!.chunks[0]!.kind).toBe("font-msdf");
    const [facetype] = await importByExtension("Ui.json", json({ glyphs: {}, resolution: 1000 }), options("Ui.json"));
    expect(facetype!.chunks[0]!.kind).toBe("font-facetype");
    for (const value of [{ atlas: "sheet.png", frames: {} }, { chars: "abc" }, { facetype: true }, { name: "config" }]) {
      await expect(importByExtension("data.json", json(value), options("data.json")), JSON.stringify(value))
        .rejects.toThrow(/not a font file/);
    }
  });

  it("attaches an MSDF PNG named with msdf to an existing Font and leaves MSDF incomplete without JSON", async () => {
    const attached = await importFont(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      fileName: "Ui-msdf.png",
      existingGuids: new Set(["font-ui"]),
      fontGuidsByName: new Map([["Ui", "font-ui"]]),
    });
    expect(attached[0]!.attachToGuid).toBe("font-ui");
    expect(attached[0]!.chunks[0]).toMatchObject({
      id: "msdf-atlas-png",
      kind: "font-msdf-png",
    });
    expect(attached[0]!.payload.representations).toMatchObject({
      msdfJson: false,
      msdfPng: true,
      msdf: false,
    });
  });

  it("routes an MSDF PNG through importByExtension instead of creating a Texture", async () => {
    const results = await importByExtension(
      "Roboto.msdf.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      { fileName: "Roboto.msdf.png", existingGuids: new Set() },
    );
    expect(results[0]!.type).toBe("Font");
    expect(results[0]!.chunks[0]!.id).toBe("msdf-atlas-png");
  });

  it("imports .babasset and remaps colliding guids", async () => {
    const bytes = await encodeBabasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
        guid: "taken",
        type: "Texture",
        name: "Tex",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: {},
      },
      chunks: [
        {
          id: "pixels",
          kind: "pixels",
          mime: "image/png",
          data: new Uint8Array([1]),
        },
      ],
    });
    const results = await importBabasset(bytes, {
      fileName: "tex.babasset",
      existingGuids: new Set(["taken"]),
    });
    const remapped = remapImportResultGuids(results, new Set(["taken"]));
    expect(remapped[0]!.guid).not.toBe("taken");
  });

  it("rewrites Audio payload guids when the batch remaps", async () => {
    const remapped = remapImportResultGuids(
      [
        {
          type: "Audio",
          name: "Jump",
          guid: "audio-1",
          version: 1,
          dependencies: ["ch-1", "att-1"],
          parentClass: null,
          payload: {
            volume: 1,
            audioChannelGuid: "ch-1",
            soundAttenuationGuid: "att-1",
          },
          chunks: [],
        },
        {
          type: "AudioChannel",
          name: "SFX",
          guid: "ch-1",
          version: 1,
          dependencies: [],
          parentClass: null,
          payload: { parentChannelGuid: null, effects: [] },
          chunks: [],
        },
      ],
      new Set(["ch-1"]),
    );
    const audio = remapped.find((entry) => entry.type === "Audio")!;
    const channel = remapped.find((entry) => entry.type === "AudioChannel")!;
    expect(channel.guid).not.toBe("ch-1");
    expect(audio.payload.audioChannelGuid).toBe(channel.guid);
    expect(audio.dependencies).toContain(channel.guid);
  });
});


it("remaps native Input Type references inside document chunks and nested graph defaults", () => {
  const value = { functionGraphs: { fn: { nodes: [{ data: { "default:input": { Name: "Jump", Asset: "jump" } } }] } } };
  const results = remapImportResultGuids([
    { type: "InputAction", name: "Jump", guid: "jump", version: 1, dependencies: [], payload: {}, chunks: [] },
    { type: "Class", name: "Player", guid: "player", version: 1, dependencies: ["jump"], payload: value, chunks: [{ id: "document", kind: "document", mime: "application/json", data: new TextEncoder().encode(JSON.stringify(value)) }] },
  ], new Set(["jump"]));
  const guid = results[0]!.guid;
  expect(guid).not.toBe("jump");
  const expected = { functionGraphs: { fn: { nodes: [{ data: { "default:input": { Name: "Jump", Asset: guid } } }] } } };
  expect(results[1]!.payload).toEqual(expected);
  expect(JSON.parse(new TextDecoder().decode(results[1]!.chunks[0]!.data))).toEqual(expected);
  expect(results[1]!.dependencies).toEqual([guid]);
});

it("refuses a colliding import whose document cannot be remapped instead of keeping its old references", () => {
  expect(() => remapImportResultGuids([
    { type: "InputAction", name: "Jump", guid: "jump", version: 1, dependencies: [], payload: {}, chunks: [] },
    { type: "Class", name: "Player", guid: "player", version: 1, dependencies: ["jump"], payload: {}, chunks: [{ id: "document", kind: "document", mime: "application/json", data: new TextEncoder().encode("{ not json") }] },
  ], new Set(["jump"]))).toThrow(/Player.*Nothing was imported/);
});

it("remaps every stored reference to a colliding asset, keeping values declared as text", () => {
  const asset = (type: string, guid: string, payload: Record<string, unknown>, document?: Record<string, unknown>) => ({
    type, name: guid, guid, version: 1, dependencies: [], payload,
    chunks: document ? [{ id: "document", kind: "document", mime: "application/json", data: new TextEncoder().encode(JSON.stringify(document)) }] : [],
  });
  const scene = { actors: [{ id: "a", classId: "Actor", components: [
    { id: "mesh", classId: "MeshComponent", properties: { assetGuid: "tex", materialSlotOverrides: { Body: "mat" } } },
    { id: "label", classId: "2DRichTextComponent", properties: { text: "Coin [img=tex size=14] x3 [IMG=other]" } },
  ] }] };
  const player = {
    members: [
      { kind: "variable", name: "Skin", typeId: "asset", typeClassId: "Texture", defaultValue: "tex" },
      { kind: "variable", name: "Caption", typeId: "string", defaultValue: "tex" },
    ],
    functionGraphs: { fn: { nodes: [{ data: { dataSchema: [{ name: "Caption", typeId: "string" }], "default:values": { Caption: "tex" } } }] } },
  };
  const results = remapImportResultGuids([
    asset("Texture", "tex", {}),
    asset("Material", "mat", {}),
    asset("Font", "fallback", {}),
    asset("Tileset", "set", { textureGuid: "tex" }),
    asset("Sprite", "sprite", { textureGuid: "tex" }),
    asset("Tilemap", "map", { tilesets: [{ guid: "set", firstGid: 1, tileCount: 4 }] }),
    asset("Font", "font", { fallbackGuids: ["fallback"] }),
    asset("Water", "water", { materialGuid: "mat" }),
    asset("SkyboxCreator", "sky", { sourceTextureGuid: "tex", generatedFaces: { px: "tex", nx: null } }),
    asset("MaterialInstance", "inst", { parentGuid: "mat" }, { parentGuid: "mat", overrides: { Albedo: { kind: "texture", textureAssetGuid: "tex" } } }),
    asset("Scene", "scene", {}, scene),
    asset("Class", "player", player, player),
  ], new Set(["tex", "mat", "set", "fallback"]));
  const guid = (name: string) => results.find((entry) => entry.name === name)!.guid;
  const payload = (name: string) => results.find((entry) => entry.name === name)!.payload;
  const document = (name: string) => JSON.parse(new TextDecoder().decode(results.find((entry) => entry.name === name)!.chunks[0]!.data));
  for (const name of ["tex", "mat", "set", "fallback"]) expect(guid(name)).not.toBe(name);
  expect(payload("set")).toEqual({ textureGuid: guid("tex") });
  expect(payload("sprite")).toEqual({ textureGuid: guid("tex") });
  expect(payload("map")).toEqual({ tilesets: [{ guid: guid("set"), firstGid: 1, tileCount: 4 }] });
  expect(payload("font")).toEqual({ fallbackGuids: [guid("fallback")] });
  expect(payload("water")).toEqual({ materialGuid: guid("mat") });
  expect(payload("sky")).toEqual({ sourceTextureGuid: guid("tex"), generatedFaces: { px: guid("tex"), nx: null } });
  expect(document("inst")).toEqual({ parentGuid: guid("mat"), overrides: { Albedo: { kind: "texture", textureAssetGuid: guid("tex") } } });
  expect(document("scene").actors[0].components[0].properties).toEqual({ assetGuid: guid("tex"), materialSlotOverrides: { Body: guid("mat") } });
  expect(document("scene").actors[0].components[1].properties.text).toBe(`Coin [img=${guid("tex")} size=14] x3 [IMG=other]`);
  expect(document("player").members.map((member: { defaultValue: unknown }) => member.defaultValue)).toEqual([guid("tex"), "tex"]);
  expect(document("player").functionGraphs.fn.nodes[0].data["default:values"]).toEqual({ Caption: "tex" });
  expect(payload("player")).toEqual(document("player"));
});
