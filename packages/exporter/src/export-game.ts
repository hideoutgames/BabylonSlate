import { err, ok, type Result } from "@babylonslate/core";
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
} from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
  "Tilemap",
  "Tileset",
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

  const manifest: GameManifest = {
    startupSceneGuid: options.startupSceneGuid,
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

export function zipExport(artifact: ExportArtifact): Uint8Array {
  const record: Record<string, Uint8Array> = {};
  for (const [path, data] of [...artifact.files.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    record[path] = data;
  }
  return zipSync(record, { level: 6, mtime: new Date(Date.UTC(1980, 0, 1)) });
}

export function unzipExport(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

export function parseGameManifest(source: string): GameManifest {
  const parsed = JSON.parse(source) as GameManifest;
  return {
    ...parsed,
    pixelsPerUnit:
      typeof parsed.pixelsPerUnit === "number" && parsed.pixelsPerUnit > 0
        ? parsed.pixelsPerUnit
        : 100,
    pixelPerfect: parsed.pixelPerfect === true,
  };
}
