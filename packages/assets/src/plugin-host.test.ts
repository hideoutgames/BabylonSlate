import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { encodeAssetDocument } from "./asset-document";
import { encodeBabasset } from "./babasset";
import { projectContentRoot } from "./content-root";
import {
  createDefaultPluginSettings,
  encodePluginSettingsDocument,
} from "./plugin-settings";
import {
  collectEnabledPluginAssets,
  discoverEnginePlugins,
  discoverProjectPlugins,
  indexUnresolvedPlaceholders,
  mountEnabledPlugins,
  resolvePluginEnabled,
  resolvePluginGraph,
  shadowEnginePlugins,
  writeProjectPlugin,
} from "./plugin-host";
import { AssetRegistry } from "./registry";

async function projectStorage(): Promise<MemoryStorageAdapter> {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("plugins.babproject");
  return storage;
}

async function writePluginFolder(
  storage: MemoryStorageAdapter,
  folder: string,
  settings: ReturnType<typeof createDefaultPluginSettings>,
  assets: Array<{
    relativePath: string;
    guid: string;
    type: string;
    name: string;
    dependencies?: string[];
  }> = [],
): Promise<void> {
  await writeProjectPlugin(storage, folder, settings);
  for (const asset of assets) {
    const path = `plugins/${folder}/assets/${asset.relativePath}`;
    const dir = path.slice(0, path.lastIndexOf("/"));
    await storage.mkdir(dir, true);
    const bytes = await encodeBabasset({
      header: {
        guid: asset.guid,
        type: asset.type,
        name: asset.name,
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: asset.dependencies ?? [],
        parentClass: asset.type === "Class" ? "Actor" : null,
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
    });
    await storage.writeBinary(path, bytes);
  }
}

describe("resolvePluginEnabled", () => {
  it("lets later layers win", () => {
    expect(resolvePluginEnabled(true)).toBe(true);
    expect(resolvePluginEnabled(true, false)).toBe(false);
    expect(resolvePluginEnabled(false, true)).toBe(true);
    expect(resolvePluginEnabled(true, true, false)).toBe(false);
    expect(resolvePluginEnabled(false, false, true)).toBe(true);
    expect(resolvePluginEnabled(true, undefined, false)).toBe(false);
  });
});

describe("discoverProjectPlugins", () => {
  it("finds PluginSettings at the plugin folder root", async () => {
    const storage = await projectStorage();
    const settings = createDefaultPluginSettings({
      pluginGuid: "plug-1",
      displayName: "Pack",
    });
    settings.version = "1.2.0";
    await writePluginFolder(storage, "Pack", settings);

    const discovered = await discoverProjectPlugins(storage);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.pluginGuid).toBe("plug-1");
    expect(discovered[0]!.folderName).toBe("Pack");
    expect(discovered[0]!.folderPath).toBe("plugins/Pack");
    expect(discovered[0]!.settingsPath).toBe("plugins/Pack/Pack.plugin.babasset");
    expect(discovered[0]!.contentPath).toBe("plugins/Pack/assets");
    expect(discovered[0]!.source).toBe("project");
    expect(discovered[0]!.readOnly).toBe(false);
    expect(discovered[0]!.settings.version).toBe("1.2.0");
  });

  it("skips folders without PluginSettings", async () => {
    const storage = await projectStorage();
    await storage.mkdir("plugins/empty", true);
    expect(await discoverProjectPlugins(storage)).toEqual([]);
  });
});

describe("discoverEnginePlugins", () => {
  it("marks engine plugins read-only", async () => {
    const storage = new MemoryStorageAdapter("opfs");
    await storage.openDocumentsProject("engine-plugins");
    const settings = createDefaultPluginSettings({
      pluginGuid: "engine-1",
      displayName: "Starter Content",
    });
    const bytes = await encodePluginSettingsDocument(settings);
    await storage.mkdir("starter-content", true);
    await storage.writeBinary(
      "starter-content/StarterContent.plugin.babasset",
      bytes,
    );
    await storage.mkdir("starter-content/assets", true);

    const discovered = await discoverEnginePlugins(storage);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.source).toBe("engine");
    expect(discovered[0]!.readOnly).toBe(true);
    expect(discovered[0]!.folderPath).toBe("starter-content");
  });
});

