import { describe, expect, it, vi } from "vitest";
import {
  canMutateContentBrowserRoot,
  classAssetPaths,
  contentBrowserRootForPath,
  contentBrowserRoots,
  createProjectPluginAndRevealContent,
  filterBabpluginFiles,
  inboundRefsFromOtherRoots,
  isBabpluginFile,
  isPluginContentFolderPath,
  isPluginDocumentReadOnly,
  isPluginSettingsReadOnly,
  playSceneLibraryPaths,
  mergePluginEditorUtilityObjects,
  pluginDependencyStatus,
  pluginEnableNeedsConfirm,
  pluginFolderSlug,
  pluginDownloadFileName,
  pluginRootId,
  pluginSettingsIdentityFields,
  rootIdForFolderPath,
  uniquePluginFolderName,
} from "./plugin-ui";

describe("plugin identity helpers", () => {
  it("builds plugin root ids from the PluginSettings guid", () => {
    expect(pluginRootId("pack-guid")).toBe("plugin:pack-guid");
  });

  it("slugs display names into unique plugin folder names", () => {
    expect(pluginFolderSlug("Starter Content")).toBe("starter-content");
    expect(pluginFolderSlug("  ")).toBe("plugin");
    expect(uniquePluginFolderName("Pack", [])).toBe("pack");
    expect(uniquePluginFolderName("Pack", ["pack"])).toBe("pack-1");
    expect(uniquePluginFolderName("Pack", ["pack", "pack-1"])).toBe("pack-2");
    expect(pluginDownloadFileName("Starter Content")).toBe(
      "starter-content.babplugin",
    );
  });
});

describe("createProjectPluginAndRevealContent", () => {
  it("creates the plugin then turns Show Plugin Content on", async () => {
    const created = {
      pluginGuid: "new-guid",
      settings: { displayName: "Pack" },
    };
    const create = vi.fn(async () => created);
    const setShowPluginContent = vi.fn();

    const result = await createProjectPluginAndRevealContent(
      create,
      setShowPluginContent,
      "Pack",
    );

    expect(create).toHaveBeenCalledWith("Pack");
    expect(setShowPluginContent).toHaveBeenCalledWith(true);
    expect(result).toBe(created);
  });
});

describe("content browser plugin roots", () => {
  const plugins = [
    {
      pluginGuid: "engine-1",
      displayName: "Starter Content",
      contentPath: "starter-content/assets",
      source: "engine" as const,
      enabled: true,
    },
    {
      pluginGuid: "proj-1",
      displayName: "Pack",
      contentPath: "plugins/pack/assets",
      source: "project" as const,
      enabled: true,
    },
    {
      pluginGuid: "off-1",
      displayName: "Off",
      contentPath: "plugins/off/assets",
      source: "project" as const,
      enabled: false,
    },
  ];

  it("hides plugin trees until Show Plugin Content is on", () => {
    expect(
      contentBrowserRoots({ showPluginContent: false, plugins }).map(
        (root) => root.id,
      ),
    ).toEqual(["project"]);
  });

  it("adds enabled plugin trees and marks engine roots read-only", () => {
    const roots = contentBrowserRoots({ showPluginContent: true, plugins });
    expect(roots.map((root) => root.id)).toEqual([
      "project",
      "plugin:engine-1",
      "plugin:proj-1",
    ]);
    expect(roots.find((root) => root.id === "plugin:engine-1")?.readOnly).toBe(
      true,
    );
    expect(roots.find((root) => root.id === "plugin:proj-1")?.readOnly).toBe(
      false,
    );
    expect(canMutateContentBrowserRoot(roots[1])).toBe(false);
    expect(canMutateContentBrowserRoot(roots[2])).toBe(true);
  });

  it("maps a selected folder to its content root", () => {
    const roots = contentBrowserRoots({ showPluginContent: true, plugins });
    expect(rootIdForFolderPath("assets/fx", roots)).toBe("project");
    expect(rootIdForFolderPath("plugins/pack/assets/actors", roots)).toBe(
      "plugin:proj-1",
    );
    expect(
      contentBrowserRootForPath("starter-content/assets", roots)?.readOnly,
    ).toBe(true);
  });

  it("never treats .babplugin files as Content Browser items", () => {
    expect(isBabpluginFile("Starter.babplugin")).toBe(true);
    expect(isBabpluginFile("hero.class.babasset")).toBe(false);
    expect(
      filterBabpluginFiles([
        { name: "Hero.class.babasset" },
        { name: "Pack.babplugin" },
      ]).map((file) => file.name),
    ).toEqual(["Hero.class.babasset"]);
  });
});

describe("isPluginContentFolderPath", () => {
  it("detects a plugin folder even when project is the only visible root", () => {
    expect(
      isPluginContentFolderPath("plugins/pack/assets/actors", [
        "plugins/pack/assets",
        "starter-content/assets",
      ]),
    ).toBe(true);
    expect(isPluginContentFolderPath("assets/fx", ["plugins/pack/assets"])).toBe(
      false,
    );
    expect(isPluginContentFolderPath("assets", ["plugins/pack/assets"])).toBe(
      false,
    );
  });
});

