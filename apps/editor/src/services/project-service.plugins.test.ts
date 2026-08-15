import { describe, expect, it } from "vitest";
import { PROJECT_FILE } from "@babylonslate/core";
import {
  createDefaultPluginSettings,
  createEmptyProjectFiles,
  encodeBabasset,
  encodePluginSettingsDocument,
  inspectBabplugin,
  writeProjectPlugin,
  buildStarterContentFiles,
  packEnginePluginFiles,
  unpackEnginePluginZip,
  STARTER_ACTOR_GUID,
  STARTER_CONTENT_FOLDER,
  STARTER_CONTENT_PLUGIN_GUID,
} from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { ProjectService } from "./project-service";

async function scaffolded() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Plugins.babproject");
  const service = new ProjectService(storage);
  await service.loadCurrentProject();
  return { storage, service };
}

async function writeClassAsset(
  storage: MemoryStorageAdapter,
  path: string,
  options: { guid: string; name: string },
) {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await storage.mkdir(dir, true);
  await storage.writeBinary(
    path,
    await encodeBabasset({
      header: {
        guid: options.guid,
        type: "Class",
        name: options.name,
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: "Actor",
        payload: {},
      },
      chunks: [
        {
          id: "payload",
          kind: "payload",
          mime: "application/octet-stream",
          data: new Uint8Array([1]),
        },
      ],
    }),
  );
}

