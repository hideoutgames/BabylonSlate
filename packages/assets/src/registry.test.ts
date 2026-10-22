import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { encodeAssetDocument, decodeAssetDocument } from "./asset-document";
import { encodeHasset, readHassetHeader } from "./hasset";
import { createVfsBlobStore } from "./blob-store";
import { projectContentRoot, type ContentRoot } from "./content-root";
import {
  buildMinimalGlbFixture,
  encodeGlbJsonBin,
} from "./importers/glb-parse";
import { EncodeQueue } from "./encode-queue";
import { AssetRegistry, RegistryGenerationClock } from "./registry";
import { ThumbnailDecodeLru } from "./thumbnails";
import { ENGINE_VERSION, SourceRevisionChangedError, type ProjectStorageReader, type StorageReadOptions } from "@haptic/core";
import { createFontPayload } from "./font-payload";

async function createStorage(): Promise<MemoryStorageAdapter> {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("test.hproject");
  return storage;
}

/** Case-preserving filesystem boundary, as on common Windows/macOS project volumes. */
class CaseInsensitiveStorage extends MemoryStorageAdapter {
  private async diskPath(path: string): Promise<string> {
    let resolved = "";
    for (const part of path.split("/").filter((part) => part && part !== ".")) {
      const entries = await super.readdir(resolved).catch(() => []);
      const name = entries.find((entry) => entry.name.toLowerCase() === part.toLowerCase())?.name ?? part;
      resolved = resolved ? `${resolved}/${name}` : name;
    }
    return resolved;
  }
  override async readBinary(path: string) { return super.readBinary(await this.diskPath(path)); }
  override async readBinaryRange(path: string, offset: number, length: number, revision?: string) { return super.readBinaryRange(await this.diskPath(path), offset, length, revision); }
  override async writeBinary(path: string, data: Uint8Array) { return super.writeBinary(await this.diskPath(path), data); }
  override async exists(path: string) { return super.exists(await this.diskPath(path)); }
  override async readdir(path: string) { return super.readdir(await this.diskPath(path)); }
  override async mkdir(path: string, recursive = true) { return super.mkdir(await this.diskPath(path), recursive); }
  override async remove(path: string) { return super.remove(await this.diskPath(path)); }
  override async stat(path: string) { return super.stat(await this.diskPath(path)); }
}

async function writeAsset(
  storage: MemoryStorageAdapter,
  path: string,
  options: {
    guid: string;
    type: string;
    name: string;
    dependencies?: string[];
    payloadBytes?: Uint8Array;
  },
): Promise<void> {
  const payload = options.payloadBytes ?? new Uint8Array([1, 2, 3, 4]);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir) await storage.mkdir(dir, true);
  const bytes = await encodeHasset({
    header: {
      dependencyMetadataVersion: 1, requiredDependencies: [], requiredVariableNames: [],
      guid: options.guid,
      type: options.type,
      name: options.name,
      engineVersion: "0.0.0",
      version: 1,
      mode: "thin",
      dependencies: options.dependencies ?? [],
      parentClass: null,
      payload: {},
    },
    chunks: [
      {
        id: "payload",
        kind: "payload",
        mime: "application/octet-stream",
        data: payload,
      },
    ],
  });
  await storage.writeBinary(path, bytes);
}