describe("shadowEnginePlugins", () => {
  it("hides an engine plugin when a project plugin has the same guid", () => {
    const settings = createDefaultPluginSettings({
      pluginGuid: "shared",
      displayName: "Starter Content",
    });
    const engine = {
      pluginGuid: "shared",
      folderName: "starter-content",
      folderPath: "starter-content",
      settingsPath: "starter-content/starter-content.plugin.babasset",
      contentPath: "starter-content/assets",
      source: "engine" as const,
      readOnly: true,
      settings,
    };
    const project = {
      ...engine,
      folderName: "starter-content",
      folderPath: "plugins/starter-content",
      settingsPath: "plugins/starter-content/starter-content.plugin.babasset",
      contentPath: "plugins/starter-content/assets",
      source: "project" as const,
      readOnly: false,
    };
    const otherEngine = {
      ...engine,
      pluginGuid: "other-engine",
      folderName: "other",
      folderPath: "other",
      settingsPath: "other/other.plugin.babasset",
      contentPath: "other/assets",
      settings: createDefaultPluginSettings({
        pluginGuid: "other-engine",
        displayName: "Other",
      }),
    };
    const visible = shadowEnginePlugins([project], [engine, otherEngine]);
    expect(visible.map((plugin) => plugin.pluginGuid)).toEqual([
      "other-engine",
      "shared",
    ]);
    expect(visible.find((plugin) => plugin.pluginGuid === "shared")?.source).toBe(
      "project",
    );
  });
});

describe("resolvePluginGraph", () => {
  it("topologically orders plugins by dependency", () => {
    const base = createDefaultPluginSettings({
      pluginGuid: "base",
      displayName: "Base",
    });
    const extra = createDefaultPluginSettings({
      pluginGuid: "extra",
      displayName: "Extra",
    });
    extra.pluginDependencies = [{ guid: "base", versionRange: "^1.0.0" }];
    base.version = "1.2.0";
    extra.version = "1.0.0";
    const { order, diagnostics } = resolvePluginGraph(
      [
        { pluginGuid: extra.pluginGuid, settings: extra },
        { pluginGuid: base.pluginGuid, settings: base },
      ],
      "0.0.0",
    );
    expect(diagnostics).toEqual([]);
    expect(order.map((entry) => entry.pluginGuid)).toEqual(["base", "extra"]);
  });

  it("reports a dependency cycle", () => {
    const a = createDefaultPluginSettings({
      pluginGuid: "a",
      displayName: "A",
    });
    const b = createDefaultPluginSettings({
      pluginGuid: "b",
      displayName: "B",
    });
    a.pluginDependencies = [{ guid: "b", versionRange: "^1.0.0" }];
    b.pluginDependencies = [{ guid: "a", versionRange: "^1.0.0" }];
    const { order, diagnostics } = resolvePluginGraph(
      [
        { pluginGuid: a.pluginGuid, settings: a },
        { pluginGuid: b.pluginGuid, settings: b },
      ],
      "0.0.0",
    );
    expect(order).toEqual([]);
    expect(diagnostics.some((row) => row.code === "plugin.cycle")).toBe(true);
  });

  it("still orders plugins that are not in a dependency cycle", () => {
    const a = createDefaultPluginSettings({
      pluginGuid: "a",
      displayName: "A",
    });
    const b = createDefaultPluginSettings({
      pluginGuid: "b",
      displayName: "B",
    });
    const solo = createDefaultPluginSettings({
      pluginGuid: "solo",
      displayName: "Solo",
    });
    a.pluginDependencies = [{ guid: "b", versionRange: "^1.0.0" }];
    b.pluginDependencies = [{ guid: "a", versionRange: "^1.0.0" }];
    const { order, diagnostics } = resolvePluginGraph(
      [
        { pluginGuid: a.pluginGuid, settings: a },
        { pluginGuid: b.pluginGuid, settings: b },
        { pluginGuid: solo.pluginGuid, settings: solo },
      ],
      "0.0.0",
    );
    expect(order.map((entry) => entry.pluginGuid)).toEqual(["solo"]);
    expect(diagnostics.some((row) => row.code === "plugin.cycle")).toBe(true);
  });

  it("reports unsatisfiable plugin and engine ranges and missing deps", () => {
    const extra = createDefaultPluginSettings({
      pluginGuid: "extra",
      displayName: "Extra",
    });
    extra.engineVersionRange = "^2.0.0";
    extra.pluginDependencies = [
      { guid: "base", versionRange: "^2.0.0" },
      { guid: "ghost", versionRange: "^1.0.0" },
    ];
    const base = createDefaultPluginSettings({
      pluginGuid: "base",
      displayName: "Base",
    });
    base.version = "1.0.0";
    const { diagnostics } = resolvePluginGraph(
      [
        { pluginGuid: extra.pluginGuid, settings: extra },
        { pluginGuid: base.pluginGuid, settings: base },
      ],
      "0.0.0",
    );
    const codes = diagnostics.map((row) => row.code).sort();
    expect(codes).toContain("plugin.engine_unsatisfiable");
    expect(codes).toContain("plugin.unsatisfiable");
    expect(codes).toContain("plugin.missing");
  });
});

