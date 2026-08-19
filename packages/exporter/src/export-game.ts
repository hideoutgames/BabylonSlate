import { err, ok, DEFAULT_LOOP_COUNT, DEFAULT_UI_PROJECT_SETTINGS, type Result } from "@babylonslate/core";
import { zipSync, unzipSync } from "fflate";
import { encodeBabpack } from "./babpack";
import {
  BOOT_PACK_FILE,
  DEFAULT_FILE_COUNT_FAIL,
  DEFAULT_FILE_COUNT_WARN,
  GAME_MANIFEST_FILE,
  SCRIPTS_FILE,
} from "./constants";
import { concatenateScripts, serializeScriptRegistry } from "./scripts";
import { selectPlayerRuntimeFiles } from "./player-files";
import type {
  ExportArtifact,
  ExportAssetBytes,
  ExportGameOptions,
  GameAssetIndexEntry,
  GameManifest,
  PackedUiDesignerPreset,
} from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function clampAudioScale(value: unknown, fallback = 1): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  if (n < 0) return 0;
  if (n > 2) return 2;
  return n;
}

function packedUiDesignerPresets(
  value: unknown,
): PackedUiDesignerPreset[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const rows: PackedUiDesignerPreset[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Partial<PackedUiDesignerPreset> & {
      safeArea?: Partial<PackedUiDesignerPreset["safeArea"]>;
    };
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const width = Number(entry.width);
    const height = Number(entry.height);
    if (!id || !label || !(width >= 1) || !(height >= 1)) continue;
    const safe = entry.safeArea;
    rows.push({
      id,
      label,
      width,
      height,
      safeArea: {
        left: Math.max(0, Number(safe?.left) || 0),
        right: Math.max(0, Number(safe?.right) || 0),
        top: Math.max(0, Number(safe?.top) || 0),
        bottom: Math.max(0, Number(safe?.bottom) || 0),
      },
    });
  }
  return rows.length > 0 ? rows : undefined;
}

function packedUiSettings(
  value: unknown,
): NonNullable<GameManifest["ui"]> {
  const record =
    value && typeof value === "object"
      ? (value as {
          designResolution?: { width?: unknown; height?: unknown };
          scaleRule?: unknown;
        })
      : undefined;
  const width = Number(record?.designResolution?.width);
  const height = Number(record?.designResolution?.height);
  const scaleRule =
    record?.scaleRule === "fitWidth" || record?.scaleRule === "fitHeight"
      ? record.scaleRule
      : DEFAULT_UI_PROJECT_SETTINGS.scaleRule;
  return {
    designResolution: {
      width:
        width >= 1 ? Math.round(width) : DEFAULT_UI_PROJECT_SETTINGS.designResolution.width,
      height:
        height >= 1
          ? Math.round(height)
          : DEFAULT_UI_PROJECT_SETTINGS.designResolution.height,
    },
    scaleRule,
  };
}

const JSON_TYPES = new Set([
  "Scene",
  "Class",
  "Graph",
  "UserInterface",
  "AnimationGraph",
  "BehaviourTree",
  "Blackboard",
  "Material",
  "MaterialFunction",
  "Sprite",
  "SpriteAnimation",
  "Tilemap",
  "Tileset",
  "ParticleEmitter",
  "ParticleSystem",
  "Animation",
]);

function scenePackName(sceneGuid: string): string {
  return `scene-${sceneGuid}.babpack`;
}

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
    ...(asset.name ? { name: asset.name } : {}),
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

async function writePackedAssets(
  files: Map<string, Uint8Array>,
  assets: readonly ExportAssetBytes[],
  startupSceneGuid: string,
): Promise<{ packs: string[]; index: GameAssetIndexEntry[] }> {
  const assigned = new Set<string>();
  const packs: string[] = [];
  const index: GameAssetIndexEntry[] = [];
  const boot = assets.filter((asset) => asset.sceneGuid === startupSceneGuid);
  for (const asset of boot) assigned.add(asset.guid);
  files.set(
    BOOT_PACK_FILE,
    await encodeBabpack(
      boot.map((asset) => ({ guid: asset.guid, bytes: asset.bytes })),
    ),
  );
  packs.push(BOOT_PACK_FILE);
  for (const asset of boot) {
    index.push(indexEntry(asset, { pack: BOOT_PACK_FILE }));
  }
  const otherScenes = [
    ...new Set(
      assets
        .filter((asset) => !assigned.has(asset.guid))
        .map((asset) => asset.sceneGuid),
    ),
  ].sort();
  for (const sceneGuid of otherScenes) {
    const group = assets.filter(
      (asset) => asset.sceneGuid === sceneGuid && !assigned.has(asset.guid),
    );
    for (const asset of group) assigned.add(asset.guid);
    const name = scenePackName(sceneGuid);
    files.set(
      name,
      await encodeBabpack(
        group.map((asset) => ({ guid: asset.guid, bytes: asset.bytes })),
      ),
    );
    packs.push(name);
    for (const asset of group) {
      index.push(indexEntry(asset, { pack: name }));
    }
  }
  return { packs, index };
}

function writeLooseAssets(
  files: Map<string, Uint8Array>,
  assets: readonly ExportAssetBytes[],
): { packs: string[]; index: GameAssetIndexEntry[] } {
  const index: GameAssetIndexEntry[] = [];
  for (const asset of assets) {
    const path = `assets/${asset.guid}.bin`;
    files.set(path, asset.bytes);
    index.push(indexEntry(asset, { path }));
  }
  return { packs: [], index };
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

  const bundled = concatenateScripts(options.scripts);
  const registry = serializeScriptRegistry(options.scripts);
  const scriptsFile =
    bundled.source.length > 0 ? `${bundled.source}\n${registry}` : registry;
  files.set(SCRIPTS_FILE, encoder.encode(scriptsFile));

  const packed =
    mode === "packed"
      ? await writePackedAssets(files, options.assets, options.startupSceneGuid)
      : writeLooseAssets(files, options.assets);

  inlineCssIntoIndex(files);

  const designerPresets = packedUiDesignerPresets(options.uiDesignerPresets);
  const manifest: GameManifest = {
    startupSceneGuid: options.startupSceneGuid,
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
    render: options.customResolution,
    playFrameCap: options.playFrameCap ?? 60,
    pixelsPerUnit:
      typeof options.pixelsPerUnit === "number" && options.pixelsPerUnit > 0
        ? options.pixelsPerUnit
        : 100,
    pixelPerfect: options.pixelPerfect === true,
    packs: packed.packs,
    scriptsFile: SCRIPTS_FILE,
    physicsWorld: options.physicsWorld ?? "3d",
    assets: packed.index,
    ...(designerPresets ? { uiDesignerPresets: designerPresets } : {}),
    ui: packedUiSettings(options.ui),
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
  const parsed = JSON.parse(source) as GameManifest;
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
  const designerPresets = packedUiDesignerPresets(parsed.uiDesignerPresets);
  const rest = { ...parsed };
  delete rest.uiDesignerPresets;
  delete rest.ui;
  return {
    ...rest,
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
    pixelPerfect: parsed.pixelPerfect === true,
    ...(designerPresets ? { uiDesignerPresets: designerPresets } : {}),
    ui: packedUiSettings(parsed.ui),
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
