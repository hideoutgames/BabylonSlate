import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { encodeBabasset } from "./babasset";
import { projectContentRoot, type ContentRoot } from "./content-root";
import { AssetRegistry } from "./registry";
import { ThumbnailDecodeLru } from "./thumbnails";

async function createStorage(): Promise<MemoryStorageAdapter> {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("test.babproject");
  return storage;
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
  const bytes = await encodeBabasset({
    header: {
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
  it("mounts the project root and indexes headers only", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.babasset", {
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
    const path = "assets/tools.eui.babasset";
    const dir = "assets";
    await storage.mkdir(dir, true);
    const write = async (dockKind: string) => {
      const bytes = await encodeBabasset({
        header: {
          guid: "eui-1",
          type: "EditorUtilityInterface",
          name: "tools",
          engineVersion: "0.0.0",
          version: 1,
          mode: "thin",
          dependencies: [],
          parentClass: null,
          payload: { dockKind },
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
    await write("scene");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.getByGuid("eui-1")?.header.payload.dockKind).toBe("scene");
    await write("class");
    await registry.reindexPath(path);
    expect(registry.getByGuid("eui-1")?.header.payload.dockKind).toBe("class");
  });

  it("mounts a second synthetic root and resolves references across roots", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/scene.babasset", {
      guid: "scene-1",
      type: "Scene",
      name: "Main",
      dependencies: ["plugin-tex"],
    });
    await writeAsset(storage, "synthetic-root/assets/tex.babasset", {
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
      await writeAsset(storage, `assets/a${i}.babasset`, {
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
    const bytes = await storage.readBinary(first!.path);
    await registry.payloadLoader.loadChunk(bytes, first!.header.chunks[0]!);
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
      new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
    );
    expect(models.some((asset) => asset.header.type === "Model")).toBe(true);

    const remounted = new AssetRegistry(storage);
    await remounted.mountRoot(projectContentRoot());
    expect(remounted.list({ type: "Texture" }).length).toBeGreaterThanOrEqual(1);
    expect(remounted.list({ type: "Model" }).length).toBeGreaterThanOrEqual(1);
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

  it("remaps colliding guids when importing a .babasset", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/existing.babasset", {
      guid: "shared-guid",
      type: "Texture",
      name: "Existing",
    });
    const incoming = await encodeBabasset({
      header: {
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
      "incoming.babasset",
      incoming,
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.header.guid).not.toBe("shared-guid");
    expect(registry.getByGuid("shared-guid")?.header.name).toBe("Existing");
  });

  it("deletes assets and updates inbound references", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.babasset", {
      guid: "tex-1",
      type: "Texture",
      name: "tex",
    });
    await writeAsset(storage, "assets/mat.babasset", {
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
    expect(await storage.exists("assets/tex.babasset")).toBe(false);
    expect(registry.showReferences("tex-1").inbound).toEqual([]);
  });

  it("builds a folder tree with nested assets", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/root.babasset", {
      guid: "r1",
      type: "Texture",
      name: "root",
    });
    await writeAsset(storage, "assets/fx/spark.babasset", {
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

  it("lists Scene and Graph document paths", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/main.scene.babasset", {
      guid: "s1",
      type: "Scene",
      name: "Main",
    });
    await writeAsset(storage, "assets/main.graph.babasset", {
      guid: "g1",
      type: "Graph",
      name: "Main",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.listDocumentPaths()).toEqual({
      scenes: ["assets/main.scene.babasset"],
      graphs: ["assets/main.graph.babasset"],
    });
  });

  it("lists Class assets as graph documents", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/hero.class.babasset", {
      guid: "c1",
      type: "Class",
      name: "Hero",
    });
    await writeAsset(storage, "assets/legacy.graph.babasset", {
      guid: "g1",
      type: "Graph",
      name: "Legacy",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.listDocumentPaths()).toEqual({
      scenes: [],
      graphs: ["assets/hero.class.babasset", "assets/legacy.graph.babasset"],
    });
  });

  it("creates empty folders with a git-visible marker", async () => {
    const storage = await createStorage();
    await storage.mkdir("assets", true);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());

    await registry.createFolder("project", "fx/vfx");
    expect(await storage.exists("assets/fx/vfx/.babylonslate-folder")).toBe(true);

    const remounted = new AssetRegistry(storage);
    await remounted.mountRoot(projectContentRoot());
    const tree = remounted.folderTree("project");
    const fx = tree.children.find((child) => child.name === "fx");
    expect(fx).toBeDefined();
    expect(fx?.children.some((child) => child.name === "vfx")).toBe(true);
  });

  it("moves an asset without changing its guid", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.babasset", {
      guid: "tex-1",
      type: "Texture",
      name: "tex",
    });
    await writeAsset(storage, "assets/mat.babasset", {
      guid: "mat-1",
      type: "Material",
      name: "mat",
      dependencies: ["tex-1"],
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const moved = await registry.moveAsset("tex-1", "project", "textures/tex.babasset");
    expect(moved.header.guid).toBe("tex-1");
    expect(moved.path).toBe("assets/textures/tex.babasset");
    expect(await storage.exists("assets/tex.babasset")).toBe(false);
    expect(await storage.exists("assets/textures/tex.babasset")).toBe(true);
    expect(registry.showReferences("tex-1").inbound).toEqual(["mat-1"]);
  });

  it("duplicates an asset with a new guid", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.babasset", {
      guid: "tex-1",
      type: "Texture",
      name: "tex",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const copy = await registry.duplicateAsset("tex-1", "project", "copies");
    expect(copy.header.guid).not.toBe("tex-1");
    expect(copy.path).toBe("assets/copies/tex.babasset");
    expect(registry.getByGuid("tex-1")).toBeDefined();
    expect(registry.getByGuid(copy.header.guid)).toBeDefined();
    expect(copy.header.name).toBe("tex");
  });

  it("duplicates in the same folder using stem_N and writes header.name", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/Duplicate_1.babasset", {
      guid: "dup-1",
      type: "Texture",
      name: "Duplicate_1",
    });
    await writeAsset(storage, "assets/Duplicate_2.babasset", {
      guid: "dup-2",
      type: "Texture",
      name: "Duplicate_2",
    });
    await writeAsset(storage, "assets/Duplicate.babasset", {
      guid: "dup-0",
      type: "Texture",
      name: "Duplicate",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const copy = await registry.duplicateAsset("dup-1", "project", "");
    expect(copy.path).toBe("assets/Duplicate_3.babasset");
    expect(copy.header.name).toBe("Duplicate_3");
    expect(copy.header.guid).not.toBe("dup-1");
  });

  it("preserves .scene.babasset when duplicating a scene", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/main.scene.babasset", {
      guid: "scene-1",
      type: "Scene",
      name: "main",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const copy = await registry.duplicateAsset("scene-1", "project", "");
    expect(copy.path).toBe("assets/main_1.scene.babasset");
    expect(copy.header.name).toBe("main_1");
  });

  it("refuses to overwrite an existing asset path", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/tex.babasset", {
      guid: "tex-1",
      type: "Texture",
      name: "tex",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await expect(
      registry.createAsset("project", "tex.babasset", {
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
    await writeAsset(storage, "assets/old.babasset", {
      guid: "tex-1",
      type: "Texture",
      name: "old",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const renamed = await registry.renameAsset("tex-1", "shiny");
    expect(renamed.header.guid).toBe("tex-1");
    expect(renamed.path).toBe("assets/shiny.babasset");
    expect(renamed.header.name).toBe("shiny");
  });

  it("moves a folder and all assets under it", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/fx/spark.babasset", {
      guid: "spark-1",
      type: "Texture",
      name: "spark",
    });

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.moveFolder("project", "fx", "effects");
    expect(registry.getByGuid("spark-1")?.path).toBe(
      "assets/effects/fx/spark.babasset",
    );
    expect(await storage.exists("assets/fx/spark.babasset")).toBe(false);
  });

  it("duplicates a folder as a sibling with new asset guids", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/fx/spark.babasset", {
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
    const copyAsset = registry.list().find((a) => a.path === "assets/fx_1/spark.babasset");
    expect(copyAsset).toBeDefined();
    expect(copyAsset?.header.guid).not.toBe("spark-1");
    expect(copyAsset?.header.name).toBe("spark");
    expect(registry.getByGuid("spark-1")?.path).toBe("assets/fx/spark.babasset");
    const nested = registry
      .folderTree("project")
      .children.find((c) => c.path === "assets/fx_1")
      ?.children.find((c) => c.name === "nested");
    expect(nested).toBeDefined();
  });

  it("renames a folder in place through moveFolder with a new name", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/fx/spark.babasset", {
      guid: "spark-1",
      type: "Texture",
      name: "spark",
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.moveFolder("project", "fx", "", "vfx");
    expect(registry.getByGuid("spark-1")?.path).toBe(
      "assets/vfx/spark.babasset",
    );
    expect(await storage.exists("assets/fx/spark.babasset")).toBe(false);
  });

  it("copies a folder into another parent", async () => {
    const storage = await createStorage();
    await writeAsset(storage, "assets/fx/spark.babasset", {
      guid: "spark-1",
      type: "Texture",
      name: "spark",
    });
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.createFolder("project", "effects");
    const copied = await registry.copyFolder("project", "fx", "effects");
    expect(copied).toBe("effects/fx");
    expect(registry.list().some((a) => a.path === "assets/effects/fx/spark.babasset")).toBe(
      true,
    );
    expect(registry.getByGuid("spark-1")?.path).toBe("assets/fx/spark.babasset");
  });

  it("uses a root's own storage and refuses writes on read-only roots", async () => {
    const project = await createStorage();
    await writeAsset(project, "assets/main.scene.babasset", {
      guid: "scene-1",
      type: "Scene",
      name: "Main",
    });
    const engine = new MemoryStorageAdapter("opfs");
    await engine.openDocumentsProject("engine-plugins");
    await writeAsset(engine, "starter/assets/hero.class.babasset", {
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
      scenes: ["assets/main.scene.babasset"],
      graphs: [],
    });
    await expect(
      registry.createAsset("plugin:engine-1", "extra.class.babasset", {
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
    await writeAsset(storage, "assets/tex.babasset", {
      guid: "tex-mtime",
      type: "Texture",
      name: "tex",
    });
    const expected = (await storage.stat("assets/tex.babasset")).mtime;
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.getByGuid("tex-mtime")?.mtime).toBe(expected);
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
});
