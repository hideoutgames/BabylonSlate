import {
  DEFAULT_CAMERA_FIELD_OF_VIEW,
  DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
  normalizeRenderTargetCaptureProperties,
  parseSpringArmProperties,
  RENDER_TARGET_CAPTURE_QUALITIES,
  RENDER_TARGET_CAPTURE_QUALITY_LABELS,
  SPRING_ARM_LAG_SPEED_LIMITS,
  SPRING_ARM_LENGTH_LIMITS,
  type SerializedComponent,
} from "@haptic/core";
import { humanizePropertyLabel, type PropertyRow } from "@haptic/editor-kit";
import {
  asNumber,
  assetRow,
  genericRows,
  rowId,
  sliderRow,
  type ComponentPropertyContext,
  type ComponentPropertyUpdate,
} from "./component-property-row-helpers";

export function cameraPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  const projectionMode =
    component.properties.projectionMode === "orthographic"
      ? "orthographic"
      : "perspective";
  return [
    {
      kind: "enum",
      id: rowId(actorId, component.id, "projectionMode"),
      label: "Projection Mode",
      value: projectionMode,
      options: [
        { value: "perspective", label: "Perspective" },
        { value: "orthographic", label: "Orthographic" },
      ],
      onChange: (next) => update("projectionMode", next),
    },
    ...(projectionMode === "perspective" ? [{ ...sliderRow(
      actorId,
      component.id,
      "fieldOfView",
      "Field Of View",
      asNumber(component.properties.fieldOfView, DEFAULT_CAMERA_FIELD_OF_VIEW),
      1,
      179,
      update,
      1,
      DEFAULT_CAMERA_FIELD_OF_VIEW,
    ), unit: "deg" }] : [sliderRow(
      actorId,
      component.id,
      "orthographicSize",
      "Orthographic Size",
      asNumber(
        component.properties.orthographicSize,
        DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
      ),
      0.1,
      50,
      update,
      0.1,
      DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
    )]),
    {
      kind: "number",
      id: rowId(actorId, component.id, "nearClip"),
      label: "Near Clip",
      value: asNumber(component.properties.nearClip, 0.1),
      min: 0.001,
      validate: (next) => next >= asNumber(component.properties.farClip, 1000)
        ? "Near Clip must be less than Far Clip." : undefined,
      onChange: (next) => {
        if (next < asNumber(component.properties.farClip, 1000)) update("nearClip", next);
      },
    },
    {
      kind: "number",
      id: rowId(actorId, component.id, "farClip"),
      label: "Far Clip",
      value: asNumber(component.properties.farClip, 1000),
      min: 0.01,
      validate: (next) => next <= asNumber(component.properties.nearClip, 0.1)
        ? "Far Clip must be greater than Near Clip." : undefined,
      onChange: (next) => {
        if (next > asNumber(component.properties.nearClip, 0.1)) update("farClip", next);
      },
    },
    {
      kind: "boolean",
      id: rowId(actorId, component.id, "attemptPossessViewTarget"),
      label: "Attempt Possess View Target",
      value: component.properties.attemptPossessViewTarget === true,
      defaultValue: false,
      onChange: (next) => update("attemptPossessViewTarget", next),
    },
    ...genericRows(
      actorId,
      component,
      update,
      new Set([
        "fieldOfView",
        "orthographicSize",
        "projectionMode",
        "nearClip",
        "farClip",
        "attemptPossessViewTarget",
      ]),
    ),
  ];
}

