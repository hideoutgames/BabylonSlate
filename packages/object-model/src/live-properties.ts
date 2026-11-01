import { isOverlayLayoutClass, supportsOverlayVisualStyle, timelineValueTypeFor } from "@haptic/core";
import type { EngineScriptVariable } from "./engine-script-api";

/**
 * Which engine component properties Play applies while running. The runtime
 * inspector edits through `engineComponentPropertyCapability`, and Timeline
 * tracks animate the properties `isTimelineAnimatableComponentProperty` accepts,
 * so the editor offers only tracks Play can show.
 */

/** Value and reference type ids a running session can hold without a structural rebuild. */
export const LIVE_SCALAR_TYPE_IDS: ReadonlySet<string> = new Set([
  "bool", "boolean", "float", "int", "number", "string", "vec2", "vec3", "vec4", "color", "quat",
  "actor", "object", "component", "class", "asset",
]);

const LIVE_COMPONENTS = new Set([
  "MeshComponent", "DynamicRuntimeMeshComponent", "CameraComponent", "LightComponent",
  "HemisphericFillLightComponent", "OutlineComponent", "RigidBodyComponent", "ColliderComponent", "NavAgentComponent",
]);
const MESH_COMPONENTS = new Set(["MeshComponent", "DynamicRuntimeMeshComponent"]);
const LIVE_MESH_PROPERTIES = new Set(["castShadows", "receiveShadows", "materialGuid"]);
const TEXT_2D_COMPONENTS = new Set(["2DTextComponent", "2DRichTextComponent"]);
const TWEENED_TEXT_PROPERTIES = new Set(["size", "color", "outline", "outlineColor", "wrapWidth", "wrapHeight"]);

/**
 * How Play applies a change to one of a component class's own engine
 * properties: `"live"` in place, `"rebuild"` by rebuilding the component, or
 * undefined when the change needs a new session. Read-only properties are the
 * caller's to exclude.
 */
export function engineComponentPropertyCapability(
  classId: string,
  variable: Pick<EngineScriptVariable, "propertyKey" | "typeId" | "container">,
): "live" | "rebuild" | undefined {
  if (!LIVE_SCALAR_TYPE_IDS.has(variable.typeId) || variable.container === "map") return undefined;
  if (classId === "ColliderComponent") return "rebuild";
  if (classId === "AudioComponent" && variable.propertyKey === "volume") return "live";
  if (!LIVE_COMPONENTS.has(classId)) return undefined;
  if (MESH_COMPONENTS.has(classId) && !LIVE_MESH_PROPERTIES.has(variable.propertyKey)) return undefined;
  return "live";
}

/** 2D properties Play's tweens already animate (`tween-targets.ts` in the runtime). */
function isTweened2DProperty(classId: string, key: string): boolean {
  if (supportsOverlayVisualStyle(classId) && (key === "opacity" || key === "tint")) return true;
  if (classId === "2DAnchorComponent") return key === "offsetX" || key === "offsetY";
  if (classId === "2DScrollBoxComponent" && (key === "scrollX" || key === "scrollY")) return true;
  if (TEXT_2D_COMPONENTS.has(classId)) return TWEENED_TEXT_PROPERTIES.has(key);
  return isOverlayLayoutClass(classId) && classId !== "2DPaddingComponent" && (key === "width" || key === "height");
}

/**
 * Whether a Timeline track can animate a component class's own engine
 * property: a single value of a track value type that Play applies live, or a
 * 2D property tweens animate. Of asset properties, only a Mesh's Material.
 */
export function isTimelineAnimatableComponentProperty(classId: string, variable: EngineScriptVariable): boolean {
  if (variable.getOnly || (variable.container ?? "single") !== "single") return false;
  if (!timelineValueTypeFor(variable.typeId)) return false;
  if (variable.typeId === "asset" && variable.propertyKey !== "materialGuid") return false;
  return engineComponentPropertyCapability(classId, variable) === "live" || isTweened2DProperty(classId, variable.propertyKey);
}
