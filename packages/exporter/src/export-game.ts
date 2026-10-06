import { err, ok, DEFAULT_LOOP_COUNT, DEFAULT_SORTING_LAYERS, normalizePlayFrameCap, normalizeRenderProjectSettings, normalizeFocusNavigationSettings, renderEffectsAssetGuids, consoleCommandMetadataFromGraph, type Result } from "@babylonslate/core";
import { collectAssetDependencyMetadata, extractPackedModelAsset, peekPackedAudioPayload, sha256Hex, PARTICLE_ASSET_TYPES, type AssetDependencyClass } from "@babylonslate/assets";
import { zipSync, unzipSync } from "fflate";
import {
  DEFAULT_FILE_COUNT_FAIL,
  DEFAULT_FILE_COUNT_WARN,
  GAME_MANIFEST_FILE,
  SCRIPTS_FILE,
} from "./constants";
import { serializeScriptRegistry } from "./scripts";
import { selectPlayerRuntimeFiles } from "./player-files";
import type {
  ExportArtifact,
  ExportAssetBytes,
  ExportGameOptions,
  GameAssetIndexEntry,
  GameManifest,
} from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizeSortingLayers(value: unknown): string[] {
  const layers = Array.isArray(value) ? value.filter((layer): layer is string => typeof layer === "string" && layer.trim().length > 0) : [];
  return layers.length > 0 ? [...new Set(layers)] : [...DEFAULT_SORTING_LAYERS];
}

function clampAudioScale(value: unknown, fallback = 1): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  if (n < 0) return 0;
  if (n > 2) return 2;
  return n;
}

const JSON_TYPES = new Set<string>([
  "InputAction", "InputAxis",
  "Scene",
  "Class",
  "Graph",
  "AnimationGraph",
  "BehaviourTree",
  "Blackboard",
  "Material",
  "MaterialFunction",
  "MaterialInstance",
  "RenderTarget",
  "RenderTargetTexture",
  "Sprite",
  "SpriteAnimation",
  "Tilemap",
  "Tileset",
  // Basic emitters, Particle Graphs and Particle Systems.
  ...PARTICLE_ASSET_TYPES,
  "Animation",
  "SceneLayer", "AudioMixer", "AudioChannel", "SoundAttenuation", "Water",
  "DataDefinition", "DataTree", "Structure", "Enum", "SaveGame",
]);

function countWarning(count: number, warn: number): string {
  return `Export file count ${count} exceeds the warning threshold of ${warn}.`;
}

function countError(count: number, fail: number): string {
  return `Export file count ${count} exceeds the limit of ${fail}.`;
}

function encodingFor(asset: ExportAssetBytes): "json" | "bytes" {
  return asset.encoding ?? (JSON_TYPES.has(asset.type) ? "json" : "bytes");
}

function indexEntry(
  asset: ExportAssetBytes,
  extra: { pack?: string; path?: string },
): GameAssetIndexEntry {
  return {
    guid: asset.guid,
    type: asset.type,
    encoding: encodingFor(asset),
    ...(asset.classId ? { classId: asset.classId } : {}),
    ...(asset.ownerGuid ? { ownerGuid: asset.ownerGuid } : {}),
    ...(asset.parentClass ? { parentClass: asset.parentClass } : {}),
    ...(asset.name ? { name: asset.name } : {}),
    ...(asset.consoleCommand ? { consoleCommand: asset.consoleCommand } : {}),
    ...(typeof asset.width === "number" &&
    asset.width > 0 &&
    typeof asset.height === "number" &&
    asset.height > 0
      ? { width: asset.width, height: asset.height }
      : {}),
    ...extra,
  };
}

export function defaultPlayerIndexHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Game</title>
  <script src="./coi-serviceworker.js"></script>
  <style>
    html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
    #player-root { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
    canvas { display: block; }
    #player-hud { position: fixed; top: 8px; left: 8px; color: #fff; font: 12px/1.4 ui-monospace, monospace; pointer-events: none; }
  </style>
