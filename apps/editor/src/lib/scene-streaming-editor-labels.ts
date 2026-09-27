import type { SerializedActor, SerializedComponent, SerializedScene } from "@babylonslate/core";

type SceneNameLookup = (guid: string) => string | undefined;
const componentCache = new WeakMap<SerializedComponent[], { key: string; result: SerializedComponent[] }>();
const sceneCache = new WeakMap<SerializedScene, SerializedScene>();

/** Resolve current asset names for display without changing the authored document. */
export function sceneStreamingEditorComponents<T extends SerializedComponent>(
  components: T[],
  sceneName: SceneNameLookup,
): T[] {
  const names = new Map<string, string>();
  for (const component of components) {
    if (component.classId !== "SceneStreamingComponent") continue;
    const guid = component.properties.sceneGuid;
    const name = typeof guid === "string" && guid ? sceneName(guid) : undefined;
    if (name !== undefined) names.set(component.id, name);
  }
  if (names.size === 0) return components;
  const key = JSON.stringify([...names]);
  const cached = componentCache.get(components);
  if (cached?.key === key) return cached.result as T[];
  let changed = false;
  const result = components.map((component) => {
    const name = component.classId === "SceneStreamingComponent"
      ? names.get(component.id)
      : component.classId === "Text3DComponent" && component.properties.editorOnly === true
        ? names.get(component.parentId ?? "")
        : undefined;
    const property = component.classId === "SceneStreamingComponent" ? "sceneName" : "text";
    if (name === undefined || component.properties[property] === name) return component;
    changed = true;
    return { ...component, properties: { ...component.properties, [property]: name } };
  });
  const projected = changed ? result : components;
  componentCache.set(components, { key, result: projected });
  return projected;
}

export function sceneStreamingEditorScene(scene: SerializedScene, sceneName: SceneNameLookup): SerializedScene {
  const previous = sceneCache.get(scene);
  const actors = scene.actors.map((actor, index): SerializedActor => {
    const components = sceneStreamingEditorComponents(actor.components, sceneName);
    if (components === actor.components) return actor;
    const prior = previous?.actors[index];
    return prior?.components === components ? prior : { ...actor, components };
  });
  if (actors.every((actor, index) => actor === scene.actors[index])) return scene;
  if (previous && actors.every((actor, index) => actor === previous.actors[index])) return previous;
  const projected = { ...scene, actors };
  sceneCache.set(scene, projected);
  return projected;
}