describe("AssetRegistry", () => {
  it("duplicates and renames data assets without changing entry identities, hierarchy, or sharing stored values", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    await storage.writeBinary("assets/Item.datadefinition.hasset", await encodeAssetDocument({
      guid: "definition", type: "DataDefinition", name: "Item", version: 1,
      payload: { kind: "dataDefinition", fields: [{ id: "damage", name: "Damage", typeId: "float" }] },
    }));
    const payload = { kind: "dataTree", defaultDefinitionGuid: "definition", entries: [
      { id: "weapons", parentId: null, name: "Weapons", values: {} },
      { id: "sword", parentId: "weapons", name: "Sword", values: { Damage: 12 } },
    ] };
    await storage.writeBinary("assets/Items.datatree.hasset", await encodeAssetDocument({
      guid: "items", type: "DataTree", name: "Items", version: 1, payload,
    }, { dependencies: ["definition"] }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const definition = await registry.duplicateAsset("definition", "project", "");
    expect(definition.path).toBe("assets/Item_1.datadefinition.hasset");
    const copy = await registry.duplicateAsset("items", "project", "");
    expect(copy.path).toBe("assets/Items_1.datatree.hasset");
    expect(copy.header.guid).not.toBe("items");
    const renamed = await registry.renameAsset(copy.header.guid, "Equipment");
    expect(renamed.path).toBe("assets/Equipment.datatree.hasset");
    await registry.deleteAsset("items");
    expect((await decodeAssetDocument(await storage.readBinary(renamed.path))).payload).toEqual(payload);
    expect(registry.showReferences("definition").inbound).toEqual([copy.header.guid]);
  });
  it("indexes the saved header when a save lands between a scan's header reads", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("SaveDuringScan");
    const path = "assets/Wood.hasset";
    const document = (name: string) => encodeAssetDocument({ guid: "wood", type: "Material", name, version: 1, payload: {} });
    await storage.writeBinary(path, await document("Before"));
    const saved = await document("After saving");
    const read = storage.readBinaryRange.bind(storage);
    let saving = true;
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (rangePath, offset, length, revision, options) => {
      if (rangePath === path && offset > 0 && saving) {
        saving = false;
        await storage.writeBinary(path, saved);
      }
      return read(rangePath, offset, length, revision, options);
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(saving).toBe(false);
    expect(registry.getByGuid("wood")?.header.name).toBe("After saving");
  });
  it.each(["rename", "move"])("preserves an asset after a case-only %s on a case-insensitive filesystem", async (operation) => {
    const storage = new CaseInsensitiveStorage();
    await storage.openDocumentsProject("CaseSensitiveNames");
    await storage.writeBinary("assets/Wood.hasset", await encodeAssetDocument({
      guid: "wood", type: "Material", name: "Wood", version: 1, payload: { roughness: 0.4 },
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    if (operation === "rename") await registry.renameAsset("wood", "wood");
    else await registry.moveAsset("wood", "project", "wood.hasset");
    expect((await storage.readdir("assets")).map((entry) => entry.name)).toEqual(["wood.hasset"]);
    expect((await decodeAssetDocument(await storage.readBinary("assets/wood.hasset"))).payload).toEqual({ roughness: 0.4 });
    const reopened = new AssetRegistry(storage);
    await reopened.mountRoot(projectContentRoot());
    expect(reopened.getByGuid("wood")?.path).toBe("assets/wood.hasset");
  });

  it("restores the original asset when a case-only rename cannot write its destination", async () => {
    const storage = new CaseInsensitiveStorage();
    await storage.openDocumentsProject("FailedRename");
    await writeAsset(storage, "assets/Wood.hasset", { guid: "wood", name: "Wood", type: "Material" });
    const original = await storage.readBinary("assets/Wood.hasset");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const write = storage.writeBinary.bind(storage);
    vi.spyOn(storage, "writeBinary").mockImplementation(async (path, bytes) => {
      if (path === "assets/wood.hasset") throw new Error("Disk full");
      return write(path, bytes);
    });
    await expect(registry.renameAsset("wood", "wood")).rejects.toThrow("Disk full");
    expect(await storage.readBinary("assets/Wood.hasset")).toEqual(original);
    expect(registry.getByGuid("wood")?.path).toBe("assets/Wood.hasset");
  });

  it.each(["case-only", "new-parent"])("moves unindexed files and empty folders along with assets (%s)", async (operation) => {
    const storage = new CaseInsensitiveStorage();
    await storage.openDocumentsProject("MoveTree");
    await writeAsset(storage, "assets/Source/wood.hasset", { guid: "wood", name: "wood", type: "Material" });
    await storage.writeText("assets/Source/source.png", "original input");
    await storage.writeText("assets/Source/.hidden", "sidecar");
    await storage.mkdir("assets/Source/empty/nested", true);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const parent = operation === "case-only" ? "" : "archive";
    await registry.moveFolder("project", "Source", parent, "source");
    const destination = `assets/${parent ? `${parent}/` : ""}source`;
    expect(await storage.readText(`${destination}/source.png`)).toBe("original input");
    expect(await storage.readText(`${destination}/.hidden`)).toBe("sidecar");
    expect((await storage.stat(`${destination}/empty/nested`)).isDir).toBe(true);
    expect(registry.getByGuid("wood")?.path).toBe(`${destination}/wood.hasset`);
    expect((await storage.readdir(`assets${parent ? `/${parent}` : ""}`)).map((entry) => entry.name)).toContain("source");
    const reopened = new AssetRegistry(storage);
    await reopened.mountRoot(projectContentRoot());
    expect(reopened.getByGuid("wood")?.path).toBe(`${destination}/wood.hasset`);
  });

  it("refuses a folder move into an aliased descendant on a case-insensitive volume", async () => {
    const storage = new CaseInsensitiveStorage();
    await storage.openDocumentsProject("RecursiveMove");
    await storage.writeText("assets/Source/source.png", "source");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await expect(registry.moveFolder("project", "Source", "source/nested")).rejects.toThrow("into itself");
    expect(await storage.readText("assets/Source/source.png")).toBe("source");
  });

  it("keeps a source folder intact if copying any unindexed file fails", async () => {
    const storage = await createStorage();
    await storage.writeText("assets/source/notes.txt", "important notes");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const write = storage.writeBinary.bind(storage);
    vi.spyOn(storage, "writeBinary").mockImplementation(async (path, bytes) => {
      if (path === "assets/moved/notes.txt") throw new Error("Disk full");
      return write(path, bytes);
    });
    await expect(registry.moveFolder("project", "source", "", "moved")).rejects.toThrow("Disk full");
    expect(await storage.readText("assets/source/notes.txt")).toBe("important notes");
    expect(await storage.exists("assets/moved")).toBe(false);
  });

  it("includes a creation already writing when a folder move is requested", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/source/existing.hasset", { guid: "existing", name: "existing", type: "Material" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    let entered!: () => void;
    let release!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const write = storage.writeBinary.bind(storage);
    vi.spyOn(storage, "writeBinary").mockImplementation(async (path, bytes) => {
      if (path === "assets/source/new.hasset") { entered(); await gate; }
      return write(path, bytes);
    });
    const creation = registry.createAsset("project", "source/new.hasset", {
      guid: "new", type: "Material", name: "new", version: 1, dependencies: [], payload: { roughness: 0.5 }, chunks: [],
    });
    await writing;
    const moving = registry.moveFolder("project", "source", "", "moved");
    release();
    await Promise.all([creation, moving]);
    expect(registry.getByGuid("new")?.path).toBe("assets/moved/new.hasset");
    expect(await storage.exists("assets/moved/new.hasset")).toBe(true);
    expect(await storage.exists("assets/source")).toBe(false);
  });

  describe("overlapping writes to one destination path", () => {
    /** Hold the first write to a matching path until the returned release is called. */
    function holdFirstWrite(storage: MemoryStorageAdapter, path: RegExp) {
      let entered!: () => void;
      let release!: () => void;
      const writing = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const write = storage.writeBinary.bind(storage);
      let held = false;
      vi.spyOn(storage, "writeBinary").mockImplementation(async (target, bytes) => {
        if (path.test(target) && !held) { held = true; entered(); await gate; }
        return write(target, bytes);
      });
      return { writing, release };
    }

    const material = (guid: string) => ({
      guid, type: "Material", name: guid, version: 1, dependencies: [], payload: { owner: guid }, chunks: [],
    });

    async function guidOnDisk(storage: MemoryStorageAdapter, path: string): Promise<string> {
      return readHassetHeader(await storage.readBinary(path)).guid;
    }

    it("lets exactly one of two creations at the same path succeed", async () => {
      const storage = await createStorage();
      const registry = new AssetRegistry(storage);
      await registry.mountRoot(projectContentRoot());
      const { writing, release } = holdFirstWrite(storage, /^assets\/Rock\.hasset$/);
      const first = registry.createAsset("project", "Rock.hasset", material("first"));
      await writing;
      const second = registry.createAsset("project", "Rock.hasset", material("second"));
      release();
      const [firstResult, secondResult] = await Promise.allSettled([first, second]);
      expect(firstResult.status).toBe("fulfilled");
      expect(secondResult).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/already exists/) }) });
      expect(registry.getByGuid("first")?.path).toBe("assets/Rock.hasset");
      expect(registry.getByGuid("second")).toBeUndefined();
      expect(await guidOnDisk(storage, "assets/Rock.hasset")).toBe("first");
    });

    it("gives overlapping duplicates distinct names and keeps an unindexed file at a copy name", async () => {
      const storage = await createStorage();
      await writeAsset(storage, "assets/Rock.hasset", { guid: "rock", type: "Material", name: "Rock" });
      const registry = new AssetRegistry(storage);
      await registry.mountRoot(projectContentRoot());
      await storage.writeText("assets/Rock_1.hasset", "not yet scanned");
      const { writing, release } = holdFirstWrite(storage, /^assets\/Rock_\d+\.hasset$/);
      const first = registry.duplicateAsset("rock", "project");
      await writing;
      const second = registry.duplicateAsset("rock", "project");
      release();
      const copies = await Promise.all([first, second]);
      expect(copies.map((copy) => copy.path).sort()).toEqual(["assets/Rock_2.hasset", "assets/Rock_3.hasset"]);
      for (const copy of copies) {
        expect(registry.getByGuid(copy.header.guid)?.path).toBe(copy.path);
        expect(await guidOnDisk(storage, copy.path)).toBe(copy.header.guid);
      }
      expect(await storage.readText("assets/Rock_1.hasset")).toBe("not yet scanned");
    });

    it("refuses a rename onto a path a creation is still writing", async () => {
      const storage = await createStorage();
      await writeAsset(storage, "assets/Stone.hasset", { guid: "stone", type: "Material", name: "Stone" });
      const stoneBytes = await storage.readBinary("assets/Stone.hasset");
      const registry = new AssetRegistry(storage);
      await registry.mountRoot(projectContentRoot());
      const { writing, release } = holdFirstWrite(storage, /^assets\/Rock\.hasset$/);
      const creation = registry.createAsset("project", "Rock.hasset", material("rock"));
      await writing;
      // The rename settles while the creation's file is not on disk yet.
      await expect(registry.renameAsset("stone", "Rock")).rejects.toThrow(/already exists/);
      release();
      await creation;
      expect(registry.getByGuid("rock")?.path).toBe("assets/Rock.hasset");
      expect(await guidOnDisk(storage, "assets/Rock.hasset")).toBe("rock");
      expect(registry.getByGuid("stone")?.path).toBe("assets/Stone.hasset");
      expect(await storage.readBinary("assets/Stone.hasset")).toEqual(stoneBytes);
    });
  });

  it("preserves an in-flight Font representation attachment through a folder move", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/source/Ui.hasset", { guid: "font", name: "Ui", type: "Font" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    let entered!: () => void;
    let release!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const write = storage.writeBinary.bind(storage);
    vi.spyOn(storage, "writeBinary").mockImplementation(async (path, bytes) => {
      if (path === "assets/source/Ui.hasset") { entered(); await gate; }
      return write(path, bytes);
    });
    const attaching = registry.importFile("project", "source", "Ui.facetype.json", new TextEncoder().encode('{"glyphs":[]}'), { attachToGuid: "font" });
    await writing;
    const moving = registry.moveFolder("project", "source", "", "moved");
    release();
    await Promise.all([attaching, moving]);
    expect(registry.getByGuid("font")?.path).toBe("assets/moved/Ui.hasset");
    expect(registry.getByGuid("font")?.header.chunks.some((chunk) => chunk.id === "facetype-glyphs")).toBe(true);
    expect(await storage.exists("assets/source")).toBe(false);
  });

  it("does not index a retained recovery folder after a successful case-only move", async () => {
    const storage = new CaseInsensitiveStorage();
    await storage.openDocumentsProject("RetainedBackup");
    await writeAsset(storage, "assets/Source/item.hasset", { guid: "item", name: "item", type: "Material" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const remove = storage.remove.bind(storage);
    vi.spyOn(storage, "remove").mockImplementation(async (path) => {
      if (path.startsWith("assets/.haptic-move-")) throw new Error("Cleanup denied");
      return remove(path);
    });
    await registry.moveFolder("project", "Source", "", "source");
    expect((await storage.readdir("assets")).some((entry) => entry.name.startsWith(".haptic-move-"))).toBe(true);
    const readdir = storage.readdir.bind(storage);
    // Filesystem enumeration order must not decide which copy of a GUID is live.
    vi.spyOn(storage, "readdir").mockImplementation(async (path) => (await readdir(path)).reverse());
    const reopened = new AssetRegistry(storage);
    await reopened.mountRoot(projectContentRoot());
    expect(reopened.getByGuid("item")?.path).toBe("assets/source/item.hasset");
    expect(reopened.folderTree("project").children.map((folder) => folder.name)).toEqual(["source"]);
  });

  it("retains incoming references while reindexing or renaming a referenced asset", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/material.hasset", { guid: "material", type: "Material", name: "material", dependencies: ["texture"] });
    await writeAsset(storage, "assets/texture.hasset", { guid: "texture", type: "Texture", name: "texture", dependencies: ["old"] });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await writeAsset(storage, "assets/texture.hasset", { guid: "texture", type: "Texture", name: "texture", dependencies: ["new"] });
    await registry.reindexPath("assets/texture.hasset");
    expect(registry.showReferences("texture").inbound).toEqual(["material"]);
    expect(registry.showReferences("old").inbound).toEqual([]);
    expect(registry.showReferences("new").inbound).toEqual(["texture"]);
    await registry.renameAsset("texture", "Renamed");
    expect(registry.showReferences("texture").inbound).toEqual(["material"]);
    expect(registry.showReferences("new").inbound).toEqual(["texture"]);
  });

  it("uses one read scope throughout recursive root indexing", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/a.hasset", { guid: "a", type: "Texture", name: "A" });
    await writeAsset(storage, "assets/nested/b.hasset", { guid: "b", type: "Texture", name: "B" });
    const paths: string[] = [];
    let closed = false;
    const scoped = Object.assign(storage, {
      async withReadScope<T>(operation: (reader: ProjectStorageReader) => Promise<T>): Promise<T> {
        const reader: ProjectStorageReader = {
          readText: (path) => storage.readText(path), exists: (path) => storage.exists(path), stat: (path) => storage.stat(path),
          readdir: async (path) => { paths.push(`dir:${path}`); return storage.readdir(path); },
          readBinary: async (path) => { paths.push(`file:${path}`); return storage.readBinary(path); },
          readBinaryRange: async (path, offset, length, revision) => { paths.push(`range:${path}`); return storage.readBinaryRange(path, offset, length, revision); },
        };
        try { return await operation(reader); } finally { closed = true; }
      },
    });
    const registry = new AssetRegistry(scoped);
    await registry.mountRoot(projectContentRoot());
    expect(registry.list().map((entry) => entry.header.guid).sort()).toEqual(["a", "b"]);
    expect(paths.sort()).toEqual(["dir:assets", "dir:assets/nested", "range:assets/a.hasset", "range:assets/a.hasset", "range:assets/nested/b.hasset", "range:assets/nested/b.hasset"]);
    expect(closed).toBe(true);
  });
  it("mounts the project root and indexes headers only", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.hasset", {
      guid: "tex-1",
      type: "Texture",
      name: "tex",
      payloadBytes: new Uint8Array(1024).fill(9),
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());

    expect(registry.getByGuid("tex-1")?.header.name).toBe("tex");
    expect(registry.accountedPayloadBytes).toBe(0);
  });

  it("reindexes a saved header payload without remounting", async () => {
    const storage = await createStorage();
    const path = "assets/hero.sprite.hasset";
    const dir = "assets";
    await storage.mkdir(dir, true);
    const write = async (name: string) => {
      const bytes = await encodeHasset({
        header: {
          dependencyMetadataVersion: 1, requiredDependencies: [],
          guid: "sprite-1",
          type: "Sprite",
          name,
          engineVersion: "0.0.0",
          version: 1,
          mode: "thin",
          dependencies: [],
          parentClass: null,
          payload: { name },
        },
        chunks: [
          {
            id: "payload",
            kind: "payload",
            mime: "application/octet-stream",
            data: new Uint8Array([1]),
          },
        ],
      });
      await storage.writeBinary(path, bytes);
    };
    await write("Hero");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.getByGuid("sprite-1")?.header.payload.name).toBe("Hero");
    await write("Walk");
    await registry.reindexPath(path);
    expect(registry.getByGuid("sprite-1")?.header.payload.name).toBe("Walk");
  });

  it("mounts a second synthetic root and resolves references across roots", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/scene.hasset", {
      guid: "scene-1",
      type: "Scene",
      name: "Main",
      dependencies: ["plugin-tex"],
    });
    await writeAsset(storage, "synthetic-root/assets/tex.hasset", {
      guid: "plugin-tex",
      type: "Texture",
      name: "Shared",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const synthetic: ContentRoot = {
      id: "synth",
      kind: "synthetic",
      pathPrefix: "synthetic-root/assets",
    };
    await registry.mountRoot(synthetic);

    expect(registry.listRoots()).toHaveLength(2);
    expect(registry.getByGuid("plugin-tex")?.rootId).toBe("synth");
    expect(registry.showReferences("plugin-tex").inbound).toEqual(["scene-1"]);
    expect(registry.showReferences("scene-1").outbound).toEqual(["plugin-tex"]);
  });

  it("keeps accounted payload bytes near zero for hundreds of assets until loadChunk", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    const fat = new Uint8Array(256).fill(7);
    for (let i = 0; i < 200; i++) {
      await writeAsset(storage, `assets/a${i}.hasset`, {
        guid: `guid-${i}`,
        type: "Texture",
        name: `a${i}`,
        payloadBytes: fat,
      });
    }

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.list()).toHaveLength(200);
    expect(registry.accountedPayloadBytes).toBe(0);

    const first = registry.getByGuid("guid-0");
    expect(first).toBeDefined();
    await registry.readChunk(first!.header.guid, first!.header.chunks[0]!.id);
    expect(registry.accountedPayloadBytes).toBe(256);
  });

  it("imports PNG and GLB and keeps them after remount", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());

    const textures = await registry.importFile(
      "project",
      "",
      "hero.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(textures).toHaveLength(1);
    expect(textures[0]!.header.type).toBe("Texture");
    expect(textures[0]!.header.payload.compressionState).toBe("pending");

    const models = await registry.importFile(
      "project",
      "models",
      "crate.glb",
      buildMinimalGlbFixture(),
    );
    expect(models.some((asset) => asset.header.type === "Model")).toBe(true);

    const scaled = await registry.importFile(
      "project",
      "models",
      "statue.glb",
      buildMinimalGlbFixture(),
      { modelImportScale: 7 },
    );
    const statue = scaled.find((asset) => asset.header.type === "Model");
    expect(statue?.header.payload.importScale).toBe(7);

    const remounted = new AssetRegistry(storage);
    await remounted.mountRoot(projectContentRoot());
    expect(remounted.list({ type: "Texture" }).length).toBeGreaterThanOrEqual(1);
    expect(remounted.list({ type: "Model" }).length).toBeGreaterThanOrEqual(1);
  });

  it("embeds importFile sidecars onto a Kenney-style GLB and enqueues encode", async () => {
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
        images: [{ name: "colormap", uri: "Textures/colormap.png" }],
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
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    const registry = new AssetRegistry(storage);
    const completed: string[] = [];
    const queue = new EncodeQueue({
      onComplete: async (result) => {
        completed.push(result.assetGuid);
        await registry.commitCompressedTexture(result);
      },
    });
    registry.setEncodePipeline(queue);
    await registry.mountRoot(projectContentRoot());

    const created = await registry.importFile(
      "project",
      "",
      "tree.glb",
      glb,
      { sidecars: { "Textures/colormap.png": png, "colormap.png": png } },
    );
    const texture = created.find((asset) => asset.header.type === "Texture");
    expect(texture).toBeDefined();
    expect(texture!.header.payload.compressionState).toBe("pending");
    await vi.waitFor(() => {
      expect(completed).toContain(texture!.header.guid);
      expect(
        registry.getByGuid(texture!.header.guid)!.header.payload.compressionState,
      ).toBe("compressed");
    });
  });

  it("passes the pixel chunk MIME into thumbnail generation", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    registry.setThumbnailWriter(async () => undefined);
    const createImageBitmap = vi.fn<(image: Blob) => Promise<ImageBitmap>>(
      async () => {
        throw new Error("stop-after-blob");
      },
    );
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    try {
      await registry.importFile(
        "project",
        "",
        "photo.jpg",
        new Uint8Array([0xff, 0xd8, 0xff]),
      );
      expect(createImageBitmap).toHaveBeenCalled();
      const firstCall = createImageBitmap.mock.calls[0];
      expect(firstCall).toBeDefined();
      if (!firstCall) return;
      const [blob] = firstCall;
      expect(blob.type).toBe("image/jpeg");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("remaps colliding guids when importing a .hasset", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/existing.hasset", {
      guid: "shared-guid",
      type: "Texture",
      name: "Existing",
    });
    const incoming = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
        guid: "shared-guid",
        type: "Texture",
        name: "Incoming",
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

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const created = await registry.importFile(
      "project",
      "",
      "incoming.hasset",
      incoming,
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.header.guid).not.toBe("shared-guid");
    expect(registry.getByGuid("shared-guid")?.header.name).toBe("Existing");
  });

  it("deletes assets and updates inbound references", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.hasset", {
      guid: "tex-1",
      type: "Texture",
      name: "tex",
    });
    await writeAsset(storage, "assets/mat.hasset", {
      guid: "mat-1",
      type: "Material",
      name: "mat",
      dependencies: ["tex-1"],
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.showReferences("tex-1").inbound).toEqual(["mat-1"]);

    await registry.deleteAsset("tex-1");
    expect(registry.getByGuid("tex-1")).toBeUndefined();
    expect(await storage.exists("assets/tex.hasset")).toBe(false);
    expect(registry.showReferences("tex-1").inbound).toEqual([]);
  });

  it("preserves folder assets and references when storage deletion fails, then permits retry", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/fx/spark.hasset", {
      guid: "spark-1", type: "Texture", name: "Spark",
    });
    await writeAsset(storage, "assets/fx-extra/material.hasset", {
      guid: "mat-1", type: "Material", name: "Material", dependencies: ["spark-1"],
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.createFolder("project", "fx/empty");
    const remove = vi.spyOn(storage, "remove").mockRejectedValueOnce(new Error("Storage unavailable"));

    await expect(registry.deleteFolder("project", "fx")).rejects.toThrow("Storage unavailable");

    expect(registry.getByGuid("spark-1")?.path).toBe("assets/fx/spark.hasset");
    expect(registry.showReferences("spark-1").inbound).toEqual(["mat-1"]);
    expect(registry.folderTree("project").children.find((folder) => folder.name === "fx")?.children.some((folder) => folder.name === "empty")).toBe(true);
    expect(await storage.exists("assets/fx/spark.hasset")).toBe(true);

    remove.mockRestore();
    await registry.deleteFolder("project", "fx");

    expect(registry.getByGuid("spark-1")).toBeUndefined();
    expect(registry.showReferences("spark-1").inbound).toEqual([]);
    expect(registry.folderTree("project").children.map((folder) => folder.name)).toEqual(["fx-extra"]);
    expect(await storage.exists("assets/fx/spark.hasset")).toBe(false);
    expect(registry.getByGuid("mat-1")?.path).toBe("assets/fx-extra/material.hasset");
  });

  it("fails the mount, leaving nothing of the root, when a folder cannot be listed", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/top.hasset", { guid: "top", type: "Material", name: "Top" });
    await writeAsset(storage, "assets/fx/spark.hasset", { guid: "spark-1", type: "Texture", name: "Spark" });
    const readdir = storage.readdir.bind(storage);
    vi.spyOn(storage, "readdir").mockImplementation(async (path) => {
      if (path === "assets/fx") throw new Error("Permission denied");
      return readdir(path);
    });
    const registry = new AssetRegistry(storage);

    await expect(registry.mountRoot(projectContentRoot())).rejects.toThrow("Permission denied");
    expect(registry.listRoots()).toEqual([]);
    expect(registry.list()).toEqual([]);
    await expect(registry.deleteFolder("project", "fx")).rejects.toThrow(/Unknown content root/);
    expect(await storage.exists("assets/fx/spark.hasset")).toBe(true);
  });

  it("keeps the first file indexed when a copy made outside the editor has its guid, and will not delete the copy unseen", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/a/hero.hasset", { guid: "hero", type: "Material", name: "Hero" });
    await storage.mkdir("assets/b", true);
    await storage.writeBinary("assets/b/hero.hasset", await storage.readBinary("assets/a/hero.hasset"));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());

    expect(registry.getByGuid("hero")?.path).toBe("assets/a/hero.hasset");
    expect(registry.getByPath("assets/a/hero.hasset")?.header.guid).toBe("hero");
    expect(registry.listGuidConflicts()).toEqual([
      { rootId: "project", path: "assets/b/hero.hasset", guid: "hero", indexedPath: "assets/a/hero.hasset" },
    ]);
    await expect(registry.deleteFolder("project", "b")).rejects.toThrow(/assets\/b\/hero\.hasset/);
    expect(await storage.exists("assets/b/hero.hasset")).toBe(true);

    await registry.moveFolder("project", "b", "", "copies");
    expect(registry.listGuidConflicts().map((conflict) => conflict.path)).toEqual(["assets/copies/hero.hasset"]);
    await expect(registry.deleteFolder("project", "copies")).rejects.toThrow(/copies\/hero\.hasset/);
  });

  it("scans a folder's files concurrently within a bound yet resolves a shared guid in directory order", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/copy-a.hasset", { guid: "shared", type: "Material", name: "First" });
    await writeAsset(storage, "assets/copy-b.hasset", { guid: "shared", type: "Material", name: "Second" });
    for (let index = 0; index < 20; index++) {
      await writeAsset(storage, `assets/item-${String(index).padStart(2, "0")}.hasset`, { guid: `item-${index}`, type: "Material", name: `Item ${index}` });
    }
    const listed = (await storage.readdir("assets")).map((entry) => `assets/${entry.name}`);
    const firstCopy = listed.find((path) => path.includes("copy-"))!;
    // The file listed first for the shared guid answers last, so a scan that indexes in completion order would keep the other copy.
    const read = storage.readBinaryRange.bind(storage);
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (path, ...rest) => {
      peak = Math.max(peak, ++inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, path === firstCopy ? 40 : 2));
        return await read(path, ...rest);
      } finally { inFlight--; }
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());

    const secondCopy = listed.find((path) => path.includes("copy-") && path !== firstCopy)!;
    expect(registry.getByGuid("shared")?.path).toBe(firstCopy);
    expect(registry.listGuidConflicts().map((conflict) => [conflict.path, conflict.indexedPath])).toEqual([[secondCopy, firstCopy]]);
    expect(registry.list()).toHaveLength(21);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("does not read headers ahead across a subfolder it has yet to walk", async () => {
    const storage = await createStorage();
    // Directory order: a1, a2, sub/, b1, b2.
    await writeAsset(storage, "assets/a1.hasset", { guid: "a1", type: "Material", name: "A1" });
    await writeAsset(storage, "assets/a2.hasset", { guid: "a2", type: "Material", name: "A2" });
    await writeAsset(storage, "assets/sub/s1.hasset", { guid: "s1", type: "Material", name: "S1" });
    await writeAsset(storage, "assets/b1.hasset", { guid: "b1", type: "Material", name: "B1" });
    await writeAsset(storage, "assets/b2.hasset", { guid: "b2", type: "Material", name: "B2" });
    expect((await storage.readdir("assets")).map((entry) => entry.name)).toEqual(["a1.hasset", "a2.hasset", "sub", "b1.hasset", "b2.hasset"]);
    const read = storage.readBinaryRange.bind(storage);
    const events: string[] = [];
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (path, ...rest) => {
      events.push(`start ${path}`);
      // The subfolder's file answers slowly, so any read begun meanwhile would show.
      if (path === "assets/sub/s1.hasset") await new Promise((resolve) => setTimeout(resolve, 30));
      try { return await read(path, ...rest); } finally { events.push(`end ${path}`); }
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());

    expect(registry.list().map((asset) => asset.header.guid).sort()).toEqual(["a1", "a2", "b1", "b2", "s1"]);
    const firstStartOfB = events.findIndex((event) => event === "start assets/b1.hasset");
    const lastEndInSub = events.map((event, index) => event === "end assets/sub/s1.hasset" ? index : -1).reduce((a, b) => Math.max(a, b));
    expect(firstStartOfB).toBeGreaterThan(lastEndInSub);
  });

  it("lets every header read it started settle before a failed scan returns", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    // The first file in directory order cannot be parsed; the files after it are read ahead of it and answer slowly.
    await storage.writeBinary("assets/a-broken.hasset", new Uint8Array([1, 2, 3]));
    for (let index = 0; index < 5; index++) await writeAsset(storage, `assets/item-${index}.hasset`, { guid: `item-${index}`, type: "Material", name: `Item ${index}` });
    const read = storage.readBinaryRange.bind(storage);
    let inFlight = 0;
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (path, ...rest) => {
      inFlight++;
      try {
        if (path !== "assets/a-broken.hasset") await new Promise((resolve) => setTimeout(resolve, 30));
        return await read(path, ...rest);
      } finally { inFlight--; }
    });
    const registry = new AssetRegistry(storage);

    await expect(registry.mountRoot(projectContentRoot())).rejects.toThrow();

    expect(inFlight).toBe(0);
    expect(registry.listRoots()).toEqual([]);
  });

  it("reads a moved asset's chunks from its new path on storage whose revisions follow content", async () => {
    class ContentRevisionStorage extends MemoryStorageAdapter {
      override async readBinaryRange(path: string, offset: number, length: number, revision?: string, options?: StorageReadOptions) {
        const read = await super.readBinaryRange(path, offset, length, undefined, options);
        const contentRevision = `size:${read.totalSize}`;
        if (revision !== undefined && revision !== contentRevision) throw new SourceRevisionChangedError(`Changed: ${path}`);
        return { ...read, revision: contentRevision };
      }
    }
    const storage = new ContentRevisionStorage("documents");
    await storage.openDocumentsProject("MoveLocator");
    const payload = new Uint8Array([4, 3, 2, 1]);
    await writeAsset(storage, "assets/tex.hasset", { guid: "tex", type: "Texture", name: "tex", payloadBytes: payload });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(await registry.readChunk("tex", "payload")).toEqual(payload);

    await registry.moveAsset("tex", "project", "moved/tex.hasset");
    expect(await registry.readChunk("tex", "payload")).toEqual(payload);
    await registry.moveFolder("project", "moved", "", "again");
    expect(await registry.readChunk("tex", "payload")).toEqual(payload);
  });

  it("copies a folder past a destination name already on disk but not indexed", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/fx/spark.hasset", { guid: "spark", type: "Material", name: "spark" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await storage.mkdir("assets/fx_1", true);

    const copied = await registry.copyFolder("project", "fx", "");
    expect(copied).toBe("fx_2");
    expect(registry.list().some((asset) => asset.path === "assets/fx_2/spark.hasset")).toBe(true);
  });

  it("stops a canceled folder copy between files and deletes the partial copy", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/fx/spark.hasset", { guid: "spark", type: "Material", name: "spark" });
    await writeAsset(storage, "assets/fx/smoke.hasset", { guid: "smoke", type: "Material", name: "smoke" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const controller = new AbortController();
    const progress: number[] = [];

    const copying = registry.copyFolder("project", "fx", "", {
      signal: controller.signal,
      onProgress: (copied) => {
        progress.push(copied);
        if (copied === 1) controller.abort();
      },
    });
    await expect(copying).rejects.toThrow();
    expect(progress).toEqual([0, 1]);
    expect(registry.list().map((asset) => asset.path).sort()).toEqual(["assets/fx/smoke.hasset", "assets/fx/spark.hasset"]);
    expect(await storage.exists("assets/fx_1")).toBe(false);
  });

  it("writes nothing for an asset copy canceled before it starts", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/rock.hasset", { guid: "rock", type: "Material", name: "rock" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());

    await expect(registry.duplicateAsset("rock", "project", "", { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(registry.list()).toHaveLength(1);
  });

  it("does not index a Texture rewrite that finishes after its root was unmounted", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "plugin/assets/tex.hasset", { guid: "plugin-tex", type: "Texture", name: "tex" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.mountRoot({ id: "plugin:p", kind: "plugin", pathPrefix: "plugin/assets" });
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // A state write reads only the header of the file it replaces.
    const read = storage.readBinaryRange.bind(storage);
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (...args) => {
      if (args[0] === "plugin/assets/tex.hasset") { entered(); await gate; }
      return read(...args);
    });
    const write = registry.setCompressionState("plugin-tex", "encode_failed", { error: "boom" });
    await reading;
    registry.unmountRoot("plugin:p");
    release();
    await write;

    expect(registry.getByGuid("plugin-tex")).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("refuses to attach a representation to a Font in a read-only root", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    await writeAsset(storage, "plugin/assets/ui.hasset", { guid: "font-ui", type: "Font", name: "Ui" });
    const before = await storage.readBinary("plugin/assets/ui.hasset");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.mountRoot({ id: "plugin:fonts", kind: "plugin", pathPrefix: "plugin/assets", readOnly: true });

    await expect(registry.importFile("project", "", "Ui.facetype.json", new TextEncoder().encode("{\"glyphs\":{}}"), {
      attachToGuid: "font-ui",
    })).rejects.toThrow(/read-only/i);
    expect(await storage.readBinary("plugin/assets/ui.hasset")).toEqual(before);
  });

  it("builds a folder tree with nested assets", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/root.hasset", {
      guid: "r1",
      type: "Texture",
      name: "root",
    });
    await writeAsset(storage, "assets/fx/spark.hasset", {
      guid: "r2",
      type: "Texture",
      name: "spark",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const tree = registry.folderTree("project");
    expect(tree.assets).toContain("r1");
    const fx = tree.children.find((child) => child.name === "fx");
    expect(fx?.assets).toContain("r2");
  });

  it("lists Scene documents and Class assets as graph documents", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/main.scene.hasset", {
      guid: "s1",
      type: "Scene",
      name: "Main",
    });
    await writeAsset(storage, "assets/hero.class.hasset", {
      guid: "c1",
      type: "Class",
      name: "Hero",
    });
    await writeAsset(storage, "assets/main.class.hasset", {
      guid: "g1",
      type: "Class",
      name: "Main",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.listDocumentPaths()).toEqual({
      scenes: ["assets/main.scene.hasset"],
      graphs: ["assets/hero.class.hasset", "assets/main.class.hasset"],
    });
  });

  it("creates empty folders with a git-visible marker", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());

    await registry.createFolder("project", "fx/vfx");
    expect(await storage.exists("assets/fx/vfx/.haptic-folder")).toBe(true);

    const remounted = new AssetRegistry(storage);
    await remounted.mountRoot(projectContentRoot());
    const tree = remounted.folderTree("project");
    const fx = tree.children.find((child) => child.name === "fx");
    expect(fx).toBeDefined();
    expect(fx?.children.some((child) => child.name === "vfx")).toBe(true);
  });

  it("moves an asset without changing its guid", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.hasset", {
      guid: "tex-1",
      type: "Texture",
      name: "tex",
    });
    await writeAsset(storage, "assets/mat.hasset", {
      guid: "mat-1",
      type: "Material",
      name: "mat",
      dependencies: ["tex-1"],
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const moved = await registry.moveAsset("tex-1", "project", "textures/tex.hasset");
    expect(moved.header.guid).toBe("tex-1");
    expect(moved.path).toBe("assets/textures/tex.hasset");
    expect(await storage.exists("assets/tex.hasset")).toBe(false);
    expect(await storage.exists("assets/textures/tex.hasset")).toBe(true);
    expect(registry.showReferences("tex-1").inbound).toEqual(["mat-1"]);
  });

  it("duplicates an asset with a new guid", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.hasset", {
      guid: "tex-1",
      type: "Texture",
      name: "tex",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const copy = await registry.duplicateAsset("tex-1", "project", "copies");
    expect(copy.header.guid).not.toBe("tex-1");
    expect(copy.path).toBe("assets/copies/tex.hasset");
    expect(registry.getByGuid("tex-1")).toBeDefined();
    expect(registry.getByGuid(copy.header.guid)).toBeDefined();
    expect(copy.header.name).toBe("tex");
  });

  it("duplicates in the same folder using stem_N and writes header.name", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/Duplicate_1.hasset", {
      guid: "dup-1",
      type: "Texture",
      name: "Duplicate_1",
    });
    await writeAsset(storage, "assets/Duplicate_2.hasset", {
      guid: "dup-2",
      type: "Texture",
      name: "Duplicate_2",
    });
    await writeAsset(storage, "assets/Duplicate.hasset", {
      guid: "dup-0",
      type: "Texture",
      name: "Duplicate",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const copy = await registry.duplicateAsset("dup-1", "project", "");
    expect(copy.path).toBe("assets/Duplicate_3.hasset");
    expect(copy.header.name).toBe("Duplicate_3");
    expect(copy.header.guid).not.toBe("dup-1");
  });

  it("never gives a copied or duplicated Class another Class's class id", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/a/Hero.class.hasset", { guid: "hero", type: "Class", name: "Hero" });
    await writeAsset(storage, "assets/b/Hero_1.class.hasset", { guid: "hero-1", type: "Class", name: "Hero_1" });
    await writeAsset(storage, "assets/c/Rock.hasset", { guid: "rock", type: "Texture", name: "Rock" });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    // Copy to Folder keeps a free stem for other types, but Hero and Hero_1 are taken class ids.
    expect((await registry.copyAsset("rock", "project", "d")).path).toBe("assets/d/Rock.hasset");
    const copy = await registry.copyAsset("hero", "project", "d");
    expect(copy.path).toBe("assets/d/Hero_2.class.hasset");
    expect(copy.header.name).toBe("Hero_2");
    expect((await registry.duplicateAsset("hero", "project", "a")).path).toBe("assets/a/Hero_3.class.hasset");
  });

  it("preserves .scene.hasset when duplicating a scene", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    await storage.writeBinary(
      "assets/main.scene.hasset",
      await encodeAssetDocument({
        type: "Scene",
        name: "main",
        guid: "scene-1",
        version: 1,
        payload: { name: "Main", actors: [] },
      }),
    );

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const copy = await registry.duplicateAsset("scene-1", "project", "");
    expect(copy.path).toBe("assets/main_1.scene.hasset");
    expect(copy.header.name).toBe("main_1");
    const copyBytes = await storage.readBinary(copy.path);
    const copyDoc = await decodeAssetDocument(copyBytes);
    expect(copyDoc.payload.name).toBe("main_1");
  });

  it("rewrites scene payload name when renaming a Scene asset", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    const bytes = await encodeAssetDocument({
      type: "Scene",
      name: "main",
      guid: "scene-rename",
      version: 1,
      payload: { name: "Main", actors: [] },
    });
    await storage.writeBinary("assets/main.scene.hasset", bytes);

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const renamed = await registry.renameAsset("scene-rename", "Arena");
    expect(renamed.header.name).toBe("Arena");
    const renamedDoc = await decodeAssetDocument(
      await storage.readBinary(renamed.path),
    );
    expect(renamedDoc.payload.name).toBe("Arena");
  });

  it.each([
    ["Material", ".material.hasset"],
    ["Tileset", ".tileset.hasset"],
  ])("rewrites the payload name when renaming and duplicating a %s", async (type, suffix) => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    await storage.writeBinary(
      `assets/Old${suffix}`,
      await encodeAssetDocument({ type, name: "Old", guid: "doc-1", version: 1, payload: { name: "Old", nodes: [] } }),
    );
    await storage.writeBinary(
      `assets/Plain${suffix}`,
      await encodeAssetDocument({ type, name: "Plain", guid: "doc-2", version: 1, payload: { nodes: [] } }),
    );

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const renamed = await registry.renameAsset("doc-1", "Fresh");
    const renamedDoc = await decodeAssetDocument(await storage.readBinary(renamed.path));
    expect(renamedDoc.payload).toEqual({ name: "Fresh", nodes: [] });
    const copy = await registry.duplicateAsset("doc-1", "project", "");
    const copyDoc = await decodeAssetDocument(await storage.readBinary(copy.path));
    expect(copyDoc.payload).toEqual({ name: copy.header.name, nodes: [] });
    expect(copy.header.name).not.toBe("Fresh");

    // A payload without a name keeps none: the header holds the asset's name.
    const plain = await registry.renameAsset("doc-2", "Smooth");
    const plainDoc = await decodeAssetDocument(await storage.readBinary(plain.path));
    expect(plainDoc.payload).toEqual({ nodes: [] });
  });

  it("refuses to overwrite an existing asset path", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.hasset", {
      guid: "tex-1",
      type: "Texture",
      name: "tex",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await expect(
      registry.createAsset("project", "tex.hasset", {
        type: "Texture",
        name: "tex",
        guid: "tex-2",
        version: 1,
        dependencies: [],
        parentClass: null,
        payload: {},
        chunks: [],
      }),
    ).rejects.toThrow(/already exists/i);
    expect(registry.getByGuid("tex-1")?.header.guid).toBe("tex-1");
  });

  it("refuses to create a folder that already exists", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.createFolder("project", "fx");
    await expect(registry.createFolder("project", "fx")).rejects.toThrow(
      /already exists/i,
    );
  });

  it("renames an asset path while keeping the guid", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/old.hasset", {
      guid: "tex-1",
      type: "Texture",
      name: "old",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const renamed = await registry.renameAsset("tex-1", "shiny");
    expect(renamed.header.guid).toBe("tex-1");
    expect(renamed.path).toBe("assets/shiny.hasset");
    expect(renamed.header.name).toBe("shiny");
  });

  it.each([
    ["SceneLayer", ".scenelayer.hasset"],
    ["MaterialInstance", ".matinst.hasset"],
    ["BehaviourTree", ".bt.hasset"],
    ["Blackboard", ".blackboard.hasset"],
    ["Water", ".water.hasset"],
  ])("retains the %s editor identity when renaming and duplicating", async (type, suffix) => {
    const storage = await createStorage();
    await writeAsset(storage, `assets/Original${suffix}`, { guid: "original", type, name: "Original" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const renamed = await registry.renameAsset("original", "Renamed");
    expect(renamed.path).toBe(`assets/Renamed${suffix}`);
    const duplicate = await registry.duplicateAsset("original", "project");
    expect(duplicate.path).toBe(`assets/Renamed_1${suffix}`);
    expect(duplicate.header.type).toBe(type);
  });

  it("preserves Unicode names, Class suffixes, and the existing asset when a rename collides", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/Player.class.hasset", { guid: "player", type: "Class", name: "Player" });
    await writeAsset(storage, "assets/Other.class.hasset", { guid: "other", type: "Class", name: "Other" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const renamed = await registry.renameAsset("player", "Hero 🤖 Ünïcødé");
    expect(renamed.path).toBe("assets/Hero 🤖 Ünïcødé.class.hasset");
    expect(renamed.header.name).toBe("Hero 🤖 Ünïcødé");
    expect(await storage.exists("assets/Player.class.hasset")).toBe(false);
    await expect(registry.renameAsset("other", "Hero 🤖 Ünïcødé")).rejects.toThrow(/already exists/);
    await expect(registry.renameAsset("player", "../Other")).rejects.toThrow(/path separators/);
    const fresh = new AssetRegistry(storage);
    await fresh.mountRoot(projectContentRoot());
    expect(fresh.getByGuid("player")?.path).toBe("assets/Hero 🤖 Ünïcødé.class.hasset");
    expect(fresh.getByGuid("other")?.path).toBe("assets/Other.class.hasset");
  });

  it("moves a folder and all assets under it", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/fx/spark.hasset", {
      guid: "spark-1",
      type: "Texture",
      name: "spark",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.moveFolder("project", "fx", "effects");
    expect(registry.getByGuid("spark-1")?.path).toBe(
      "assets/effects/fx/spark.hasset",
    );
    expect(await storage.exists("assets/fx/spark.hasset")).toBe(false);
  });

  it("duplicates a folder as a sibling with new asset guids", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/fx/spark.hasset", {
      guid: "spark-1",
      type: "Texture",
      name: "spark",
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.createFolder("project", "fx/nested");

    const copied = await registry.duplicateFolder("project", "fx");
    expect(copied).toBe("fx_1");
    expect(registry.folderTree("project").children.map((c) => c.name).sort()).toEqual(
      ["fx", "fx_1"],
    );
    const copyAsset = registry.list().find((a) => a.path === "assets/fx_1/spark.hasset");
    expect(copyAsset).toBeDefined();
    expect(copyAsset?.header.guid).not.toBe("spark-1");
    expect(copyAsset?.header.name).toBe("spark");
    expect(registry.getByGuid("spark-1")?.path).toBe("assets/fx/spark.hasset");
    const nested = registry
      .folderTree("project")
      .children.find((c) => c.path === "assets/fx_1")
      ?.children.find((c) => c.name === "nested");
    expect(nested).toBeDefined();
  });

  it("points a copied folder's references at the copies inside it and keeps references to outside assets", async () => {
    const storage = await createStorage();
    const writeDocument = async (path: string, type: string, guid: string, payload: Record<string, unknown>, metadata: {
      parentClass?: string;
      dependencies?: string[];
      classReferences?: string[];
      headerMeta?: Record<string, unknown>;
    } = {}) => {
      const name = path.slice(path.lastIndexOf("/") + 1).replace(/(\.class|\.scene|\.datadefinition|\.datatree)?\.hasset$/, "");
      await storage.mkdir(path.slice(0, path.lastIndexOf("/")), true);
      await storage.writeBinary(path, await encodeAssetDocument({ type, name, guid, version: 1, payload }, {
        parentClass: metadata.parentClass ?? null,
        headerMeta: metadata.headerMeta,
        dependencyMetadata: {
          dependencyMetadataVersion: 1,
          dependencies: metadata.dependencies ?? [],
          requiredDependencies: metadata.dependencies ?? [],
          ...(type === "Class" ? { requiredVariableNames: [] } : {}),
          ...(metadata.classReferences ? { classReferences: metadata.classReferences, requiredClassReferences: metadata.classReferences } : {}),
        },
      }));
    };
    // Outside the copied folder.
    await writeAsset(storage, "assets/shared/stone.hasset", { guid: "tex-stone", type: "Texture", name: "stone" });
    await writeAsset(storage, "assets/Base.class.hasset", { guid: "class-base", type: "Class", name: "Base" });
    const loot = { kind: "dataDefinition", fields: [{ id: "icon", name: "Icon", typeId: "asset" }] };
    await writeDocument("assets/defs/Loot.datadefinition.hasset", "DataDefinition", "def-loot", loot, { headerMeta: loot });
    // Inside: Texture -> Material -> Class prefab -> Scene, a Class deriving from a copied Class, and a nested Sprite.
    await writeAsset(storage, "assets/kit/brick.hasset", { guid: "tex-brick", type: "Texture", name: "brick" });
    await writeDocument("assets/kit/wall.hasset", "Material", "mat-wall", {
      nodes: [
        { id: "albedo", type: "texture", properties: { texture: "tex-brick" } },
        { id: "detail", type: "texture", properties: { texture: "tex-stone" } },
      ],
    }, { dependencies: ["tex-brick", "tex-stone"] });
    await writeDocument("assets/kit/Enemy.class.hasset", "Class", "class-enemy", {
      prefab: { components: [{ id: "mesh", classId: "MeshComponent", properties: { materialGuid: "mat-wall" } }] },
    }, { parentClass: "Base", dependencies: ["mat-wall", "class-base"], classReferences: ["Base"] });
    await writeDocument("assets/kit/Boss.class.hasset", "Class", "class-boss", { members: [] }, {
      parentClass: "Enemy", dependencies: ["class-enemy"], classReferences: ["Enemy"],
    });
    await writeDocument("assets/kit/levels/arena.scene.hasset", "Scene", "scene-arena", {
      name: "arena",
      actors: [
        { id: "a1", classId: "Enemy", components: [{ id: "mesh", classId: "MeshComponent", properties: { materialGuid: "mat-wall" } }] },
        { id: "a2", classId: "Base", components: [{ id: "sprite", classId: "SpriteComponent", properties: { assetGuid: "tex-stone" } }] },
      ],
    }, { dependencies: ["class-enemy", "mat-wall", "class-base", "tex-stone"], classReferences: ["Enemy", "Base"] });
    // Its Definition is outside the folder: only that schema says Icon is an asset reference.
    await writeDocument("assets/kit/drops.datatree.hasset", "DataTree", "tree-drops", {
      kind: "dataTree", entries: [{ id: "coin", definitionGuid: "def-loot", values: { Icon: "tex-brick" } }],
    }, { dependencies: ["def-loot", "tex-brick"] });
    await writeDocument("assets/kit/sprites/hero.hasset", "Sprite", "sprite-hero", { textureGuid: "tex-brick" }, { dependencies: ["tex-brick"] });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(await registry.copyFolder("project", "kit", "")).toBe("kit_1");

    const copyAt = (path: string) => {
      const asset = registry.list().find((entry) => entry.path === path);
      expect(asset, path).toBeDefined();
      return asset!;
    };
    const documentAt = async (path: string) => (await decodeAssetDocument(await storage.readBinary(path))).payload;
    const brick = copyAt("assets/kit_1/brick.hasset").header.guid;
    const wall = copyAt("assets/kit_1/wall.hasset");
    // Class ids come from file stems and stay unique, so the copies are Enemy_1 and Boss_1.
    const enemy = copyAt("assets/kit_1/Enemy_1.class.hasset");
    const boss = copyAt("assets/kit_1/Boss_1.class.hasset");
    const arena = copyAt("assets/kit_1/levels/arena.scene.hasset");
    const hero = copyAt("assets/kit_1/sprites/hero.hasset");

    expect(await documentAt(wall.path)).toEqual({
      nodes: [
        { id: "albedo", type: "texture", properties: { texture: brick } },
        { id: "detail", type: "texture", properties: { texture: "tex-stone" } },
      ],
    });
    expect(wall.header.dependencies).toEqual([brick, "tex-stone"]);

    expect(await documentAt(enemy.path)).toEqual({
      prefab: { components: [{ id: "mesh", classId: "MeshComponent", properties: { materialGuid: wall.header.guid } }] },
    });
    expect(enemy.header.parentClass).toBe("Base");
    expect(enemy.header.dependencies).toEqual([wall.header.guid, "class-base"]);

    expect(boss.header.parentClass).toBe("Enemy_1");
    expect(boss.header.dependencies).toEqual([enemy.header.guid]);
    expect(boss.header.classReferences).toEqual(["Enemy_1"]);

    expect(await documentAt(arena.path)).toEqual({
      name: "arena",
      actors: [
        { id: "a1", classId: "Enemy_1", components: [{ id: "mesh", classId: "MeshComponent", properties: { materialGuid: wall.header.guid } }] },
        { id: "a2", classId: "Base", components: [{ id: "sprite", classId: "SpriteComponent", properties: { assetGuid: "tex-stone" } }] },
      ],
    });
    expect(arena.header.dependencies).toEqual([enemy.header.guid, wall.header.guid, "class-base", "tex-stone"]);
    expect(arena.header.classReferences).toEqual(["Enemy_1", "Base"]);

    expect(await documentAt(hero.path)).toEqual({ textureGuid: brick });
    expect(await documentAt(copyAt("assets/kit_1/drops.datatree.hasset").path)).toEqual({
      kind: "dataTree", entries: [{ id: "coin", definitionGuid: "def-loot", values: { Icon: brick } }],
    });
    expect(hero.header.payload.atlasTextures).toEqual([brick]);

    // The originals keep pointing at each other, and only the copies use the copied Texture.
    expect(await documentAt("assets/kit/levels/arena.scene.hasset")).toMatchObject({
      actors: [{ classId: "Enemy", components: [{ properties: { materialGuid: "mat-wall" } }] }, { classId: "Base" }],
    });
    expect(registry.getByGuid("class-boss")?.header.parentClass).toBe("Enemy");
    expect(registry.showReferences("tex-brick").inbound).toEqual(["mat-wall", "sprite-hero", "tree-drops"]);
    expect(registry.showReferences(brick).inbound).toEqual(
      [hero.header.guid, wall.header.guid, copyAt("assets/kit_1/drops.datatree.hasset").header.guid].sort(),
    );
  });

  it("renames a folder in place through moveFolder with a new name", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/fx/spark.hasset", {
      guid: "spark-1",
      type: "Texture",
      name: "spark",
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.moveFolder("project", "fx", "", "vfx");
    expect(registry.getByGuid("spark-1")?.path).toBe(
      "assets/vfx/spark.hasset",
    );
    expect(await storage.exists("assets/fx/spark.hasset")).toBe(false);
  });

  it("copies a folder into another parent", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/fx/spark.hasset", {
      guid: "spark-1",
      type: "Texture",
      name: "spark",
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.createFolder("project", "effects");
    const copied = await registry.copyFolder("project", "fx", "effects");
    expect(copied).toBe("effects/fx");
    expect(registry.list().some((a) => a.path === "assets/effects/fx/spark.hasset")).toBe(
      true,
    );
    expect(registry.getByGuid("spark-1")?.path).toBe("assets/fx/spark.hasset");
  });

  it("uses a root's own storage and refuses writes on read-only roots", async () => {
    const project = await createStorage();
    await writeAsset(project, "assets/main.scene.hasset", {
      guid: "scene-1",
      type: "Scene",
      name: "Main",
    });
    const engine = new MemoryStorageAdapter("opfs");
    await engine.openDocumentsProject("engine-plugins");
    await writeAsset(engine, "starter/assets/hero.class.hasset", {
      guid: "hero-1",
      type: "Class",
      name: "StarterActor",
    });

    const registry = new AssetRegistry(project);
    await registry.mountRoot(projectContentRoot());
    const pluginRoot: ContentRoot = {
      id: "plugin:engine-1",
      kind: "plugin",
      pathPrefix: "starter/assets",
      readOnly: true,
      storage: engine,
    };
    await registry.mountRoot(pluginRoot);

    expect(registry.storageFor("plugin:engine-1")).toBe(engine);
    expect(registry.getByGuid("hero-1")?.rootId).toBe("plugin:engine-1");
    expect(registry.listDocumentPaths({ rootId: "project" })).toEqual({
      scenes: ["assets/main.scene.hasset"],
      graphs: [],
    });
    await expect(
      registry.createAsset("plugin:engine-1", "extra.class.hasset", {
        guid: "extra-1",
        type: "Class",
        name: "Extra",
        version: 1,
        dependencies: [],
        parentClass: "Actor",
        payload: {},
        chunks: [],
      }),
    ).rejects.toThrow(/read-only/i);
  });

  it("records DirEntry mtime on indexed assets", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.hasset", {
      guid: "tex-mtime",
      type: "Texture",
      name: "tex",
    });
    const expected = (await storage.stat("assets/tex.hasset")).mtime;
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.getByGuid("tex-mtime")?.mtime).toBe(expected);
  });

  it("records the written file's mtime after a rename, a duplicate and a Font attach", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.hasset", { guid: "tex", type: "Texture", name: "tex" });
    await writeAsset(storage, "assets/Ui.hasset", { guid: "font", type: "Font", name: "Ui" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.renameAsset("tex", "Renamed");
    const copy = await registry.duplicateAsset("tex", "project");
    await registry.importFile("project", "", "Ui.facetype.json", new TextEncoder().encode('{"glyphs":{}}'));
    expect(registry.getByGuid("font")!.header.chunks.some((chunk) => chunk.id === "facetype-glyphs")).toBe(true);
    for (const guid of ["tex", copy.header.guid, "font"]) {
      const asset = registry.getByGuid(guid)!;
      expect(asset.mtime).not.toBeNull();
      expect(asset.mtime).toBe((await storage.stat(asset.path)).mtime);
    }
  });

  it("attaches a representation to the Font of its name in the import folder, and to no Font when the name is ambiguous", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/a/Ui.hasset", { guid: "font-a", type: "Font", name: "Ui" });
    await writeAsset(storage, "assets/b/Ui.hasset", { guid: "font-b", type: "Font", name: "Ui" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const glyphs = () => new TextEncoder().encode('{"glyphs":{}}');
    const hasGlyphs = (guid: string) => registry.getByGuid(guid)!.header.chunks.some((chunk) => chunk.id === "facetype-glyphs");

    expect(await registry.importFile("project", "a", "Ui.facetype.json", glyphs())).toEqual([]);
    expect([hasGlyphs("font-a"), hasGlyphs("font-b")]).toEqual([true, false]);
    // Two Fonts named Ui and neither in this folder: the import makes its own.
    const created = await registry.importFile("project", "c", "Ui.facetype.json", glyphs());
    expect(created.map((asset) => [asset.header.type, asset.path])).toEqual([["Font", "assets/c/Ui.hasset"]]);
    expect(hasGlyphs("font-b")).toBe(false);
  });

  it("attaches MSDF into a saved Font's document, keeping its source and fallbacks", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    // Saved from the Font editor: the payload lives in the document chunk.
    await storage.writeBinary("assets/Ui.hasset", await encodeAssetDocument({
      type: "Font", name: "Ui", guid: "font", version: 1,
      payload: createFontPayload("Ui", { fallbackGuids: ["fallback"], representations: { source: true } }) as unknown as Record<string, unknown>,
    }, { extraChunks: [{ id: "source", kind: "font", mime: "font/ttf", data: new Uint8Array([1, 2, 3]) }] }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());

    const json = new TextEncoder().encode(JSON.stringify({ pages: ["Ui-msdf.png"], chars: [] }));
    await registry.importFile("project", "", "Ui-msdf.json", json, { sidecars: { "Ui-msdf.png": new Uint8Array([9]) } });
    const expected = {
      family: "Ui",
      fallbackGuids: ["fallback"],
      representations: { source: true, facetype: false, msdfJson: true, msdfPng: true, msdf: true },
    };
    expect((await decodeAssetDocument(await storage.readBinary("assets/Ui.hasset"))).payload).toMatchObject(expected);
    expect(registry.getByGuid("font")!.header.payload).toMatchObject(expected);
  });

  it("fails a pending Texture's encode that has no source pixels instead of leaving it pending", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    await storage.writeBinary("assets/tex.hasset", await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
        guid: "tex", type: "Texture", name: "tex", engineVersion: "0.0.0", version: 1, mode: "thin",
        dependencies: [], parentClass: null, payload: { usage: "albedo", compressionState: "pending" },
      },
      chunks: [],
    }));
    const registry = new AssetRegistry(storage);
    registry.setEncodePipeline(new EncodeQueue({ onComplete: async () => {} }));
    await registry.mountRoot(projectContentRoot());

    expect(await registry.requeueUncompressedTextures()).toBe(0);
    expect(registry.getByGuid("tex")!.header.payload).toMatchObject({
      compressionState: "encode_failed",
      encodeError: "The Texture has no source pixels to encode.",
    });
  });

  it("gives overlapping copies of one folder different names", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/fx/spark.hasset", { guid: "spark", type: "Texture", name: "spark" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());

    const copies = await Promise.all([registry.duplicateFolder("project", "fx"), registry.duplicateFolder("project", "fx")]);
    expect(copies.sort()).toEqual(["fx_1", "fx_2"]);
    for (const copy of copies) expect(registry.getByPath(`assets/${copy}/spark.hasset`)).toBeDefined();
  });

  it("knows a created Tileset's atlas from its header payload without reading a document", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const tileset = await registry.createAsset("project", "Ground.tileset.hasset", {
      type: "Tileset", name: "Ground", guid: "ground", version: 1, dependencies: [], parentClass: null,
      payload: { textureGuid: "atlas", tileWidth: 16, tileHeight: 16 }, chunks: [],
    });
    expect(tileset.header.engineVersion).toBe(ENGINE_VERSION);
    expect(registry.isAtlasTexture("atlas")).toBe(true);
    expect(registry.payloadLoader.snapshot().recentRequests).toEqual([]);
  });
});

