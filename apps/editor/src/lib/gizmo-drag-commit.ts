import {
  TEXT2D_COMPONENT_CLASS_IDS,
  patchComponentProperties,
  type SerializedActor,
} from "@babylonslate/core";

/**
 * Live mesh TRS may be written back only for an in-progress gizmo drag.
 * Spurious Babylon `onDragEnd` (attach/rebuild) must not re-dirty after Save.
 */
export function takeGizmoDragScene<T>(ref: { current: T | null }): T | null {
  const scene = ref.current;
  ref.current = null;
  return scene;
}

export type LiveGizmoTransform = {
  actorId: string;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  text2dWrap?: { wrapWidth: number; wrapHeight: number };
};

/** Persist gizmo TRS; 2D Text / Rich Text resize writes wrap px, not actor scale. */
export function applyLiveGizmoToActor(
  actor: SerializedActor,
  live: LiveGizmoTransform,
): SerializedActor {
  const wrap = live.text2dWrap;
  return {
    ...actor,
    transform: {
      position: live.position,
      rotation: live.rotation,
      scale: live.scale,
    },
    components: wrap
      ? actor.components.map((component) =>
          (TEXT2D_COMPONENT_CLASS_IDS as readonly string[]).includes(
            component.classId,
          )
            ? {
                ...component,
                properties: patchComponentProperties(
                  patchComponentProperties(
                    component.properties,
                    "wrapWidth",
                    wrap.wrapWidth,
                  ),
                  "wrapHeight",
                  wrap.wrapHeight,
                ),
              }
            : component,
        )
      : actor.components,
  };
}