</head>
<body>
  <div id="player-root" data-testid="player-root">
    <canvas id="game" data-testid="player-canvas"></canvas>
    <div id="player-hud" data-testid="player-hud" hidden></div>
  </div>
  <script type="module" src="./player.js"></script>
</body>
</html>
`;
}

function inlineCssIntoIndex(files: Map<string, Uint8Array>): void {
  const htmlBytes = files.get("index.html");
  if (!htmlBytes) return;
  let html = decoder.decode(htmlBytes);
  for (const [path, bytes] of [...files.entries()]) {
    if (!path.endsWith(".css")) continue;
    const fileName = path.split("/").pop() ?? path;
    const css = decoder.decode(bytes);
    html = html.replace(
      new RegExp(
        `<link[^>]*href=["'](?:\\./)?${fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
        "i",
      ),
      `<style>${css}</style>`,
    );
    files.delete(path);
  }
  files.set("index.html", encoder.encode(html));
}

async function writeLooseAssets(
  files: Map<string, Uint8Array>,
  assets: readonly ExportAssetBytes[],
): Promise<{ packs: string[]; index: GameAssetIndexEntry[] }> {
  const index: GameAssetIndexEntry[] = [];
  for (const [indexInExport, asset] of assets.entries()) {
    // Asset IDs include namespaced sidecars (for example area-emission:guid).
    // Keep IDs in the manifest and use portable, collision-free file names.
    const path = `assets/data-${indexInExport}.bin`;
    files.set(path, asset.bytes);
    index.push({ ...indexEntry(asset, { path }), byteLength: asset.bytes.byteLength, revision: await sha256Hex(asset.bytes),
      dependencies: [...(asset.dependencies ?? [])], requiredDependencies: [...(asset.requiredDependencies ?? [])],
      ...(asset.startupRequired ? { startupRequired: true } : {}),
    });
  }
  return { packs: [], index };
}

function dependencyCatalog(assets: readonly ExportAssetBytes[]): ExportAssetBytes[] {
  const byId = new Map(assets.map(asset => [asset.guid, asset]));
  const byName = new Map(assets.filter(asset => asset.name).map(asset => [asset.name!, asset.guid]));
  const documents = new Map<string, Record<string, unknown>>();
  const document = (asset: ExportAssetBytes) => {
    if (documents.has(asset.guid)) return documents.get(asset.guid);
    if (encodingFor(asset) !== "json") return undefined;
    try {
      const value: unknown = JSON.parse(decoder.decode(asset.bytes));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        documents.set(asset.guid, value as Record<string, unknown>);
        return value as Record<string, unknown>;
      }
    } catch { /* The player reports corrupt requested payloads. */ }
    return undefined;
  };
  const classes: AssetDependencyClass[] = assets.filter(asset => asset.type === "Class" || asset.type === "Graph").map(asset => {
    const payload = document(asset);
    return { guid: asset.guid, classId: asset.classId ?? asset.name ?? asset.guid, parentClassId: asset.parentClass,
      members: Array.isArray(payload?.members) ? payload.members as AssetDependencyClass["members"] : undefined,
      requiredVariableNames: asset.requiredVariableNames };
  });
  const definitionFields = (guid: string): readonly unknown[] | undefined => {
    const asset = byId.get(guid);
    const fields = asset && ["DataDefinition", "Structure"].includes(asset.type) ? document(asset)?.fields : undefined;
    return Array.isArray(fields) ? fields : undefined;
  };
  for (const definition of classes) {
    const payload = document(byId.get(definition.guid)!);
    if (!definition.requiredVariableNames && payload) definition.requiredVariableNames = collectAssetDependencyMetadata("Class", payload, {
      classes, parentClass: definition.parentClassId, definitionFields,
    }).requiredVariableNames;
  }
  const sidecars = new Map<string, string[]>();
  for (const asset of assets) {
    const separator = asset.guid.indexOf(":");
    if (separator < 0) continue;
    const owner = asset.ownerGuid ?? asset.guid.slice(separator + 1);
    if (!byId.has(owner)) continue;
    const list = sidecars.get(owner) ?? [];
    list.push(asset.guid);
    sidecars.set(owner, list);
  }
  return assets.map(asset => {
    let required = asset.requiredDependencies;
    let dependencies = asset.dependencies;
    let classReferences = asset.classReferences;
    let requiredClassReferences = asset.requiredClassReferences;
    if (!required) {
      let payload: unknown;
      if (asset.type === "Model") payload = extractPackedModelAsset(asset.bytes).payload;
      else if (asset.type === "Audio") payload = peekPackedAudioPayload(asset.bytes);
      else payload = document(asset);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const metadata = collectAssetDependencyMetadata(asset.type, payload as Record<string, unknown>, {
          dependencies, classes, definitionFields, parentClass: asset.parentClass,
        });
        required = metadata.requiredDependencies;
        dependencies = metadata.dependencies;
        classReferences = metadata.classReferences;
        requiredClassReferences = metadata.requiredClassReferences;
      }
    }
    const resolve = (refs: readonly string[]) => [...new Set(refs.map(ref => byId.has(ref) ? ref : byName.get(ref) ?? ref))];
    const resolveClasses = (refs: readonly string[] = []) => refs.flatMap(ref => {
      const match = classes.find(entry => entry.guid === ref || entry.classId === ref || `scene:${entry.guid}` === ref);
      return match ? [match.guid] : [];
    });
    const consoleCommand = asset.consoleCommand ?? (["Class", "Graph"].includes(asset.type) ? consoleCommandMetadataFromGraph(document(asset)) : undefined);
    return { ...asset, consoleCommand, dependencies: resolve([...(dependencies ?? []), ...resolveClasses(classReferences), ...(sidecars.get(asset.guid) ?? [])]),
      requiredDependencies: resolve([...(required ?? []), ...resolveClasses(requiredClassReferences), ...(asset.type === "Font" ? [] : sidecars.get(asset.guid) ?? [])]) };
  });
}

