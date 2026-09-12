import { describe, expect, it, vi } from "vitest";
import { PROJECT_FILE } from "@babylonslate/core";
import {
  createDefaultPluginSettings,
  createVfsBlobStore,
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
import { EnginePluginLibrary } from "../lib/engine-plugin-library";

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
  it("indexes export-enabled dependencies without changing the editor's disabled roots", async () => {
    const { storage, service } = await scaffolded();
    const dependency = createDefaultPluginSettings({
      pluginGuid: "base",
      displayName: "Base",
    });
    const dependent = createDefaultPluginSettings({
      pluginGuid: "extra",
      displayName: "Extra",
    });
    dependent.pluginDependencies = [{ guid: "base", versionRange: "^1.0.0" }];
    await writeProjectPlugin(storage, "base", dependency);
    await writeProjectPlugin(storage, "extra", dependent);
    await writeClassAsset(
      storage,
      "plugins/extra/assets/Extra.class.babasset",
      { guid: "extra-class", name: "Extra" },
    );
    await service.remountRegistry();

    const assets = await service.listExportAssets(new Set(["base", "extra"]));

    expect(
      assets.find((asset) => asset.header.guid === "extra-class")?.rootId,
    ).toBe("plugin:extra");
    expect(assets.some((asset) => asset.rootId === "project")).toBe(true);
    expect(service.registry?.getRoot("plugin:base")).toBeUndefined();
    expect(service.registry?.getRoot("plugin:extra")).toBeUndefined();
    expect(service.registry?.getByGuid("extra-class")).toBeUndefined();
  });

  it.each(["project", "engine"] as const)("loads plugin-local blob chunks for export-enabled %s plugins that remain disabled in the editor", async (source) => {
    const { storage, service } = await scaffolded();
    const pluginStorage = source === "project" ? storage : new MemoryStorageAdapter("documents");
    if (source === "engine") await pluginStorage.openDocumentsProject("Engine Plugins");
    const folderPath = source === "project" ? "plugins/export-pack" : "export-pack";
    const settings = createDefaultPluginSettings({
      pluginGuid: "export-pack",
      displayName: "Export Pack",
    });
    await pluginStorage.mkdir(`${folderPath}/assets`, true);
    await pluginStorage.writeBinary(
      `${folderPath}/export-pack.plugin.babasset`,
      await encodePluginSettingsDocument(settings),
    );
    const blobs = createVfsBlobStore(pluginStorage, `${folderPath}/assets/.blobs`);
    const payload = new Uint8Array([3, 5, 8]);
    await pluginStorage.writeBinary(
      `${folderPath}/assets/Texture.texture.babasset`,
      await encodeBabasset({
        header: {
          guid: "export-texture",
          type: "Texture",
          name: "Texture",
          engineVersion: "0.0.0",
          version: 1,
          mode: "thin",
          dependencies: [],
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
        blobThreshold: 0,
        writeBlob: (hash, bytes) => blobs.writeBlob(hash, bytes),
      }),
    );
    if (source === "engine") service.setEnginePluginStorage(pluginStorage);
    await service.remountRegistry();

    const assets = await service.listExportAssets(new Set(["export-pack"]));
    const texture = assets.find(
      (asset) => asset.header.guid === "export-texture",
    )!;
    expect(await service.readAssetChunk(texture.path, "payload")).toEqual(
      payload,
    );
    expect(service.registry?.getRoot("plugin:export-pack")).toBeUndefined();
    expect(service.registry?.getByGuid("export-texture")).toBeUndefined();
  });

  it("keeps app-owned Engine Plugin and template libraries out of the project list", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("__slate_engine_plugins__");
    await storage.openDocumentsProject("__slate_templates__");
    await storage.openDocumentsProject("My Project");
    expect((await new ProjectService(storage).listProjects()).map((folder) => folder.name))
      .toEqual(["My Project"]);
  });

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

  it("refreshes plugin metadata and dependency diagnostics immediately after settings save", async () => {
    const { service } = await scaffolded();
    const created = await service.createProjectPlugin("My Pack");
    const changed = vi.fn();
    service.onRegistryChange(changed);
    await service.saveDocument("plugin-settings", created.settingsPath, {
      ...created.settings,
      displayName: "Renamed Pack",
      iconKey: "Box",
      experimental: true,
      enabledByDefault: true,
      pluginDependencies: [{ guid: "missing-plugin", versionRange: "^1.0.0" }],
    });
    expect(service.plugins.find((plugin) => plugin.pluginGuid === created.pluginGuid)?.settings)
      .toMatchObject({ displayName: "Renamed Pack", iconKey: "Box", experimental: true });
    expect(service.pluginGraphDiagnostics).toMatchObject([
      { code: "plugin.missing", pluginGuid: created.pluginGuid, dependencyGuid: "missing-plugin" },
    ]);
    expect(service.registry?.getRoot(`plugin:${created.pluginGuid}`)).toBeUndefined();
    expect(changed).toHaveBeenCalled();
  });

  it("blocks an enabled plugin until its disabled dependency is enabled", async () => {
    const { storage, service } = await scaffolded();
    const dependency = createDefaultPluginSettings({ pluginGuid: "dependency", displayName: "Dependency" });
    const dependent = createDefaultPluginSettings({ pluginGuid: "dependent", displayName: "Dependent" });
    dependent.enabledByDefault = true;
    dependent.pluginDependencies = [{ guid: "dependency", versionRange: "^1.0.0" }];
    await writeProjectPlugin(storage, "dependency", dependency);
    await writeProjectPlugin(storage, "dependent", dependent);
    await service.remountRegistry();
    expect(service.registry?.getRoot("plugin:dependent")).toBeUndefined();
    expect(service.pluginGraphDiagnostics).toMatchObject([
      { code: "plugin.missing", pluginGuid: "dependent", dependencyGuid: "dependency" },
    ]);
    await service.applyPluginOverrides({ dependency: { enabled: true } });
    expect(service.registry?.getRoot("plugin:dependent")).toBeTruthy();
    expect(service.registry?.getRoot("plugin:dependency")).toBeTruthy();
    expect(service.pluginGraphDiagnostics).toEqual([]);
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

  it.each(["empty", "template"] as const)(
    "clones user Engine Plugins and their global default into a new %s project independently",
    async (kind) => {
      const bundled = new MemoryStorageAdapter("opfs");
      await bundled.openDocumentsProject("bundled");
      const saved = new MemoryStorageAdapter("opfs");
      await saved.openDocumentsProject("library");
      const library = new EnginePluginLibrary(bundled, saved);
      const source = await scaffolded();
      const created = await source.service.createProjectPlugin("Global Pack");
      await library.import(await source.service.exportPlugin(created.pluginGuid));
      await library.setEnabledByDefault(created.pluginGuid, true);
      const destination = new MemoryStorageAdapter("documents");
      const service = new ProjectService(destination);
      service.setEnginePluginStorage(await library.createStorageSnapshot());
      if (kind === "empty") {
        await service.createEmptyProject("FromLibrary");
      } else {
        await service.createFromTemplate({
          name: "FromLibrary",
          templateFiles: createEmptyProjectFiles({ guid: "template", name: "Template" }),
        });
      }
      expect(service.plugins.find((plugin) => plugin.pluginGuid === created.pluginGuid))
        .toMatchObject({ source: "project", settings: { enabledByDefault: true } });
      expect(service.registry?.getRoot(`plugin:${created.pluginGuid}`)).toBeTruthy();
      await library.setEnabledByDefault(created.pluginGuid, false);
      await library.remove(created.pluginGuid);
      service.setEnginePluginStorage(bundled);
      await service.loadCurrentProject();
      expect(service.plugins.find((plugin) => plugin.pluginGuid === created.pluginGuid))
        .toMatchObject({ source: "project", settings: { enabledByDefault: true } });
      expect(await destination.exists("plugins/global-pack/global-pack.plugin.babasset")).toBe(true);
    },
  );
});