export function springArmPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  const properties = parseSpringArmProperties(component.properties);
  const lagSpeedRow = (key: "locationLagSpeed" | "rotationLagSpeed", label: string, enabled: boolean): PropertyRow => ({
    kind: "number", id: rowId(actorId, component.id, key), label, value: properties[key],
    min: SPRING_ARM_LAG_SPEED_LIMITS[0], max: SPRING_ARM_LAG_SPEED_LIMITS[1], sensitivity: 0.1, disabled: !enabled,
    description: "Higher values catch up faster. The lag is frame-rate independent.", onChange: (next) => update(key, next) });
  return [
    { kind: "number", id: rowId(actorId, component.id, "armLength"), label: "Arm Length", value: properties.armLength,
      min: SPRING_ARM_LENGTH_LIMITS[0], max: SPRING_ARM_LENGTH_LIMITS[1], sensitivity: 0.05,
      description: "Distance behind the arm's origin, along its local -Z axis, where child components attach.", onChange: (next) => update("armLength", next) },
    { kind: "boolean", id: rowId(actorId, component.id, "enableLocationLag"), label: "Enable Location Lag", value: properties.enableLocationLag,
      description: "During Play, the arm trails behind its target position and children move smoothly.", onChange: (next) => update("enableLocationLag", next) },
    lagSpeedRow("locationLagSpeed", "Location Lag Speed", properties.enableLocationLag),
    { kind: "number", id: rowId(actorId, component.id, "maxLocationLagDistance"), label: "Max Location Lag Distance", value: properties.maxLocationLagDistance,
      min: 0, sensitivity: 0.05, disabled: !properties.enableLocationLag,
      description: "Furthest the arm may trail its target. 0 means unlimited.", onChange: (next) => update("maxLocationLagDistance", next) },
    { kind: "boolean", id: rowId(actorId, component.id, "enableRotationLag"), label: "Enable Rotation Lag", value: properties.enableRotationLag,
      description: "During Play, the arm eases toward its target rotation and children swing smoothly.", onChange: (next) => update("enableRotationLag", next) },
    lagSpeedRow("rotationLagSpeed", "Rotation Lag Speed", properties.enableRotationLag),
    { kind: "boolean", id: rowId(actorId, component.id, "drawDebugLag"), label: "Draw Debug Lag", value: properties.drawDebugLag,
      description: "During Play, draw the target arm (yellow), the lagged arm (green), the lag offset (red), and recent socket trails.", onChange: (next) => update("drawDebugLag", next) },
  ];
}

export function renderTargetCapturePropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const capture = normalizeRenderTargetCaptureProperties(component.properties);
  return [
    assetRow(actorId, component, "renderTargetGuid", "Render Target", ["RenderTarget"], update, context, "Pick Render Target"),
    {
      kind: "enum", id: rowId(actorId, component.id, "quality"), label: "Quality", value: capture.quality,
      defaultValue: "fast",
      options: RENDER_TARGET_CAPTURE_QUALITIES.map((value) => ({ value, label: RENDER_TARGET_CAPTURE_QUALITY_LABELS[value] })),
      description: "Full Quality renders like a camera here, with its own sun shadows, water refraction, post-processing and outlines. It differs only in planar water mirrors, and in which lights shine and which point and spot lights cast shadows when more ask than the device allows. It costs about a second camera, including its own sun shadow maps each captured frame: keep its Render Target at 512 × 512 or smaller, and turn off Capture Every Frame for images that rarely change. Scene Color targets only.",
      onChange: (value) => update("quality", value),
    },
    ...(["enabled", "captureEveryFrame", "captureOnlyActors"] as const).map((key): PropertyRow => ({
      kind: "boolean", id: rowId(actorId, component.id, key), label: humanizePropertyLabel(key), value: capture[key],
      defaultValue: key !== "captureOnlyActors",
      ...(key === "captureEveryFrame" ? { description: "Disable automatic captures and request captures from a NodeGraph." } : {}),
      ...(key === "captureOnlyActors" ? { description: "Capture only the actors in Capture Actors. An empty enabled list captures nothing." } : {}),
      onChange: (value) => update(key, value),
    })),
    ...([
      ["fieldOfView", "Field Of View", 1, 179], ["nearClip", "Near Clip", 0.001, 100000], ["farClip", "Far Clip", 0.002, 100000],
    ] as const).map(([key, label, min, max]): PropertyRow => ({
      kind: "number", id: rowId(actorId, component.id, key), label, value: capture[key], min, max,
      onChange: (value) => update(key, value),
    })),
  ];
}