describe("AssetRegistry generation", () => {
  /** Every read the editor derives registry views from; none may advance the generation. */
  function readEverything(registry: AssetRegistry): void {
    registry.list();
    registry.list({ type: "Texture" });
    registry.getByGuid("tex-1");
    registry.getByPath("assets/tex.hasset");
    registry.folderTree("project");
    registry.listRoots();
    registry.showReferences("tex-1");
    registry.listDocumentPaths();
    registry.isAtlasTexture("tex-1");
  }

  it("advances on every index, folder, root and compression change, and never on reads", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.hasset", { guid: "tex-1", type: "Texture", name: "tex" });
    await writeAsset(storage, "assets/fx/spark.hasset", { guid: "spark-1", type: "Texture", name: "spark" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const plugin: ContentRoot = { id: "plugin:p", kind: "plugin", pathPrefix: "plugin/assets", readOnly: true };

    const mutations: Array<[string, () => Promise<unknown> | unknown]> = [
      ["create", () => registry.createAsset("project", "mat.hasset", {
        guid: "mat-1", type: "Material", name: "mat", version: 1, dependencies: ["tex-1"], payload: {}, chunks: [],
      })],
      ["reindex a saved file", async () => {
        await writeAsset(storage, "assets/tex.hasset", { guid: "tex-1", type: "Texture", name: "saved" });
        await registry.reindexPath("assets/tex.hasset");
      }],
      ["compression state", () => registry.setCompressionState("tex-1", "encode_failed", { error: "boom" })],
      ["rename", () => registry.renameAsset("mat-1", "shiny")],
      ["move", () => registry.moveAsset("mat-1", "project", "materials/shiny.hasset")],
      ["create folder", () => registry.createFolder("project", "empty")],
      ["move folder", () => registry.moveFolder("project", "empty", "", "renamed")],
      ["delete folder", () => registry.deleteFolder("project", "renamed")],
      ["placeholder", () => registry.indexPlaceholder("missing-1")],
      ["delete", () => registry.deleteAsset("spark-1")],
      ["mount root", () => registry.mountRoot(plugin)],
      ["unmount root", () => registry.unmountRoot("plugin:p")],
    ];

    let previous = registry.generation;
    for (const [label, mutate] of mutations) {
      await mutate();
      const after = registry.generation;
      expect(after, label).toBeGreaterThan(previous);
      readEverything(registry);
      expect(registry.generation, `reads after ${label}`).toBe(after);
      previous = after;
    }
    expect(registry.getByGuid("tex-1")?.header.payload.compressionState).toBe("encode_failed");
    expect(registry.getByGuid("mat-1")?.path).toBe("assets/materials/shiny.hasset");
  });

  it("never moves backwards or repeats when a remount replaces the registry", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.hasset", { guid: "tex-1", type: "Texture", name: "tex" });
    const clock = new RegistryGenerationClock();
    const first = new AssetRegistry(storage, { generationClock: clock });
    await first.mountRoot(projectContentRoot());
    await first.createFolder("project", "a");
    await first.createFolder("project", "b");
    const seen = first.generation;

    // A fresh scan of fewer entries than the old registry ever indexed.
    await storage.remove("assets/a");
    await storage.remove("assets/b");
    const second = new AssetRegistry(storage, { generationClock: clock });
    await second.mountRoot(projectContentRoot());
    expect(second.generation).toBeGreaterThan(seen);

    // A write still landing on the replaced registry is not lost either.
    const beforeLateWrite = second.generation;
    await first.setCompressionState("tex-1", "pending");
    expect(second.generation).toBeGreaterThan(beforeLateWrite);
  });

  it("resolves symbolic class references against the catalog as it is after a rename", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    const dependencyMetadata = { dependencyMetadataVersion: 1, dependencies: [], requiredDependencies: [], requiredVariableNames: [] };
    await storage.writeBinary("assets/Goblin.class.hasset", await encodeAssetDocument(
      { type: "Class", name: "Goblin", guid: "class-goblin", version: 1, payload: { members: [] } },
      { parentClass: null, dependencyMetadata },
    ));
    await storage.writeBinary("assets/level.scene.hasset", await encodeAssetDocument(
      { type: "Scene", name: "level", guid: "scene", version: 1, payload: { name: "level", actors: [{ id: "a", classId: "Goblin", components: [] }] } },
      { parentClass: null, dependencyMetadata: { ...dependencyMetadata, classReferences: ["Goblin"], requiredClassReferences: ["Goblin"] } },
    ));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.dependenciesFor("scene")).toEqual(["class-goblin"]);
    expect(registry.requiredDependenciesFor("scene")).toEqual(["class-goblin"]);
    expect(registry.showReferences("class-goblin").inbound).toEqual(["scene"]);

    await registry.renameAsset("class-goblin", "Orc");
    expect(registry.dependenciesFor("scene")).toEqual([]);
    expect(() => registry.requiredDependenciesFor("scene")).toThrow("requires missing Class Goblin");
    expect(() => registry.requiredDependenciesFor("scene")).toThrow("requires missing Class Goblin");
    expect(registry.showReferences("class-goblin").inbound).toEqual([]);

    await registry.renameAsset("class-goblin", "Goblin");
    expect(registry.requiredDependenciesFor("scene")).toEqual(["class-goblin"]);
    expect(registry.showReferences("class-goblin").inbound).toEqual(["scene"]);
  });

  it("reports each Class's symbolic referrers together and follows referrers that are removed or added", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    const base = { dependencyMetadataVersion: 1, dependencies: [], requiredDependencies: [], requiredVariableNames: [] };
    const writeClass = async (name: string, guid: string) => storage.writeBinary(`assets/${name}.class.hasset`, await encodeAssetDocument(
      { type: "Class", name, guid, version: 1, payload: { members: [] } }, { parentClass: null, dependencyMetadata: base },
    ));
    const writeScene = async (guid: string, classes: string[]) => storage.writeBinary(`assets/${guid}.scene.hasset`, await encodeAssetDocument(
      { type: "Scene", name: guid, guid, version: 1, payload: { name: guid, actors: classes.map((classId, index) => ({ id: `a${index}`, classId, components: [] })) } },
      { parentClass: null, dependencyMetadata: { ...base, classReferences: classes, requiredClassReferences: classes } },
    ));
    await writeClass("Goblin", "class-goblin");
    await writeClass("Orc", "class-orc");
    await writeScene("scene-b", ["Goblin"]);
    await writeScene("scene-a", ["Goblin", "Orc"]);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.showReferences("class-goblin").inbound).toEqual(["scene-a", "scene-b"]);
    expect(registry.showReferences("class-orc").inbound).toEqual(["scene-a"]);
    expect(registry.showReferences("scene-a").inbound).toEqual([]);

    await registry.deleteAsset("scene-a");
    expect(registry.showReferences("class-goblin").inbound).toEqual(["scene-b"]);
    expect(registry.showReferences("class-orc").inbound).toEqual([]);
    await writeScene("scene-c", ["Orc"]);
    await registry.reindexPath("assets/scene-c.scene.hasset");
    expect(registry.showReferences("class-orc").inbound).toEqual(["scene-c"]);
  });
});

