import {
  PROJECT_FILE,
  QUALITY_GROUPS,
  collisionResponseTo,
  defaultExportPreset,
  humanizePropertyLabel,
  qualityGroupLabel,
  resolveRenderingQuality,
  type CollisionPreset,
  type ExportPreset,
  type ProjectDocument,
  type QualityGroup,
  type SceneLayerPostProcessEntry,
} from "@haptic/core";
import type { AssetDiff } from "./asset-diff";
import { formatDiffValue, groupStatus, valueRow, type DiffStatus, type PropertyDiffGroup, type PropertyDiffRow } from "./asset-diff-values";
import { resolveExtensionFieldValue, type ExtensionField, type ExtensionSettingsContribution } from "./extension-fields";
import { readProjectManifest } from "./project-manifest";

/**
 * Names the diff shows for what `project.json` stores by id: assets by guid,
 * classes by class id, plugins and extensions by guid, and the project
 * browser's icon and color ids. Null means nothing in the project has it now.
 */
export interface ProjectDiffLookup {
  assetName(guid: string): string | null;
  className(classId: string): string | null;
  plugin(guid: string): { name: string; enabledByDefault: boolean } | null;
  extension(guid: string): { name: string; enabledByDefault: boolean; settings: ExtensionSettingsContribution | null } | null;
  iconName(id: string): string | null;
  colorName(id: string): string | null;
  /** The appearance a project without one shows. */
  defaultAppearance: { icon: string; color: string };
}

/** A lookup that knows no names: every reference shows as missing. */
export const EMPTY_PROJECT_DIFF_LOOKUP: ProjectDiffLookup = {
  assetName: () => null,
  className: () => null,
  plugin: () => null,
  extension: () => null,
  iconName: () => null,
  colorName: () => null,
  defaultAppearance: { icon: "shapes", color: "stone" },
};

/**
 * The diff's groups: the project's identity, then the Project Settings
 * dialog's categories in its order, with its titles (`settings-catalog.ts`).
 * Each extension's settings get a group of their own (`extension:<guid>`, the
 * dialog's category id), after Project Extensions.
 */
export const PROJECT_DIFF_CATEGORIES = [
  ["project", "Project"],
  ["general", "General"],
  ["sourceControl", "Source Control"],
  ["export", "Export"],
  ["game", "Game"],
  ["tags", "Tags"],
  ["saveGames", "Save Games"],
  ["physics", "Physics"],
  ["focusNavigation", "Focus Navigation"],
  ["rendering", "Rendering"],
  ["textures", "Textures"],
  ["fonts", "Fonts"],
  ["audio", "Audio"],
  ["plugins", "Plugins"],
  ["extensions", "Project Extensions"],
] as const;

export type ProjectDiffCategory = (typeof PROJECT_DIFF_CATEGORIES)[number][0];

type Format = (value: unknown, lookup: ProjectDiffLookup) => string;

/**
 * One row: its id (a key path under `settings`, or `metadata.*`), the
 * category and label the Project Settings dialog shows it under, the key
 * paths it covers when it reads more than its id, how it reads a version
 * (default: the value at its id) and how it shows a value.
 */
export interface ProjectSettingRow {
  kind: "value";
  id: string;
  category: ProjectDiffCategory;
  label: string;
  keys?: readonly string[];
  read?: (document: ProjectDocument) => unknown;
  format?: Format;
}

/** A list or map: one row per entry, built by `rows`, which compares the two versions' entries. */
export interface ProjectSettingList {
  kind: "list";
  key: string;
  category: ProjectDiffCategory;
  rows: (base: ProjectDocument | null, compare: ProjectDocument | null, lookup: ProjectDiffLookup) => PropertyDiffRow[];
}

/** A map whose entries get groups of their own, placed after `after`'s group. */
export interface ProjectSettingGroups {
  kind: "groups";
  key: string;
  after: ProjectDiffCategory;
  groups: (base: ProjectDocument | null, compare: ProjectDocument | null, lookup: ProjectDiffLookup) => PropertyDiffGroup[];
}

/** A number as the dialog's fields show it: whole numbers in full, others to six significant digits, with a minus sign. */
export function formatSettingNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const shown = Number.isInteger(value) ? value : Number(value.toPrecision(6));
  return (Object.is(shown, -0) ? 0 : shown).toString().replace("-", "−");
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

