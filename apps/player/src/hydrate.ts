import {
  parseAnimGraphDocument,
  resolveAnimGraphClips,
  type AnimClipCatalogEntry,
} from "@babylonslate/anim-graph";
import {
  hydrateSpriteAnimationPixelSizes,
  modelClipAnimationGuidsFromAnimations,
  normalizeAnimationPayload,
  normalizeAudioChannelPayload,
  normalizeAudioMixerPayload,
  normalizeAudioPayload,
  normalizeParticleEmitterPayload,
  normalizeParticleSystemPayload,
  normalizeSoundAttenuationPayload,
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  parseSpriteAnimationPayload,
  type AnimationPayload,
  type AudioChannelPayload,
  type AudioMixerPayload,
  type AudioPayload,
  type ParticleEmitterPayload,
  type ParticleSystemPayload,
  type SoundAttenuationPayload,
  type SpriteAnimationPayload,
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

export type PackedAudioLibrary = {
  mixerGuid: string | null;
  mixers: Map<string, AudioMixerPayload>;
  channels: Map<string, AudioChannelPayload>;
  audio: Map<string, AudioPayload>;
  attenuations: Map<string, SoundAttenuationPayload>;
};

export type PackedParticleLibrary = {
  emitters: Map<string, ParticleEmitterPayload>;
  systems: Map<string, ParticleSystemPayload>;
};

export type PackedGameContent = {
  spritePayloads: Map<string, SpritePayload>;
  spriteAnimationPayloads: Map<string, SpriteAnimationPayload>;
  tilemapPayloads: Map<string, TilemapPayload>;
  tilesetPayloads: Map<string, TilesetPayload>;
  animGraphs: Array<{ guid: string; document: unknown }>;
  behaviourTrees: Array<{ guid: string; document: unknown }>;
  blackboards: Array<{ guid: string; document: unknown }>;
  navmeshBytes: Uint8Array | null;
  navmeshByScene: Map<string, Uint8Array>;
  audioReverbBytes: Uint8Array | null;
  audioReverbByScene: Map<string, Uint8Array>;
  materialDocuments: Map<string, MaterialDocument>;
  materialFunctions: Map<string, MaterialFunctionDocument>;
  postProcessStack: ScenePostProcessEntry[];
  pixelsPerUnit: number;
  pixelPerfect: boolean;
  audioLibrary: PackedAudioLibrary;
  particleLibrary: PackedParticleLibrary;
  userInterfaces: Map<string, UserInterfaceDocument>;
  modelClipAnimationGuids: Map<string, Map<string, string>>;
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

function asSpriteAnimationPayload(
  value: unknown,
): SpriteAnimationPayload | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { frames?: unknown; clips?: unknown };
  if (!Array.isArray(record.frames) || Array.isArray(record.clips)) return null;
  return parseSpriteAnimationPayload(value);
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
  const spriteAnimationPayloads = new Map<string, SpriteAnimationPayload>();
  const tilemapPayloads = new Map<string, TilemapPayload>();
  const tilesetPayloads = new Map<string, TilesetPayload>();
  const animGraphs: Array<{ guid: string; document: unknown }> = [];
  const behaviourTrees: Array<{ guid: string; document: unknown }> = [];
  const blackboards: Array<{ guid: string; document: unknown }> = [];
  const materialDocuments = new Map<string, MaterialDocument>();
  const materialFunctions = new Map<string, MaterialFunctionDocument>();
  const mixers = new Map<string, AudioMixerPayload>();
  const channels = new Map<string, AudioChannelPayload>();
  const audio = new Map<string, AudioPayload>(game.audioPayloads);
  const attenuations = new Map<string, SoundAttenuationPayload>();
  const emitters = new Map<string, ParticleEmitterPayload>();
  const systems = new Map<string, ParticleSystemPayload>();
  const animationPayloads = new Map<string, AnimationPayload>();
  const animationNames = new Map<string, string>();

  for (const entry of game.manifest.assets ?? []) {
    const bytes = game.payloads.get(entry.guid);
    if (!bytes) continue;
    const parsed = jsonFromBytes(bytes);
    if (entry.type === "Sprite") {
      const sprite = asSpritePayload(parsed);
      if (sprite) spritePayloads.set(entry.guid, sprite);
      continue;
    }
    if (entry.type === "SpriteAnimation" && parsed) {
      const animation = asSpriteAnimationPayload(parsed);
      if (animation) spriteAnimationPayloads.set(entry.guid, animation);
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
      continue;
    }
    if (entry.type === "AudioMixer" && parsed) {
      mixers.set(entry.guid, normalizeAudioMixerPayload(parsed));
      continue;
    }
    if (entry.type === "AudioChannel" && parsed) {
      channels.set(entry.guid, normalizeAudioChannelPayload(parsed));
      continue;
    }
    if (entry.type === "SoundAttenuation" && parsed) {
      attenuations.set(entry.guid, normalizeSoundAttenuationPayload(parsed));
      continue;
    }
    if (entry.type === "Audio" && parsed && !audio.has(entry.guid)) {
      audio.set(entry.guid, normalizeAudioPayload(parsed));
      continue;
    }
    if (entry.type === "ParticleEmitter" && parsed) {
      emitters.set(entry.guid, normalizeParticleEmitterPayload(parsed));
      continue;
    }
    if (entry.type === "ParticleSystem" && parsed) {
      systems.set(entry.guid, normalizeParticleSystemPayload(parsed));
      continue;
    }
    if (entry.type === "Animation" && parsed) {
      animationPayloads.set(entry.guid, normalizeAnimationPayload(parsed));
      if (entry.name?.trim()) animationNames.set(entry.guid, entry.name.trim());
    }
  }

  const startup = game.manifest.startupSceneGuid;
  const navmeshByScene = new Map(game.navmeshBytes);
  const navmeshBytes = navmeshByScene.get(startup) ?? null;
  const audioReverbByScene = new Map(game.audioReverbBytes);
  const audioReverbBytes = audioReverbByScene.get(startup) ?? null;
  const startupScene = game.scenes.get(startup);
  const pixelsPerUnit =
    typeof game.manifest.pixelsPerUnit === "number" && game.manifest.pixelsPerUnit > 0
      ? game.manifest.pixelsPerUnit
      : 100;

  const sizedSpriteAnimations = hydrateSpriteAnimationPixelSizes(
    spriteAnimationPayloads,
    game.textureBytes,
  );

  const clipCatalog: AnimClipCatalogEntry[] = [...animationPayloads.entries()].map(
    ([guid, payload]) => ({
      guid,
      type: "Animation",
      name: animationNames.get(guid) ?? payload.clipName,
      clipName: payload.clipName,
      ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
      ...(payload.skeletonGuid ? { skeletonGuid: payload.skeletonGuid } : {}),
      ...(payload.modelGuid ? { modelGuid: payload.modelGuid } : {}),
    }),
  );
  const resolvedAnimGraphs = animGraphs.map((entry) => {
    const document = parseAnimGraphDocument(entry.document);
    if (!document) return entry;
    return {
      guid: entry.guid,
      document: resolveAnimGraphClips(document, clipCatalog),
    };
  });

  return {
    spritePayloads,
    spriteAnimationPayloads: sizedSpriteAnimations,
    tilemapPayloads,
    tilesetPayloads,
    animGraphs: resolvedAnimGraphs,
    behaviourTrees,
    blackboards,
    navmeshBytes,
    navmeshByScene,
    audioReverbBytes,
    audioReverbByScene,
    materialDocuments,
    materialFunctions,
    postProcessStack: startupScene?.settings.postProcessStack ?? [],
    pixelsPerUnit,
    pixelPerfect: game.manifest.pixelPerfect === true,
    audioLibrary: {
      mixerGuid: game.manifest.audioMixerGuid?.trim() || null,
      mixers,
      channels,
      audio,
      attenuations,
    },
    particleLibrary: {
      emitters,
      systems,
    },
    userInterfaces: new Map(game.userInterfaces ?? []),
    modelClipAnimationGuids: modelClipAnimationGuidsFromAnimations(
      [...animationPayloads.entries()].map(([guid, payload]) => ({ guid, payload })),
    ),
  };
}

export function packedPlayControls(content: PackedGameContent): ControlMessage[] {
  const controls: ControlMessage[] = [];
  if (content.animGraphs.length > 0) {
    controls.push({ type: "loadAnimGraphs", graphs: [...content.animGraphs] });
  }
  if (content.spritePayloads.size > 0 || content.spriteAnimationPayloads.size > 0) {
    controls.push({
      type: "loadSprites",
      sprites: [...content.spritePayloads.entries()].map(([guid, document]) => ({
        guid,
        document,
      })),
      spriteAnimations: [...content.spriteAnimationPayloads.entries()].map(
        ([guid, document]) => ({ guid, document }),
      ),
      ...(content.pixelsPerUnit > 0 ? { pixelsPerUnit: content.pixelsPerUnit } : {}),
    });
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
