import type { ControlMessage } from "@babylonslate/bridge";
import type { PhysicsWorldKind } from "@babylonslate/core";

/** Public path of the self-hosted Havok wasm (same pattern as `/ktx2/`). */
export const EDITOR_HAVOK_WASM_PATH = "/havok/HavokPhysics.wasm";

export type PlayPhysicsSettings = {
  physicsWorld: PhysicsWorldKind;
  gravity: [number, number, number];
};

export type PlaySceneDocument = {
  id: string;
  ref: { kind: string };
  content: {
    settings?: {
      physicsWorld?: string;
      gravity?: [number, number, number];
    };
  } | null;
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
  const active = documents.find((entry) => entry.id === activeDocumentId);
  const scene =
    active?.ref.kind === "scene"
      ? active
      : documents.find((entry) => entry.ref.kind === "scene");
  return playPhysicsFromSceneSettings(scene?.content?.settings);
}

export function playLoadControl(options: {
  sceneAssetGuid?: string;
  seed?: number;
  physicsWorld?: PhysicsWorldKind;
  gravity?: [number, number, number];
}): Extract<ControlMessage, { type: "load" }> {
  const physics = playPhysicsFromSceneSettings({
    physicsWorld: options.physicsWorld,
    gravity: options.gravity,
  });
  return {
    type: "load",
    sceneAssetGuid: options.sceneAssetGuid ?? "play-scene",
    seed: options.seed,
    physicsWorld: physics.physicsWorld,
    gravity: physics.gravity,
    havokWasmUrl: editorHavokWasmUrl(),
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
