import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { encodeAssetDocument } from "./asset-document";
import { encodeProjectZip, exportProjectZip } from "./babproject";
import { projectContentRoot } from "./content-root";
import { createExtensionSettings, discoverEngineExtensions, discoverProjectExtensions, shadowEngineExtensions, writeProjectExtension } from "./extension-host";
import { applyExtensionImport, exportExtensionZip, inspectBabextension, installEngineExtensionDefaults, planExtensionImport, unpackEngineExtensionZip } from "./extension-package";
import { encodeExtensionSettings } from "./extension-settings";
import { AssetRegistry } from "./registry";

const text = (value: string) => new TextEncoder().encode(value);

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
  return { source, descriptor, incoming: await inspectBabextension(await exportExtensionZip(source, descriptor)) };
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
    expect((await inspectBabextension(await exportExtensionZip(target, installed))).settings.extensionGuid).toBe("tools");
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
    await expect(inspectBabextension(encodeProjectZip([...incoming.files, { path, data: text("bad") }]))).rejects.toThrow(/path/i);
  });

  it("rejects a missing module or an entry point escaping the package", async () => {
    const { incoming } = await extensionPackage();
    await expect(inspectBabextension(encodeProjectZip(incoming.files.filter((file) => file.path !== "index.ts")))).rejects.toThrow(/Entry Point is missing/);
    const manifest = JSON.stringify({ kind: "extension", formatVersion: 1, ...incoming.settings, entryPoint: "../index.ts" });
    const invalidFiles = incoming.files.map((file) => file.path === "extension.json" ? { ...file, data: text(manifest) } : file);
    await expect(inspectBabextension(encodeProjectZip(invalidFiles))).rejects.toThrow(/relative/);
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
    await expect(inspectBabextension(archive)).rejects.toThrow(/size limit/);
    const oversizedSource = incoming.files.map((file) => file.path === "index.ts"
      ? { ...file, data: new Uint8Array(1024 * 1024 + 1) }
      : file);
    await expect(inspectBabextension(encodeProjectZip(oversizedSource))).rejects.toThrow(/Entry Point exceeds/);
  });

  it("rejects malformed manifest identities and unsupported formats instead of installing defaults", async () => {
    const { incoming } = await extensionPackage();
    for (const replacement of [
      { kind: "plugin", formatVersion: 1, ...incoming.settings },
      { kind: "extension", formatVersion: 2, ...incoming.settings },
      { kind: "extension", formatVersion: 1, ...incoming.settings, extensionGuid: " " },
      { kind: "extension", formatVersion: 1, ...incoming.settings, entryPoint: "assets/../index.ts" },
    ]) {
      const files = incoming.files.map((file) => file.path === "extension.json" ? { ...file, data: text(JSON.stringify(replacement)) } : file);
      await expect(inspectBabextension(encodeProjectZip(files))).rejects.toThrow();
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
    await source.writeBinary("extensions/tools/assets/Example.material.babasset", asset);
    await source.mkdir("assets", true);
    await source.writeBinary("assets/Generated.material.babasset", await encodeAssetDocument({ type: "Material", name: "Generated", guid: "generated", version: 1, payload: {} }));
    const registry = new AssetRegistry(source);
    await registry.mountRoot(projectContentRoot());
    expect(registry.list().map((asset) => asset.header.guid)).toEqual(["generated"]);
    const restored = await storage();
    const { importProjectZip } = await import("./babproject");
    await importProjectZip(restored, await exportProjectZip(source));
    expect(await restored.readText("extensions/tools/index.ts")).toContain("api.log('ready')");
    expect((await discoverProjectExtensions(restored))[0]!.extensionGuid).toBe("tools");
  });
});
