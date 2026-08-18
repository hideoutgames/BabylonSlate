import { describe, expect, it } from "vitest";
import { encodeBabasset } from "../babasset";
import { importAudio } from "./audio";
import { importBabasset } from "./babasset";
import { importFont } from "./font";
import { importImage } from "./image";
import { importModel } from "./model";
import { remapImportResultGuids } from "./guid-remap";

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
    const results = await importModel(new Uint8Array([9]), {
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
    const animation = results.find((result) => result.type === "Animation")!;
    expect(animation.payload).toEqual({ clipName: "Animation" });
  });

  it("imports audio", async () => {
    const results = await importAudio(new Uint8Array([1]), {
      fileName: "hit.wav",
      existingGuids: new Set(),
    });
    expect(results[0]!.type).toBe("Audio");
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
});