describe("ProjectService plugin roots", () => {
  it("mounts enabled-by-default project plugins when opening", async () => {
    const { storage, service } = await scaffolded();
    const settings = createDefaultPluginSettings({
      pluginGuid: "pack-guid",
      displayName: "Pack",
    });
    settings.enabledByDefault = true;
    await writeProjectPlugin(storage, "pack", settings);
    await writeClassAsset(storage, "plugins/pack/assets/PackActor.class.babasset", {
      guid: "pack-actor",
      name: "PackActor",
    });

    await service.remountRegistry();
    expect(service.registry?.getRoot("plugin:pack-guid")).toBeTruthy();
    expect(service.registry?.getByGuid("pack-actor")?.header.name).toBe(
      "PackActor",
    );
    expect(
      service.registry?.listDocumentPaths({ rootId: "project" }).graphs,
    ).not.toContain("plugins/pack/assets/PackActor.class.babasset");
  });

  it("leaves disabled plugins unmounted", async () => {
    const { storage, service } = await scaffolded();
    const settings = createDefaultPluginSettings({
      pluginGuid: "off-guid",
      displayName: "Off",
    });
    settings.enabledByDefault = false;
    await writeProjectPlugin(storage, "off", settings);
    await writeClassAsset(storage, "plugins/off/assets/Hidden.class.babasset", {
      guid: "hidden-class",
      name: "Hidden",
    });

    await service.remountRegistry();
    expect(service.registry?.getRoot("plugin:off-guid")).toBeUndefined();
    expect(service.registry?.getByGuid("hidden-class")).toBeUndefined();
  });

  it("creates a project plugin folder from New Plugin", async () => {
    const { storage, service } = await scaffolded();
    const created = await service.createProjectPlugin("My Pack");
    expect(created.settings.displayName).toBe("My Pack");
    expect(await storage.exists("plugins/my-pack/my-pack.plugin.babasset")).toBe(
      true,
    );
    expect(await storage.exists("plugins/my-pack/assets")).toBe(true);
    expect(await storage.exists(PROJECT_FILE)).toBe(true);
  });

  it("exports a project plugin as a self-contained .babplugin zip", async () => {
    const { service } = await scaffolded();
    const created = await service.createProjectPlugin("My Pack");
    const zip = await service.exportPlugin(created.pluginGuid);
    const inspected = await inspectBabplugin(zip);
    expect(inspected.manifest.kind).toBe("plugin");
    expect(inspected.settings.displayName).toBe("My Pack");
    expect(inspected.settings.pluginGuid).toBe(created.pluginGuid);
  });

  it("imports a .babplugin into plugins/<safeName>/ and keeps guids", async () => {
    const source = await scaffolded();
    const created = await source.service.createProjectPlugin("Shared Pack");
    await writeClassAsset(
      source.storage,
      "plugins/shared-pack/assets/Hero.class.babasset",
      { guid: "hero-1", name: "Hero" },
    );
    const zip = await source.service.exportPlugin(created.pluginGuid);

    const dest = await scaffolded();
    const result = await dest.service.importPlugin(zip);
    expect(result.status).toBe("imported");
    if (result.status !== "imported") return;
    expect(result.descriptor.pluginGuid).toBe(created.pluginGuid);
    expect(
      await dest.storage.exists(
        "plugins/shared-pack/assets/Hero.class.babasset",
      ),
    ).toBe(true);
  });

  it("returns a Keep/Replace conflict for the same guid and version", async () => {
    const { storage, service } = await scaffolded();
    const settings = createDefaultPluginSettings({
      pluginGuid: "dup-guid",
      displayName: "Dup",
    });
    await writeProjectPlugin(storage, "dup", settings);
    await service.remountRegistry();
    const zip = await service.exportPlugin("dup-guid");
    const conflict = await service.importPlugin(zip);
    expect(conflict.status).toBe("conflict");
    const kept = await service.importPlugin(zip, "keep");
    expect(kept.status).toBe("kept");
    const replaced = await service.importPlugin(zip, "replace");
    expect(replaced.status).toBe("imported");
  });

  it("mounts enabled engine plugins from a separate storage", async () => {
    const { service } = await scaffolded();
    const engine = new MemoryStorageAdapter("opfs");
    await engine.openDocumentsProject("engine-plugins");
    const files = await buildStarterContentFiles();
    const packed = await packEnginePluginFiles(files, {
      id: STARTER_CONTENT_FOLDER,
    });
    await unpackEnginePluginZip(engine, packed.zip, STARTER_CONTENT_FOLDER);
    service.setEnginePluginStorage(engine);
    await service.applyPluginOverrides({
      [STARTER_CONTENT_PLUGIN_GUID]: { enabled: true },
    });
    expect(service.registry?.getRoot(`plugin:${STARTER_CONTENT_PLUGIN_GUID}`)).toBeTruthy();
    expect(service.registry?.getByGuid(STARTER_ACTOR_GUID)?.header.name).toBe(
      "StarterActor",
    );
    expect(service.plugins.find((plugin) => plugin.source === "engine")?.readOnly).toBe(
      true,
    );
  });

  it("does not placeholder a discovered plugin guid when an override exists", async () => {
    const { storage, service } = await scaffolded();
    const settings = createDefaultPluginSettings({
      pluginGuid: "pack-guid",
      displayName: "Pack",
    });
    settings.enabledByDefault = false;
    await writeProjectPlugin(storage, "pack", settings);
    await service.applyPluginOverrides({
      "pack-guid": { enabled: true },
      "deadbeef-0000-4000-8000-000000000099": { enabled: true },
    });
    expect(service.registry?.getByGuid("pack-guid")?.placeholder).toBeFalsy();
    expect(
      service.registry?.getByGuid("deadbeef-0000-4000-8000-000000000099")
        ?.placeholder,
    ).toBe(true);
    expect(
      service.registry?.getByGuid("deadbeef-0000-4000-8000-000000000099")
        ?.header.guid,
    ).toBe("deadbeef-0000-4000-8000-000000000099");
  });

  async function engineStarterStorage() {
    const engine = new MemoryStorageAdapter("opfs");
    await engine.openDocumentsProject("engine-plugins");
    const files = await buildStarterContentFiles();
    const packed = await packEnginePluginFiles(files, {
      id: STARTER_CONTENT_FOLDER,
    });
    await unpackEnginePluginZip(engine, packed.zip, STARTER_CONTENT_FOLDER);
    return engine;
  }

  it("copies engine plugin defaults into a new empty project", async () => {
    const storage = new MemoryStorageAdapter("documents");
    const service = new ProjectService(storage);
    service.setEnginePluginStorage(await engineStarterStorage());
    await service.createEmptyProject("Copy.babproject");
    expect(
      await storage.exists(
        "plugins/starter-content/assets/StarterActor.class.babasset",
      ),
    ).toBe(true);
    const row = service.plugins.find(
      (plugin) => plugin.pluginGuid === STARTER_CONTENT_PLUGIN_GUID,
    );
    expect(row?.source).toBe("project");
    expect(row?.readOnly).toBe(false);
    expect(
      service.plugins.filter(
        (plugin) => plugin.pluginGuid === STARTER_CONTENT_PLUGIN_GUID,
      ),
    ).toHaveLength(1);

    await service.applyPluginOverrides({
      [STARTER_CONTENT_PLUGIN_GUID]: { enabled: true },
    });
    const root = service.registry?.getRoot(
      `plugin:${STARTER_CONTENT_PLUGIN_GUID}`,
    );
    expect(root?.readOnly).toBeFalsy();
    expect(root?.pathPrefix).toBe("plugins/starter-content/assets");
    const created = await service.registry?.createAsset(
      `plugin:${STARTER_CONTENT_PLUGIN_GUID}`,
      "Extra.class.babasset",
      {
        guid: "bbbb0000-0000-4000-8000-000000000001",
        type: "Class",
        name: "Extra",
        version: 1,
        dependencies: [],
        parentClass: "Actor",
        payload: {},
        chunks: [],
      },
    );
    expect(created?.path).toBe(
      "plugins/starter-content/assets/Extra.class.babasset",
    );
  });

  it("refuses navmesh writes on an unmasked engine plugin scene", async () => {
    const { service } = await scaffolded();
    service.setEnginePluginStorage(await engineStarterStorage());
    await service.loadCurrentProject();
    await expect(
      service.writeSceneNavmeshChunk(
        "starter-content/assets/Main.scene.babasset",
        new Uint8Array([1, 2, 3]),
        {},
      ),
    ).rejects.toThrow(/read-only/i);
  });

  it("does not copy engine defaults onto an existing project open", async () => {
    const { storage, service } = await scaffolded();
    service.setEnginePluginStorage(await engineStarterStorage());
    await service.loadCurrentProject();
    expect(
      await storage.exists(
        "plugins/starter-content/assets/StarterActor.class.babasset",
      ),
    ).toBe(false);
    expect(
      service.plugins.find(
        (plugin) => plugin.pluginGuid === STARTER_CONTENT_PLUGIN_GUID,
      )?.source,
    ).toBe("engine");
  });

  it("does not overwrite a template plugin that already has the engine guid", async () => {
    const storage = new MemoryStorageAdapter("documents");
    const service = new ProjectService(storage);
    service.setEnginePluginStorage(await engineStarterStorage());
    const settings = createDefaultPluginSettings({
      pluginGuid: STARTER_CONTENT_PLUGIN_GUID,
      displayName: "Mine",
    });
    const templateFiles = [
      ...createEmptyProjectFiles({ guid: "tpl", name: "HasPlugin" }),
      {
        path: "plugins/mine/mine.plugin.babasset",
        data: await encodePluginSettingsDocument(settings),
      },
    ];
    await service.createFromTemplate({
      templateFiles,
      name: "FromTemplate",
    });
    const row = service.plugins.find(
      (plugin) => plugin.pluginGuid === STARTER_CONTENT_PLUGIN_GUID,
    );
    expect(row?.folderName).toBe("mine");
    expect(row?.settings.displayName).toBe("Mine");
    expect(row?.source).toBe("project");
    expect(
      await storage.exists(
        "plugins/starter-content/assets/StarterActor.class.babasset",
      ),
    ).toBe(false);
  });
});