describe("mountEnabledPlugins", () => {
  it("mounts enabled plugin assets and leaves disabled plugins unmounted", async () => {
    const storage = await projectStorage();
    const on = createDefaultPluginSettings({
      pluginGuid: "on",
      displayName: "On",
    });
    const off = createDefaultPluginSettings({
      pluginGuid: "off",
      displayName: "Off",
    });
    await writePluginFolder(storage, "On", on, [
      {
        relativePath: "Hero.class.babasset",
        guid: "hero-1",
        type: "Class",
        name: "Hero",
      },
    ]);
    await writePluginFolder(storage, "Off", off, [
      {
        relativePath: "Villain.class.babasset",
        guid: "villain-1",
        type: "Class",
        name: "Villain",
      },
    ]);

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const discovered = await discoverProjectPlugins(storage);
    await mountEnabledPlugins(registry, discovered, {
      enabledGuids: new Set(["on"]),
    });

    expect(registry.getByGuid("hero-1")?.rootId).toBe("plugin:on");
    expect(registry.getByGuid("villain-1")).toBeUndefined();
    expect(
      registry.listDocumentPaths({ rootId: "project" }).graphs,
    ).not.toContain("plugins/On/assets/Hero.class.babasset");
    expect(registry.listDocumentPaths().graphs).toContain(
      "plugins/On/assets/Hero.class.babasset",
    );
  });

  it("unmounts cycle members and keeps independent enabled plugins mounted", async () => {
    const storage = await projectStorage();
    const a = createDefaultPluginSettings({
      pluginGuid: "a",
      displayName: "A",
    });
    const b = createDefaultPluginSettings({
      pluginGuid: "b",
      displayName: "B",
    });
    const solo = createDefaultPluginSettings({
      pluginGuid: "solo",
      displayName: "Solo",
    });
    a.pluginDependencies = [{ guid: "b", versionRange: "^1.0.0" }];
    b.pluginDependencies = [{ guid: "a", versionRange: "^1.0.0" }];
    await writePluginFolder(storage, "A", a, [
      {
        relativePath: "A.class.babasset",
        guid: "class-a",
        type: "Class",
        name: "A",
      },
    ]);
    await writePluginFolder(storage, "B", b, [
      {
        relativePath: "B.class.babasset",
        guid: "class-b",
        type: "Class",
        name: "B",
      },
    ]);
    await writePluginFolder(storage, "Solo", solo, [
      {
        relativePath: "Solo.class.babasset",
        guid: "class-solo",
        type: "Class",
        name: "Solo",
      },
    ]);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const discovered = await discoverProjectPlugins(storage);
    await mountEnabledPlugins(registry, discovered, {
      enabledGuids: new Set(["a", "b", "solo"]),
    });
    expect(registry.getByGuid("class-solo")?.rootId).toBe("plugin:solo");
    expect(registry.getByGuid("class-a")).toBeUndefined();
    expect(registry.getByGuid("class-b")).toBeUndefined();
  });
});

