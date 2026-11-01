import {
  createActor,
  createDefaultScene,
  createDefaultSceneLayer,
  createMeshComponent,
  defaultTimelineProxyPreview,
  eulerDegreesToQuaternion,
  identitySerializedTransform,
  inverseQuat,
  multiplyQuats,
  quaternionToEulerDegrees,
  quatRotateVector,
  sceneLayerToEditorScene,
  timelineClipOfAsset,
  withTimelineClipOfAsset,
  type SerializedActor,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedScene,
  type SerializedTimelineClipAsset,
  type TimelineProxy,
  type TimelineProxyPreview,
} from "@haptic/core";
import { TIMELINE_PROXY_OUTLINE_CLASS_ID } from "@haptic/render";
import { defaultComponentAuthoringProperties } from "@haptic/runtime";
import type { LiveGizmoTransform } from "./gizmo-drag-commit";
import { timelineTransformEdit } from "./timeline-transform-edit";
import type { NewId } from "./timeline-track-edits";

/**
 * A proxy as the actor the Timeline panel lists and keys. An Actor proxy is an
 * actor of its Class with the components the Class defines; a Component proxy
 * is an actor holding that one component, whose id is the proxy's, so its
 * tracks name the proxy. A proxy previewed As Absolute stands at its preview
 * placement, so new transform keys record world values; a Relative one stands
 * at the origin, so they record offsets (`composeTimelineProxyPreview` then
 * adds the placement for the viewport).
 */
export function timelineProxyActor(
  proxy: TimelineProxy,
  preview: TimelineProxyPreview | undefined,
  graphs: Readonly<Record<string, SerializedGraph>>,
  twoD: boolean,
): SerializedActor {
  const place = preview ?? defaultTimelineProxyPreview(0);
  const transform = place.previewAs === "absolute" ? placementTransform(place) : identitySerializedTransform();
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
  // A 2D clip previews like a Scene Layer: overlay editing and its default frame.
  return {
    ...(twoD ? sceneLayerToEditorScene(createDefaultSceneLayer()) : createDefaultScene("3d")),
    actors: payload.proxies.map((proxy) => timelineProxyActor(proxy, payload.editorPreview?.proxies[proxy.id], graphs, twoD)),
    timelineClips: [timelineClipOfAsset(payload, name)],
  };
}

function placementTransform(place: TimelineProxyPreview) {
  return {
    position: [...place.location] as [number, number, number],
    rotation: eulerDegreesToQuaternion([...place.rotation] as [number, number, number]),
    scale: [...place.scale] as [number, number, number],
  };
}

/**
 * How the clip asset viewport draws each proxy: its Editor Preview
 * representation (an Outline, a Model in 3D, a Material or Texture in 2D,
 * sized by Size) in place of an Actor proxy's Class components, or with Class
 * those components. A Component proxy keeps its component beside it, so its
 * property tracks still apply.
 */
export function timelineProxyPreviewScene(scene: SerializedScene, payload: SerializedTimelineClipAsset, twoD: boolean): SerializedScene {
  const proxies = new Map(payload.proxies.map((proxy) => [proxy.id, proxy]));
  return {
    ...scene,
    actors: scene.actors.map((actor): SerializedActor => {
      if (!proxies.has(actor.id)) return actor;
      const preview = payload.editorPreview?.proxies[actor.id] ?? defaultTimelineProxyPreview(0);
      if (preview.representation === "class") return actor;
      const representation = representationComponent(actor.id, preview, twoD);
      // A Component proxy keeps its component, so its property tracks still apply (a Light still lights).
      const kept = actor.components.filter((component) => component.id === actor.id);
      return { ...actor, components: [...kept, representation] };
    }),
  };
}

function representationComponent(proxyId: string, preview: TimelineProxyPreview, twoD: boolean): SerializedComponent {
  const id = `${proxyId}:preview`;
  const scaled = { ...identitySerializedTransform(), scale: [preview.size, preview.size, preview.size] as [number, number, number] };
  const outline: SerializedComponent = {
    id, classId: TIMELINE_PROXY_OUTLINE_CLASS_ID, parentId: null, transform: identitySerializedTransform(),
    properties: { size: preview.size, color: preview.color, twoD },
  };
  if (!preview.assetGuid) return outline;
  if (preview.representation === "model" && !twoD) {
    const mesh = createMeshComponent(id, "box");
    mesh.properties.assetGuid = preview.assetGuid;
    return { ...mesh, transform: scaled };
  }
  if (preview.representation === "texture" && twoD) {
    return { id, classId: "2DTextureComponent", parentId: null, transform: scaled, properties: { textureGuid: preview.assetGuid, hitTest: "ignore" } };
  }
  if (preview.representation === "material" && twoD) {
    return { id, classId: "2DMaterialComponent", parentId: null, transform: scaled, properties: { materialGuid: preview.assetGuid, hitTest: "ignore" } };
  }
  return outline;
}

/**
 * Places each Relative proxy at its preview placement: its evaluated
 * transform is an offset from there (Location turned by the placement's
 * Rotation, Scale multiplied by its Scale, as a Relative binding offsets the
 * bound actor). Absolute proxies already stand where their keys put them.
 */
