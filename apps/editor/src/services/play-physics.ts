import type { ControlMessage } from "@babylonslate/bridge";
import {
  normalizeScene,
  type PhysicsWorldKind,
  type SerializedScene,
  type SerializedSceneLayer,
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

/** Prefer the registry guid so `activeScene` resolves in every Play host. */
export function canonicalPlaySceneGuid(
  scene: PlaySceneLoad,
  guidForPath: (path: string) => string | null,
): string {
  return scene.path
    ? (guidForPath(scene.path) ?? scene.sceneAssetGuid)
    : scene.sceneAssetGuid;
}

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
  options?: {
    previewBuild?: boolean;
    playFromScene?: boolean;
    hasStartupScene?: boolean;
  },
): boolean {
  if (options?.previewBuild) return true;
  if (options?.playFromScene !== false) {
    if (playSceneFromOpenDocuments(documents, activeDocumentId) !== null) {
      return true;
    }
    return options?.hasStartupScene === true;
  }
  return options?.hasStartupScene === true;
}

/** Open scene when Play from Scene is on; otherwise the startup fallback. */
export function resolvePlayScene(options: {
  documents: readonly PlaySceneDocument[];
  activeDocumentId: string | null;
  playFromScene?: boolean;
  fallback?: PlaySceneLoad | null;
}): PlaySceneLoad | null {
  if (options.playFromScene !== false) {
    const open = playSceneFromOpenDocuments(
      options.documents,
      options.activeDocumentId,
    );
    if (open) return open;
  }
  return options.fallback ?? null;
}

export function resolvePreviewStartupGuid(options: {
  playFromScene: boolean;
  openSceneGuid: string | null | undefined;
  startupSceneGuid: string | null | undefined;
}): string | null {
  if (options.playFromScene) {
    const open = options.openSceneGuid?.trim() ?? "";
    if (open) return open;
  }
  const startup = options.startupSceneGuid?.trim() ?? "";
  return startup || null;
}

export function playLoadControl(options: {
  sceneAssetGuid?: string;
  scene?: SerializedScene;
  seed?: number;
  physicsWorld?: PhysicsWorldKind;
  gravity?: [number, number, number];
  gameInstanceClass?: string;
  scenes?: Array<{ guid: string; scene: SerializedScene }>;
  sceneLayers?: Array<{ guid: string; layer: SerializedSceneLayer }>;
  infiniteLoopDetection?: boolean;
  loopCount?: number;
  audioAssetGuids?: string[];
  animClipCatalog?: Array<{
    guid: string;
    type: string;
    name: string;
    clipName?: string;
    durationMs?: number;
    skeletonGuid?: string | null;
    modelGuid?: string;
  }>;
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
    sceneLayers: options.sceneLayers,
    infiniteLoopDetection: options.infiniteLoopDetection,
    loopCount: options.loopCount,
    audioAssetGuids: options.audioAssetGuids,
    animClipCatalog: options.animClipCatalog,
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