export async function exportGame(
  options: ExportGameOptions,
): Promise<Result<ExportArtifact, string>> {
  const mode = options.mode ?? "packed";
  const warnAt = options.fileCountWarn ?? DEFAULT_FILE_COUNT_WARN;
  const failAt = options.fileCountFail ?? DEFAULT_FILE_COUNT_FAIL;
  const files = new Map<string, Uint8Array>();

  if (options.playerFiles) {
    const physicsWorld = options.physicsWorld ?? "3d";
    for (const [path, bytes] of selectPlayerRuntimeFiles(options.playerFiles, {
      physicsWorld,
      hasSceneLayers: options.assets.some((asset) => asset.type === "SceneLayer"),
    })) {
      files.set(path, bytes);
    }
  }
  if (!files.has("index.html")) {
    files.set("index.html", encoder.encode(defaultPlayerIndexHtml()));
  }
  if (options.extraFiles) {
    for (const [path, bytes] of options.extraFiles) {
      files.set(path.replace(/^\/+/, ""), bytes);
    }
  }

  // Keep the historical bootstrap filename without eagerly shipping every
  // compiled Class source inside it. Class code has the same scoped ownership
  // and independently addressed source contract as other required sidecars.
  files.set(SCRIPTS_FILE, encoder.encode(serializeScriptRegistry([])));
  const scriptByAsset = new Map(options.scripts.map(script => [script.assetGuid, script]));
  const sourceAssets: ExportAssetBytes[] = options.assets.map(asset => {
    const script = scriptByAsset.get(asset.guid);
    return script && ["Class", "Graph"].includes(asset.type) ? { ...asset, classId: script.classId, parentClass: script.parentClassId ?? asset.parentClass,
      consoleCommand: script.command ?? asset.consoleCommand } : asset;
  });
  for (const script of options.scripts) {
    let owner = sourceAssets.find(asset => asset.guid === script.assetGuid);
    if (!owner) {
      owner = { guid: script.assetGuid, type: "Class", classId: script.classId, name: script.classId,
        parentClass: script.parentClassId, consoleCommand: script.command, sceneGuid: options.startupSceneGuid,
        bytes: encoder.encode(JSON.stringify({ components: script.components ?? [] })), encoding: "json" };
      sourceAssets.push(owner);
    }
    sourceAssets.push({ guid: `script:${script.assetGuid}:${encodeURIComponent(script.classId)}`, ownerGuid: script.assetGuid, type: "CompiledScript", classId: script.classId,
      sceneGuid: owner.sceneGuid, encoding: "json", bytes: encoder.encode(JSON.stringify(script)), requiredDependencies: [] });
  }

  const projectAssetGuids = new Set(renderEffectsAssetGuids(options.renderSettings?.effects));
  const prepared = dependencyCatalog(sourceAssets).map(asset => ({ ...asset,
    startupRequired: asset.startupRequired || projectAssetGuids.has(asset.guid) || asset.guid === options.audioMixerGuid ||
      asset.guid === options.gameInstanceClass || (!!options.gameInstanceClass && asset.name === options.gameInstanceClass) || asset.type === "InputAction" || asset.type === "InputAxis",
  }));
  // Packaging choice never changes runtime addressability. A ZIP is only the
  // delivery container; static hosts serve independent immutable asset files.
  const packed = await writeLooseAssets(files, prepared);

  inlineCssIntoIndex(files);

  const manifest: GameManifest = {
    assetCatalogVersion: 1,
    ...(options.saveGame ? { saveGame: structuredClone(options.saveGame) } : {}),
    project: { name: options.project?.name ?? "", version: options.project?.version ?? "" },
    ...(options.inputAssets !== undefined ? { inputAssets: structuredClone(options.inputAssets) } : {}),
    ...(options.inputMappings !== undefined ? { inputMappings: structuredClone(options.inputMappings) } : {}),
    focusNavigation: normalizeFocusNavigationSettings(options.focusNavigation),
    startupSceneGuid: options.startupSceneGuid,
    ...(options.defaultFontGuid ? { defaultFontGuid: options.defaultFontGuid } : {}),
    ...(options.gameInstanceClass?.trim()
      ? { gameInstanceClass: options.gameInstanceClass.trim() }
      : {}),
    ...(options.audioMixerGuid?.trim()
      ? { audioMixerGuid: options.audioMixerGuid.trim() }
      : {}),
    occlusionEnabled: options.occlusionEnabled !== false,
    reverbWetScale: clampAudioScale(options.reverbWetScale, 1),
    reverbDecayScale: clampAudioScale(options.reverbDecayScale, 1),
    reverbDampingScale: clampAudioScale(options.reverbDampingScale, 1),
    bundleDebugger: options.bundleDebugger,
    mode,
    render: normalizeRenderProjectSettings(options.renderSettings),
    playFrameCap: normalizePlayFrameCap(options.playFrameCap),
    touchMinTargetPx:
      typeof options.touchMinTargetPx === "number" &&
      options.touchMinTargetPx > 0
        ? options.touchMinTargetPx
        : 44,
    pixelsPerUnit:
      typeof options.pixelsPerUnit === "number" && options.pixelsPerUnit > 0
        ? options.pixelsPerUnit
        : 100,
    pixelPerfect: options.pixelPerfect === true,
    sortingLayers: normalizeSortingLayers(options.sortingLayers),
    packs: packed.packs,
    scriptsFile: SCRIPTS_FILE,
    physicsWorld: options.physicsWorld ?? "3d",
    assets: packed.index,
    ...(options.bundleDebugger
      ? {
          infiniteLoopDetection: options.infiniteLoopDetection !== false,
          loopCount:
            typeof options.loopCount === "number" &&
            Number.isFinite(options.loopCount) &&
            options.loopCount >= 1
              ? Math.round(options.loopCount)
              : DEFAULT_LOOP_COUNT,
        }
      : {}),
  };
  files.set(GAME_MANIFEST_FILE, encoder.encode(`${JSON.stringify(manifest)}\n`));

  const fileCount = files.size;
  if (fileCount > failAt) {
    return err(countError(fileCount, failAt));
  }
  const warnings: string[] = [];
  if (fileCount > warnAt) {
    warnings.push(countWarning(fileCount, warnAt));
  }

  return ok({ files, fileCount, warnings, manifest });
}

