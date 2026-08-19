import { describe, expect, it } from "vitest";
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
import { buildMinimalGlbFixture } from "./glb-parse";

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

  it("leaves pixel-art images uncompressed by policy", async () => {
    const results = await importImage(new Uint8Array([1, 2, 3]), {
      fileName: "hero_pixel.png",
      existingGuids: new Set(),
    });
    expect(results[0]!.payload.usage).toBe("pixelArt");
    expect(results[0]!.payload.compressionState).toBeUndefined();
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
  });

  it("rejects OBJ, STL, FBX, and invalid GLB bytes", async () => {
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
    expect(registeredImportAccept()).toMatch(/\.glb/);
    expect(registeredImportAccept()).toMatch(/\.gltf/);
    expect(registeredImportAccept()).not.toMatch(/\.fbx/);
    expect(registeredImportAccept()).not.toMatch(/\.stl/);
    expect(pickerImportAccept()).toMatch(/\.obj/);
    expect(pickerImportAccept()).not.toMatch(/\.fbx/);
  });

  it("imports audio", async () => {
    const results = await importAudio(new Uint8Array([1]), {
      fileName: "hit.wav",
      existingGuids: new Set(),
    });
    expect(results[0]!.type).toBe("Audio");
    expect(results[0]!.chunks[0]!.mime).toBe("audio/wav");
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
  });

  it("imports .babasset and remaps colliding guids", async () => {
    const bytes = await encodeBabasset({
      header: {
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

  it("returns the same array when no imported guid collides", () => {
    const results = [
      {
        type: "Model",
        name: "Hero",
        guid: "model-1",
        version: 1,
        dependencies: ["skel-1"],
        parentClass: null,
        payload: {
          clipNames: ["Idle"],
          skeletonGuid: "skel-1",
          materialSlots: [],
        },
        chunks: [],
      },
    ];
    expect(remapImportResultGuids(results, new Set(["other"]))).toBe(results);
  });

  it("rewrites Model, Skeleton, and Animation guids together when a Model collides", () => {
    const remapped = remapImportResultGuids(
      [
        {
          type: "Model",
          name: "Hero",
          guid: "model-1",
          version: 1,
          dependencies: ["skel-1", "mat-1"],
          parentClass: null,
          payload: {
            clipNames: ["Idle"],
            skeletonGuid: "skel-1",
            materialSlots: [
              { index: 0, name: "Body", materialGuid: "mat-1" },
            ],
          },
          chunks: [],
        },
        {
          type: "Skeleton",
          name: "Hero_Skeleton",
          guid: "skel-1",
          version: 1,
          dependencies: ["model-1"],
          parentClass: null,
          payload: {
            modelGuid: "model-1",
            kind: "hierarchy",
            boneNames: ["root"],
          },
          chunks: [],
        },
        {
          type: "Animation",
          name: "Idle",
          guid: "anim-1",
          version: 1,
          dependencies: ["model-1", "skel-1"],
          parentClass: null,
          payload: {
            clipName: "Idle",
            modelGuid: "model-1",
            skeletonGuid: "skel-1",
          },
          chunks: [],
          attachToGuid: "model-1",
        },
        {
          type: "Material",
          name: "Body",
          guid: "mat-1",
          version: 1,
          dependencies: [],
          parentClass: null,
          payload: {},
          chunks: [],
        },
      ],
      new Set(["model-1"]),
    );
    const model = remapped.find((entry) => entry.type === "Model")!;
    const skeleton = remapped.find((entry) => entry.type === "Skeleton")!;
    const animation = remapped.find((entry) => entry.type === "Animation")!;
    const material = remapped.find((entry) => entry.type === "Material")!;
    expect(model.guid).not.toBe("model-1");
    expect(skeleton.guid).toBe("skel-1");
    expect(material.guid).toBe("mat-1");
    expect(model.payload.skeletonGuid).toBe("skel-1");
    expect(skeleton.payload.modelGuid).toBe(model.guid);
    expect(skeleton.dependencies).toEqual([model.guid]);
    expect(animation.payload.modelGuid).toBe(model.guid);
    expect(animation.payload.skeletonGuid).toBe("skel-1");
    expect(animation.dependencies).toEqual([model.guid, "skel-1"]);
    expect(animation.attachToGuid).toBe(model.guid);
  });
});
