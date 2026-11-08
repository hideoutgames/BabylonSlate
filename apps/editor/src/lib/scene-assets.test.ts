import { describe, expect, it } from "vitest";
import { projectPlaceActors } from "./place-actors";
import {
  changedSceneAssetKinds,
  draggedSceneAssetIds,
  filterSceneAssets,
  sceneAssetDropPositions,
  sceneAssetFilterKinds,
  sceneAssetItems,
  selectSceneAsset,
  sortSceneAssets,
  type SceneAssetItem,
} from "./scene-assets";

const ASSETS = [
  { rootId: "project", path: "assets/props/Crate.model.hasset", header: { guid: "crate", name: "Crate", type: "Model" } },
  { rootId: "project", path: "assets/gameplay/Door.class.hasset", header: { guid: "door", name: "Door", type: "Class", parentClass: "Actor" } },
  { rootId: "project", path: "assets/gameplay/Locked Door.class.hasset", header: { guid: "locked", name: "Locked Door", type: "Class", parentClass: "Door" } },
  { rootId: "project", path: "assets/Game.class.hasset", header: { guid: "game", name: "Game", type: "Class", parentClass: "GameInstance" } },
  { rootId: "project", path: "assets/ui/Health Bar.class.hasset", header: { guid: "health", name: "Health Bar", type: "Class", parentClass: "SceneLayerActor" } },
  { rootId: "project", path: "assets/props/Stack.prefab.hasset", header: { guid: "stack", name: "Stack", type: "Prefab" } },
  { rootId: "project", path: "assets/2d/Hero.sprite.hasset", header: { guid: "hero", name: "Hero", type: "Sprite" } },
  { rootId: "project", path: "assets/2d/Level.tilemap.hasset", header: { guid: "level", name: "Level", type: "Tilemap" } },
  { rootId: "project", path: "assets/audio/Wind.audio.hasset", header: { guid: "wind", name: "Wind", type: "Audio" } },
  { rootId: "plugin:kit", path: "plugins/kit/assets/Cone.model.hasset", header: { guid: "cone", name: "Cone", type: "Model" } },
];

function entries(overlay: boolean): SceneAssetItem[] {
  return sceneAssetItems({
    projectItems: projectPlaceActors(ASSETS, undefined, { overlay }),
    assets: ASSETS,
    overlay,
    pluginName: (rootId) => (rootId === "plugin:kit" ? "Props Kit" : null),
  });
}

const summary = (items: readonly SceneAssetItem[]) =>
  items.map((entry) => [entry.title, entry.kind, entry.folder, entry.pluginName]);

describe("sceneAssetItems", () => {
  it("lists a Scene's Models, Actor Classes at any depth, Prefabs, Sprites and Tilemaps, with their plugin", () => {
    expect(summary(entries(false))).toEqual([
      ["Crate", "model", "assets/props", null],
      ["Door", "actor", "assets/gameplay", null],
      ["Locked Door", "actor", "assets/gameplay", null],
      ["Stack", "prefab", "assets/props", null],
      ["Hero", "sprite", "assets/2d", null],
      ["Level", "tilemap", "assets/2d", null],
      ["Cone", "model", "plugins/kit/assets", "Props Kit"],
    ]);
  });

  it("lists a Scene Layer's built-in 2D elements first, then Layer Actor Classes, Models, Sprites and Tilemaps", () => {
    const layer = entries(true);
    const elements = layer.filter((entry) => entry.kind === "element");
    expect(elements.slice(0, 3).map((entry) => entry.title)).toEqual(["2D Panel", "2D Text", "2D Rich Text"]);
    expect(layer.slice(0, elements.length)).toEqual(elements);
    expect(summary(layer.slice(elements.length))).toEqual([
      ["Crate", "model", "assets/props", null],
      ["Health Bar", "layer-actor", "assets/ui", null],
      ["Hero", "sprite", "assets/2d", null],
      ["Level", "tilemap", "assets/2d", null],
      ["Cone", "model", "plugins/kit/assets", "Props Kit"],
    ]);
  });
});