/**
 * fflate encodes DOS dates with local getFullYear/getMonth/…. UTC midnight
 * 1980-01-01 is still 1979 in US timezones and throws "date not in range
 * 1980-2099". Local noon stays in range everywhere.
 */
export const SAFE_ZIP_MTIME = new Date(1980, 0, 1, 12, 0, 0);

export function zipExport(artifact: ExportArtifact): Uint8Array {
  const record: Record<string, Uint8Array> = {};
  for (const [path, data] of [...artifact.files.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    record[path] = data;
  }
  return zipSync(record, { level: 6, mtime: SAFE_ZIP_MTIME });
}

export function unzipExport(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

export function parseGameManifest(source: string): GameManifest {
  const parsed = JSON.parse(source) as Omit<GameManifest, "scriptsFile"> & {
    scriptsFile?: unknown;
    ui?: unknown;
    uiDesignerPresets?: unknown;
  };
  if (parsed.assetCatalogVersion !== undefined && parsed.assetCatalogVersion !== 1) throw new Error("Unsupported asset catalog version; rebuild this game with the current exporter.");
  let scriptsFile = SCRIPTS_FILE;
  if (parsed.scriptsFile !== undefined) {
    if (typeof parsed.scriptsFile !== "string" || parsed.scriptsFile.length === 0) {
      throw new Error("game.json scriptsFile must be a non-empty string");
    }
    scriptsFile = parsed.scriptsFile;
  }
  const gameInstanceClass =
    typeof parsed.gameInstanceClass === "string" &&
    parsed.gameInstanceClass.trim()
      ? parsed.gameInstanceClass.trim()
      : undefined;
  const audioMixerGuid =
    typeof parsed.audioMixerGuid === "string" && parsed.audioMixerGuid.trim()
      ? parsed.audioMixerGuid.trim()
      : undefined;
  const bundleDebugger = parsed.bundleDebugger === true;
  const rest = { ...parsed, scriptsFile } as GameManifest & {
    ui?: unknown;
    uiDesignerPresets?: unknown;
  };
  delete rest.ui;
  delete rest.uiDesignerPresets;
  return {
    ...rest,
    render: normalizeRenderProjectSettings(parsed.render),
    focusNavigation: normalizeFocusNavigationSettings(parsed.focusNavigation),
    playFrameCap: normalizePlayFrameCap(parsed.playFrameCap),
    project: {
      name: typeof parsed.project?.name === "string" ? parsed.project.name : "",
      version: typeof parsed.project?.version === "string" ? parsed.project.version : "",
    },
    ...(gameInstanceClass ? { gameInstanceClass } : {}),
    ...(audioMixerGuid ? { audioMixerGuid } : {}),
    occlusionEnabled: parsed.occlusionEnabled !== false,
    reverbWetScale: clampAudioScale(parsed.reverbWetScale, 1),
    reverbDecayScale: clampAudioScale(parsed.reverbDecayScale, 1),
    reverbDampingScale: clampAudioScale(parsed.reverbDampingScale, 1),
    bundleDebugger,
    pixelsPerUnit:
      typeof parsed.pixelsPerUnit === "number" && parsed.pixelsPerUnit > 0
        ? parsed.pixelsPerUnit
        : 100,
    touchMinTargetPx:
      typeof parsed.touchMinTargetPx === "number" && parsed.touchMinTargetPx > 0
        ? parsed.touchMinTargetPx
        : 44,
    pixelPerfect: parsed.pixelPerfect === true,
    sortingLayers: normalizeSortingLayers(parsed.sortingLayers),
    ...(bundleDebugger
      ? {
          infiniteLoopDetection: parsed.infiniteLoopDetection !== false,
          loopCount:
            typeof parsed.loopCount === "number" &&
            Number.isFinite(parsed.loopCount) &&
            parsed.loopCount >= 1
              ? Math.round(parsed.loopCount)
              : DEFAULT_LOOP_COUNT,
        }
      : {
          infiniteLoopDetection: undefined,
          loopCount: undefined,
        }),
  };
}
