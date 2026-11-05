import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { splitGlbJsonBin } from "./glb-parse";
import { embedGltfImportBatch } from "./gltf-import-batch";
import { importByExtension, isImportableFileName } from "./index";
import {
  describeSkippedZipEntries,
  expandImportZip,
  isZipArchive,
  zipImportFolderName,
  type ExpandImportZipOptions,
} from "./zip-import";

const text = (value: string) => new TextEncoder().encode(value);

function zip(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") });
}

function expand(bytes: Uint8Array, options: Partial<ExpandImportZipOptions> = {}) {
  return expandImportZip(bytes, { isImportable: isImportableFileName, ...options });
}

/** Rewrites fields of the central directory record for `name`, as another archiver would have written them. */
function patchCentralEntry(
  archive: Uint8Array,
  name: string,
  patch: { flags?: number; method?: number; size?: number },
): Uint8Array {
  const bytes = archive.slice();
  const view = new DataView(bytes.buffer);
  const encoded = text(name);
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const stored = bytes.subarray(offset + 46, offset + 46 + nameLength);
    if (nameLength !== encoded.length || !stored.every((byte, index) => byte === encoded[index])) continue;
    if (patch.flags !== undefined) view.setUint16(offset + 8, patch.flags, true);
    if (patch.method !== undefined) view.setUint16(offset + 10, patch.method, true);
    if (patch.size !== undefined) view.setUint32(offset + 24, patch.size, true);
    return bytes;
  }
  throw new Error(`No central record for ${name}`);
}

const names = (result: { files: Array<{ name: string }> }) => result.files.map((file) => file.name).sort();

