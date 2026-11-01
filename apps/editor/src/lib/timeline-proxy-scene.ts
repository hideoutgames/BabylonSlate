import {
  createActor,
  createDefaultScene,
  defaultTimelineProxyPreview,
  eulerDegreesToQuaternion,
  identitySerializedTransform,
  timelineClipOfAsset,
  type SerializedActor,
  type SerializedGraph,
  type SerializedScene,
  type SerializedTimelineClipAsset,
  type TimelineProxy,
  type TimelineProxyPreview,
} from "@haptic/core";
import { defaultComponentAuthoringProperties } from "@haptic/runtime";

/**
 * A proxy as the actor the Timeline panel lists and keys, standing where the
 * Editor Preview places it. An Actor proxy is an actor of its Class with the
 * components the Class defines; a Component proxy is an actor holding that
 * one component, whose id is the proxy's, so its tracks name the proxy.
 */
export function timelineProxyActor(
  proxy: TimelineProxy,
  preview: TimelineProxyPreview | undefined,
  graphs: Readonly<Record<string, SerializedGraph>>,
  twoD: boolean,
): SerializedActor {
  const place = preview ?? defaultTimelineProxyPreview(0);
  const transform = { position: [...place.location] as [number, number, number], rotation: eulerDegreesToQuaternion([...place.rotation] as [number, number, number]), scale: [1, 1, 1] as [number, number, number] };
  if (proxy.represents === "component") {
    const world = twoD ? "2d" : "3d";
    return createActor(proxy.id, proxy.name, {
      transform,
      components: [{
        id: proxy.id,
        classId: proxy.classId,
        properties: defaultComponentAuthoringProperties(proxy.classId, world, world),
        parentId: null,
        transform: identitySerializedTransform(),
      }],
    });
  }
  return createActor(proxy.id, proxy.name, {
    classId: proxy.classId,
    transform,
    components: structuredClone(graphs[proxy.classId]?.components ?? []),
  });
}

/**
 * A clip asset as the scene the Timeline windows edit: its proxies are the
 * actors, and its one clip, named after the asset, is the scene's clip.
 */
export function timelineProxyScene(
  payload: SerializedTimelineClipAsset,
  name: string,
  graphs: Readonly<Record<string, SerializedGraph>>,
  twoD: boolean,
): SerializedScene {
  return {
    ...createDefaultScene(twoD ? "2d" : "3d"),
    actors: payload.proxies.map((proxy) => timelineProxyActor(proxy, payload.editorPreview?.proxies[proxy.id], graphs, twoD)),
    timelineClips: [timelineClipOfAsset(payload, name)],
  };
}