describe("AssetRegistry moves between content roots", () => {
  const PLUGIN = "plugins/tools/assets";
  const pluginRoot: ContentRoot = { id: "plugin:tools", kind: "plugin", pathPrefix: PLUGIN };
  /** Above the blob threshold, so the chunk lives in its root's blob store. */
  const bigPayload = new Uint8Array(70 * 1024).map((_, index) => index % 251);

  async function writeBlobAsset(storage: MemoryStorageAdapter, path: string, options: { guid: string; type: string; name: string }): Promise<string> {
    await storage.mkdir(path.slice(0, path.lastIndexOf("/")), true);
    const blobs = createVfsBlobStore(storage, "assets/.blobs");
    const bytes = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [], requiredVariableNames: [],
        guid: options.guid, type: options.type, name: options.name, engineVersion: "0.0.0",
        version: 1, mode: "thin", dependencies: [], parentClass: null, payload: {},
      },
      chunks: [{ id: "payload", kind: "payload", mime: "application/octet-stream", data: bigPayload }],
      writeBlob: (sha256, data) => blobs.writeBlob(sha256, data),
    });
    await storage.writeBinary(path, bytes);
    const locator = readHassetHeader(bytes).chunks[0]!.locator;
    if (!("blob" in locator)) throw new Error("The fixture chunk was stored inline");
    return locator.blob;
  }

  async function mountBoth(storage: MemoryStorageAdapter): Promise<AssetRegistry> {
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.mountRoot(pluginRoot);
    return registry;
  }

  it("moves an asset into a plugin with its blob chunks, keeping its guid and the references to it", async () => {
    const storage = await createStorage();
    const blob = await writeBlobAsset(storage, "assets/Rock.hasset", { guid: "rock", type: "Texture", name: "Rock" });
    await writeAsset(storage, "assets/main.scene.hasset", { guid: "scene", type: "Scene", name: "main", dependencies: ["rock"] });
    const registry = await mountBoth(storage);
    const original = await storage.readBinary("assets/Rock.hasset");

    const moved = await registry.moveAsset("rock", "plugin:tools", "Textures/Rock.hasset");

    expect(moved).toMatchObject({ rootId: "plugin:tools", path: `${PLUGIN}/Textures/Rock.hasset` });
    expect(moved.header.guid).toBe("rock");
    expect(registry.getByGuid("rock")).toBe(moved);
    expect(registry.getByPath(moved.path)).toBe(moved);
    expect(registry.getByPath("assets/Rock.hasset")).toBeUndefined();
    expect(registry.list({ rootId: "project" }).map((asset) => asset.header.guid)).toEqual(["scene"]);
    expect(await storage.exists("assets/Rock.hasset")).toBe(false);
    expect(await storage.readBinary(moved.path)).toEqual(original);
    expect(await storage.exists(`${PLUGIN}/.blobs/${blob}`)).toBe(true);
    expect(registry.showReferences("rock").inbound).toEqual(["scene"]);
    expect(await registry.readChunk("rock", "payload")).toEqual(bigPayload);

    // Without the project's copy of the blob, a fresh scan still reads it from the plugin.
    await storage.remove(`assets/.blobs/${blob}`);
    const rescanned = await mountBoth(storage);
    expect(rescanned.getByGuid("rock")?.rootId).toBe("plugin:tools");
    expect(await rescanned.readChunk("rock", "payload")).toEqual(bigPayload);
  });

  it("moves a Scene out of the project's document list and back into it", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/Level.scene.hasset", { guid: "level", type: "Scene", name: "Level" });
    const registry = await mountBoth(storage);

    await registry.moveAsset("level", "plugin:tools", "Level.scene.hasset");
    expect(registry.listDocumentPaths({ rootId: "project" }).scenes).toEqual([]);

    const back = await registry.moveAsset("level", "project", "Levels/Level.scene.hasset");
    expect(back.rootId).toBe("project");
    expect(registry.listDocumentPaths({ rootId: "project" }).scenes).toEqual(["assets/Levels/Level.scene.hasset"]);
    expect(await storage.exists(`${PLUGIN}/Level.scene.hasset`)).toBe(false);
  });

  it("refuses to move into or out of a read-only root and leaves both roots as they were", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/Wood.hasset", { guid: "wood", type: "Material", name: "Wood" });
    const engine = new MemoryStorageAdapter("opfs");
    await engine.openDocumentsProject("engine-plugins");
    await writeAsset(engine, "starter/assets/Hero.class.hasset", { guid: "hero", type: "Class", name: "Hero" });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.mountRoot({ id: "plugin:starter", kind: "plugin", pathPrefix: "starter/assets", readOnly: true, storage: engine });
    await registry.createFolder("project", "Props");

    await expect(registry.moveAsset("wood", "plugin:starter", "Wood.hasset")).rejects.toThrow(/read-only/i);
    await expect(registry.moveAsset("hero", "project", "Hero.class.hasset")).rejects.toThrow(/read-only/i);
    await expect(registry.moveFolder("project", "Props", "", undefined, "plugin:starter")).rejects.toThrow(/read-only/i);

    expect(registry.getByGuid("wood")?.path).toBe("assets/Wood.hasset");
    expect(registry.getByGuid("hero")?.rootId).toBe("plugin:starter");
    expect(await storage.exists("assets/Wood.hasset")).toBe(true);
    expect(await storage.exists("assets/Props")).toBe(true);
    expect(await storage.exists("assets/Hero.class.hasset")).toBe(false);
    expect(await engine.exists("starter/assets/Hero.class.hasset")).toBe(true);
    expect(await engine.exists("starter/assets/Wood.hasset")).toBe(false);
  });

  it("refuses to replace a file or folder already at the destination, even one the index does not list", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/Wood.hasset", { guid: "wood", type: "Material", name: "Wood" });
    const registry = await mountBoth(storage);
    await storage.mkdir(PLUGIN, true);
    await storage.writeBinary(`${PLUGIN}/Wood.hasset`, new Uint8Array([7]));
    await registry.createFolder("project", "Props");
    await registry.createFolder("plugin:tools", "Props");

    await expect(registry.moveAsset("wood", "plugin:tools", "Wood.hasset")).rejects.toThrow(`Target path already exists: ${PLUGIN}/Wood.hasset`);
    await expect(registry.moveFolder("project", "Props", "", undefined, "plugin:tools")).rejects.toThrow(`Target path already exists: ${PLUGIN}/Props`);

    expect(await storage.readBinary(`${PLUGIN}/Wood.hasset`)).toEqual(new Uint8Array([7]));
    expect(registry.getByGuid("wood")).toMatchObject({ rootId: "project", path: "assets/Wood.hasset" });
    expect(await storage.exists("assets/Wood.hasset")).toBe(true);
    expect(await storage.exists("assets/Props")).toBe(true);
  });

  it("refuses to move an asset whose blob is missing and writes nothing into the target root", async () => {
    const storage = await createStorage();
    const blob = await writeBlobAsset(storage, "assets/Rock.hasset", { guid: "rock", type: "Texture", name: "Rock" });
    const registry = await mountBoth(storage);
    await storage.remove(`assets/.blobs/${blob}`);

    await expect(registry.moveAsset("rock", "plugin:tools", "Rock.hasset")).rejects.toThrow(blob);

    expect(await storage.exists(`${PLUGIN}/Rock.hasset`)).toBe(false);
    expect(await storage.exists("assets/Rock.hasset")).toBe(true);
    expect(registry.getByGuid("rock")).toMatchObject({ rootId: "project", path: "assets/Rock.hasset" });
  });

  it("moves a folder into a plugin with its subfolders, empty folders and blob chunks", async () => {
    const storage = await createStorage();
    const blob = await writeBlobAsset(storage, "assets/Characters/Hero.hasset", { guid: "hero", type: "Texture", name: "Hero" });
    await writeAsset(storage, "assets/Characters/Armor/Plate.hasset", { guid: "plate", type: "Material", name: "Plate", dependencies: ["hero"] });
    await writeAsset(storage, "assets/main.scene.hasset", { guid: "scene", type: "Scene", name: "main", dependencies: ["plate"] });
    const registry = await mountBoth(storage);
    await registry.createFolder("project", "Characters/Empty");

    await registry.moveFolder("project", "Characters", "", undefined, "plugin:tools");

    expect(registry.getByGuid("hero")).toMatchObject({ rootId: "plugin:tools", path: `${PLUGIN}/Characters/Hero.hasset` });
    expect(registry.getByGuid("plate")).toMatchObject({ rootId: "plugin:tools", path: `${PLUGIN}/Characters/Armor/Plate.hasset` });
    expect(registry.showReferences("plate").inbound).toEqual(["scene"]);
    expect(registry.showReferences("hero").inbound).toEqual(["plate"]);
    expect(await storage.exists("assets/Characters")).toBe(false);
    expect(registry.folderTree("project").children).toEqual([]);
    const subfolders = (registry: AssetRegistry) =>
      registry.folderTree("plugin:tools").children.find((child) => child.name === "Characters")?.children.map((child) => child.name).sort();
    expect(subfolders(registry)).toEqual(["Armor", "Empty"]);

    await storage.remove(`assets/.blobs/${blob}`);
    const rescanned = await mountBoth(storage);
    expect(rescanned.getByGuid("hero")?.rootId).toBe("plugin:tools");
    expect(await rescanned.readChunk("hero", "payload")).toEqual(bigPayload);
    expect(subfolders(rescanned)).toEqual(["Armor", "Empty"]);
  });

  it("moves an asset and a folder into a writable root that keeps its own storage", async () => {
    const storage = await createStorage();
    const blob = await writeBlobAsset(storage, "assets/Rock.hasset", { guid: "rock", type: "Texture", name: "Rock" });
    await writeAsset(storage, "assets/Props/Crate.hasset", { guid: "crate", type: "Material", name: "Crate" });
    const other = new MemoryStorageAdapter("opfs");
    await other.openDocumentsProject("other");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.mountRoot({ id: "extra", kind: "synthetic", pathPrefix: "extra/assets", storage: other });
    await registry.createFolder("project", "Props/Empty");

    await registry.moveAsset("rock", "extra", "Rock.hasset");
    await registry.moveFolder("project", "Props", "", undefined, "extra");

    expect(await other.exists(`extra/assets/.blobs/${blob}`)).toBe(true);
    expect(await other.exists("extra/assets/Props/Crate.hasset")).toBe(true);
    expect(await other.exists("extra/assets/Props/Empty")).toBe(true);
    expect(await storage.exists("assets/Rock.hasset")).toBe(false);
    expect(await storage.exists("assets/Props")).toBe(false);
    expect(registry.getByGuid("crate")).toMatchObject({ rootId: "extra", path: "extra/assets/Props/Crate.hasset" });
    expect(await registry.readChunk("rock", "payload")).toEqual(bigPayload);
  });

  it("will not carry a folder's unlisted copy of another file's guid to another root, and follows the listed file when it moves", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/a/hero.hasset", { guid: "hero", type: "Material", name: "Hero" });
    await storage.mkdir("assets/b", true);
    await storage.writeBinary("assets/b/hero.hasset", await storage.readBinary("assets/a/hero.hasset"));
    const registry = await mountBoth(storage);
    expect(registry.listGuidConflicts().map((conflict) => conflict.path)).toEqual(["assets/b/hero.hasset"]);

    await expect(registry.moveFolder("project", "b", "", undefined, "plugin:tools")).rejects.toThrow(/assets\/b\/hero\.hasset/);
    expect(await storage.exists("assets/b/hero.hasset")).toBe(true);
    expect(await storage.exists(`${PLUGIN}/b`)).toBe(false);

    await registry.moveFolder("project", "a", "", undefined, "plugin:tools");
    expect(registry.listGuidConflicts()).toEqual([
      { rootId: "project", path: "assets/b/hero.hasset", guid: "hero", indexedPath: `${PLUGIN}/a/hero.hasset` },
    ]);
  });
});

describe("ThumbnailDecodeLru", () => {
  it("evicts the oldest entry when over capacity", () => {
    const lru = new ThumbnailDecodeLru(2);
    lru.set("a", new Uint8Array([1]));
    lru.set("b", new Uint8Array([2]));
    lru.set("c", new Uint8Array([3]));
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toEqual(new Uint8Array([2]));
    expect(lru.size).toBe(2);
  });

  it("deletes a cached key so a later get reloads", () => {
    const lru = new ThumbnailDecodeLru(4);
    lru.set("hero", new Uint8Array([9]));
    expect(lru.delete("hero")).toBe(true);
    expect(lru.get("hero")).toBeUndefined();
    expect(lru.size).toBe(0);
    expect(lru.delete("missing")).toBe(false);
  });
});