describe("indexUnresolvedPlaceholders", () => {
  it("keeps a missing dependency guid as a placeholder until the plugin remounts", async () => {
    const storage = await projectStorage();
    await storage.mkdir("assets", true);
    const sceneBytes = await encodeAssetDocument({
      type: "Scene",
      name: "Main",
      guid: "scene-1",
      version: 1,
      payload: { name: "Main", actors: [] },
    });
    const withDeps = await encodeBabasset({
      header: {
        guid: "scene-1",
        type: "Scene",
        name: "Main",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: ["plugin-tex"],
        parentClass: null,
        payload: {},
      },
      chunks: [
        {
          id: "document",
          kind: "document",
          mime: "application/json",
          data: new TextEncoder().encode("{}"),
        },
      ],
    });
    void sceneBytes;
    await storage.writeBinary("assets/main.scene.babasset", withDeps);

    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    indexUnresolvedPlaceholders(registry, { expectedGuids: ["absent-plugin"] });

    expect(registry.getByGuid("plugin-tex")?.placeholder).toBe(true);
    expect(registry.getByGuid("plugin-tex")?.header.guid).toBe("plugin-tex");
    expect(registry.getByGuid("absent-plugin")?.placeholder).toBe(true);

    const settings = createDefaultPluginSettings({
      pluginGuid: "pack",
      displayName: "Pack",
    });
    await writePluginFolder(storage, "Pack", settings, [
      {
        relativePath: "tex.babasset",
        guid: "plugin-tex",
        type: "Texture",
        name: "Shared",
      },
    ]);
    const discovered = await discoverProjectPlugins(storage);
    await mountEnabledPlugins(registry, discovered, {
      enabledGuids: new Set(["pack"]),
    });
    indexUnresolvedPlaceholders(registry);

    expect(registry.getByGuid("plugin-tex")?.placeholder).toBeFalsy();
    expect(registry.getByGuid("plugin-tex")?.header.type).toBe("Texture");
  });
});

describe("collectEnabledPluginAssets", () => {
  it("returns assets from enabled plugin roots and omits disabled ones", async () => {
    const storage = await projectStorage();
    const on = createDefaultPluginSettings({
      pluginGuid: "on",
      displayName: "On",
    });
    const off = createDefaultPluginSettings({
      pluginGuid: "off",
      displayName: "Off",
    });
    await writePluginFolder(storage, "On", on, [
      {
        relativePath: "Hero.class.babasset",
        guid: "hero-1",
        type: "Class",
        name: "Hero",
      },
    ]);
    await writePluginFolder(storage, "Off", off, [
      {
        relativePath: "Villain.class.babasset",
        guid: "villain-1",
        type: "Class",
        name: "Villain",
      },
    ]);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await mountEnabledPlugins(registry, await discoverProjectPlugins(storage), {
      enabledGuids: new Set(["on", "off"]),
    });
    const collected = collectEnabledPluginAssets(registry, new Set(["on"]));
    expect(collected.map((asset) => asset.header.guid)).toEqual(["hero-1"]);
    expect(collected.some((asset) => asset.header.guid === "villain-1")).toBe(
      false,
    );
  });
});
