import {
  createActor,
  identitySerializedTransform,
  type SerializedActor,
  type SerializedComponent,
  type SerializedTransform,
} from "./scene";
import { createText3DComponent } from "./text3d";

/** A reference and editor marker only; child content is instantiated by runtime streaming. */
export function createSceneStreamingActor(
  id: string,
  sceneGuid = "",
  sceneName = "",
  transform: SerializedTransform = identitySerializedTransform(),
): SerializedActor {
  const streamingId = `${id}-scene-streaming`;
  const text = createText3DComponent(`${id}-scene-name`);
  text.parentId = streamingId;
  text.transform = { ...identitySerializedTransform(), position: [0, 0.8, 0] };
  text.properties = {
    ...text.properties,
    text: sceneName || "No Scene",
    size: 0.25,
    alignment: "center",
    editorOnly: true,
  };
  return createActor(id, sceneName || "Scene Streaming", {
    classId: "SceneStreamingActor",
    transform,
    components: [
      {
        id: streamingId,
        classId: "SceneStreamingComponent",
        properties: { sceneGuid, sceneName },
        parentId: null,
        transform: identitySerializedTransform(),
      },
      text,
    ],
  });
}

/** Keep the persisted editor label and target reference in one undoable authoring edit. */
export function setSceneStreamingTarget<T extends SerializedComponent>(
  components: readonly T[],
  componentId: string,
  sceneGuid: string | null,
  sceneName: string,
): T[] {
  if (!components.some((component) => component.id === componentId && component.classId === "SceneStreamingComponent")) {
    return [...components];
  }
  return components.map((component) => {
    if (component.id === componentId) {
      return {
        ...component,
        properties: { ...component.properties, sceneGuid: sceneGuid ?? "", sceneName: sceneGuid ? sceneName : "" },
      };
    }
    if (component.classId === "Text3DComponent" && component.parentId === componentId && component.properties.editorOnly === true) {
      return { ...component, properties: { ...component.properties, text: sceneGuid ? sceneName || "No Scene" : "No Scene" } };
    }
    return component;
  });
}