describe("expandImportZip", () => {
  it("keeps the folders inside the ZIP and the files' bytes", async () => {
    const wood = Uint8Array.from({ length: 4096 }, (_, index) => index % 7);
    const result = await expand(zip({
      "Chair/chair.png": wood,
      "Chair/Textures/wood.png": new Uint8Array([1, 2, 3]),
      "beep.wav": new Uint8Array([4, 5]),
    }));
    expect(names(result)).toEqual(["Chair/Textures/wood.png", "Chair/chair.png", "beep.wav"]);
    expect(result.files.find((file) => file.name === "Chair/chair.png")!.bytes).toEqual(wood);
    expect(result.skipped).toEqual([]);
  });

  it("drops one folder that wraps every file, as a picked project folder's is", async () => {
    const wrapped = await expand(zip({
      "Props/chair.png": new Uint8Array([1]),
      "Props/Sub/lamp.png": new Uint8Array([2]),
      "Props/readme.txt": text("x"),
      "__MACOSX/Props/._chair.png": new Uint8Array([0]),
    }));
    expect(names(wrapped)).toEqual(["Sub/lamp.png", "chair.png"]);

    const mixed = await expand(zip({
      "Props/chair.png": new Uint8Array([1]),
      "lamp.png": new Uint8Array([2]),
    }));
    expect(names(mixed)).toEqual(["Props/chair.png", "lamp.png"]);
  });

  it("skips and lists unsupported files, macOS metadata, dot-files and ZIPs inside the ZIP", async () => {
    const result = await expand(zip({
      "Chair/chair.png": new Uint8Array([1]),
      "Chair/notes.txt": text("notes"),
      "Chair/.DS_Store": new Uint8Array([0]),
      ".git/config": text("x"),
      "__MACOSX/Chair/._chair.png": new Uint8Array([0]),
      "Chair/More.zip": zip({ "inner.png": new Uint8Array([9]) }),
      "beep.wav": new Uint8Array([2]),
    }));
    expect(names(result)).toEqual(["Chair/chair.png", "beep.wav"]);
    expect(result.skipped).toEqual([
      { path: "Chair/notes.txt", reason: "unsupported" },
      { path: "Chair/.DS_Store", reason: "metadata" },
      { path: ".git/config", reason: "metadata" },
      { path: "__MACOSX/Chair/._chair.png", reason: "metadata" },
      { path: "Chair/More.zip", reason: "nested-zip" },
    ]);
    const lines = describeSkippedZipEntries(result.skipped);
    expect(lines).toHaveLength(3);
    expect(lines.find((line) => line.includes("Chair/notes.txt"))).toMatch(/^Skipped 1 /);
    expect(lines.find((line) => line.includes("Chair/More.zip"))).toBeDefined();
    expect(lines.find((line) => line.includes("__MACOSX/Chair/._chair.png"))).toMatch(/^Skipped 3 /);
  });

  it("rejects absolute and .. paths, and reads backslashes as folder separators", async () => {
    const result = await expand(zip({
      "../escape.png": new Uint8Array([1]),
      "Chair/../../escape.png": new Uint8Array([1]),
      "/etc/absolute.png": new Uint8Array([1]),
      "C:/Users/drive.png": new Uint8Array([1]),
      "Chair\\Legs\\leg.png": new Uint8Array([2]),
      "./Chair/./seat.png": new Uint8Array([3]),
      "Bad:Name/x.png": new Uint8Array([4]),
      "top.png": new Uint8Array([5]),
    }));
    expect(names(result)).toEqual(["Chair/Legs/leg.png", "Chair/seat.png", "top.png"]);
    expect(result.skipped.map((entry) => entry.reason)).toEqual(Array(5).fill("unsafe-path"));
    expect(result.skipped.map((entry) => entry.path).sort()).toEqual([
      "../escape.png",
      "/etc/absolute.png",
      "Bad:Name/x.png",
      "C:/Users/drive.png",
      "Chair/../../escape.png",
    ]);
  });

  it("skips encrypted entries and ones compressed with anything but Stored or Deflate", async () => {
    let archive = zip({
      "secret.png": new Uint8Array([1, 2, 3]),
      "lzma.png": new Uint8Array([4, 5, 6]),
      "plain.png": new Uint8Array([7]),
    });
    archive = patchCentralEntry(archive, "secret.png", { flags: 0x1 });
    archive = patchCentralEntry(archive, "lzma.png", { method: 14 });
    const result = await expand(archive);
    expect(names(result)).toEqual(["plain.png"]);
    expect(result.skipped).toEqual([
      { path: "secret.png", reason: "encrypted" },
      { path: "lzma.png", reason: "compression" },
    ]);
  });

  it("refuses a ZIP whose importable files expand past the size limit, and imports one at it", async () => {
    const entries = { "a.png": new Uint8Array(600), "b.png": new Uint8Array(400), "notes.txt": new Uint8Array(5000) };
    // Skipped files are never expanded, so they do not count.
    await expect(expand(zip(entries), { maxExpandedBytes: 1000 })).resolves.toMatchObject({ files: [{}, {}] });
    await expect(expand(zip(entries), { maxExpandedBytes: 999 })).rejects.toThrow(/expand to more than/);
  });

  it("stops an entry that inflates past the size its header records, so a lying header cannot grow memory", async () => {
    const archive = patchCentralEntry(zip({ "bomb.png": new Uint8Array(200_000), "ok.png": new Uint8Array([1]) }), "bomb.png", { size: 10 });
    const result = await expand(archive);
    expect(names(result)).toEqual(["ok.png"]);
    expect(result.skipped).toEqual([{ path: "bomb.png", reason: "damaged" }]);
  });

  it("refuses a ZIP with more entries than the limit, folders included", async () => {
    const entries = { "A/": new Uint8Array(0), "A/a.png": new Uint8Array([1]), "b.png": new Uint8Array([2]) };
    await expect(expand(zip(entries), { maxEntries: 3 })).resolves.toMatchObject({ files: [{}, {}] });
    await expect(expand(zip(entries), { maxEntries: 2 })).rejects.toThrow(/more than 2 files and folders/);
  });

  it("refuses bytes that are not a ZIP", async () => {
    await expect(expand(text("not a zip at all"))).rejects.toThrow(/Not a ZIP archive/);
    expect(isZipArchive(text("not a zip at all"))).toBe(false);
    expect(isZipArchive(zip({ "a.png": new Uint8Array([1]) }))).toBe(true);
  });

  it("stops with the abort reason when cancelled", async () => {
    const controller = new AbortController();
    const archive = zip({ "a.png": new Uint8Array([1]), "b.png": new Uint8Array([2]) });
    const pending = expand(archive, {
      signal: controller.signal,
      isImportable: (name) => {
        // Cancelled while the import is under way.
        controller.abort();
        return isImportableFileName(name);
      },
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("zipImportFolderName", () => {
  it("names the folder after the ZIP, as a name the Content Browser accepts", () => {
    expect(zipImportFolderName("Props.zip")).toBe("Props");
    expect(zipImportFolderName("Kenney Pack.ZIP")).toBe("Kenney Pack");
    expect(zipImportFolderName("a:b.zip")).toBe("a_b");
    expect(zipImportFolderName(".zip")).toBe("Imported");
  });
});

describe("ZIP glTF sidecars", () => {
  const PNG = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
    0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
    0x41, 0x54, 0x78, 0xda, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01,
    0x00, 0xf7, 0x03, 0x41, 0x43, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ]);

  /** A glTF naming `scene.bin` beside it and `textures/color.png` below it, as exporters write them. */
  const sceneGltf = text(JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ uri: "scene.bin", byteLength: 4 }],
    images: [{ uri: "textures/color.png" }],
    textures: [{ source: 0 }],
    materials: [{ name: "Paint", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
  }));

  it("embeds each model's own BIN and texture when two folders use the same file names", async () => {
    const tablePng = Uint8Array.from([...PNG, 0]);
    const { files } = await expand(zip({
      "Chair/scene.gltf": sceneGltf,
      "Chair/scene.bin": new Uint8Array([1, 2, 3, 4]),
      "Chair/textures/color.png": PNG,
      "Table/scene.gltf": sceneGltf,
      "Table/scene.bin": new Uint8Array([5, 6, 7, 8]),
      "Table/textures/color.png": tablePng,
    }));
    const embedded = embedGltfImportBatch(files);
    expect(embedded.warnings).toEqual([]);
    expect(embedded.files.map((file) => file.name).sort()).toEqual(["Chair/scene.glb", "Table/scene.glb"]);
    for (const [model, bin, png] of [["Chair/scene.glb", [1, 2, 3, 4], PNG], ["Table/scene.glb", [5, 6, 7, 8], tablePng]] as const) {
      const glb = splitGlbJsonBin(embedded.files.find((file) => file.name === model)!.bytes)!;
      const image = (glb.json.images as Array<{ uri?: string; bufferView?: number }>)[0]!;
      expect(image.uri).toBeUndefined();
      const view = (glb.json.bufferViews as Array<{ byteOffset: number; byteLength: number }>)[image.bufferView!]!;
      expect(Array.from(glb.bin.subarray(0, 4))).toEqual(bin);
      expect(glb.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength)).toEqual(png);
    }

    // The model imports with its texture, as the Content Browser imports it.
    const chair = embedded.files.find((file) => file.name === "Chair/scene.glb")!;
    const results = await importByExtension("scene.glb", chair.bytes, { fileName: "scene.glb", existingGuids: new Set() });
    expect(results.map((result) => result.type).sort()).toEqual(["Material", "Model", "Texture"]);
  });
});
