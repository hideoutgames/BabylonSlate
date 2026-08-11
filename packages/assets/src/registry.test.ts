import { describe, expect, it } from "vitest";
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
