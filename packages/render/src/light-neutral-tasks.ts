import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";

/*
 * Babylon 9.29 `_setLightsForShadow` writes `light.shadowEnabled` around every
 * pass, readiness probe included, for every light that can cast a shadow (so
 * unshadowed lights too: their flag defaults to true). Each write that changes
 * the value walks every mesh and submesh to mark its material light defines
 * dirty, and every material rebuilds those defines on its next draw. Seven
 * lights across three outline masks cost 42 such walks per frame.
 *
 * A pass whose output cannot depend on light or shadow defines has no use for
 * the toggle. These subclasses make `_setLightsForShadow` a no-op: the pass
 * registers no observers and the lights keep their authored flags. They must
 * not be used for a pass that shades with scene lights (see
 * `ManagedShadowObjectRendererTask`, which keeps its own policy).
 */

/** Object renderer for passes whose draws never read light or shadow state. */
export class LightNeutralObjectRendererTask extends FrameGraphObjectRendererTask {
  protected override _setLightsForShadow(): void {}
}

/**
 * Geometry renderer for passes whose attachments (depth, normals, reflectivity,
 * velocity, object ids) are independent of lighting. Materials still compile
 * their normal light defines for the pass, so it follows the main pass's
 * shadow variants instead of forcing a shadowless one.
 */
export class LightNeutralGeometryRendererTask extends FrameGraphGeometryRendererTask {
  protected override _setLightsForShadow(): void {}
}
