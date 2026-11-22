import { describe, expect, it } from "vitest";
import { normalizeProjectSettings } from "@haptic/core";
import type { AssetDiff } from "./asset-diff";
import {
  diffProjectVersions,
  EMPTY_PROJECT_DIFF_LOOKUP,
  HIDDEN_PROJECT_SETTINGS,
  PROJECT_SETTING_ROWS,
  type ProjectDiffLookup,
} from "./project-settings-diff";

// Two stored `project.json` versions, read as the editor opens them, compared through the public diff.

interface Manifest {
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  version?: number;
  guid?: string;
  scenes?: string[];
}

function manifest({ settings = {}, metadata = {}, version = 1, guid = "project-guid", scenes = ["assets/main.scene.hasset"] }: Manifest = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    guid,
    kind: "project",
    version,
    metadata: { name: "Game", version: "1.0.0", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...metadata },
    settings,
    scenes,
    graphs: ["assets/main.class.hasset"],
  }));
}

const LOOKUP: ProjectDiffLookup = {
  ...EMPTY_PROJECT_DIFF_LOOKUP,
  assetName: (guid) => ({ "scene-forest": "Forest", "mat-blur": "Blur", "mat-glow": "Glow", "axis-move": "Move" } as Record<string, string>)[guid] ?? null,
  className: (id) => (id === "Tools" ? "Tools" : id === "GameInstance" ? "Game Instance" : null),
  plugin: (guid) => (guid === "plugin-water" ? { name: "Water Tools", enabledByDefault: true } : null),
  extension: (guid) => guid === "ext-glsl" ? {
    name: "GLSL Converter",
    enabledByDefault: false,
    settings: {
      title: "GLSL",
      sections: [{ id: "main", title: "Main", fields: [
        { id: "fast", label: "Fast Mode", type: "toggle", default: false },
        { id: "precision", label: "Precision", type: "choice", default: "high", options: [{ value: "high", label: "High Precision" }, { value: "low", label: "Low Precision" }] },
      ] }],
    },
  } : null,
  iconName: (id) => ({ shapes: "Shapes", rocket: "Rocket" } as Record<string, string>)[id] ?? null,
  colorName: (id) => ({ stone: "Stone", sky: "Electric Blue" } as Record<string, string>)[id] ?? null,
};

function diff(base: Uint8Array | null, compare: Uint8Array | null, lookup: ProjectDiffLookup = LOOKUP): AssetDiff {
  return diffProjectVersions({ bytes: base, label: "main · 1a2b3c4" }, { bytes: compare, label: "Working Copy" }, lookup);
}

function groupsOf(result: AssetDiff) {
  if (result.view.kind !== "properties") throw new Error("Project diffs are property views.");
  return result.view.groups;
}

/** Every changed row as `[group, label, base, compare]`. */
function changes(result: AssetDiff): Array<[string, string, string | null, string | null]> {
  return groupsOf(result).flatMap((group) => group.rows.filter((row) => row.changed).map((row): [string, string, string | null, string | null] => [group.id, row.label, row.base, row.compare]));
}

