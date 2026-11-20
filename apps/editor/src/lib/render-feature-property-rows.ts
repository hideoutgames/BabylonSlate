import {
  OUTLINE_WIDTH_LIMITS,
  parseDecalProperties,
  parseFogVolumeProperties,
  parseMirrorProperties,
  parseOutlineProperties,
  parseReflectionProbeProperties,
  parseSkyboxSize,
  REFLECTION_PROBE_RESOLUTIONS,
  SKYBOX_FACE_KEYS,
  type SerializedComponent,
  type SkyboxFaceKey,
  UPDATE_RATE_LABELS,
  UPDATE_RATES,
} from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import {
  assetRow,
  genericRows,
  rowId,
  sliderRow,
  type ComponentPropertyContext,
  type ComponentPropertyUpdate,
} from "./component-property-row-helpers";

const SKYBOX_FACE_LABELS: Record<SkyboxFaceKey, string> = {
  px: "Positive X",
  py: "Positive Y",
  pz: "Positive Z",
  nx: "Negative X",
  ny: "Negative Y",
  nz: "Negative Z",
};

export function skyboxPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return [
    sliderRow(
      actorId,
      component.id,
      "size",
      "Size",
      parseSkyboxSize(component.properties.size),
      1,
      10000,
      update,
    ),
    ...SKYBOX_FACE_KEYS.map((key) =>
      assetRow(
        actorId,
        component,
        `faces.${key}`,
        SKYBOX_FACE_LABELS[key],
        ["Texture"],
        update,
        context,
        `Pick ${SKYBOX_FACE_LABELS[key]} Texture`,
        "Engine Default",
      ),
    ),
    ...genericRows(
      actorId,
      component,
      update,
      new Set(["size", "faces"]),
    ),
  ];
}

export function outlinePropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  const properties = parseOutlineProperties(component.properties);
  return [
    { kind: "boolean", id: rowId(actorId, component.id, "enabled"), label: "Enabled", value: properties.enabled,
      description: "Outline this actor's geometry. Disabling reveals any applicable global CEL outline.", onChange: (next) => update("enabled", next) },
    { kind: "color", id: rowId(actorId, component.id, "color"), label: "Color", value: properties.color, onChange: (next) => update("color", next) },
    { kind: "number", id: rowId(actorId, component.id, "width"), label: "Width", unit: "px", value: properties.width,
      min: OUTLINE_WIDTH_LIMITS[0], max: OUTLINE_WIDTH_LIMITS[1], sensitivity: 0.025,
      description: "In output pixels, independent of the actor's scale.", onChange: (next) => update("width", next) },
    { kind: "boolean", id: rowId(actorId, component.id, "throughMeshes"), label: "Render Through Meshes", value: properties.throughMeshes,
      description: "Show this outline through other geometry. Global CEL outlines remain occluded.", onChange: (next) => update("throughMeshes", next) },
  ];
}

export function fogVolumePropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  const properties = parseFogVolumeProperties(component.properties);
  const defaults = parseFogVolumeProperties({});
  return [
    { kind: "boolean", id: rowId(actorId, component.id, "enabled"), label: "Enabled",
      value: properties.enabled, defaultValue: defaults.enabled,
      description: "Local fog works independently of Scene-Wide Fog. Shared quality is in Project Settings > Rendering > Post Processing.",
      onChange: (next) => update("enabled", next) },
    { kind: "enum", id: rowId(actorId, component.id, "shape"), label: "Shape",
      value: properties.shape, defaultValue: defaults.shape,
      options: [{ value: "box", label: "Box" }, { value: "sphere", label: "Sphere" }],
      onChange: (next) => update("shape", next === "sphere" ? "sphere" : "box") },
    { kind: "vector3", id: rowId(actorId, component.id, "size"), label: "Size", unit: "scene units",
      value: properties.size, defaultValue: defaults.size, sensitivity: 0.1,
      description: properties.shape === "sphere"
        ? "Full diameters along local X, Y and Z. Different values stretch the sphere. Actor and component scale also apply."
        : "Full width, height and depth along local X, Y and Z. Actor and component scale also apply.",
      onChange: (next) => update("size", next.slice(0, 3).map((value) => Math.max(0.01, value))) },
    { kind: "number", id: rowId(actorId, component.id, "density"), label: "Density",
      value: properties.density, defaultValue: defaults.density, min: 0, precision: 6, sensitivity: 0.0001,
      description: "Additional fog inside this volume. Zero contributes no fog; overlapping volumes add density.",
      onChange: (next) => update("density", Math.max(0, next)) },
    { kind: "slider", id: rowId(actorId, component.id, "edgeFalloff"), label: "Edge Falloff",
      value: properties.edgeFalloff, defaultValue: defaults.edgeFalloff, min: 0, max: 1, step: 0.01,
      description: "Fraction of the half-size used for soft edges. Zero gives a hard boundary; one fades from the center.",
      onChange: (next) => update("edgeFalloff", Math.min(1, Math.max(0, next))) },
  ];
}