const onOff: Format = (value) => (value ? "On" : "Off");
const number: Format = (value) => (typeof value === "number" ? formatSettingNumber(value) : formatDiffValue(value));
const withUnit = (unit: string): Format => (value) => `${number(value, EMPTY_PROJECT_DIFF_LOOKUP)} ${unit}`;
const choice = (names: Readonly<Record<string, string>>): Format => (value) => names[String(value)] ?? formatDiffValue(value);
const capitalized: Format = (value) => {
  const text = String(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const text: Format = (value) => formatDiffValue(value);

/** An asset's name by its guid; `none` when unset, and the guid's start when no asset has it. */
function assetLabel(guid: unknown, lookup: ProjectDiffLookup, none = "None"): string {
  if (typeof guid !== "string" || guid === "") return none;
  return lookup.assetName(guid) ?? `Missing Asset (${shortId(guid)})`;
}
const asset = (none?: string): Format => (value, lookup) => assetLabel(value, lookup, none);
const classRef: Format = (value, lookup) => {
  if (typeof value !== "string" || value === "") return "None";
  return lookup.className(value) ?? `Missing Class (${value})`;
};

const SOURCE_CONTROL_MODES = { off: "Off", integrated: "Integrated", manual: "Manual" };
const LOCK_ON_EDIT = { ask: "Ask", always: "Always", never: "Never" };
const RENDER_MODES = { pbr: "PBR", cel: "CEL" };
const UPSCALING = { smooth: "Smooth", pixelated: "Pixelated" };
const AUTO_MANUAL = { auto: "Auto", manual: "Manual" };
const LEVELS = { off: "Off", low: "Low", medium: "Medium", high: "High" };
const SHADOW_FILTERS = { pcf: "PCF", pcss: "Contact Hardening (PCSS)" };
const FIRST_CASCADE = { 1: "Map Size", 2: "Twice Map Size" };
const LIGHT_MIXING = { strongest: "Strongest Light", additive: "Additive", blend: "Blend" };
const COLOR_PIPELINES = { displaySpace: "Display Space", sceneLinear: "Scene Linear" };
const TONE_MAPPING = { none: "None", standard: "Standard", aces: "ACES", neutral: "Neutral" };
const ANTI_ALIASING = { msaa4: "MSAA 4x", msaa2: "MSAA 2x", fxaa: "FXAA", off: "Off" };
const MIRROR_REFLECTIONS = { everything: "Everything", movingActors: "Moving Actors", environment: "Environment" };
const WATER_REFLECTIONS = { sky: "Sky Only", screenSpace: "Screen Space", planar: "Planar" };
const QUALITY_GROUP_LABELS: Record<QualityGroup, string> = {
  shadows: "Shadows",
  lighting: "Lighting",
  resolution: "Resolution",
  textures: "Textures",
  geometry: "Geometry",
  water: "Water",
  postprocessing: "Post Processing",
};

function value(id: string, category: ProjectDiffCategory, label: string, format?: Format, more: Partial<Pick<ProjectSettingRow, "keys" | "read">> = {}): ProjectSettingRow {
  return { kind: "value", id, category, label, ...(format ? { format } : {}), ...more };
}

const rendering = (id: string, label: string, format?: Format) => value(`render.${id}`, "rendering", label, format);

/** A Scalability group's preset as the dialog's `<Group> Quality` shows it: matched against the levels, or Custom. */
function qualityRow(group: QualityGroup): ProjectSettingRow {
  const owner = group === "shadows" ? "render.shadows" : `render.quality.${group}`;
  return value(`quality.${group}`, "rendering", `${QUALITY_GROUP_LABELS[group]} Quality`, capitalized, {
    keys: [`${owner}.preset`, `${owner}.profile`],
    read: (document) => qualityGroupLabel(resolveRenderingQuality(document.settings.render), group),
  });
}

function settingAt(document: ProjectDocument, path: string): unknown {
  let at: unknown = document.settings;
  for (const part of path.split(".")) {
    if (!at || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

const joined = (values: readonly string[]) => (values.length > 0 ? values.join(", ") : "None");

/** A list's entries, by key, in the compare version's order and then the base's own. */
function entryIds<T>(base: readonly T[] | undefined, compare: readonly T[] | undefined, id: (entry: T) => string): string[] {
  return [...new Set([...(compare ?? []).map(id), ...(base ?? []).map(id)])];
}

/** The entries both versions hold, when they hold them in another order: a row with each version's order. */
function orderRow<T>(key: string, label: string, base: readonly T[] | undefined, compare: readonly T[] | undefined, id: (entry: T) => string, name: (entry: T) => string): PropertyDiffRow[] {
  if (!base || !compare) return [];
  const before = base.map(id);
  const after = new Set(compare.map(id));
  const common = before.filter((entry) => after.has(entry));
  const kept = new Set(common);
  const now = compare.map(id).filter((entry) => kept.has(entry));
  if (common.every((entry, index) => entry === now[index])) return [];
  return [{ id: `${key}:order`, label, base: joined(base.map(name)), compare: joined(compare.map(name)), changed: true }];
}

interface ListField<T> {
  id: string;
  label: string;
  read: (entry: T, document: ProjectDocument, lookup: ProjectDiffLookup) => unknown;
  format?: Format;
}

/**
 * A list keyed by `id`: a row per entry and field (`<entry> · <field>`, or
 * `itemLabel` for a single field), added, removed and changed entries
 * alike, then the order row when only the order of shared entries moved.
 */
function keyedList<T>(options: {
  key: string;
  category: ProjectDiffCategory;
  entries: (document: ProjectDocument) => readonly T[];
  id: (entry: T) => string;
  name: (entry: T, lookup: ProjectDiffLookup) => string;
  fields: (base: ProjectDocument | null, compare: ProjectDocument | null, lookup: ProjectDiffLookup) => ReadonlyArray<ListField<T>>;
  /** A single field's label (the entry's name when a function) instead of `<entry> · <field>`. */
  itemLabel?: string | ((name: string) => string);
  orderLabel: string;
}): ProjectSettingList {
  return {
    kind: "list",
    key: options.key,
    category: options.category,
    rows: (base, compare, lookup) => {
      const before = base ? options.entries(base) : undefined;
      const after = compare ? options.entries(compare) : undefined;
      const find = (list: readonly T[] | undefined, id: string) => list?.find((entry) => options.id(entry) === id);
      const fields = options.fields(base, compare, lookup);
      const rows: PropertyDiffRow[] = [];
      for (const id of entryIds(before, after, options.id)) {
        const from = find(before, id);
        const to = find(after, id);
        const name = options.name((to ?? from)!, lookup);
        for (const field of fields) {
          const format = field.format ?? text;
          rows.push(valueRow(
            `${options.key}:${id}:${field.id}`,
            typeof options.itemLabel === "function" ? options.itemLabel(name) : options.itemLabel ?? `${name} · ${field.label}`,
            from === undefined ? undefined : field.read(from, base!, lookup),
            to === undefined ? undefined : field.read(to, compare!, lookup),
            (shown) => format(shown, lookup),
          ));
        }
      }
      const name = (entry: T) => options.name(entry, lookup);
      rows.push(...orderRow(options.key, options.orderLabel, before, after, options.id, name));
      return rows;
    },
  };
}

/** A list of plain names or paths: one row per entry, under `label`. */
function namedList(key: string, category: ProjectDiffCategory, label: string, orderLabel: string, entries: (document: ProjectDocument) => readonly string[], format: Format = text): ProjectSettingList {
  return keyedList<string>({
    key,
    category,
    entries,
    id: (entry) => entry,
    name: (entry, lookup) => format(entry, lookup),
    fields: () => [{ id: "value", label, read: (entry) => entry, format }],
    itemLabel: label,
    orderLabel,
  });
}

/** A layer bit's name in that version's Collision Layers. */
function layerName(layers: readonly string[], bit: number): string {
  const index = Math.log2(bit >>> 0);
  return Number.isInteger(index) ? layers[index] ?? `Layer ${index + 1}` : `Layer Bits ${bit >>> 0}`;
}

/** The named layers a preset blocks or overlaps, as the dialog's Collision Responses table shows them. */
function layersWith(preset: CollisionPreset, layers: readonly string[], response: "block" | "overlap"): string {
  return joined(layers.filter((_, index) => collisionResponseTo(preset, (1 << index) >>> 0) === response));
}

/** Packaging reads the first preset, or the default one while none is stored, as the Export category edits it. */
function exportPresets(document: ProjectDocument): readonly ExportPreset[] {
  return document.settings.exportPresets.length > 0 ? document.settings.exportPresets : [defaultExportPreset()];
}

function pluginName(guid: string, lookup: ProjectDiffLookup): string {
  return lookup.plugin(guid)?.name ?? `Missing Plugin (${shortId(guid)})`;
}

function extensionName(guid: string, lookup: ProjectDiffLookup): string {
  return lookup.extension(guid)?.name ?? `Missing Extension (${shortId(guid)})`;
}

const NO_OVERRIDE = "No Override";

/**
 * Plugin or extension enablement by guid: what the project makes of each one
 * either version overrides, its own default where it sets none (or "Default"
 * when the project no longer has it).
 */
function enablementMap(key: "pluginOverrides" | "extensionOverrides", category: ProjectDiffCategory): ProjectSettingList {
  return {
    kind: "list",
    key,
    category,
    rows: (base, compare, lookup) => {
      const known = (guid: string) => (key === "pluginOverrides" ? lookup.plugin(guid) : lookup.extension(guid));
      const enabled = (document: ProjectDocument | null, guid: string): unknown => {
        if (!document) return undefined;
        const stored = document.settings[key][guid]?.enabled;
        return stored ?? known(guid)?.enabledByDefault ?? "Default";
      };
      const guids = [...new Set([...Object.keys(compare?.settings[key] ?? {}), ...Object.keys(base?.settings[key] ?? {})])];
      return guids.map((guid) => valueRow(
        `${key}:${guid}`,
        key === "pluginOverrides" ? pluginName(guid, lookup) : extensionName(guid, lookup),
        enabled(base, guid),
        enabled(compare, guid),
        (shown) => (typeof shown === "boolean" ? onOff(shown, lookup) : String(shown)),
      ));
    },
  };
}

function formatExtensionField(field: ExtensionField | undefined, shown: unknown): string {
  if (field?.type === "toggle" || typeof shown === "boolean") return shown ? "On" : "Off";
  if (field?.type === "choice") return field.options.find((option) => option.value === shown)?.label ?? formatDiffValue(shown);
  if (typeof shown === "number") return field?.type === "number" && field.unit ? `${formatSettingNumber(shown)} ${field.unit}` : formatSettingNumber(shown);
  return formatDiffValue(shown);
}

const EFFECTS = "render.effects";

/**
 * Every Project Setting the diff shows, in the dialog's order within each
 * category. `HIDDEN_PROJECT_SETTINGS` lists the stored keys it leaves out;
 * together they cover every key of `ProjectSettings` (a test walks the
 * normalised defaults), so a new setting cannot go missing from the diff.
 */
export const PROJECT_SETTING_ROWS: ReadonlyArray<ProjectSettingRow | ProjectSettingList | ProjectSettingGroups> = [
  value("metadata.name", "project", "Project Name", text, { read: (document) => document.metadata.name }),
  value("metadata.appearance.icon", "project", "Icon", (shown, lookup) => lookup.iconName(String(shown)) ?? humanizePropertyLabel(String(shown)),
    { read: (document) => document.metadata.appearance?.icon }),
  value("metadata.appearance.color", "project", "Color", (shown, lookup) => lookup.colorName(String(shown)) ?? humanizePropertyLabel(String(shown)),
    { read: (document) => document.metadata.appearance?.color }),
  value("metadata.appearance.coverFile", "project", "Picture", (shown) => (shown ? String(shown) : "None"),
    { read: (document) => document.metadata.appearance?.coverFile ?? null }),
  value("metadata.appearance.cover", "project", "Use Picture", onOff, { read: (document) => document.metadata.appearance?.cover !== "icon" }),

  value("autoSave", "general", "Auto-Save", onOff),
  value("autoSaveIntervalMs", "general", "Auto-Save Interval (Seconds)", (shown) => formatSettingNumber(Math.round(Number(shown) / 1000))),
  value("compileOnSave", "general", "Compile On Save", onOff),
  value("infiniteLoopDetection", "general", "Infinite Loop Detection", onOff),
  value("loopCount", "general", "Loop Count", number),
  value("garbageCollectionIntervalTicks", "general", "Garbage Collection Interval (Ticks)", number),
  namedList("editorUtilityObjects", "general", "Editor Utility Object", "Editor Utility Object Order", (document) => document.settings.editorUtilityObjects, classRef),

  value("sourceControl.mode", "sourceControl", "Mode", choice(SOURCE_CONTROL_MODES)),
  value("sourceControl.repositoryUrl", "sourceControl", "Repository", (shown) => (shown ? String(shown) : "None")),
  value("sourceControl.branch", "sourceControl", "Branch", text),
  value("sourceControl.lockOnEdit", "sourceControl", "Lock On Edit", choice(LOCK_ON_EDIT)),
  value("sourceControl.releaseLocksAfterPush", "sourceControl", "Release Locks After Push", onOff),

  keyedList<ExportPreset>({
    key: "exportPresets",
    category: "export",
    entries: exportPresets,
    id: (preset) => preset.id,
    name: (preset) => preset.name,
    fields: (base, compare, lookup) => {
      const guids = [...new Set([base, compare].flatMap((document) => (document ? exportPresets(document).flatMap((preset) => Object.keys(preset.pluginOverrides)) : [])))];
      return [
        { id: "name", label: "Name", read: (preset) => preset.name },
        { id: "bundleDebugger", label: "Bundle Debugger", read: (preset) => preset.bundleDebugger, format: onOff },
        { id: "fileCountWarn", label: "File Count Warn", read: (preset) => preset.fileCountWarn, format: number },
        { id: "fileCountFail", label: "File Count Fail", read: (preset) => preset.fileCountFail, format: number },
        ...guids.map((guid): ListField<ExportPreset> => ({
          id: `plugin:${guid}`,
          label: pluginName(guid, lookup),
          read: (preset) => preset.pluginOverrides[guid]?.enabled ?? NO_OVERRIDE,
          format: (shown) => (typeof shown === "boolean" ? (shown ? "On" : "Off") : String(shown)),
        })),
      ];
    },
    orderLabel: "Export Preset Order",
  }),
  value("appIdentity.appId", "export", "App ID", (shown) => (shown ? String(shown) : "None")),
  value("appIdentity.displayName", "export", "Display Name", (shown) => (shown ? String(shown) : "None")),
  value("metadata.version", "export", "Project Version", text, { read: (document) => document.metadata.version }),
  value("appIdentity.iconTextureGuid", "export", "App Icon", asset()),
  value("appIdentity.buildNumber", "export", "Build Number", number),
  value("appIdentity.autoIncrementBuildNumber", "export", "Auto Increment Build Number", onOff),
  namedList("alwaysPackageFolders", "export", "Always Package Folder", "Always Package Folder Order", (document) => document.settings.alwaysPackageFolders),

  value("startupSceneGuid", "game", "Startup Scene", asset()),
  value("gameInstanceClass", "game", "Game Instance", classRef),
  value("twoD.pixelsPerUnit", "game", "Pixels Per Unit", number),
  value("twoD.pixelPerfect", "game", "Pixel-Perfect Mode", onOff),
  value("twoD.nearestTextures", "game", "Nearest Texture Filtering", onOff),
  namedList("twoD.sortingLayers", "game", "Sorting Layer", "Sorting Layer Order", (document) => document.settings.twoD.sortingLayers),
  value("touchMinTargetPx", "game", "Touch Target Size", withUnit("px")),

  keyedList<{ id: number; path: string }>({
    key: "tags.tags",
    category: "tags",
    entries: (document) => document.settings.tags.tags,
    id: (tag) => tag.path,
    name: (tag) => tag.path,
    fields: () => [{ id: "id", label: "ID", read: (tag) => tag.id, format: (shown) => `ID ${String(shown)}` }],
    itemLabel: (path) => path,
    orderLabel: "Tag Order",
  }),

  value("saveGame.definitionGuid", "saveGames", "Default Definition", asset()),
  value("saveGame.defaultSlot", "saveGames", "Default Slot", text),
  value("saveGame.defaultProfile", "saveGames", "Default Profile", text),
  value("saveGame.wipeOnPlay", "saveGames", "Wipe Preview Saves On Play", onOff),

  {
    // Bit order: a layer's position is the bit colliders store, so rows follow positions.
    kind: "list",
    key: "physics.collisionLayers",
    category: "physics",
    rows: (base, compare) => {
      const before = base?.settings.physics.collisionLayers;
      const after = compare?.settings.physics.collisionLayers;
      const count = Math.max(before?.length ?? 0, after?.length ?? 0);
      return Array.from({ length: count }, (_, index) => valueRow(
        `physics.collisionLayers:${index}`,
        `Collision Layer ${index + 1}`,
        before?.[index],
        after?.[index],
        String,
      ));
    },
  },
  keyedList<CollisionPreset>({
    key: "physics.collisionPresets",
    category: "physics",
    entries: (document) => document.settings.physics.collisionPresets,
    id: (preset) => preset.id,
    name: (preset) => preset.name,
    fields: () => [
      { id: "name", label: "Name", read: (preset) => preset.name },
      { id: "layer", label: "Layer", read: (preset, document) => layerName(document.settings.physics.collisionLayers, preset.layer) },
      { id: "blocks", label: "Blocks", read: (preset, document) => layersWith(preset, document.settings.physics.collisionLayers, "block") },
      { id: "overlaps", label: "Overlaps", read: (preset, document) => layersWith(preset, document.settings.physics.collisionLayers, "overlap") },
    ],
    orderLabel: "Collision Preset Order",
  }),

  value("focusNavigation.enabled", "focusNavigation", "Focus Navigation", onOff),
  value("focusNavigation.navigationInputGuid", "focusNavigation", "Navigation Input", asset("Built-In Controls")),
  value("focusNavigation.activateInputGuid", "focusNavigation", "Activate Input", asset("Built-In Controls")),
  value("focusNavigation.repeatDelay", "focusNavigation", "Repeat Delay", withUnit("s")),
  value("focusNavigation.repeatInterval", "focusNavigation", "Repeat Interval", withUnit("s")),
  value("focusNavigation.wrap", "focusNavigation", "Wrap Navigation", onOff),

  // Pipeline
  rendering("mode", "Render Mode", choice(RENDER_MODES)),
  rendering("largeWorldRendering", "Large World Rendering", onOff),
  // Scalability
  ...QUALITY_GROUPS.map(qualityRow),
  rendering("quality.resolution.scale", "Resolution Scale", number),
  rendering("quality.textures.lodBias", "Texture LOD Bias", number),
  rendering("quality.textures.anisotropy", "Texture Anisotropy", number),
  rendering("quality.textures.byteBudget", "Texture Budget (MiB)", (shown) => formatSettingNumber(Number(shown) / 1024 ** 2)),
  rendering("quality.geometry.autoLod", "Auto LOD", onOff),
  rendering("quality.geometry.lodDistanceScale", "LOD Distance Scale", number),
  rendering("quality.geometry.occlusionCulling", "Occlusion Culling", onOff),
  rendering("quality.geometry.mirrorReflections", "Mirror Reflections", choice(MIRROR_REFLECTIONS)),
  rendering("quality.water.shadingDetail", "Water Shading Detail", capitalized),
  rendering("quality.water.meshDensity", "Water Mesh Density", number),
  rendering("quality.water.contactResolution", "Contact Resolution", number),
  rendering("quality.water.refraction", "Water Refraction", onOff),
  rendering("quality.water.refractionScale", "Refraction Resolution", number),
  rendering("quality.water.reflections", "Water Reflections", choice(WATER_REFLECTIONS)),
  rendering("quality.water.reflectionSteps", "Reflection Steps", number),
  rendering("quality.water.planarScale", "Planar Resolution", number),
  rendering("quality.water.fftSize", "FFT Size", number),
  rendering("quality.water.fftCascades", "FFT Cascades", number),
  rendering("quality.postprocessing.resolutionScale", "Post Processing Resolution Scale", number),
  rendering("quality.postprocessing.antiAliasing", "Anti-Aliasing", choice(ANTI_ALIASING)),
  rendering("quality.postprocessing.ambientOcclusion", "Allow Ambient Occlusion", onOff),
  rendering("quality.postprocessing.reflections", "Allow Reflections", onOff),
  rendering("quality.postprocessing.volumetricLighting", "Allow Volumetric Lighting", onOff),
  rendering("quality.lighting.localLightMode", "Local Light Budget Mode", choice(AUTO_MANUAL)),
  rendering("quality.lighting.maxLocalLights", "Local Light Budget", number),
  // Shadows
  rendering("shadows.enabled", "Shadows Enabled", onOff),
  rendering("shadows.distance", "Shadow Distance", number),
  rendering("shadows.fadeFraction", "Shadow Distance Fade", number),
  rendering("shadows.mapSize", "Directional Map Size", number),
  rendering("shadows.firstCascadeScale", "First Cascade Detail", choice(FIRST_CASCADE)),
  rendering("shadows.cascades", "Shadow Cascades", number),
  rendering("shadows.filter", "Shadow Filter", choice(SHADOW_FILTERS)),
  rendering("shadows.filterQuality", "Shadow Filter Quality", choice(LEVELS)),
  rendering("shadows.softness", "Contact Hardening Size", number),
  rendering("shadows.screenShadows", "Screen-Space Shadows", choice(LEVELS)),
  rendering("shadows.reflections", "Reflection Shadows", onOff),
  rendering("shadows.depthBias", "Shadow Depth Bias", number),
  rendering("shadows.autoBias", "Automatic Shadow Bias", onOff),
  rendering("shadows.normalBias", "Shadow Normal Bias", number),
  rendering("shadows.localLightMode", "Local Shadow Budget Mode", choice(AUTO_MANUAL)),
  rendering("shadows.maxLocalLights", "Local Shadow Light Budget", number),
  rendering("shadows.localMapSize", "Local Shadow Map Size", number),
  // Environment Lighting
  rendering("environmentLighting.enabled", "Image-Based Lighting", onOff),
  rendering("environmentLighting.intensity", "Environment Intensity", number),
  rendering("environmentLighting.rotationYDegrees", "Environment Rotation", withUnit("°")),
  rendering("environmentLighting.celStrength", "CEL Environment Strength", number),
  // Post Processing
  value(`${EFFECTS}.ambientOcclusion.enabled`, "rendering", "Ambient Occlusion", onOff),
  value(`${EFFECTS}.ambientOcclusion.radius`, "rendering", "Occlusion Radius", number),
  value(`${EFFECTS}.ambientOcclusion.strength`, "rendering", "Occlusion Strength", number),
  value(`${EFFECTS}.ambientOcclusion.maxDistance`, "rendering", "Occlusion Distance", number),
  value(`${EFFECTS}.ambientOcclusion.resolutionScale`, "rendering", "Occlusion Resolution Scale", number),
  value(`${EFFECTS}.ambientOcclusion.samples`, "rendering", "Occlusion Samples", number),
  value(`${EFFECTS}.reflections.enabled`, "rendering", "Real-Time Reflections", onOff),
  value(`${EFFECTS}.reflections.resolutionScale`, "rendering", "Reflection Resolution Scale", number),
  value(`${EFFECTS}.reflections.maxSteps`, "rendering", "Reflection Steps", number),
  value(`${EFFECTS}.reflections.maxDistance`, "rendering", "Reflection Distance", number),
  value(`${EFFECTS}.reflections.thickness`, "rendering", "Reflection Thickness", number),
  value(`${EFFECTS}.reflections.strength`, "rendering", "Reflection Strength", number),
  value(`${EFFECTS}.volumetricLighting.enabled`, "rendering", "Scene-Wide Fog", onOff),
  value(`${EFFECTS}.volumetricLighting.density`, "rendering", "Scene-Wide Fog Density", number),
  value(`${EFFECTS}.volumetricLighting.height`, "rendering", "Fog Height", number),
  value(`${EFFECTS}.volumetricLighting.heightFalloff`, "rendering", "Fog Height Falloff", number),
  value(`${EFFECTS}.volumetricLighting.intensity`, "rendering", "Volumetric Intensity", number),
  value(`${EFFECTS}.volumetricLighting.maxDistance`, "rendering", "Volumetric Distance", number),
  value(`${EFFECTS}.volumetricLighting.anisotropy`, "rendering", "Scattering Anisotropy", number),
  value(`${EFFECTS}.volumetricLighting.resolutionScale`, "rendering", "Volumetric Resolution Scale", number),
  value(`${EFFECTS}.volumetricLighting.steps`, "rendering", "Volumetric Steps", number),
  value(`${EFFECTS}.volumetricLighting.maxLights`, "rendering", "Volumetric Light Limit", number),
  value(`${EFFECTS}.colorPipeline.mode`, "rendering", "Color Pipeline", choice(COLOR_PIPELINES)),
  value(`${EFFECTS}.toneMapping`, "rendering", "Tone Mapping", choice(TONE_MAPPING)),
  value(`${EFFECTS}.exposure`, "rendering", "Exposure", number),
  value(`${EFFECTS}.contrast`, "rendering", "Contrast", number),
  value(`${EFFECTS}.whiteBalance.enabled`, "rendering", "White Balance", onOff),
  value(`${EFFECTS}.whiteBalance.temperature`, "rendering", "Temperature (K)", number),
  value(`${EFFECTS}.whiteBalance.tint`, "rendering", "Tint", number),
  value(`${EFFECTS}.bloom.enabled`, "rendering", "Bloom", onOff),
  value(`${EFFECTS}.bloom.threshold`, "rendering", "Bloom Threshold", number),
  value(`${EFFECTS}.bloom.weight`, "rendering", "Bloom Weight", number),
  value(`${EFFECTS}.bloom.kernel`, "rendering", "Bloom Kernel", number),
  value(`${EFFECTS}.bloom.scale`, "rendering", "Bloom Scale", number),
  value(`${EFFECTS}.vignette.enabled`, "rendering", "Vignette", onOff),
  value(`${EFFECTS}.vignette.weight`, "rendering", "Vignette Weight", number),
  value(`${EFFECTS}.vignette.color`, "rendering", "Vignette Color"),
  value(`${EFFECTS}.colorGrading.enabled`, "rendering", "Color Grading", onOff),
  value(`${EFFECTS}.colorGrading.lutTextureGuid`, "rendering", "LUT Texture", asset()),
  value(`${EFFECTS}.upscaling.enabled`, "rendering", "FSR Upscaling", onOff),
  value(`${EFFECTS}.upscaling.renderScale`, "rendering", "Render Scale", number),
  value(`${EFFECTS}.upscaling.sharpness`, "rendering", "Sharpness", number),
  // Scene Layer Post-Processing
  keyedList<SceneLayerPostProcessEntry>({
    key: "sceneLayerPostProcessStack",
    category: "rendering",
    entries: (document) => document.settings.sceneLayerPostProcessStack,
    id: (pass) => pass.id,
    name: (pass, lookup) => assetLabel(pass.materialGuid, lookup),
    fields: () => [
      { id: "material", label: "Material", read: (pass) => pass.materialGuid, format: asset() },
      { id: "enabled", label: "Enabled", read: (pass) => pass.enabled, format: onOff },
      { id: "parameters", label: "Parameters", read: (pass) => pass.parameters ?? {} },
    ],
    orderLabel: "Post-Process Pass Order",
  }),
  // CEL Shading
  rendering("cel.outlinesEnabled", "Outlines", onOff),
  rendering("cel.outlineColor", "Outline Color"),
  rendering("cel.outlineWidth", "Outline Width", number),
  rendering("cel.outlineDistanceFadeEnabled", "Outline Distance Fade", onOff),
  rendering("cel.outlineFadeStart", "Outline Fade Start", number),
  rendering("cel.outlineFadeEnd", "Outline Fade End", number),
  rendering("cel.lightMixing", "Light Mixing", choice(LIGHT_MIXING)),
  rendering("cel.shadowBands", "Shadow Bands", number),
  rendering("cel.shadowThreshold", "Shadow Threshold", number),
  rendering("cel.shadowStrength", "Shadow Strength", number),
  rendering("cel.specularEnabled", "Specular", onOff),
  rendering("cel.specularStrength", "Specular Strength", number),
  rendering("cel.specularSize", "Specular Size", number),
  rendering("cel.lightColorInfluence", "Light Color Influence", number),
  // Resolution
  rendering("customResolution", "Custom Resolution", onOff),
  value("render.size", "rendering", "Render Size", text, {
    keys: ["render.width", "render.height"],
    read: (document) => `${formatSettingNumber(document.settings.render.width)} × ${formatSettingNumber(document.settings.render.height)}`,
  }),
  rendering("blackBars", "Black Bars", onOff),
  rendering("upscaling", "Upscaling", choice(UPSCALING)),
  // Water
  rendering("water.blendDistance", "Water Blend Distance", number),
  // Play Preview
  value("playFrameCap", "rendering", "Play Frame Cap", number),
  value("playPreview.followSystem", "rendering", "Follow System", onOff),
  value("playPreview.aspect", "rendering", "Aspect Ratio", text, {
    keys: ["playPreview.aspectWidth", "playPreview.aspectHeight"],
    read: (document) => `${formatSettingNumber(document.settings.playPreview.aspectWidth)}:${formatSettingNumber(document.settings.playPreview.aspectHeight)}`,
  }),

  value("textures.maxTextureDimension", "textures", "Max Texture Dimension", number),
  value("textures.autoRequeueUncompressed", "textures", "Auto Requeue Uncompressed", onOff),

  value("fonts.defaultFontGuid", "fonts", "Default Font", asset()),
  value("fonts.globalFallback", "fonts", "Global Fallback", text),

  value("audio.audioMixerGuid", "audio", "Audio Mixer", asset()),
  value("audio.occlusionEnabled", "audio", "Occlusion", onOff),
  value("audio.reverbWetScale", "audio", "Reverb Wet Scale", number),
  value("audio.reverbDecayScale", "audio", "Reverb Decay Scale", number),
  value("audio.reverbDampingScale", "audio", "Reverb Damping Scale", number),

  enablementMap("pluginOverrides", "plugins"),
  enablementMap("extensionOverrides", "extensions"),
  { kind: "groups", key: "extensionSettings", after: "extensions", groups: (base, compare, lookup) => extensionSettingsGroups(base, compare, lookup) },
];

/**
 * Stored keys the diff leaves out, with why: bookkeeping no one edits.
 * `metadata.createdAt` and `updatedAt`, the file's `guid`, `kind` and
 * format `version`, and the `scenes` and `graphs` lists sit outside
 * `settings` and are never read.
 */
export const HIDDEN_PROJECT_SETTINGS: Readonly<Record<string, string>> = {
  "tags.nextId": "The next free Tag id, advanced as Tags are added.",
};

/** Each extension's settings either version stores, as its Project Settings category shows them (absent fields at their defaults). */
function extensionSettingsGroups(base: ProjectDocument | null, compare: ProjectDocument | null, lookup: ProjectDiffLookup): PropertyDiffGroup[] {
  const guids = [...new Set([...Object.keys(compare?.settings.extensionSettings ?? {}), ...Object.keys(base?.settings.extensionSettings ?? {})])];
  return guids.map((guid) => {
    const extension = lookup.extension(guid);
    const fields = extension?.settings?.sections.flatMap((section) => section.fields) ?? [];
    const stored = (document: ProjectDocument | null) => document?.settings.extensionSettings[guid];
    const keys = [...new Set([
      ...fields.map((field) => field.id),
      ...Object.keys(stored(compare) ?? {}),
      ...Object.keys(stored(base) ?? {}),
    ])];
    const rows = keys.map((key) => {
      const field = fields.find((entry) => entry.id === key);
      const read = (document: ProjectDocument | null): unknown => {
        if (!document) return undefined;
        const values = stored(document) ?? {};
        return field ? resolveExtensionFieldValue(field, values[key]) : values[key];
      };
      return valueRow(`extensionSettings:${guid}:${key}`, field?.label ?? humanizePropertyLabel(key), read(base), read(compare), (shown) => formatExtensionField(field, shown));
    });
    return {
      id: `extension:${guid}`,
      title: extension?.settings?.title ?? extensionName(guid, lookup),
      status: groupStatus(rows),
      rows,
    };
  });
}

/** One version's row: its read value, absent when the version has no `project.json`. */
function readRow(row: ProjectSettingRow, document: ProjectDocument | null): unknown {
  if (!document) return undefined;
  return row.read ? row.read(document) : settingAt(document, row.id);
}

function appearanceOf(document: ProjectDocument | null, lookup: ProjectDiffLookup): ProjectDocument | null {
  if (!document || document.metadata.appearance) return document;
  // A project without an appearance shows the default one.
  return { ...document, metadata: { ...document.metadata, appearance: { ...lookup.defaultAppearance } } };
}

/**
 * Two versions of `project.json` as the editor reads them (`readProjectManifest`:
 * an absent setting is its default), grouped by the Project Settings
 * dialog's categories: a row per setting, per list entry and per map key,
 * with assets, classes, plugins and extensions by name. A null version has
 * no `project.json`: the diff is then added or removed.
 */
export function diffProjectSettings(base: ProjectDocument | null, compare: ProjectDocument | null, lookup: ProjectDiffLookup): AssetDiff {
  const before = appearanceOf(base, lookup);
  const after = appearanceOf(compare, lookup);
  const byCategory = new Map<string, PropertyDiffRow[]>();
  const extra = new Map<string, PropertyDiffGroup[]>();
  for (const spec of PROJECT_SETTING_ROWS) {
    if (spec.kind === "groups") {
      extra.set(spec.after, [...(extra.get(spec.after) ?? []), ...spec.groups(before, after, lookup)]);
      continue;
    }
    const rows = byCategory.get(spec.category) ?? [];
    byCategory.set(spec.category, rows);
    if (spec.kind === "list") {
      rows.push(...spec.rows(before, after, lookup));
      continue;
    }
    const format = spec.format ?? ((shown: unknown) => (typeof shown === "number" ? formatSettingNumber(shown) : formatDiffValue(shown, spec.id)));
    rows.push(valueRow(spec.id, spec.label, readRow(spec, before), readRow(spec, after), (shown) => format(shown, lookup)));
  }
  const groups: PropertyDiffGroup[] = [];
  for (const [id, title] of PROJECT_DIFF_CATEGORIES) {
    const rows = byCategory.get(id) ?? [];
    if (rows.length > 0) groups.push({ id, title, status: groupStatus(rows), rows });
    groups.push(...(extra.get(id) ?? []));
  }
  const status: DiffStatus = !base && !compare ? "unchanged" : !base ? "added" : !compare ? "removed"
    : groups.some((group) => group.status !== "unchanged") ? "changed" : "unchanged";
  return { path: PROJECT_FILE, status, type: "Project", name: "Project Settings", header: [], chunks: [], view: { kind: "properties", groups } };
}

/** One version of `project.json`: its bytes (null when the version has none) and the name the diff gives the version. */
export interface ProjectVersion {
  bytes: Uint8Array | null;
  label: string;
}

/** A version as the editor would open it; throws, naming the version, when it cannot be read. */
export function readProjectVersion(version: ProjectVersion): ProjectDocument | null {
  if (!version.bytes) return null;
  try {
    return readProjectManifest(new TextDecoder().decode(version.bytes)).document;
  } catch (error) {
    throw new Error(`The Project Settings in ${version.label} cannot be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Both versions of `project.json`, read as the editor reads them, then compared (`diffProjectSettings`). */
export function diffProjectVersions(base: ProjectVersion, compare: ProjectVersion, lookup: ProjectDiffLookup): AssetDiff {
  return diffProjectSettings(readProjectVersion(base), readProjectVersion(compare), lookup);
}
