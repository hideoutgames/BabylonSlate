import type { ControlMessage } from "@babylonslate/bridge";
import {
  normalizeScene,
  type PhysicsWorldKind,
  type SerializedScene,
} from "@babylonslate/core";

/** Public path of the self-hosted Havok wasm (same pattern as `/ktx2/`). */
export const EDITOR_HAVOK_WASM_PATH = "/havok/HavokPhysics.wasm";

export type PlayPhysicsSettings = {
  physicsWorld: PhysicsWorldKind;
  gravity: [number, number, number];
};

export function editorHavokWasmUrl(): string {
  const origin =
    typeof globalThis.location?.origin === "string"
      ? globalThis.location.origin
      : "";
  if (origin && origin !== "null") {
    return new URL(EDITOR_HAVOK_WASM_PATH, origin).href;
  }
  return EDITOR_HAVOK_WASM_PATH;
}

export type PlaySceneDocument = {
  id: string;
  ref: { kind: string; path?: string };
  content: unknown;
};

function settingsFromContent(content: unknown): {
  physicsWorld?: string;
  gravity?: [number, number, number];
} | undefined {
  if (!content || typeof content !== "object") return undefined;
  const settings = (content as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object") return undefined;
  const record = settings as {
    physicsWorld?: string;
    gravity?: [number, number, number];
  };
  return {
    physicsWorld: record.physicsWorld,
    gravity: record.gravity,
  };
}

export function playPhysicsFromSceneSettings(
  settings?: {
    physicsWorld?: string;
    gravity?: [number, number, number];
  } | null,
): PlayPhysicsSettings {
  const gravity = settings?.gravity;
  return {
    physicsWorld: settings?.physicsWorld === "2d" ? "2d" : "3d",
    gravity:
      Array.isArray(gravity) && gravity.length >= 3
        ? [gravity[0] ?? 0, gravity[1] ?? -9.81, gravity[2] ?? 0]
        : [0, -9.81, 0],
  };
}

export function playPhysicsFromOpenDocuments(
  documents: readonly PlaySceneDocument[],
  activeDocumentId: string | null,
): PlayPhysicsSettings {
  const scene = findOpenSceneDocument(documents, activeDocumentId);
  return playPhysicsFromSceneSettings(settingsFromContent(scene?.content));
}

function findOpenSceneDocument(
  documents: readonly PlaySceneDocument[],
  activeDocumentId: string | null,
): PlaySceneDocument | undefined {
  const active = documents.find((entry) => entry.id === activeDocumentId);
  if (active?.ref.kind === "scene") return active;
  return documents.find((entry) => entry.ref.kind === "scene");
}

export type PlaySceneLoad = {
  sceneAssetGuid: string;
  scene: SerializedScene;
  path?: string;
};

/** Active (or first) open scene document for the Play `load` message. */
export function playSceneFromOpenDocuments(
  documents: readonly PlaySceneDocument[],
  activeDocumentId: string | null,
): PlaySceneLoad | null {
  const scene = findOpenSceneDocument(documents, activeDocumentId);
  if (!scene?.content) return null;
  return {
    sceneAssetGuid: scene.id,
    scene: normalizeScene(scene.content),
    path: scene.ref.path,
  };
}

export function playIsEnabled(
  documents: readonly PlaySceneDocument[],
  activeDocumentId: string | null,
  options?: { previewBuild?: boolean },
): boolean {
  if (options?.previewBuild) return true;
  return playSceneFromOpenDocuments(documents, activeDocumentId) !== null;
}

/** Open scene tab only. Startup scene is export-only and must not feed Play. */
export function resolvePlayScene(options: {
  documents: readonly PlaySceneDocument[];
  activeDocumentId: string | null;
  fallback?: PlaySceneLoad | null;
}): PlaySceneLoad | null {
  void options.fallback;
  return playSceneFromOpenDocuments(options.documents, options.activeDocumentId);
}

export function playLoadControl(options: {
  sceneAssetGuid?: string;
  scene?: SerializedScene;
  seed?: number;
  physicsWorld?: PhysicsWorldKind;
  gravity?: [number, number, number];
  gameInstanceClass?: string;
  scenes?: Array<{ guid: string; scene: SerializedScene }>;
  infiniteLoopDetection?: boolean;
  loopCount?: number;
  audioAssetGuids?: string[];
}): Extract<ControlMessage, { type: "load" }> {
  const physics = playPhysicsFromSceneSettings({
    physicsWorld: options.physicsWorld,
    gravity: options.gravity,
  });
  return {
    type: "load",
    sceneAssetGuid: options.sceneAssetGuid ?? "play-scene",
    scene: options.scene,
    seed: options.seed,
    physicsWorld: physics.physicsWorld,
    gravity: physics.gravity,
    havokWasmUrl: editorHavokWasmUrl(),
    gameInstanceClass: options.gameInstanceClass,
    scenes: options.scenes,
    infiniteLoopDetection: options.infiniteLoopDetection,
    loopCount: options.loopCount,
    audioAssetGuids: options.audioAssetGuids,
  };
}

export function inProcessPlayRuntimeOptions(physics: PlayPhysicsSettings): {
  physicsWorld: PhysicsWorldKind;
  gravity: [number, number, number];
  havokWasmUrl: string;
} {
  return {
    physicsWorld: physics.physicsWorld,
    gravity: physics.gravity,
    havokWasmUrl: editorHavokWasmUrl(),
  };
}