describe("diffProjectVersions", () => {
  it("reads an absent setting as its default, so only real differences change", () => {
    // Every setting written out at its default against a manifest that stores none, saved at another time.
    const full = manifest({ settings: normalizeProjectSettings(undefined) as unknown as Record<string, unknown>, metadata: { updatedAt: "2026-05-05T00:00:00.000Z" } });
    const result = diff(manifest(), full);
    expect(result.status).toBe("unchanged");
    expect(changes(result)).toEqual([]);
    expect(result).toMatchObject({ path: "project.json", type: "Project", name: "Project Settings", header: [], chunks: [] });
    // The groups follow the Project Settings dialog's categories; a list with no entries (Tags) has none.
    expect(groupsOf(result).map((group) => group.title).slice(0, 6)).toEqual(["Project", "General", "Source Control", "Export", "Game", "Save Games"]);
  });

  it("shows a changed setting under its dialog category and label, with its value as the dialog shows it", () => {
    const result = diff(
      manifest({ settings: { autoSave: true, render: { mode: "pbr", effects: { volumetricLighting: { density: 0.003 } } }, sourceControl: { lockOnEdit: "ask" } } }),
      manifest({ settings: { autoSave: false, autoSaveIntervalMs: 30_000, render: { mode: "cel", effects: { volumetricLighting: { density: 0.0045 } } }, sourceControl: { lockOnEdit: "always" } } }),
    );
    expect(result.status).toBe("changed");
    expect(changes(result)).toEqual([
      ["general", "Auto-Save", "On", "Off"],
      ["general", "Auto-Save Interval (Seconds)", "120", "30"],
      ["sourceControl", "Lock On Edit", "Ask", "Always"],
      ["rendering", "Render Mode", "PBR", "CEL"],
      ["rendering", "Scene-Wide Fog Density", "0.003", "0.0045"],
    ]);
    const groups = groupsOf(result);
    expect(groups.find((group) => group.id === "general")?.status).toBe("changed");
    expect(groups.find((group) => group.id === "audio")?.status).toBe("unchanged");
  });

  it("shows the project's name, version and appearance, an absent appearance as the default one", () => {
    const result = diff(
      manifest(),
      manifest({ metadata: { name: "Space Game", version: "1.1.0", appearance: { icon: "rocket", color: "sky", coverFile: "cover.png", cover: "icon" } } }),
    );
    expect(changes(result)).toEqual([
      ["project", "Project Name", "Game", "Space Game"],
      ["project", "Icon", "Shapes", "Rocket"],
      ["project", "Color", "Stone", "Electric Blue"],
      ["project", "Picture", "None", "cover.png"],
      ["project", "Use Picture", "On", "Off"],
      ["export", "Project Version", "1.0.0", "1.1.0"],
    ]);
  });

  it("leaves out bookkeeping: save times, the guid, the format version and the scene and graph lists", () => {
    const result = diff(
      manifest({ settings: { tags: { tags: [], nextId: 4 } } }),
      manifest({ guid: "other-guid", scenes: [], metadata: { createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z" }, settings: { tags: { tags: [], nextId: 9 } } }),
    );
    expect(result.status).toBe("unchanged");
    const ids = groupsOf(result).flatMap((group) => group.rows.map((row) => row.id));
    expect(ids.filter((id) => /updatedAt|createdAt|guid$|scenes|graphs|nextId|^version$/.test(id))).toEqual([]);
  });

  it("names referenced assets, classes and inputs, and says when the project no longer has one", () => {
    const result = diff(
      manifest({ settings: { startupSceneGuid: "scene-forest", gameInstanceClass: "GameInstance", focusNavigation: { navigationInputGuid: "axis-move" } } }),
      manifest({ settings: { startupSceneGuid: "scene-gone-12345678", gameInstanceClass: "OldGame", focusNavigation: {} } }),
    );
    expect(changes(result)).toEqual([
      ["game", "Startup Scene", "Forest", "Missing Asset (scene-go)"],
      ["game", "Game Instance", "Game Instance", "Missing Class (OldGame)"],
      ["focusNavigation", "Navigation Input", "Move", "Built-In Controls"],
    ]);
  });

  it("lists name lists by entry: added and removed entries, and the order when only the order moved", () => {
    const sorting = (sortingLayers: string[]) => manifest({ settings: { twoD: { sortingLayers }, editorUtilityObjects: ["Tools"], alwaysPackageFolders: ["assets/Weapons"] } });
    expect(changes(diff(sorting(["Background", "Foreground", "UI"]), sorting(["Background", "UI", "Water"])))).toEqual([
      ["game", "Sorting Layer", null, "Water"],
      ["game", "Sorting Layer", "Foreground", null],
    ]);
    expect(changes(diff(sorting(["Background", "Default", "UI"]), sorting(["Default", "Background", "UI"])))).toEqual([
      ["game", "Sorting Layer Order", "Background, Default, UI", "Default, Background, UI"],
    ]);
    const utilities = (editorUtilityObjects: string[], alwaysPackageFolders: string[]) => manifest({ settings: { editorUtilityObjects, alwaysPackageFolders } });
    expect(changes(diff(utilities(["Tools"], []), utilities(["Gone"], ["assets/Weapons"])))).toEqual([
      ["general", "Editor Utility Object", null, "Missing Class (Gone)"],
      ["general", "Editor Utility Object", "Tools", null],
      ["export", "Always Package Folder", null, "assets/Weapons"],
    ]);
  });

  it("compares Collision Layers by position, and Collision Presets by id with their masks as layer names", () => {
    const physics = (collisionLayers: string[], mask: number, overlapMask: number, name = "Pawn") => manifest({ settings: { physics: {
      collisionLayers,
      collisionPresets: [{ id: "default", name: "Default", layer: 1, mask: 0xffffffff, overlapMask: 0 }, { id: "pawn", name, layer: 2, mask, overlapMask }],
    } } });
    expect(changes(diff(physics(["Default", "Enemy"], 0b11, 0), physics(["Default", "Enemies"], 0b01, 0b10, "Player")))).toEqual([
      ["physics", "Collision Layer 2", "Enemy", "Enemies"],
      // The renamed layer is named in every mask that holds it.
      ["physics", "Default · Blocks", "Default, Enemy", "Default, Enemies"],
      ["physics", "Player · Name", "Pawn", "Player"],
      ["physics", "Player · Layer", "Enemy", "Enemies"],
      ["physics", "Player · Blocks", "Default, Enemy", "Default"],
      ["physics", "Player · Overlaps", "None", "Enemies"],
    ]);
    // A preset only one version has, and a new layer.
    expect(changes(diff(physics(["Default"], 1, 0), manifest({ settings: { physics: { collisionLayers: ["Default", "Water"] } } })))).toEqual([
      ["physics", "Collision Layer 2", null, "Water"],
      ["physics", "Default · Blocks", "Default", "Default, Water"],
      ["physics", "Pawn · Name", "Pawn", null],
      ["physics", "Pawn · Layer", "Layer 2", null],
      ["physics", "Pawn · Blocks", "Default", null],
      ["physics", "Pawn · Overlaps", "None", null],
    ]);
  });

  it("compares Tags by path, Export Presets by id with the default preset where none is stored, and the Scene Layer pass stack", () => {
    const result = diff(
      manifest({ settings: {
        tags: { tags: [{ id: 1, path: "Enemy" }, { id: 2, path: "Enemy.Boss" }] },
        sceneLayerPostProcessStack: [{ id: "a", materialGuid: "mat-blur", enabled: true }, { id: "b", materialGuid: "mat-glow", enabled: true }],
      } }),
      manifest({ settings: {
        tags: { tags: [{ id: 1, path: "Enemy" }, { id: 3, path: "Pickup" }] },
        exportPresets: [{ id: "web", name: "Web", bundleDebugger: true, pluginOverrides: { "plugin-water": { enabled: false } } }],
        sceneLayerPostProcessStack: [{ id: "b", materialGuid: "mat-glow", enabled: false }, { id: "a", materialGuid: "mat-blur", enabled: true }],
      } }),
    );
    expect(changes(result)).toEqual([
      ["export", "Web · Bundle Debugger", "Off", "On"],
      ["export", "Web · Water Tools", "No Override", "Off"],
      ["tags", "Pickup", null, "ID 3"],
      ["tags", "Enemy.Boss", "ID 2", null],
      ["rendering", "Glow · Enabled", "On", "Off"],
      ["rendering", "Post-Process Pass Order", "Blur, Glow", "Glow, Blur"],
    ]);
  });

  it("shows plugin and extension enablement and extension settings by name, absent values at their defaults", () => {
    const result = diff(
      manifest({ settings: { pluginOverrides: { "plugin-gone-1234": { enabled: true } } } }),
      manifest({ settings: {
        pluginOverrides: { "plugin-water": { enabled: false } },
        extensionOverrides: { "ext-glsl": { enabled: true } },
        extensionSettings: { "ext-glsl": { fast: true } },
      } }),
    );
    expect(changes(result)).toEqual([
      ["plugins", "Water Tools", "On", "Off"],
      ["plugins", "Missing Plugin (plugin-g)", "On", "Default"],
      ["extensions", "GLSL Converter", "Off", "On"],
      ["extension:ext-glsl", "Fast Mode", "Off", "On"],
    ]);
    const glsl = groupsOf(result).find((group) => group.id === "extension:ext-glsl")!;
    expect(glsl.title).toBe("GLSL");
    expect(glsl.rows.find((row) => row.label === "Precision")).toMatchObject({ base: "High Precision", compare: "High Precision", changed: false });
  });

  it("is added or removed when one version has no project.json", () => {
    const added = diff(null, manifest());
    expect(added.status).toBe("added");
    expect(groupsOf(added).find((group) => group.id === "general")?.rows.find((row) => row.label === "Auto-Save")).toMatchObject({ base: null, compare: "On", changed: true });
    expect(diff(manifest(), null).status).toBe("removed");
  });

  it("names the version that cannot be read, and why", () => {
    expect(() => diff(manifest({ version: 99 }), manifest())).toThrow(/^The Project Settings in main · 1a2b3c4 cannot be read: .*newer engine version/);
    expect(() => diff(manifest(), new TextEncoder().encode("{ not json"))).toThrow(/^The Project Settings in Working Copy cannot be read: /);
    expect(() => diff(manifest(), new TextEncoder().encode(JSON.stringify({ guid: "g", settings: {} })))).toThrow(
      "The Project Settings in Working Copy cannot be read: Invalid project manifest: project.json is missing metadata, settings, scenes or graphs.",
    );
  });

  it("covers every stored Project Setting with a row, a list or a reason to leave it out", () => {
    const covered = [
      ...PROJECT_SETTING_ROWS.flatMap((spec) => (spec.kind === "value" ? spec.keys ?? [spec.id] : [spec.key])),
      ...Object.keys(HIDDEN_PROJECT_SETTINGS),
    ];
    const leaves: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
        for (const [key, entry] of Object.entries(value)) walk(entry, path ? `${path}.${key}` : key);
      } else leaves.push(path);
    };
    walk(normalizeProjectSettings(undefined), "");
    expect(leaves.length).toBeGreaterThan(150);
    expect(leaves.filter((leaf) => !covered.some((key) => leaf === key || leaf.startsWith(`${key}.`)))).toEqual([]);
  });
});