describe("filterSceneAssets", () => {
  const all = entries(false);
  const allKinds = sceneAssetFilterKinds(false).map((entry) => entry.kind);
  const titles = (items: readonly SceneAssetItem[]) => items.map((entry) => entry.title);

  it("keeps only the shown kinds, hides plugin content and keeps one folder", () => {
    expect(titles(filterSceneAssets(all, { search: "", shownKinds: ["model", "prefab"], showPluginContent: true, folder: "" })))
      .toEqual(["Crate", "Stack", "Cone"]);
    expect(titles(filterSceneAssets(all, { search: "", shownKinds: ["sprite", "tilemap"], showPluginContent: true, folder: "" })))
      .toEqual(["Hero", "Level"]);
    expect(filterSceneAssets(all, { search: "", shownKinds: [], showPluginContent: true, folder: "" })).toEqual([]);
    expect(titles(filterSceneAssets(all, { search: "", shownKinds: allKinds, showPluginContent: false, folder: "" })))
      .toEqual(["Crate", "Door", "Locked Door", "Stack", "Hero", "Level"]);
    expect(titles(filterSceneAssets(all, { search: "", shownKinds: allKinds, showPluginContent: true, folder: "assets/props" })))
      .toEqual(["Crate", "Stack"]);
  });

  it("searches names, type labels, folders and plugin names", () => {
    const search = (text: string) =>
      titles(filterSceneAssets(all, { search: text, shownKinds: allKinds, showPluginContent: true, folder: "" }));
    expect(search("door")).toEqual(["Door", "Locked Door"]);
    expect(search("actor class")).toEqual(["Door", "Locked Door"]);
    expect(search("GAMEPLAY")).toEqual(["Door", "Locked Door"]);
    expect(search("props kit")).toEqual(["Cone"]);
    expect(search("tilemap")).toEqual(["Level"]);
  });
});

describe("changedSceneAssetKinds", () => {
  it("names the host's Asset Types shown or hidden against the default, in menu order", () => {
    expect(changedSceneAssetKinds(false, ["actor", "prefab", "tilemap", "element", "layer-actor"])).toEqual([
      { kind: "model", label: "Models", shown: false },
      { kind: "tilemap", label: "Tilemaps", shown: true },
    ]);
    // Kinds the other host offers are not this host's changes.
    expect(changedSceneAssetKinds(true, ["model", "actor", "prefab", "element", "layer-actor"])).toEqual([]);
    expect(changedSceneAssetKinds(true, ["model", "sprite"])).toEqual([
      { kind: "element", label: "2D Elements", shown: false },
      { kind: "layer-actor", label: "Layer Actor Classes", shown: false },
      { kind: "sprite", label: "Sprites", shown: true },
    ]);
  });
});

describe("sortSceneAssets", () => {
  it("sorts by name, type or folder and keeps built-in 2D elements first in catalog order", () => {
    const layer = entries(true);
    const elementTitles = layer.filter((entry) => entry.kind === "element").map((entry) => entry.title);
    const rest = (sort: "name" | "type" | "folder") =>
      sortSceneAssets(layer, sort).slice(elementTitles.length).map((entry) => entry.title);
    expect(sortSceneAssets(layer, "name").slice(0, elementTitles.length).map((entry) => entry.title))
      .toEqual(elementTitles);
    expect(rest("name")).toEqual(["Cone", "Crate", "Health Bar", "Hero", "Level"]);
    expect(rest("type")).toEqual(["Health Bar", "Cone", "Crate", "Hero", "Level"]);
    expect(rest("folder")).toEqual(["Hero", "Level", "Crate", "Health Bar", "Cone"]);
  });
});

describe("selectSceneAsset", () => {
  const order = ["a", "b", "c", "d"];

  it("replaces, toggles with Ctrl/Cmd and ranges from the anchor with Shift", () => {
    const one = selectSceneAsset("b", undefined, order, { ids: ["a", "c"], anchor: "a" });
    expect(one).toEqual({ ids: ["b"], anchor: "b" });
    const added = selectSceneAsset("d", { additive: true }, order, one);
    expect(added).toEqual({ ids: ["b", "d"], anchor: "d" });
    expect(selectSceneAsset("b", { additive: true }, order, added)).toEqual({ ids: ["d"], anchor: "b" });
    expect(selectSceneAsset("a", { range: true }, order, { ids: ["c"], anchor: "c" }))
      .toEqual({ ids: ["a", "b", "c"], anchor: "c" });
  });

  it("drags the whole selection in list order from a selected entry, and an unselected entry alone", () => {
    expect(draggedSceneAssetIds("c", ["d", "b", "c"], order)).toEqual(["b", "c", "d"]);
    expect(draggedSceneAssetIds("a", ["d", "b"], order)).toEqual(["a"]);
  });
});

describe("sceneAssetDropPositions", () => {
  it("puts one entry on the drop point", () => {
    expect(sceneAssetDropPositions([4, 5, 6], 1, "xz")).toEqual([[4, 5, 6]]);
  });

  it("spreads several entries in a grid centred on the point, across the ground in 3D and the screen in 2D", () => {
    expect(sceneAssetDropPositions([4, 5, 6], 3, "xz")).toEqual([
      [3, 5, 5],
      [5, 5, 5],
      [3, 5, 7],
    ]);
    expect(sceneAssetDropPositions([4, 5, 0], 3, "xy")).toEqual([
      [3, 6, 0],
      [5, 6, 0],
      [3, 4, 0],
    ]);
  });
});
