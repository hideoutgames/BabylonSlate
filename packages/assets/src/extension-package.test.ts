import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { encodeAssetDocument } from "./asset-document";
import { decodeProjectZip, encodeProjectZip, exportProjectZip, writeProjectTree } from "./hproject";
import { projectContentRoot } from "./content-root";
import { createExtensionSettings, discoverEngineExtensions, discoverProjectExtensions, shadowEngineExtensions, writeProjectExtension } from "./extension-host";
import * as fflate from "fflate";
import { applyExtensionImport, exportExtensionZip, inspectHextension, installEngineExtensionDefaults, planExtensionImport, unpackEngineExtensionZip, unzipExtensionArchive } from "./extension-package";
import { encodeExtensionSettings } from "./extension-settings";
import { AssetRegistry } from "./registry";

const text = (value: string) => new TextEncoder().encode(value);

/**
 * A one-file ZIP whose deflate data is a literal zero then `copies` 258-byte
 * back-references (fixed Huffman), so it inflates to 1 + 258 × copies bytes,
 * while both headers declare `declaredSize`.
 */
function zeroBombZip(name: string, copies: number, declaredSize: number): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let count = 0;
  const write = (value: number, length: number) => {
    for (let index = 0; index < length; index += 1) {
      bits |= ((value >> index) & 1) << count;
      count += 1;
      if (count === 8) { out.push(bits); bits = 0; count = 0; }
    }
  };
  // Huffman codes go most significant bit first.
  const code = (value: number, length: number) => { for (let index = length - 1; index >= 0; index -= 1) write((value >> index) & 1, 1); };
  write(1, 1); // final block
  write(1, 2); // fixed Huffman
  code(0x30, 8); // literal 0
  for (let index = 0; index < copies; index += 1) {
    code(0xc5, 8); // length 258 (symbol 285)
    code(0, 5); // distance 1
  }
  code(0, 7); // end of block
  if (count > 0) out.push(bits);
  const data = Uint8Array.from(out);
  const fileName = text(name);
  const local = new Uint8Array(30 + fileName.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(8, 8, true);
  localView.setUint32(18, data.length, true);
  localView.setUint32(22, declaredSize, true);
  localView.setUint16(26, fileName.length, true);
  local.set(fileName, 30);
  const central = new Uint8Array(46 + fileName.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(10, 8, true);
  centralView.setUint32(20, data.length, true);
  centralView.setUint32(24, declaredSize, true);
  centralView.setUint16(28, fileName.length, true);
  central.set(fileName, 46);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length + data.length, true);
  const zip = new Uint8Array(local.length + data.length + central.length + end.length);
  zip.set(local, 0);
  zip.set(data, local.length);
  zip.set(central, local.length + data.length);
  zip.set(end, local.length + data.length + central.length);
  return zip;
}

async function storage() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Extensions");
  return storage;
}

async function extensionPackage() {
  const source = await storage();
  const settings = { ...createExtensionSettings("Tools", "tools"), engineVersion: "0.1", experimental: true };
  const descriptor = await writeProjectExtension(source, "tools", settings, "export function activate(api) { api.log('ready'); }");
  await source.writeText("extensions/tools/assets/template.txt", "template");
  await source.mkdir("extensions/tools/assets/.blobs", true);
  await source.writeBinary("extensions/tools/assets/.blobs/blob", new Uint8Array([9, 2]));
  return { source, descriptor, incoming: await inspectHextension(await exportExtensionZip(source, descriptor)) };
}

