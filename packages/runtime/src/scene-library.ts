import type { SerializedScene, SerializedSceneLayer } from "@haptic/core";
import { sceneAssetClassId, type ClassRegistry } from "@haptic/object-model";

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
 * key, then by display name where no key or earlier display name holds it (a
 * key wins over a display name, and both lookups resolve a name to the same
 * Scene), Scene Layer documents, and the Play Scene under its guid and name,
 * which replace library entries.
 */
export function indexSceneLibrary(sources: SceneLibrarySources, targets: SceneLibraryTargets): void {
  const library = Object.entries(sources.sceneLibrary ?? {});
  const documents = !sources.acquired;
  for (const [key, guid] of Object.entries(sources.sceneGuidByKey ?? {})) targets.sceneGuids.set(key, guid);
  for (const [key, scene] of library) {
    if (documents) targets.scenes.set(key, scene);
    if (!targets.sceneGuids.has(key)) targets.sceneGuids.set(key, key);
  }
  for (const [key, scene] of library) {
    const displayName = typeof scene.name === "string" ? scene.name.trim() : "";
    const guid = targets.sceneGuids.get(key)!;
    const named = targets.sceneGuids.get(displayName);
    // The name already resolves to another Scene: a key, or an earlier display name.
    if (!displayName || (named !== undefined && named !== guid)) continue;
    if (documents && !targets.scenes.has(displayName)) targets.scenes.set(displayName, scene);
    targets.sceneGuids.set(displayName, guid);
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
