import { describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { readGoldenBinary, writeGoldenBinary } from "@babylonslate/test-kit";
import { encodeBabasset, readBabassetHeader } from "./babasset";
import { decodeProjectZip, encodeProjectZip } from "./babproject";
import { bytesEqual } from "./bytes";
import {
  createDefaultPluginSettings,
} from "./plugin-settings";
import {
  applyPluginImport,
  exportPluginZip,
  inspectBabplugin,
  packEnginePluginFiles,
  planPluginImport,
  unpackEnginePluginZip,
  installEnginePluginDefaults,
} from "./plugin-package";
import {
  discoverEnginePlugins,
  discoverProjectPlugins,
  writeProjectPlugin,
} from "./plugin-host";
import {
  STARTER_ACTOR_GUID,
  STARTER_CONTENT_FOLDER,
  STARTER_CONTENT_PLUGIN_GUID,
  buildStarterContentFiles,
} from "./starter-content";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";

async function projectStorage(): Promise<MemoryStorageAdapter> {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("plugins.babproject");
  return storage;
}

async function writeClass(
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

describe("exportPluginZip", () => {
  it("packs PluginSettings, assets, blobs, and a kind:plugin manifest", async () => {
    const storage = await projectStorage();
    const settings = createDefaultPluginSettings({
      pluginGuid: "pack-guid",
      displayName: "Pack",
    });
    const descriptor = await writeProjectPlugin(storage, "pack", settings);
    await writeClass(storage, "plugins/pack/assets/Hero.class.babasset", {
      guid: "hero-1",
      name: "Hero",
    });
    await storage.mkdir("plugins/pack/assets/.blobs", true);
    await storage.writeBinary(
      "plugins/pack/assets/.blobs/deadbeef",
      new Uint8Array([9, 8, 7]),
    );

    const zip = await exportPluginZip(storage, descriptor);
    const files = decodeProjectZip(zip);
    const paths = files.map((file) => file.path).sort();
    expect(paths).toContain("plugin.json");
    expect(paths).toContain("pack.plugin.babasset");
    expect(paths).toContain("assets/Hero.class.babasset");
    expect(paths).toContain("assets/.blobs/deadbeef");
    expect(paths.some((path) => path.startsWith("plugins/"))).toBe(false);

    const manifest = JSON.parse(
      new TextDecoder().decode(files.find((file) => file.path === "plugin.json")!.data),
    ) as { kind: string; guid: string; name: string };
    expect(manifest.kind).toBe("plugin");
    expect(manifest.guid).toBe("pack-guid");
    expect(manifest.name).toBe("Pack");

    const inspected = await inspectBabplugin(zip);
    expect(inspected.settings.pluginGuid).toBe("pack-guid");
    expect(inspected.settings.displayName).toBe("Pack");
  });

  it("round-trips directory ↔ zip identically for a packed plugin", async () => {
    const storage = await projectStorage();
    const settings = createDefaultPluginSettings({
      pluginGuid: "00000000-0000-4000-8000-00000000plug",
      displayName: "Pack",
    });
    settings.version = "1.0.0";
    const descriptor = await writeProjectPlugin(storage, "pack", settings);
    await storage.writeBinary(
      "plugins/pack/assets/note.txt",
      new TextEncoder().encode("hello-plugin"),
    );
    const zip = await exportPluginZip(storage, descriptor);
    const fromZip = decodeProjectZip(zip);
    expect(bytesEqual(zip, encodeProjectZip(fromZip))).toBe(true);

    const relative = "__fixtures__/pack.babplugin.zip";
    if (UPDATE) {
      writeGoldenBinary(FIXTURE_DIR, relative, zip);
    }
    const golden = readGoldenBinary(FIXTURE_DIR, relative);
    expect(bytesEqual(zip, golden)).toBe(true);
    void descriptor;
  });
});

describe("importPluginZip", () => {
  it("unpacks under plugins/<safeName>/ and keeps asset guids", async () => {
    const source = await projectStorage();
    const settings = createDefaultPluginSettings({
      pluginGuid: "pack-guid",
      displayName: "My Pack",
    });
    const descriptor = await writeProjectPlugin(source, "my-pack", settings);
    await writeClass(source, "plugins/my-pack/assets/Hero.class.babasset", {
      guid: "hero-1",
      name: "Hero",
    });
    const zip = await exportPluginZip(source, descriptor);

    const dest = await projectStorage();
    const inspected = await inspectBabplugin(zip);
    const plan = planPluginImport({
      incoming: inspected,
      existingPlugins: [],
      occupiedGuids: new Set(),
      existingFolderNames: [],
    });
    expect(plan.kind).toBe("install");
    const imported = await applyPluginImport(dest, inspected, plan);
    expect(imported.pluginGuid).toBe("pack-guid");
    expect(imported.folderPath).toBe("plugins/my-pack");
    expect(await dest.exists("plugins/my-pack/my-pack.plugin.babasset")).toBe(
      true,
    );
    expect(await dest.exists("plugins/my-pack/assets/Hero.class.babasset")).toBe(
      true,
    );
    expect(await dest.exists("plugins/my-pack/plugin.json")).toBe(false);
    expect(
      readBabassetHeader(
        await dest.readBinary("plugins/my-pack/assets/Hero.class.babasset"),
      ).guid,
    ).toBe("hero-1");
  });

  it("reports a Keep/Replace conflict for the same guid and version", async () => {
    const storage = await projectStorage();
    const settings = createDefaultPluginSettings({
      pluginGuid: "pack-guid",
      displayName: "Pack",
    });
    settings.version = "1.2.0";
    const descriptor = await writeProjectPlugin(storage, "pack", settings);
    const zip = await exportPluginZip(storage, descriptor);
    const inspected = await inspectBabplugin(zip);
    const existing = await discoverProjectPlugins(storage);
    const plan = planPluginImport({
      incoming: inspected,
      existingPlugins: existing,
      occupiedGuids: new Set(["pack-guid"]),
      existingFolderNames: ["pack"],
    });
    expect(plan).toMatchObject({
      kind: "conflict",
      existingGuid: "pack-guid",
      version: "1.2.0",
      folderName: "pack",
    });
  });

  it("treats the same guid at a new version as an in-place update", async () => {
    const storage = await projectStorage();
    const settings = createDefaultPluginSettings({
      pluginGuid: "pack-guid",
      displayName: "Pack",
    });
    settings.version = "1.0.0";
    await writeProjectPlugin(storage, "pack", settings);
    await writeClass(storage, "plugins/pack/assets/Hero.class.babasset", {
      guid: "hero-1",
      name: "Hero",
    });

    const incomingSettings = createDefaultPluginSettings({
      pluginGuid: "pack-guid",
      displayName: "Pack",
    });
    incomingSettings.version = "1.1.0";
    const incomingStorage = await projectStorage();
    const incomingDescriptor = await writeProjectPlugin(
      incomingStorage,
      "pack",
      incomingSettings,
    );
    await writeClass(
      incomingStorage,
      "plugins/pack/assets/Hero.class.babasset",
      { guid: "hero-1", name: "Hero" },
    );
    const zip = await exportPluginZip(incomingStorage, incomingDescriptor);
    const inspected = await inspectBabplugin(zip);
    const plan = planPluginImport({
      incoming: inspected,
      existingPlugins: await discoverProjectPlugins(storage),
      occupiedGuids: new Set(["pack-guid", "hero-1"]),
      existingFolderNames: ["pack"],
    });
    expect(plan.kind).toBe("update");
    const imported = await applyPluginImport(storage, inspected, plan);
    expect(imported.pluginGuid).toBe("pack-guid");
    expect(imported.settings.version).toBe("1.1.0");
    expect(imported.folderPath).toBe("plugins/pack");
    expect(
      readBabassetHeader(
        await storage.readBinary("plugins/pack/assets/Hero.class.babasset"),
      ).guid,
    ).toBe("hero-1");
  });

  it("remaps PluginSettings guid when it collides with a different plugin", async () => {
    const storage = await projectStorage();
    await writeClass(storage, "assets/Taken.class.babasset", {
      guid: "shared-guid",
      name: "Taken",
    });

    const incomingStorage = await projectStorage();
    const incomingSettings = createDefaultPluginSettings({
      pluginGuid: "shared-guid",
      displayName: "Other Pack",
    });
    const incomingDescriptor = await writeProjectPlugin(
      incomingStorage,
      "other-pack",
      incomingSettings,
    );
    await writeClass(
      incomingStorage,
      "plugins/other-pack/assets/Other.class.babasset",
      { guid: "other-class", name: "Other" },
    );
    const zip = await exportPluginZip(incomingStorage, incomingDescriptor);
    const inspected = await inspectBabplugin(zip);
    const plan = planPluginImport({
      incoming: inspected,
      existingPlugins: await discoverProjectPlugins(storage),
      occupiedGuids: new Set(["shared-guid"]),
      existingFolderNames: [],
      createGuid: () => "remapped-guid",
    });
    expect(plan.kind).toBe("remap-plugin");
    if (plan.kind !== "remap-plugin") return;
    expect(plan.previousGuid).toBe("shared-guid");
    expect(plan.nextGuid).toBe("remapped-guid");
    const imported = await applyPluginImport(storage, inspected, plan);
    expect(imported.pluginGuid).toBe("remapped-guid");
    expect(imported.folderName).toBe("other-pack");
    expect(
      readBabassetHeader(await storage.readBinary(imported.settingsPath)).guid,
    ).toBe("remapped-guid");
    expect(
      readBabassetHeader(
        await storage.readBinary(
          "plugins/other-pack/assets/Other.class.babasset",
        ),
      ).guid,
    ).toBe("other-class");
  });
});

describe("replace conflict", () => {
  it("replaces the existing plugin folder when the caller confirms", async () => {
    const storage = await projectStorage();
    const settings = createDefaultPluginSettings({
      pluginGuid: "pack-guid",
      displayName: "Pack",
    });
    await writeProjectPlugin(storage, "pack", settings);
    await writeClass(storage, "plugins/pack/assets/Old.class.babasset", {
      guid: "old-class",
      name: "Old",
    });

    const incomingStorage = await projectStorage();
    const incomingSettings = createDefaultPluginSettings({
      pluginGuid: "pack-guid",
      displayName: "Pack",
    });
    const incomingDescriptor = await writeProjectPlugin(
      incomingStorage,
      "pack",
      incomingSettings,
    );
    await writeClass(
      incomingStorage,
      "plugins/pack/assets/New.class.babasset",
      { guid: "new-class", name: "New" },
    );
    const zip = await exportPluginZip(incomingStorage, incomingDescriptor);
    const inspected = await inspectBabplugin(zip);
    const imported = await applyPluginImport(storage, inspected, {
      kind: "conflict",
      existingGuid: "pack-guid",
      version: "1.0.0",
      folderName: "pack",
      replace: true,
    });
    expect(imported.pluginGuid).toBe("pack-guid");
    expect(await storage.exists("plugins/pack/assets/New.class.babasset")).toBe(
      true,
    );
    expect(await storage.exists("plugins/pack/assets/Old.class.babasset")).toBe(
      false,
    );
  });
});

describe("engine plugin pack and unpack", () => {
  it("packs directory files into a kind:plugin zip with plugin.json", async () => {
    const files = await buildStarterContentFiles();
    const packed = await packEnginePluginFiles(files, {
      id: STARTER_CONTENT_FOLDER,
    });
    expect(packed.indexEntry).toEqual({
      id: "starter-content",
      file: "starter-content.babplugin",
    });
    const inspected = await inspectBabplugin(packed.zip);
    expect(inspected.manifest.kind).toBe("plugin");
    expect(inspected.settings.pluginGuid).toBe(STARTER_CONTENT_PLUGIN_GUID);
    expect(inspected.settings.displayName).toBe("Starter Content");
    expect(
      inspected.files.some(
        (file) => file.path === "assets/StarterActor.class.babasset",
      ),
    ).toBe(true);
  });

  it("unpacks a .babplugin at the engine storage root, not under plugins/", async () => {
    const files = await buildStarterContentFiles();
    const packed = await packEnginePluginFiles(files, {
      id: STARTER_CONTENT_FOLDER,
    });
    const storage = new MemoryStorageAdapter("opfs");
    await storage.openDocumentsProject("engine-plugins");
    const descriptor = await unpackEnginePluginZip(
      storage,
      packed.zip,
      STARTER_CONTENT_FOLDER,
    );
    expect(descriptor.folderPath).toBe("starter-content");
    expect(descriptor.source).toBe("engine");
    expect(descriptor.readOnly).toBe(true);
    expect(
      await storage.exists(
        "starter-content/assets/StarterActor.class.babasset",
      ),
    ).toBe(true);
    expect(await storage.exists("plugins/starter-content")).toBe(false);
    expect(
      readBabassetHeader(
        await storage.readBinary(
          "starter-content/assets/StarterActor.class.babasset",
        ),
      ).guid,
    ).toBe(STARTER_ACTOR_GUID);
    const discovered = await discoverEnginePlugins(storage);
    expect(discovered.map((plugin) => plugin.pluginGuid)).toEqual([
      STARTER_CONTENT_PLUGIN_GUID,
    ]);
  });

  it("inspects a fflate zip packed the same way as the Vite plugin", async () => {
    const files = await buildStarterContentFiles();
    const record: Record<string, Uint8Array> = {};
    for (const file of files) record[file.path] = file.data;
    record["plugin.json"] = new TextEncoder().encode(
      `${JSON.stringify({
        kind: "plugin",
        guid: STARTER_CONTENT_PLUGIN_GUID,
        name: "Starter Content",
        engineVersion: "0.0.0",
        version: 1,
      })}\n`,
    );
    const zip = zipSync(record, {
      level: 6,
      mtime: new Date(Date.UTC(1980, 0, 1)),
    });
    const inspected = await inspectBabplugin(zip);
    expect(inspected.settings.pluginGuid).toBe(STARTER_CONTENT_PLUGIN_GUID);
    const storage = new MemoryStorageAdapter("opfs");
    await storage.openDocumentsProject("engine-plugins");
    const descriptor = await unpackEnginePluginZip(
      storage,
      zip,
      STARTER_CONTENT_FOLDER,
    );
    expect(descriptor.pluginGuid).toBe(STARTER_CONTENT_PLUGIN_GUID);
  });
});

describe("installEnginePluginDefaults", () => {
  async function engineWithStarter() {
    const engine = new MemoryStorageAdapter("opfs");
    await engine.openDocumentsProject("engine-plugins");
    const files = await buildStarterContentFiles();
    const packed = await packEnginePluginFiles(files, {
      id: STARTER_CONTENT_FOLDER,
    });
    await unpackEnginePluginZip(engine, packed.zip, STARTER_CONTENT_FOLDER);
    return engine;
  }

  it("copies engine plugins into plugins/ with the same guids", async () => {
    const engine = await engineWithStarter();
    const project = await projectStorage();
    const installed = await installEnginePluginDefaults(project, engine);
    expect(installed.map((plugin) => plugin.pluginGuid)).toEqual([
      STARTER_CONTENT_PLUGIN_GUID,
    ]);
    expect(installed[0]!.source).toBe("project");
    expect(installed[0]!.readOnly).toBe(false);
    expect(installed[0]!.folderPath).toBe("plugins/starter-content");
    expect(
      await project.exists(
        "plugins/starter-content/assets/StarterActor.class.babasset",
      ),
    ).toBe(true);
    expect(
      readBabassetHeader(
        await project.readBinary(
          "plugins/starter-content/assets/StarterActor.class.babasset",
        ),
      ).guid,
    ).toBe(STARTER_ACTOR_GUID);
  });

  it("skips a guid the project already has", async () => {
    const engine = await engineWithStarter();
    const project = await projectStorage();
    const settings = createDefaultPluginSettings({
      pluginGuid: STARTER_CONTENT_PLUGIN_GUID,
      displayName: "Mine",
    });
    await writeProjectPlugin(project, "mine", settings);
    await installEnginePluginDefaults(project, engine);
    const discovered = await discoverProjectPlugins(project);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.folderName).toBe("mine");
    expect(discovered[0]!.settings.displayName).toBe("Mine");
    expect(
      await project.exists(
        "plugins/starter-content/assets/StarterActor.class.babasset",
      ),
    ).toBe(false);
  });

  it("is a no-op when the copy is already installed", async () => {
    const engine = await engineWithStarter();
    const project = await projectStorage();
    await installEnginePluginDefaults(project, engine);
    const second = await installEnginePluginDefaults(project, engine);
    expect(second).toEqual([]);
    expect(await discoverProjectPlugins(project)).toHaveLength(1);
  });
});