describe("Extension packages", () => {
  it("round-trips module source, assets, blobs and author metadata independently of Plugins", async () => {
    const { incoming } = await extensionPackage();
    const target = await storage();
    const installed = await applyExtensionImport(target, incoming, { kind: "install", folderName: "imported-tools" });
    expect(installed.settings).toMatchObject({ extensionGuid: "tools", engineVersion: "0.1", experimental: true, entryPoint: "index.ts" });
    expect(await target.readText("extensions/imported-tools/index.ts")).toBe("export function activate(api) { api.log('ready'); }");
    expect(await target.readText("extensions/imported-tools/assets/template.txt")).toBe("template");
    expect(await target.readBinary("extensions/imported-tools/assets/.blobs/blob")).toEqual(new Uint8Array([9, 2]));
    expect((await inspectHextension(await exportExtensionZip(target, installed))).settings.extensionGuid).toBe("tools");
  });

  it("requires replacement for same-version imports and removes obsolete files only after confirmation", async () => {
    const { source, descriptor, incoming } = await extensionPackage();
    await source.writeText("extensions/tools/obsolete.js", "old");
    const plan = planExtensionImport({ incoming, existingExtensions: [descriptor], occupiedGuids: new Set(["tools"]), existingFolderNames: ["tools"] });
    expect(plan.kind).toBe("conflict");
    await expect(applyExtensionImport(source, incoming, plan)).rejects.toThrow(/conflict/);
    expect(await source.readText("extensions/tools/obsolete.js")).toBe("old");
    if (plan.kind !== "conflict") throw new Error("Expected same-version conflict");
    await applyExtensionImport(source, incoming, { ...plan, replace: true });
    expect(await source.exists("extensions/tools/obsolete.js")).toBe(false);
    expect(await source.readText("extensions/tools/assets/template.txt")).toBe("template");
  });

  it("restores an installed extension if replacement storage fails", async () => {
    const { source, incoming } = await extensionPackage();
    await source.writeText("extensions/tools/index.ts", "original module");
    const originalWrite = source.writeBinary.bind(source);
    let failed = false;
    vi.spyOn(source, "writeBinary").mockImplementation(async (path, bytes) => {
      if (!failed && path === "extensions/tools/index.ts") {
        failed = true;
        throw new Error("Disk full");
      }
      await originalWrite(path, bytes);
    });
    await expect(applyExtensionImport(source, incoming, { kind: "update", folderName: "tools", existingGuid: "tools" })).rejects.toThrow("Disk full");
    expect(await source.readText("extensions/tools/index.ts")).toBe("original module");
    expect((await discoverProjectExtensions(source)).map((extension) => extension.extensionGuid)).toEqual(["tools"]);
  });

  it("remaps an occupied identity without changing package source or asset bytes", async () => {
    const { incoming } = await extensionPackage();
    const plan = planExtensionImport({ incoming, existingExtensions: [], occupiedGuids: new Set(["tools"]), existingFolderNames: ["TOOLS"], createGuid: () => "imported-id" });
    const target = await storage();
    const descriptor = await applyExtensionImport(target, incoming, plan);
    expect(descriptor).toMatchObject({ extensionGuid: "imported-id", folderName: "tools-1" });
    expect(await target.readText("extensions/tools-1/assets/template.txt")).toBe("template");
    expect(await target.readText("extensions/tools-1/index.ts")).toContain("api.log('ready')");
  });

  it.each(["../outside.js", "/absolute.js", "C:/outside.js", "code\\outside.js", "assets/../../outside.js", "assets/.. /outside.js", "assets/CON.js", "INDEX.ts", "assets", "assets/template.txt/child.txt"])("rejects unsafe or conflicting package path %s before writing", async (path) => {
    const { incoming } = await extensionPackage();
    await expect(inspectHextension(encodeProjectZip([...incoming.files, { path, data: text("bad") }]))).rejects.toThrow(/path/i);
  });

  it("refuses a picked file that is not an archive by name, as an iOS picker offers any file", async () => {
    await expect(inspectHextension(text("{\"name\":\"theme\"}"))).rejects.toThrow("Not a .hextension: the file is not an Extension archive.");
  });

  it("rejects a missing module or an entry point escaping the package", async () => {
    const { incoming } = await extensionPackage();
    await expect(inspectHextension(encodeProjectZip(incoming.files.filter((file) => file.path !== "index.ts")))).rejects.toThrow(/Entry Point is missing/);
    const manifest = JSON.stringify({ kind: "extension", formatVersion: 1, ...incoming.settings, entryPoint: "../index.ts" });
    const invalidFiles = incoming.files.map((file) => file.path === "extension.json" ? { ...file, data: text(manifest) } : file);
    await expect(inspectHextension(encodeProjectZip(invalidFiles))).rejects.toThrow(/relative/);
  });

  it("rejects oversized ZIP entries before decompression and oversized source modules before import", async () => {
    const { incoming } = await extensionPackage();
    const archive = encodeProjectZip(incoming.files);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    for (let offset = 0; offset <= archive.byteLength - 28; offset += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      // A forged central directory must not cause a hundreds-of-MiB allocation.
      view.setUint32(offset + 24, 300 * 1024 * 1024, true);
      break;
    }
    await expect(inspectHextension(archive)).rejects.toThrow(/size limit/);
    const oversizedSource = incoming.files.map((file) => file.path === "index.ts"
      ? { ...file, data: new Uint8Array(1024 * 1024 + 1) }
      : file);
    await expect(inspectHextension(encodeProjectZip(oversizedSource))).rejects.toThrow(/code file exceeds 1 MiB: index.ts/);
    const oversizedCodeFile = [...incoming.files, { path: "code/large.js", data: new Uint8Array(1024 * 1024 + 1) }];
    await expect(inspectHextension(encodeProjectZip(oversizedCodeFile))).rejects.toThrow(/code file exceeds 1 MiB: code\/large.js/);
    // The cap is for code: other package files may be larger.
    const largeData = [...incoming.files, { path: "data.bin", data: new Uint8Array(1024 * 1024 + 1) }];
    await expect(inspectHextension(encodeProjectZip(largeData))).resolves.toMatchObject({ settings: { extensionGuid: "tools" } });
  });

  it("stops inflating a ZIP bomb whose headers declare a small size once the real bytes pass the cap", () => {
    // About 100 MiB of zeros in 650 KiB of deflate, declared as 10 bytes in both the local and the central header.
    const bomb = zeroBombZip("data.bin", 400_000, 10);
    const pushes = vi.spyOn(fflate.Unzip.prototype, "push");
    try {
      expect(() => unzipExtensionArchive(bomb, 1024 * 1024)).toThrow(/expanded size limit/);
      // A cap of 1 MiB stops the stream within the first compressed chunks, long before the rest of the archive.
      const pushed = pushes.mock.calls.reduce((total, call) => total + call[0].byteLength, 0);
      expect(pushed).toBeLessThan(bomb.byteLength / 4);
    } finally {
      pushes.mockRestore();
    }
    // Under the cap, the real bytes come back whatever the headers declared.
    const [file] = unzipExtensionArchive(zeroBombZip("data.bin", 100, 10), 1024 * 1024);
    expect(file).toMatchObject({ path: "data.bin" });
    expect(file!.data.byteLength).toBe(1 + 258 * 100);
  });

  it("requires a gameplay package's game entry and keeps added code files in exports", async () => {
    const { incoming } = await extensionPackage();
    const gameplay = (files: typeof incoming.files) => files.map((file) => file.path === "extension.json"
      ? { ...file, data: encodeExtensionSettings({ ...incoming.settings, editorOnly: false }) }
      : file);
    await expect(inspectHextension(encodeProjectZip(gameplay(incoming.files)))).rejects.toThrow(/Game Entry Point is missing: game.ts/);
    const withGame = gameplay([...incoming.files, { path: "game.ts", data: text("export const ready = true;") }, { path: "code/util.ts", data: text("export const util = 1;") }]);
    const inspected = await inspectHextension(encodeProjectZip(withGame));
    expect(inspected.settings).toMatchObject({ editorOnly: false, gameEntryPoint: "game.ts" });
    expect(inspected.files.map((file) => file.path)).toEqual(expect.arrayContaining(["game.ts", "code/util.ts"]));
  });

  it("rejects malformed manifest identities and unsupported formats instead of installing defaults", async () => {
    const { incoming } = await extensionPackage();
    for (const replacement of [
      { kind: "plugin", formatVersion: 1, ...incoming.settings },
      { kind: "extension", formatVersion: 2, ...incoming.settings },
      { kind: "extension", formatVersion: 1, ...incoming.settings, extensionGuid: " " },
      { kind: "extension", formatVersion: 1, ...incoming.settings, entryPoint: "assets/../index.ts" },
      { kind: "extension", formatVersion: 1, ...incoming.settings, gameEntryPoint: "assets/game.ts" },
      { kind: "extension", formatVersion: 1, ...incoming.settings, gameEntryPoint: "index.ts" },
      { kind: "extension", formatVersion: 1, ...incoming.settings, libraryName: "my-tools" },
    ]) {
      const files = incoming.files.map((file) => file.path === "extension.json" ? { ...file, data: text(JSON.stringify(replacement)) } : file);
      await expect(inspectHextension(encodeProjectZip(files))).rejects.toThrow();
    }
  });

  it("clones Engine defaults once, keeps editable project copies independent, and shadows by GUID", async () => {
    const { incoming } = await extensionPackage();
    const engine = await storage();
    await unpackEngineExtensionZip(engine, encodeProjectZip(incoming.files), "tools");
    const project = await storage();
    const [copy] = await installEngineExtensionDefaults(project, engine);
    expect(copy).toMatchObject({ source: "project", readOnly: false, extensionGuid: "tools" });
    await project.writeText("extensions/tools/index.ts", "edited module");
    await engine.writeBinary("tools/extension.json", encodeExtensionSettings({ ...incoming.settings, enabledByDefault: true }));
    expect(await installEngineExtensionDefaults(project, engine)).toEqual([]);
    const projectExtensions = await discoverProjectExtensions(project);
    expect(projectExtensions[0]!.settings.enabledByDefault).toBe(false);
    expect(await project.readText("extensions/tools/index.ts")).toBe("edited module");
    expect(shadowEngineExtensions(projectExtensions, await discoverEngineExtensions(engine))).toEqual(projectExtensions);
  });

  it("skips invalid engine packages during project creation and refuses to export a recovery placeholder", async () => {
    const { incoming } = await extensionPackage();
    const engine = await storage();
    await unpackEngineExtensionZip(engine, encodeProjectZip(incoming.files), "tools");
    await engine.mkdir("broken", true);
    await engine.writeText("broken/extension.json", "{broken");
    const project = await storage();
    expect((await installEngineExtensionDefaults(project, engine)).map((entry) => entry.extensionGuid)).toEqual(["tools"]);
    expect(await project.exists("extensions/broken")).toBe(false);
    const invalid = (await discoverEngineExtensions(engine)).find((entry) => entry.invalid)!;
    await expect(exportExtensionZip(engine, invalid)).rejects.toThrow(/invalid/);
  });

  it("keeps extension files in project backups but exposes only generated project assets to the registry", async () => {
    const { source } = await extensionPackage();
    const asset = await encodeAssetDocument({ type: "Material", name: "Example", guid: "template", version: 1, payload: {} });
    await source.writeBinary("extensions/tools/assets/Example.material.hasset", asset);
    await source.mkdir("assets", true);
    await source.writeBinary("assets/Generated.material.hasset", await encodeAssetDocument({ type: "Material", name: "Generated", guid: "generated", version: 1, payload: {} }));
    const registry = new AssetRegistry(source);
    await registry.mountRoot(projectContentRoot());
    expect(registry.list().map((asset) => asset.header.guid)).toEqual(["generated"]);
    const restored = await storage();
    await writeProjectTree(restored, decodeProjectZip(await exportProjectZip(source)));
    expect(await restored.readText("extensions/tools/index.ts")).toContain("api.log('ready')");
    expect((await discoverProjectExtensions(restored))[0]!.extensionGuid).toBe("tools");
  });
});