export function decalPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const properties = parseDecalProperties(component.properties);
  const defaults = parseDecalProperties({});
  return [
    { kind: "boolean", id: rowId(actorId, component.id, "enabled"), label: "Enabled",
      value: properties.enabled, defaultValue: defaults.enabled,
      description: "Projects along local -Y onto underlying opaque surfaces inside the box volume.",
      onChange: (next) => update("enabled", next) },
    { ...assetRow(actorId, component, "textureGuid", "Texture", ["Texture"], update, context, "Choose Decal Texture", "None"),
      description: "RGBA texture projected onto world surfaces. Alpha controls coverage." },
    { ...assetRow(actorId, component, "normalTextureGuid", "Normal Texture", ["Texture"], update, context, "Choose Normal Texture", "None"),
      description: "Optional tangent-space normal map blended over the underlying surface normal when lit." },
    { kind: "color", id: rowId(actorId, component.id, "tint"), label: "Tint",
      value: properties.tint, defaultValue: defaults.tint,
      description: "Multiplies the decal texture color.",
      onChange: (next) => update("tint", next) },
    { kind: "slider", id: rowId(actorId, component.id, "opacity"), label: "Opacity",
      value: properties.opacity, defaultValue: defaults.opacity, min: 0, max: 1, step: 0.01,
      description: "Overall decal opacity multiplier.",
      onChange: (next) => update("opacity", Math.min(1, Math.max(0, next))) },
    { kind: "slider", id: rowId(actorId, component.id, "roughness"), label: "Roughness",
      value: properties.roughness, defaultValue: defaults.roughness, min: 0, max: 1, step: 0.01,
      description: "Surface roughness used for direct and environment reflections when Receive Lighting is on.",
      onChange: (next) => update("roughness", Math.min(1, Math.max(0, next))) },
    { kind: "enum", id: rowId(actorId, component.id, "blendMode"), label: "Blend Mode",
      value: properties.blendMode, defaultValue: defaults.blendMode,
      options: [
        { value: "alpha", label: "Alpha" },
        { value: "multiply", label: "Multiply" },
        { value: "additive", label: "Additive" },
      ],
      description: "How the decal combines with the underlying opaque scene color.",
      onChange: (next) => update("blendMode", next === "multiply" || next === "additive" ? next : "alpha") },
    { kind: "boolean", id: rowId(actorId, component.id, "receiveLighting"), label: "Receive Lighting",
      value: properties.receiveLighting, defaultValue: defaults.receiveLighting,
      description: "Shades the decal with scene lights, shadows, and environment lighting.",
      onChange: (next) => update("receiveLighting", next) },
    { kind: "vector3", id: rowId(actorId, component.id, "size"), label: "Size", unit: "scene units",
      value: properties.size, defaultValue: defaults.size, sensitivity: 0.1,
      description: "Local projection box extents: X width, Y projection depth, Z height.",
      onChange: (next) => update("size", next.slice(0, 3).map((value) => Math.max(0.01, value))) },
    { kind: "slider", id: rowId(actorId, component.id, "fadeAngle"), label: "Fade Angle",
      value: properties.fadeAngle, defaultValue: defaults.fadeAngle, min: 1, max: 180, step: 1,
      description: "Fades out where the receiving surface normal diverges past this angle from local +Y (degrees).",
      onChange: (next) => update("fadeAngle", Math.min(180, Math.max(1, next))) },
    { kind: "number", id: rowId(actorId, component.id, "sortOrder"), label: "Sort Order",
      value: properties.sortOrder, defaultValue: defaults.sortOrder, sensitivity: 1, precision: 0,
      description: "Higher values draw on top of lower-order overlapping decals.",
      onChange: (next) => update("sortOrder", Math.round(next)) },
    { kind: "number", id: rowId(actorId, component.id, "cullDistance"), label: "Cull Distance", unit: "scene units",
      value: properties.cullDistance, defaultValue: defaults.cullDistance, min: 0, sensitivity: 1,
      description: "Distance from the camera beyond which the decal stops drawing, scaled by Geometry quality. Zero never culls by distance.",
      onChange: (next) => update("cullDistance", Math.max(0, next)) },
  ];
}

