import { parseAnimGraphDocument } from "@babylonslate/anim-graph";
import {
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  type SpritePayload,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";
import {
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
} from "@babylonslate/behaviour-tree";
import type { ControlMessage, ScriptBundleEntry } from "@babylonslate/bridge";
import type { ScenePostProcessEntry } from "@babylonslate/core";
import { shouldSpawnScriptedActor } from "@babylonslate/runtime";
import type { UserInterfaceDocument } from "@babylonslate/ui-runtime";
import {
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import type { LoadedGame } from "./artifact";

const decoder = new TextDecoder();

export type PackedGameContent = {
  spritePayloads: Map<string, SpritePayload>;
  tilemapPayloads: Map<string, TilemapPayload>;
  tilesetPayloads: Map<string, TilesetPayload>;
  animGraphs: Array<{ guid: string; document: unknown }>;
  behaviourTrees: Array<{ guid: string; document: unknown }>;
  blackboards: Array<{ guid: string; document: unknown }>;
  navmeshBytes: Uint8Array | null;
  navmeshByScene: Map<string, Uint8Array>;
  materialDocuments: Map<string, MaterialDocument>;
  materialFunctions: Map<string, MaterialFunctionDocument>;
  postProcessStack: ScenePostProcessEntry[];
  pixelsPerUnit: number;
  pixelPerfect: boolean;
  userInterfaces: Map<string, UserInterfaceDocument>;
};

function jsonFromBytes(bytes: Uint8Array): unknown | null {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
}

function asSpritePayload(value: unknown): SpritePayload | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { frames?: unknown; clips?: unknown };
  if (!Array.isArray(record.frames) || !Array.isArray(record.clips)) return null;
  return value as SpritePayload;
}

function navmeshArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = bytes.slice();
  return copy.buffer.slice(
    copy.byteOffset,
    copy.byteOffset + copy.byteLength,
  ) as ArrayBuffer;
}

export function packedContentFromGame(game: LoadedGame): PackedGameContent {
  const spritePayloads = new Map<string, SpritePayload>();
  const tilemapPayloads = new Map<string, TilemapPayload>();
  const tilesetPayloads = new Map<string, TilesetPayload>();
  const animGraphs: Array<{ guid: string; document: unknown }> = [];
  const behaviourTrees: Array<{ guid: string; document: unknown }> = [];
  const blackboards: Array<{ guid: string; document: unknown }> = [];
  const materialDocuments = new Map<string, MaterialDocument>();
  const materialFunctions = new Map<string, MaterialFunctionDocument>();

  for (const entry of game.manifest.assets ?? []) {
    const bytes = game.payloads.get(entry.guid);
    if (!bytes) continue;
    const parsed = jsonFromBytes(bytes);
    if (entry.type === "Sprite") {
      const sprite = asSpritePayload(parsed);
      if (sprite) spritePayloads.set(entry.guid, sprite);
      continue;
    }
    if (entry.type === "Tilemap" && parsed) {
      tilemapPayloads.set(entry.guid, normalizeTilemapPayload(parsed));
      continue;
    }
    if (entry.type === "Tileset" && parsed) {
      tilesetPayloads.set(entry.guid, normalizeTilesetPayload(parsed));
      continue;
    }
    if (entry.type === "AnimationGraph" && parsed) {
      const document = parseAnimGraphDocument(parsed);
      if (document) animGraphs.push({ guid: entry.guid, document });
      continue;
    }
    if (entry.type === "BehaviourTree" && parsed) {
      const document = parseBehaviourTreeDocument(parsed);
      if (document) behaviourTrees.push({ guid: entry.guid, document });
      continue;
    }
    if (entry.type === "Blackboard" && parsed) {
      const document = parseBlackboardDocument(parsed);
      if (document) blackboards.push({ guid: entry.guid, document });
      continue;
    }
    if (entry.type === "Material" && parsed) {
      materialDocuments.set(
        entry.guid,
        normalizeMaterialDocument(parsed, entry.name ?? "Material"),
      );
      continue;
    }
    if (entry.type === "MaterialFunction" && parsed) {
      materialFunctions.set(
        entry.guid,
        normalizeMaterialFunctionDocument(
          parsed,
          entry.name ?? "Material Function",
        ),
      );
    }
  }

  const startup = game.manifest.startupSceneGuid;
  const navmeshByScene = new Map(game.navmeshBytes);
  const navmeshBytes = navmeshByScene.get(startup) ?? null;
  const startupScene = game.scenes.get(startup);
  const pixelsPerUnit =
    typeof game.manifest.pixelsPerUnit === "number" && game.manifest.pixelsPerUnit > 0
      ? game.manifest.pixelsPerUnit
      : 100;

  return {
    spritePayloads,
    tilemapPayloads,
    tilesetPayloads,
    animGraphs,
    behaviourTrees,
    blackboards,
    navmeshBytes,
    navmeshByScene,
    materialDocuments,
    materialFunctions,
    postProcessStack: startupScene?.settings.postProcessStack ?? [],
    pixelsPerUnit,
    pixelPerfect: game.manifest.pixelPerfect === true,
    userInterfaces: new Map(game.userInterfaces ?? []),
  };
}

