import type { SerializedScene, SerializedSceneLayer } from "@babylonslate/core";
import { sceneAssetClassId, type ClassRegistry } from "@babylonslate/object-model";

interface SceneLibrarySources {
  sceneLibrary?: Readonly<Record<string, SerializedScene>>;
  sceneGuidByKey?: Readonly<Record<string, string>>;
  sceneLayerLibrary?: Readonly<Record<string, SerializedSceneLayer>>;
  playScene?: SerializedScene;
  playSceneGuid: string;
  /** Scenes are acquired on demand, so documents are not kept in the library. */
  acquired: boolean;
}

interface SceneLibraryTargets {
  scenes: Map<string, SerializedScene>;
  sceneGuids: Map<string, string>;
  sceneLayers: Map<string, SerializedSceneLayer>;
}

/**
 * Fills the driver's Scene lookups from its options: documents and guids by
 * key and by display name (a key wins over a display name), Scene Layer
 * documents, and the Play Scene under its guid and name.
 */
export function indexSceneLibrary(sources: SceneLibrarySources, targets: SceneLibraryTargets): void {
  if (sources.sceneLibrary && !sources.acquired) {
    for (const [key, scene] of Object.entries(sources.sceneLibrary)) {
      targets.scenes.set(key, scene);
      const displayName =
        typeof scene.name === "string" ? scene.name.trim() : "";
      if (displayName && displayName !== key) {
        targets.scenes.set(displayName, scene);
      }
    }
  }
  if (sources.sceneGuidByKey) {
    for (const [key, guid] of Object.entries(sources.sceneGuidByKey)) {
      targets.sceneGuids.set(key, guid);
    }
  }
  if (sources.sceneLibrary) {
    for (const [key, scene] of Object.entries(sources.sceneLibrary)) {
      if (!targets.sceneGuids.has(key)) {
        targets.sceneGuids.set(key, key);
      }
      const displayName =
        typeof scene.name === "string" ? scene.name.trim() : "";
      if (displayName && !targets.sceneGuids.has(displayName)) {
        targets.sceneGuids.set(
          displayName,
          targets.sceneGuids.get(key) ?? key,
        );
      }
    }
  }
  if (sources.sceneLayerLibrary) {
    for (const [key, layer] of Object.entries(sources.sceneLayerLibrary)) {
      targets.sceneLayers.set(key, layer);
    }
  }
  if (sources.playScene) {
    if (!sources.acquired) targets.scenes.set(sources.playSceneGuid, sources.playScene);
    targets.sceneGuids.set(sources.playSceneGuid, sources.playSceneGuid);
    if (sources.playScene.name) {
      if (!sources.acquired) targets.scenes.set(sources.playScene.name, sources.playScene);
      targets.sceneGuids.set(sources.playScene.name, sources.playSceneGuid);
    }
  }
}

/**
 * Registers the Scene asset Class (a `Scene` subclass) of the Play Scene and of
 * every Scene guid the library resolves, so their Scene objects are typed
 * before scripts or Scene realization create them.
 */
export function registerSceneAssetClasses(registry: ClassRegistry, playSceneGuid: string, sceneGuids: Iterable<string>): void {
  const guids = new Set<string>();
  if (playSceneGuid) guids.add(playSceneGuid);
  for (const guid of sceneGuids) {
    if (guid) guids.add(guid);
  }
  for (const guid of guids) {
    registry.ensure({
      id: sceneAssetClassId(guid),
      parentClassId: "Scene",
      kind: "object",
      variables: [],
      implementedInterfaces: [],
    });
  }
}