export function mirrorPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const properties = parseMirrorProperties(component.properties);
  const defaults = parseMirrorProperties({});
  return [
    { kind: "boolean", id: rowId(actorId, component.id, "enabled"), label: "Enabled",
      value: properties.enabled, defaultValue: defaults.enabled,
      description: "The reflective side faces local -Z, as a Plane mesh does. Off hides the surface.",
      onChange: (next) => update("enabled", next) },
    { kind: "enum", id: rowId(actorId, component.id, "reflects"), label: "Reflects", value: properties.reflects, defaultValue: defaults.reflects,
      options: [{ value: "everything", label: "Everything" }, { value: "movingActors", label: "Moving Actors" }, { value: "environment", label: "Environment" }],
      description: "Moving Actors and Environment show what they do not draw from the Reflection Probe the Mirror stands in, or the sky.",
      onChange: (next) => update("reflects", next) },
    ...(["width", "height"] as const).map((key): PropertyRow => ({
      kind: "number", id: rowId(actorId, component.id, key), label: key === "width" ? "Width" : "Height",
      value: properties[key], defaultValue: defaults[key], min: 0.01, sensitivity: 0.05,
      description: "Local units. Actor and component scale also apply.",
      onChange: (next) => update(key, Math.max(0.01, next)),
    })),
    { kind: "slider", id: rowId(actorId, component.id, "resolutionScale"), label: "Resolution Scale",
      value: properties.resolutionScale, defaultValue: defaults.resolutionScale, min: 0.1, max: 1, step: 0.05,
      description: "Reflection resolution as a fraction of the view's. Lower values save GPU time and memory.",
      onChange: (next) => update("resolutionScale", Math.min(1, Math.max(0.1, next))) },
    { kind: "enum", id: rowId(actorId, component.id, "updateRate"), label: "Update Rate", value: properties.updateRate, defaultValue: defaults.updateRate,
      options: UPDATE_RATES.map((value) => ({ value, label: UPDATE_RATE_LABELS[value] })),
      description: "In Play, a lower rate keeps the last reflection on skipped frames; the editor draws every frame.",
      onChange: (next) => update("updateRate", next) },
    { kind: "color", id: rowId(actorId, component.id, "tint"), label: "Tint", value: properties.tint,
      description: "Multiplies the reflection on the built-in surface. A Material override decides its own look.",
      onChange: (next) => update("tint", next) },
    { ...assetRow(actorId, component, "materialGuid", "Material", ["Material", "MaterialInstance"], update, context, "Choose Mirror Material", "Built-In Surface"),
      description: "Use a Mirror Reflection node to read the reflection." },
  ];
}

export function reflectionProbePropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  const properties = parseReflectionProbeProperties(component.properties);
  const defaults = parseReflectionProbeProperties({});
  return [
    { kind: "boolean", id: rowId(actorId, component.id, "enabled"), label: "Enabled",
      value: properties.enabled, defaultValue: defaults.enabled,
      description: "Captures static actors around its center. Moving actors are left out, and screen-space reflections still show them.",
      onChange: (next) => update("enabled", next) },
    { kind: "vector3", id: rowId(actorId, component.id, "size"), label: "Size", unit: "scene units",
      value: properties.size, defaultValue: defaults.size, sensitivity: 0.1,
      description: "Fit it to the room. Surfaces whose center is inside reflect this probe, projected onto this box; the smallest probe wins where boxes overlap. Rotation is ignored.",
      onChange: (next) => update("size", next.slice(0, 3).map((value) => Math.max(0.01, value))) },
    { kind: "enum", id: rowId(actorId, component.id, "resolution"), label: "Resolution",
      value: String(properties.resolution), defaultValue: String(defaults.resolution),
      options: REFLECTION_PROBE_RESOLUTIONS.map((size) => ({ value: String(size), label: `${size} px` })),
      description: "Size of each captured face. Larger is sharper and takes longer to capture.",
      onChange: (next) => update("resolution", Number(next)) },
  ];
}