export function packedPlayControls(content: PackedGameContent): ControlMessage[] {
  const controls: ControlMessage[] = [];
  if (content.animGraphs.length > 0) {
    controls.push({ type: "loadAnimGraphs", graphs: [...content.animGraphs] });
  }
  if (content.behaviourTrees.length > 0 || content.blackboards.length > 0) {
    controls.push({
      type: "loadBehaviourTrees",
      trees: [...content.behaviourTrees],
      blackboards: [...content.blackboards],
    });
  }
  if (content.tilemapPayloads.size > 0 || content.tilesetPayloads.size > 0) {
    controls.push({
      type: "loadTilemaps",
      tilemaps: [...content.tilemapPayloads.entries()].map(([guid, document]) => ({
        guid,
        document,
      })),
      tilesets: [...content.tilesetPayloads.entries()].map(([guid, document]) => ({
        guid,
        document,
      })),
      ...(content.pixelsPerUnit > 0 ? { pixelsPerUnit: content.pixelsPerUnit } : {}),
    });
  }
  if (content.navmeshBytes && content.navmeshBytes.byteLength > 0) {
    controls.push({
      type: "loadNavMesh",
      bytes: navmeshArrayBuffer(content.navmeshBytes),
    });
  }
  return controls;
}

function widgetMetaFromDocument(document: UserInterfaceDocument) {
  return Object.values(document.widgets).map((widget) => ({
    id: widget.id,
    kind: widget.kind,
    ...(widget.name ? { name: widget.name } : {}),
  }));
}

export function packedUserInterfaceControl(
  content: PackedGameContent,
): Extract<ControlMessage, { type: "loadUserInterfaces" }> | null {
  if (content.userInterfaces.size === 0) return null;
  return {
    type: "loadUserInterfaces",
    documents: [...content.userInterfaces.entries()].map(([guid, document]) => ({
      guid,
      widgets: widgetMetaFromDocument(document),
    })),
  };
}

export function packedBootControls(
  content: PackedGameContent,
  scripts: readonly ScriptBundleEntry[],
  spawn: readonly { classId: string }[] = [],
): ControlMessage[] {
  const controls: ControlMessage[] = [];
  const userInterfaces = packedUserInterfaceControl(content);
  if (userInterfaces) controls.push(userInterfaces);
  if (scripts.length > 0) {
    controls.push({
      type: "loadScripts",
      scripts: [...scripts],
      spawn: spawn.filter((entry) => shouldSpawnScriptedActor(entry.classId)),
    });
  }
  controls.push(...packedPlayControls(content));
  controls.push({ type: "play" });
  return controls;
}
