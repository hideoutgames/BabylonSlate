import { describe, expect, it, vi } from "vitest";
import {
  AssetRegistry,
  encodeBabasset,
  projectContentRoot,
} from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { createPickerAsset, createProjectAsset } from "./create-project-asset";

async function registryWith(
  files: Array<{ path: string; type: string; name: string; parentClass?: string }>,
  engineFiles: Array<{ path: string; type: string; name: string }> = [],
  /** Writable project plugin content roots (`plugins/Foo/assets`). */
  pluginRoots: string[] = [],
): Promise<AssetRegistry> {
  const write = async (
    storage: MemoryStorageAdapter,
    file: { path: string; type: string; name: string; parentClass?: string },
  ) => {
    await storage.mkdir(file.path.slice(0, file.path.lastIndexOf("/")), true);
    const bytes = await encodeBabasset({
      header: {
        guid: `guid-${file.path}`,
        type: file.type,
        name: file.name,
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: file.parentClass ?? null,
        payload: {},
      },
      chunks: [],
    });
    await storage.writeBinary(file.path, bytes);
  };
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("test.babproject");
  for (const file of files) await write(storage, file);
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  for (const pathPrefix of pluginRoots) {
    await storage.mkdir(pathPrefix, true);
    await registry.mountRoot({ id: `plugin:${pathPrefix}`, kind: "plugin", pathPrefix });
  }
  if (engineFiles.length > 0) {
    const engine = new MemoryStorageAdapter("opfs");
    await engine.openDocumentsProject("engine-plugins");
    for (const file of engineFiles) await write(engine, file);
    await registry.mountRoot({
      id: "plugin:engine-1",
      kind: "plugin",
      pathPrefix: "starter/assets",
      readOnly: true,
      storage: engine,
    });
  }
  return registry;
}