describe("plugin enablement UI", () => {
  it("confirms experimental or beta plugins before enable", () => {
    expect(pluginEnableNeedsConfirm({ experimental: false, beta: false })).toBe(
      false,
    );
    expect(pluginEnableNeedsConfirm({ experimental: true, beta: false })).toBe(
      true,
    );
    expect(pluginEnableNeedsConfirm({ experimental: false, beta: true })).toBe(
      true,
    );
  });

  it("opens engine PluginSettings as read-only", () => {
    expect(isPluginSettingsReadOnly("engine")).toBe(true);
    expect(isPluginSettingsReadOnly("project")).toBe(false);
  });

  it("lists inbound refs from other roots when disabling a plugin", () => {
    const refs = inboundRefsFromOtherRoots(
      [
        {
          rootId: "plugin:pack",
          header: { guid: "actor-class", name: "PackActor" },
        },
        {
          rootId: "project",
          header: { guid: "scene-1", name: "Main" },
        },
        {
          rootId: "plugin:pack",
          header: { guid: "pack-tex", name: "PackTex" },
        },
      ],
      (guid) =>
        guid === "actor-class" ? { inbound: ["scene-1"] } : { inbound: [] },
      "plugin:pack",
    );
    expect(refs).toEqual([{ guid: "scene-1", name: "Main" }]);
  });

  it("summarizes plugin dependency diagnostics", () => {
    expect(pluginDependencyStatus("a", [])).toBe("ok");
    expect(
      pluginDependencyStatus("a", [
        { code: "plugin.missing", pluginGuid: "a" },
      ]),
    ).toBe("Missing Dependency");
    expect(
      pluginDependencyStatus("a", [{ code: "plugin.cycle", plugins: ["a", "b"] }]),
    ).toBe("Dependency Cycle");
    expect(
      pluginDependencyStatus("a", [
        { code: "plugin.engine_unsatisfiable", pluginGuid: "a" },
      ]),
    ).toBe("Engine Range");
    expect(
      pluginDependencyStatus("a", [
        { code: "plugin.unsatisfiable", pluginGuid: "a" },
      ]),
    ).toBe("Unsatisfiable Range");
  });

  it("lists the plugin GUID as a read-only identity field", () => {
    const fields = pluginSettingsIdentityFields({
      pluginGuid: "pack-guid",
      displayName: "Pack",
      version: "1.2.3",
      author: "Hideout",
      category: "Gameplay",
      iconKey: "Puzzle",
    });
    expect(fields[0]).toEqual({
      id: "pluginGuid",
      label: "GUID",
      value: "pack-guid",
      readOnly: true,
    });
    expect(fields.map((field) => field.label)).toEqual([
      "GUID",
      "Display Name",
      "Version",
      "Author",
      "Category",
      "Icon Key",
    ]);
  });
});

describe("plugin editor utilities and class paths", () => {
  it("merges enabled plugin EUO class ids with project registrations", () => {
    expect(
      mergePluginEditorUtilityObjects(["Tools"], [
        { editorUtilityObjects: ["PackTools", "Tools"] },
        { editorUtilityObjects: ["More"] },
      ]),
    ).toEqual(["Tools", "PackTools", "More"]);
  });

  it("lists Class assets from every mounted root for Play and compile", () => {
    expect(
      classAssetPaths([
        { path: "assets/Hero.class.babasset", header: { type: "Class" } },
        {
          path: "plugins/pack/assets/PackActor.class.babasset",
          header: { type: "Class" },
        },
        {
          path: "__unresolved__/missing",
          placeholder: true,
          header: { type: "Unresolved" },
        },
        { path: "assets/main.scene.babasset", header: { type: "Scene" } },
      ]),
    ).toEqual([
      "assets/Hero.class.babasset",
      "plugins/pack/assets/PackActor.class.babasset",
    ]);
  });

  it("lists Scene assets from every mounted root for Play changescene", () => {
    expect(
      playSceneLibraryPaths(["assets/main.scene.babasset"], [
        { path: "assets/main.scene.babasset", header: { type: "Scene" } },
        {
          path: "plugins/pack/assets/Arena.scene.babasset",
          header: { type: "Scene" },
        },
        {
          path: "__unresolved__/missing",
          placeholder: true,
          header: { type: "Scene" },
        },
        { path: "assets/Hero.class.babasset", header: { type: "Class" } },
      ]),
    ).toEqual([
      "assets/main.scene.babasset",
      "plugins/pack/assets/Arena.scene.babasset",
    ]);
  });

  it("treats engine plugin documents as read-only", () => {
    const plugins = [
      {
        folderPath: "starter-content",
        settingsPath: "starter-content/starter-content.plugin.babasset",
        readOnly: true,
      },
      {
        folderPath: "plugins/pack",
        settingsPath: "plugins/pack/pack.plugin.babasset",
        readOnly: false,
      },
    ];
    expect(
      isPluginDocumentReadOnly(
        plugins,
        "starter-content/assets/StarterActor.class.babasset",
      ),
    ).toBe(true);
    expect(
      isPluginDocumentReadOnly(plugins, "plugins/pack/assets/Hero.class.babasset"),
    ).toBe(false);
  });
});
