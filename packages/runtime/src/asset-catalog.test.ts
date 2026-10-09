import { describe, expect, it } from "vitest";
import type { RuntimeAssetCatalogEntry } from "@babylonslate/core";
import { compileGraph, type GraphNode, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { RuntimeAssetCatalog, emptyAssetData } from "./asset-catalog";
import { createInProcessRuntime } from "./driver";
import { loadCompiledModule } from "./module-loader";
import { runtimeOptionsFromLoadControl } from "./play-load";
import { ScriptHost, type ScriptHostServices } from "./script-host";

function entry(
  path: string,
  type: string,
  extra: Partial<RuntimeAssetCatalogEntry> = {},
): RuntimeAssetCatalogEntry {
  const name = path.split("/").pop()!.split(".")[0]!;
  return { guid: extra.guid ?? `guid-${name}`, name, type, path, dependencies: [], requiredDependencies: [], ...extra };
}

const rifle = entry("assets/Weapons/Rifle.class.babasset", "Class", {
  classId: "Rifle", parentClass: "Weapon", dependencies: ["guid-rifleTex", "guid-Impact", "guid-Missing"], requiredDependencies: ["guid-rifleTex"],
});
const sniper = entry("assets/Weapons/Rifles/Sniper.class.babasset", "Class", {
  classId: "Sniper", parentClass: "Rifle", dependencies: ["guid-Rifle", "guid-Sniper"], requiredDependencies: ["guid-Rifle"],
});
const weapon = entry("assets/Weapons/Weapon.class.babasset", "Class", { classId: "Weapon", parentClass: "Actor" });
const pickup = entry("assets/Items/Pickup.class.babasset", "Class", { classId: "Pickup", parentClass: "Actor", dependencies: ["guid-rifleTex"] });
const gem = entry("plugins/Foo/assets/Gem.class.babasset", "Class", { classId: "Gem", parentClass: "Weapon" });
const hud = entry("assets/UI/Hud.class.babasset", "Class", { classId: "Hud", parentClass: "ActorComponent" });
const rifleTex = entry("assets/Weapons/Textures/rifle.texture.babasset", "Texture", { guid: "guid-rifleTex" });
const impact = entry("assets/Weapons/Impact.audio.babasset", "Audio", { guid: "guid-Impact" });
const logo = entry("assets/UI/Logo.texture.babasset", "Texture");
const main = entry("assets/Levels/Main.scene.babasset", "Scene", { dependencies: ["guid-Rifle"], requiredDependencies: [] });
const all = [rifle, sniper, weapon, pickup, gem, hud, rifleTex, impact, logo, main];
const paths = (found: Array<{ Path: string }>) => found.map((asset) => asset.Path);

describe("RuntimeAssetCatalog", () => {
  const catalog = new RuntimeAssetCatalog(all);

  it("describes an asset with the Asset Data fields, leaving Class empty for non-Class assets", () => {
    expect(catalog.getAssetData("guid-Rifle")).toEqual({
      Asset: "guid-Rifle", Name: "Rifle", Path: "assets/Weapons/Rifle.class.babasset", Folder: "assets/Weapons",
      Type: "Class", Class: "Rifle", ParentClass: "Weapon",
    });
    expect(catalog.getAssetData("guid-rifleTex")).toEqual({
      Asset: "guid-rifleTex", Name: "rifle", Path: "assets/Weapons/Textures/rifle.texture.babasset", Folder: "assets/Weapons/Textures",
      Type: "Texture", Class: "", ParentClass: "",
    });
    expect(catalog.hasAsset("guid-Rifle")).toBe(true);
  });

  it("reports an unknown asset or path as an empty Asset Data and not found", () => {
    expect(catalog.getAssetData("missing")).toEqual(emptyAssetData());
    expect(catalog.hasAsset("missing")).toBe(false);
    expect(catalog.getAssetByPath("assets/Nope.texture.babasset")).toEqual(emptyAssetData());
    expect(catalog.hasAssetPath("assets/Nope.texture.babasset")).toBe(false);
  });

  it("finds an asset by its normalized full storage path", () => {
    expect(catalog.getAssetByPath("/assets//UI/Logo.texture.babasset ").Asset).toBe("guid-Logo");
    expect(catalog.hasAssetPath("assets/UI/Logo.texture.babasset")).toBe(true);
    expect(catalog.hasAssetPath("assets/ui/logo.texture.babasset")).toBe(false);
  });

  it("lists a folder's own assets, or with Recursive its subfolders too, in Path order", () => {
    expect(paths(catalog.getAssetsByPath("assets/Weapons", false))).toEqual([
      "assets/Weapons/Impact.audio.babasset",
      "assets/Weapons/Rifle.class.babasset",
      "assets/Weapons/Weapon.class.babasset",
    ]);
    expect(paths(catalog.getAssetsByPath("assets/Weapons", true))).toEqual([
      "assets/Weapons/Impact.audio.babasset",
      "assets/Weapons/Rifle.class.babasset",
      "assets/Weapons/Rifles/Sniper.class.babasset",
      "assets/Weapons/Textures/rifle.texture.babasset",
      "assets/Weapons/Weapon.class.babasset",
    ]);
  });

  it("normalizes folder input and matches it exactly and case-sensitively", () => {
    const direct = paths(catalog.getAssetsByPath("assets/Weapons", false));
    expect(paths(catalog.getAssetsByPath(" /assets//Weapons/ ", false))).toEqual(direct);
    expect(catalog.getAssetsByPath("assets/weapons", true)).toEqual([]);
    expect(catalog.getAssetsByPath("assets/Weap", true)).toEqual([]);
  });

  it("treats an empty folder as every root only when searching recursively", () => {
    expect(catalog.getAssetsByPath("", true)).toHaveLength(all.length);
    expect(catalog.getAssetsByPath("", false)).toEqual([]);
    expect(paths(catalog.getAssetsByType("Class", "", true))).toContain("plugins/Foo/assets/Gem.class.babasset");
  });

  it("filters by type within an optional folder", () => {
    expect(paths(catalog.getAssetsByType("Texture", "", true))).toEqual([
      "assets/UI/Logo.texture.babasset",
      "assets/Weapons/Textures/rifle.texture.babasset",
    ]);
    expect(paths(catalog.getAssetsByType("Texture", "assets/Weapons", true))).toEqual([
      "assets/Weapons/Textures/rifle.texture.babasset",
    ]);
    expect(catalog.getAssetsByType("Texture", "assets/Weapons", false)).toEqual([]);
    expect(catalog.getAssetsByType("", "", true)).toEqual([]);
    expect(catalog.getAssetsByType("Material", "", true)).toEqual([]);
  });

  it("matches a Class and the project Classes below it through a multi-level chain into the engine bases", () => {
    const classes = (id: string, subclasses = true) =>
      catalog.getAssetsByClass(id, subclasses, "", true).map((asset) => asset.Class);
    expect(classes("Rifle")).toEqual(["Rifle", "Sniper"]);
    // Sniper -> Rifle -> Weapon -> Actor -> BObject. Gem is a plugin Class, so its Path sorts last.
    expect(classes("Weapon")).toEqual(["Rifle", "Sniper", "Weapon", "Gem"]);
    expect(classes("Actor")).toEqual(["Pickup", "Rifle", "Sniper", "Weapon", "Gem"]);
    expect(classes("ActorComponent")).toEqual(["Hud"]);
    expect(classes("BObject")).toEqual(["Pickup", "Hud", "Rifle", "Sniper", "Weapon", "Gem"]);
  });

  it("matches only the Class itself without Include Subclasses", () => {
    expect(catalog.getAssetsByClass("Weapon", false, "", true).map((asset) => asset.Class)).toEqual(["Weapon"]);
    expect(catalog.getAssetsByClass("Actor", false, "", true)).toEqual([]);
  });

  it("limits a Class query to a folder and never matches non-Class assets or unknown Classes", () => {
    expect(paths(catalog.getAssetsByClass("Weapon", true, "assets/Weapons", false))).toEqual([
      "assets/Weapons/Rifle.class.babasset",
      "assets/Weapons/Weapon.class.babasset",
    ]);
    expect(catalog.getAssetsByClass("Texture", true, "", true)).toEqual([]);
    expect(catalog.getAssetsByClass("Nope", true, "", true)).toEqual([]);
    expect(catalog.getAssetsByClass("", true, "", true)).toEqual([]);
  });

  it("stops at a parent cycle or a parent that is not in the catalog", () => {
    const loop = new RuntimeAssetCatalog([
      entry("assets/A.class.babasset", "Class", { classId: "A", parentClass: "B" }),
      entry("assets/B.class.babasset", "Class", { classId: "B", parentClass: "A" }),
      entry("assets/C.class.babasset", "Class", { classId: "C", parentClass: "Gone" }),
    ]);
    expect(loop.getAssetsByClass("A", true, "", true).map((asset) => asset.Class)).toEqual(["A", "B"]);
    expect(loop.getAssetsByClass("Gone", true, "", true).map((asset) => asset.Class)).toEqual(["C"]);
    expect(loop.getAssetsByClass("BObject", true, "", true).map((asset) => asset.Class)).toEqual([]);
  });

  it("combines every Find Assets constraint", () => {
    expect(paths(catalog.findAssets({ Folders: ["assets/Weapons"], NameContains: "RIF" }))).toEqual([
      "assets/Weapons/Rifle.class.babasset",
      "assets/Weapons/Textures/rifle.texture.babasset",
    ]);
    expect(paths(catalog.findAssets({ Folders: ["assets/Weapons"], Types: ["Class"], NameContains: "RIF" }))).toEqual([
      "assets/Weapons/Rifle.class.babasset",
    ]);
    expect(paths(catalog.findAssets({ Folders: ["assets/Weapons"], Recursive: false, Types: ["Class", "Audio"] }))).toEqual([
      "assets/Weapons/Impact.audio.babasset",
      "assets/Weapons/Rifle.class.babasset",
      "assets/Weapons/Weapon.class.babasset",
    ]);
    expect(paths(catalog.findAssets({ Folders: ["assets/Weapons", "assets/UI"], Types: ["Texture"] }))).toEqual([
      "assets/UI/Logo.texture.babasset",
      "assets/Weapons/Textures/rifle.texture.babasset",
    ]);
    expect(paths(catalog.findAssets({ Classes: ["Rifle"], IncludeSubclasses: false }))).toEqual([
      "assets/Weapons/Rifle.class.babasset",
    ]);
    expect(paths(catalog.findAssets({ Classes: ["Rifle"], Folders: ["assets/Weapons/Rifles"] }))).toEqual([
      "assets/Weapons/Rifles/Sniper.class.babasset",
    ]);
    expect(catalog.findAssets({ Types: ["Texture"], Classes: ["Rifle"] })).toEqual([]);
  });

  it("reads empty lists, empty strings and missing fields as no constraint", () => {
    const everything = catalog.getAssetsByPath("", true);
    expect(catalog.findAssets({})).toEqual(everything);
    expect(
      catalog.findAssets({ Folders: [""], Types: [], Classes: [], NameContains: "", Recursive: false }),
    ).toEqual(everything);
    expect(catalog.findAssets(undefined as never)).toEqual(everything);
  });

  it("derives full sub-folder paths from the assets, direct or recursive", () => {
    expect(catalog.getSubFolders("assets", false)).toEqual([
      "assets/Items", "assets/Levels", "assets/UI", "assets/Weapons",
    ]);
    expect(catalog.getSubFolders("assets/Weapons", false)).toEqual([
      "assets/Weapons/Rifles", "assets/Weapons/Textures",
    ]);
    expect(catalog.getSubFolders("plugins", true)).toEqual(["plugins/Foo", "plugins/Foo/assets"]);
    expect(catalog.getSubFolders("", false)).toEqual(["assets", "plugins"]);
    expect(catalog.getSubFolders("assets/Weapons/Rifles", true)).toEqual([]);
    expect(catalog.getSubFolders("assets/Weapons", true)).not.toContain("assets/Weapons");
  });

  it("lists folders without assets only when the host supplies them", () => {
    const withEmpty = new RuntimeAssetCatalog(all, { folders: ["assets/Weapons/Empty/", "assets/Drafts"] });
    expect(withEmpty.getSubFolders("assets/Weapons", false)).toContain("assets/Weapons/Empty");
    expect(withEmpty.getSubFolders("assets", false)).toContain("assets/Drafts");
    expect(withEmpty.folderHasAssets("assets/Drafts", true)).toBe(false);
    expect(catalog.getSubFolders("assets", false)).not.toContain("assets/Drafts");
  });

  it("reports whether a folder holds assets directly or below it", () => {
    expect(catalog.folderHasAssets("assets/Weapons", false)).toBe(true);
    expect(catalog.folderHasAssets("assets", false)).toBe(false);
    expect(catalog.folderHasAssets("assets", true)).toBe(true);
    expect(catalog.folderHasAssets("assets/Nothing", true)).toBe(false);
    expect(catalog.folderHasAssets("", true)).toBe(true);
  });

  it("lists dependencies that are catalog assets, Hard Only keeping the required ones", () => {
    expect(catalog.getDependencies("guid-Rifle", false)).toEqual(["guid-Impact", "guid-rifleTex"]);
    expect(catalog.getDependencies("guid-Rifle", true)).toEqual(["guid-rifleTex"]);
    expect(catalog.getDependencies("guid-Sniper", false)).toEqual(["guid-Rifle"]);
    expect(catalog.getDependencies("missing", false)).toEqual([]);
  });

  it("lists referencers that are catalog assets, Hard Only keeping the owners that load it", () => {
    expect(catalog.getReferencers("guid-rifleTex", false)).toEqual(["guid-Pickup", "guid-Rifle"]);
    expect(catalog.getReferencers("guid-rifleTex", true)).toEqual(["guid-Rifle"]);
    expect(catalog.getReferencers("guid-Rifle", false)).toEqual(["guid-Main", "guid-Sniper"]);
    expect(catalog.getReferencers("guid-Rifle", true)).toEqual(["guid-Sniper"]);
    expect(catalog.getReferencers("guid-Sniper", false)).toEqual([]);
  });

  it("answers the same regardless of the order entries arrive in, with fresh arrays per call", () => {
    const shuffled = new RuntimeAssetCatalog([...all].reverse());
    expect(shuffled.findAssets({})).toEqual(catalog.findAssets({}));
    expect(shuffled.getReferencers("guid-rifleTex", false)).toEqual(catalog.getReferencers("guid-rifleTex", false));
    catalog.getAssetsByPath("assets", true).splice(0);
    catalog.getSubFolders("", true).splice(0);
    expect(catalog.getAssetsByPath("assets", true)).toHaveLength(all.length - 1);
    expect(catalog.getSubFolders("", true)).not.toHaveLength(0);
  });

  it("never throws on values a graph can leave unset", () => {
    for (const value of [null, undefined, 3, {}] as unknown as string[]) {
      expect(catalog.getAssetsByPath(value, true)).toEqual(catalog.getAssetsByPath("", true));
      expect(catalog.getAssetsByPath(value, false)).toEqual([]);
      expect(catalog.getAssetByPath(value)).toEqual(emptyAssetData());
      expect(catalog.getSubFolders(value, true)).toEqual(catalog.getSubFolders("", true));
      expect(catalog.getAssetData(value)).toEqual(emptyAssetData());
      expect(catalog.getDependencies(value, false)).toEqual([]);
    }
    expect(catalog.findAssets({ Folders: "assets" as never, Types: null as never, Classes: 3 as never })).toHaveLength(all.length);
  });
});

function host(catalog?: RuntimeAssetCatalog, logs: string[] = []): ScriptHost {
  const services: ScriptHostServices = {
    ...(catalog ? { getAssetCatalog: () => catalog } : {}),
    log: (_severity, _category, message) => { logs.push(message); },
    print: () => {}, destroyActor: () => {},
    executeConsoleCommand: () => ({ success: true, output: "" }),
    delay: async () => {}, reportError: () => {},
  };
  return new ScriptHost(services);
}

describe("Asset Registry nodes at runtime", () => {
  const registry = createDefaultNodeRegistry();
  const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
    id, typeId, position: { x: 0, y: 0 }, properties, pins: registry.get(typeId)!.pins(properties),
  });
  const runLogging = async (context: ReturnType<ScriptHost["createContext"]>, typeId: string, properties: Record<string, unknown>, output: string) => {
    const graph: LogicGraph = {
      id: typeId, kind: "event",
      nodes: [node("start", "flow.entry"), node("query", typeId, properties), node("log", "debug.log")],
      edges: [
        { id: "flow", sourceNodeId: "start", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "value", sourceNodeId: "query", sourcePinId: output, targetNodeId: "log", targetPinId: "message" },
      ],
    };
    await (await loadCompiledModule(compileGraph(graph, { registry, assetGuid: "a" }).source, `${typeId}-${output}`)).run!(context);
  };

  it("runs compiled queries against the host's catalog", async () => {
    const logs: string[] = [];
    const context = host(new RuntimeAssetCatalog(all), logs).createContext(null, 0, 0);
    await runLogging(context, "assetRegistry.getAssetsByClass", { "default:class": "Weapon" }, "classes");
    await runLogging(context, "assetRegistry.getSubFolders", { "default:folder": "assets/Weapons" }, "folders");
    await runLogging(context, "assetRegistry.getAssetData", { "default:asset": "guid-Logo" }, "found");
    await runLogging(context, "assetRegistry.getAssetData", { "default:asset": "guid-Nope" }, "found");
    await runLogging(context, "assetRegistry.folderHasAssets", { "default:folder": "assets/UI", "default:recursive": false }, "hasAssets");
    expect(logs).toEqual(["[Rifle, Sniper, Weapon, Gem]", "[assets/Weapons/Rifles, assets/Weapons/Textures]", "true", "false", "true"]);
  });

  it("answers empty results, never an error, when the host has no catalog", async () => {
    const logs: string[] = [];
    const context = host(undefined, logs).createContext(null, 0, 0);
    expect(context.assetRegistry.getAssetsByPath("assets", true)).toEqual([]);
    expect(context.assetRegistry.getAssetData("guid-Logo")).toEqual(emptyAssetData());
    await runLogging(context, "assetRegistry.getAssetData", { "default:asset": "guid-Logo" }, "found");
    expect(logs).toEqual(["false"]);
  });

  const tickAssetReader = async (assetCatalog: RuntimeAssetCatalogEntry[] | undefined, expression: string): Promise<string[]> => {
    const logs: string[] = [];
    const runtime = createInProcessRuntime({
      ...runtimeOptionsFromLoadControl({ type: "load", sceneAssetGuid: "scene", ...(assetCatalog ? { assetCatalog } : {}) }),
      seedDemoActors: false, preferSoftwarePhysics: true,
      onCommand: (command) => { if (command.type === "log" && command.category === "Assets") logs.push(command.message); },
    });
    try {
      await runtime.loadScripts([{
        assetGuid: "reader", classId: "AssetReader", anchors: [],
        source: `export function onTick(ctx) { ctx.log("log", "Assets", ${expression}); }`,
        entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
      }]);
      runtime.spawnScriptedActor({ classId: "AssetReader" });
      runtime.start();
      runtime.tick();
      return logs;
    } finally { runtime.stop(); }
  };

  it("installs the load control's catalog into the actual runtime driver's authored graph context", async () => {
    expect(await tickAssetReader(all, 'ctx.assetRegistry.getAssetsByClass("Weapon", true, "", true).map((asset) => asset.Class).join(",")'))
      .toEqual(["Rifle,Sniper,Weapon,Gem"]);
  });

  it("gives a runtime loaded without a catalog an empty one", async () => {
    expect(await tickAssetReader(undefined, 'String(ctx.assetRegistry.getAssetsByPath("", true).length)')).toEqual(["0"]);
  });
});