describe("createPickerAsset", () => {
  it("creates a persisted Save Game definition through the standard asset registry", async () => {
    const registry = await registryWith([]);
    const asset = await createPickerAsset({ registry, ownerPath: null, openDocuments: [], type: "SaveGame", name: "Player Progress" });
    expect(asset.path).toBe("assets/Player_Progress.savegame.babasset");
    expect(asset.header.type).toBe("SaveGame");
    expect(asset.header.payload).toEqual({ id: asset.header.guid, schemaVersion: 1, fields: [] });
    expect(registry.getByGuid(asset.header.guid)).toBeDefined();
  });
  it("creates a uniquely named asset beside the owning document", async () => {
    const registry = await registryWith([
      { path: "assets/Levels/Main.scene.babasset", type: "Scene", name: "Main" },
      { path: "assets/Levels/NewMaterial.material.babasset", type: "Material", name: "NewMaterial" },
      { path: "assets/NewMaterial_1.material.babasset", type: "Material", name: "NewMaterial_1" },
    ]);

    const created = await createPickerAsset({
      registry,
      ownerPath: "assets/Levels/Main.scene.babasset",
      openDocuments: [],
      type: "Material",
    });
    const named = await createPickerAsset({
      registry,
      ownerPath: "assets/Levels/Main.scene.babasset",
      openDocuments: [],
      type: "Material",
      name: "Lava Glow",
    });

    expect(created.path).toBe("assets/Levels/NewMaterial_1.material.babasset");
    expect(created.header.name).toBe("NewMaterial_1");
    expect(named.path).toBe("assets/Levels/Lava_Glow.material.babasset");
    expect(named.header.name).toBe("Lava Glow");
    expect(registry.getByGuid(created.header.guid)?.path).toBe(created.path);
  });

  it("writes new Materials in the requested domain", async () => {
    const registry = await registryWith([]);

    const particle = await createPickerAsset({
      registry,
      ownerPath: null,
      openDocuments: [],
      type: "Material",
      materialDomain: "particle",
    });
    const surface = await createPickerAsset({
      registry,
      ownerPath: null,
      openDocuments: [],
      type: "Material",
    });

    expect(particle.header.payload.domain).toBe("particle");
    expect(surface.header.payload.domain).toBe("surface");
  });

  it("keeps Class ids unique across folders and engine classes", async () => {
    const registry = await registryWith([
      { path: "assets/Characters/Hero.class.babasset", type: "Class", name: "Hero", parentClass: "Actor" },
      { path: "assets/Game/GameInstance_1.class.babasset", type: "Class", name: "GameInstance_1", parentClass: "GameInstance" },
      { path: "assets/Levels/Main.scene.babasset", type: "Scene", name: "Main" },
    ]);
    const create = (name: string) =>
      createPickerAsset({
        registry,
        ownerPath: "assets/Levels/Main.scene.babasset",
        openDocuments: [],
        type: "Class",
        name,
        parentClass: "Hero",
      });

    const hero = await create("Hero");
    const spaced = await create(" Boss Fight! ");
    const engine = await create("Actor");
    // `_N` stripping must not land on the engine class id `GameInstance`.
    const copy = await create("GameInstance_1");

    expect(hero.path).toBe("assets/Levels/Hero_1.class.babasset");
    expect(hero.header.parentClass).toBe("Hero");
    expect(spaced.path).toBe("assets/Levels/Boss_Fight.class.babasset");
    expect(spaced.header.name).toBe("Boss_Fight");
    expect(engine.path).toBe("assets/Levels/Actor_1.class.babasset");
    expect(copy.path).toBe("assets/Levels/GameInstance_2.class.babasset");
  });

  it("refuses Class parents that New Asset does not offer, before writing", async () => {
    const registry = await registryWith([
      { path: "assets/Layers/Fog.class.babasset", type: "Class", name: "Fog", parentClass: "SceneLayer" },
    ]);
    const before = registry.list().length;

    for (const parentClass of ["MeshComponent", "Fog"]) {
      await expect(
        createPickerAsset({
          registry,
          ownerPath: null,
          openDocuments: [],
          type: "Class",
          name: "Child",
          parentClass,
        }),
      ).rejects.toThrow(`cannot be a child of ${parentClass}`);
    }
    expect(registry.list()).toHaveLength(before);
  });

  it("creates in a project plugin's content root from its settings document", async () => {
    const registry = await registryWith([], [], ["plugins/Tools/assets"]);

    const created = await createPickerAsset({
      registry,
      ownerPath: "plugins/Tools/Tools.plugin.babasset",
      openDocuments: [],
      type: "Class",
      name: "Cleanup",
      parentClass: "EditorUtilityObject",
    });

    expect(created.rootId).toBe("plugin:plugins/Tools/assets");
    expect(created.path).toBe("plugins/Tools/assets/Cleanup.class.babasset");
  });

  it("falls back to the project assets root for read-only or missing owners", async () => {
    const registry = await registryWith(
      [],
      [{ path: "starter/assets/Demo/Intro.scene.babasset", type: "Scene", name: "Intro" }],
    );

    const fromPlugin = await createPickerAsset({
      registry,
      ownerPath: "starter/assets/Demo/Intro.scene.babasset",
      openDocuments: [],
      type: "RenderTarget",
    });
    const fromNothing = await createPickerAsset({
      registry,
      ownerPath: undefined,
      openDocuments: [],
      type: "RenderTarget",
    });

    expect(fromPlugin.rootId).toBe("project");
    expect(fromPlugin.path).toBe("assets/NewRenderTarget.rendertarget.babasset");
    expect(fromNothing.path).toBe("assets/NewRenderTarget_1.rendertarget.babasset");
  });
});

describe("createProjectAsset", () => {
  it("refuses a Class parent at the inheritance depth limit before writing", async () => {
    const createAsset = vi.fn();
    const parentOf = (id: string) => {
      const depth = Number(id.slice(1));
      return depth > 0 ? `C${depth - 1}` : null;
    };

    await expect(
      createProjectAsset({
        registry: { createAsset },
        rootId: "project",
        folderRelative: "",
        type: "Class",
        name: "TooDeep",
        parentClass: "C15",
        classParentOf: parentOf,
      }),
    ).rejects.toThrow(/at most 16 levels/);
    expect(createAsset).not.toHaveBeenCalled();
  });
});