export function composeTimelineProxyPreview(scene: SerializedScene, payload: SerializedTimelineClipAsset): SerializedScene {
  const previews = payload.editorPreview?.proxies ?? {};
  let changed = false;
  const actors = scene.actors.map((actor): SerializedActor => {
    const preview = previews[actor.id];
    if (!preview || preview.previewAs === "absolute") return actor;
    const place = placementTransform(preview);
    const [qx, qy, qz, qw] = place.rotation;
    const placeQuat = { x: qx, y: qy, z: qz, w: qw };
    const [px, py, pz] = actor.transform.position;
    const offset = quatRotateVector(placeQuat, { x: px, y: py, z: pz });
    const [rx, ry, rz, rw] = actor.transform.rotation;
    const rotation = multiplyQuats(placeQuat, { x: rx, y: ry, z: rz, w: rw });
    const [sx, sy, sz] = actor.transform.scale;
    changed = true;
    return {
      ...actor,
      transform: {
        position: [place.position[0] + offset.x, place.position[1] + offset.y, place.position[2] + offset.z],
        rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
        scale: [place.scale[0] * sx, place.scale[1] * sy, place.scale[2] * sz],
      },
    };
  });
  return changed ? { ...scene, actors } : scene;
}

const EPSILON = 1e-5;
const quatOf = (rotation: readonly number[]) => ({ x: rotation[0]!, y: rotation[1]!, z: rotation[2]!, w: rotation[3]! });
const sameTriple = (a: readonly number[], b: readonly number[]) => a.every((value, index) => Math.abs(value - b[index]!) < EPSILON);

/**
 * A gizmo drag on proxies in the clip asset viewport. `lives` are where the
 * proxies were dropped, as drawn (a Relative proxy's preview placement
 * included). A channel whose transform track has keys takes a key at
 * `time` (Auto Key) or an unkeyed value, as in a Scene's Timeline mode; a
 * changed Location, Rotation or Scale without a track, or whose track has no
 * keys yet, overwrites the proxy's Editor Preview placement, so the proxy
 * stays as it was dropped.
 */
export function timelineProxyGizmoEdit(
  payload: SerializedTimelineClipAsset,
  scene: SerializedScene,
  time: number,
  lives: readonly LiveGizmoTransform[],
  options: { autoKey: boolean; unkeyed: ReadonlyMap<string, unknown>; newId: NewId },
): { payload: SerializedTimelineClipAsset; unkeyed: Map<string, unknown> } {
  const clip = scene.timelineClips?.[0];
  const previews = payload.editorPreview?.proxies ?? {};
  if (!clip || lives.length === 0) return { payload, unkeyed: new Map() };
  // Into the proxies' own space: a Relative proxy's transform is an offset from its placement.
  const local = lives.map((live): LiveGizmoTransform => {
    const preview = previews[live.actorId];
    if (!preview || preview.previewAs === "absolute") return live;
    const place = placementTransform(preview);
    const inverse = inverseQuat(quatOf(place.rotation));
    const offset = quatRotateVector(inverse, {
      x: live.position[0] - place.position[0], y: live.position[1] - place.position[1], z: live.position[2] - place.position[2],
    });
    const rotation = multiplyQuats(inverse, quatOf(live.rotation));
    const scale = live.scale.map((value, axis) => (place.scale[axis] ? value / place.scale[axis]! : value)) as [number, number, number];
    return { ...live, position: [offset.x, offset.y, offset.z], rotation: [rotation.x, rotation.y, rotation.z, rotation.w], scale };
  });
  const edit = timelineTransformEdit(scene, clip, time, local, { ...options, keyedTracksOnly: true });
  const keyed = edit.scene.timelineClips?.find((entry) => entry.id === clip.id);
  let next = keyed && keyed !== clip ? withTimelineClipOfAsset(payload, keyed) : payload;
  const moved: Record<string, TimelineProxyPreview> = {};
  lives.forEach((live, index) => {
    const preview = previews[live.actorId];
    if (!preview) return;
    const tracked = new Set((clip.objects.find((object) => object.actorId === live.actorId)?.tracks ?? [])
      .filter((track) => !track.muted && track.target.kind === "transform" && track.keys.length > 0).map((track) => track.target.property));
    let placement = preview;
    if (!tracked.has("rotation")) {
      const rotation = quaternionToEulerDegrees(live.rotation);
      if (!sameTriple(eulerDegreesToQuaternion(rotation), eulerDegreesToQuaternion(preview.rotation))) placement = { ...placement, rotation };
    }
    if (!tracked.has("scale") && !sameTriple(live.scale, preview.scale)) placement = { ...placement, scale: [...live.scale] };
    if (!tracked.has("location")) {
      if (!sameTriple(live.position, preview.location)) placement = { ...placement, location: [...live.position] };
    } else if (placement.rotation !== preview.rotation && preview.previewAs !== "absolute") {
      // A Relative proxy turned in place: its Location keys now turn with the new rotation, so the placement follows.
      const offset = local[index]!.position;
      const turned = quatRotateVector(quatOf(eulerDegreesToQuaternion(placement.rotation)), { x: offset[0], y: offset[1], z: offset[2] });
      placement = { ...placement, location: [live.position[0] - turned.x, live.position[1] - turned.y, live.position[2] - turned.z] };
    }
    if (placement !== preview) moved[live.actorId] = placement;
  });
  if (Object.keys(moved).length) next = { ...next, editorPreview: { proxies: { ...previews, ...moved } } };
  return { payload: next, unkeyed: edit.unkeyed };
}
