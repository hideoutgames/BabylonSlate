import { sceneAssetClassId, sceneLayerAssetClassId } from "@haptic/object-model";

/**
 * The script a Scene (SceneScript) or Scene Layer (SceneLayerScript) document
 * embeds. It has no asset of its own: it compiles and runs as the Scene or
 * layer object's class, `Scene:<guid>` / `SceneLayer:<guid>`.
 */
export type EmbeddedScriptHost = {
  classId: string;
  parentClass: "Scene" | "SceneLayer";
  /** The Scene or Scene Layer asset's name, used in diagnostics. */
  className: string;
  assetGuid: string;
};

export function embeddedScriptHost(
  kind: string | undefined,
  asset: { header: { guid: string; name: string } } | undefined,
): EmbeddedScriptHost | null {
  if (!asset) return null;
  const { guid, name } = asset.header;
  if (kind === "scene") {
    return { classId: sceneAssetClassId(guid), parentClass: "Scene", className: name, assetGuid: guid };
  }
  if (kind === "scene-layer") {
    return { classId: sceneLayerAssetClassId(guid), parentClass: "SceneLayer", className: name, assetGuid: guid };
  }
  return null;
}

/**
 * Class id and parent of the logic graph a document edits: a Class from its
 * path and header, an Animation Object as an `Object`, a Scene or Scene Layer
 * script as its asset class.
 */
export function logicGraphHostClass(
  kind: string | undefined,
  path: string | undefined,
  asset: { header: { guid: string; name: string; parentClass?: string | null } } | undefined,
  classIdForPath: (path: string) => string,
): { classId: string | undefined; parentClass: string | null } {
  const embedded = embeddedScriptHost(kind, asset);
  if (embedded) return { classId: embedded.classId, parentClass: embedded.parentClass };
  return {
    classId: path ? classIdForPath(path) : undefined,
    parentClass: asset?.header.parentClass ?? (kind === "anim-graph" ? "Object" : null),
  };
}
