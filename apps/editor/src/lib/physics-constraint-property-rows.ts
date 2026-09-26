import {
  eulerDegreesToQuaternion,
  quaternionToEulerDegrees,
  type SerializedComponent,
} from "@babylonslate/core";
import type { PropertyRow } from "@babylonslate/editor-kit";
import { parseConstraintProperties } from "@babylonslate/physics";
import type { ComponentPropertyContext } from "./component-property-rows";

/** Scene and Class authoring share the same serialized constraint properties. */
export function physicsConstraintPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: (property: string, value: unknown) => void,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const parsed = parseConstraintProperties(component.properties, context.physicsWorld);
  const defaults = parseConstraintProperties({}, context.physicsWorld);
  const twoD = context.physicsWorld === "2d";
  const id = (key: string) => `${actorId}-${component.id}-${key}`;
  const directionProblem = (key: "axisA" | "axisB" | "referenceAxisA" | "referenceAxisB"): string | undefined => {
    const value = parsed[key];
    const length = Math.hypot(value.x, value.y, value.z);
    if (length < 1e-7) return "Cannot simulate with a zero direction. Enter a nonzero direction or Reset.";
    if (key === "axisA" || key === "axisB") {
      if (twoD && (Math.abs(value.x / length) > 1e-7 || Math.abs(value.y / length) > 1e-7)) {
        return "2D hinge axes must point along Z. Set X and Y to 0 and Z to 1.";
      }
      if (twoD && parsed.axisA.z * parsed.axisB.z < 0) return "Both 2D hinge axes must point in the same direction. Use positive Z for both axes.";
      return undefined;
    }
    const axis = key === "referenceAxisA" ? parsed.axisA : parsed.axisB;
    const axisLength = Math.hypot(axis.x, axis.y, axis.z);
    if (axisLength < 1e-7) return undefined;
    const crossLength = Math.hypot(axis.y * value.z - axis.z * value.y, axis.z * value.x - axis.x * value.z, axis.x * value.y - axis.y * value.x);
    if (crossLength / axisLength < 1e-7) return "Cannot simulate when the reference direction is parallel to the hinge axis. Choose a perpendicular direction.";
    return undefined;
  };
  const vectorRow = (
    key: "anchorA" | "anchorB" | "axisA" | "axisB" | "referenceAxisA" | "referenceAxisB",
    label: string,
    description: string,
  ): PropertyRow => ({
    kind: "vector3",
    id: id(key),
    label,
    description: key === "anchorA" || key === "anchorB"
      ? twoD && Math.abs(parsed[key].z) > 1e-7
        ? `${description} 2D anchors must have Z = 0; editing either coordinate corrects Z.`
        : description
      : directionProblem(key) ?? description,
    value: [parsed[key].x, parsed[key].y, parsed[key].z],
    defaultValue: [defaults[key].x, defaults[key].y, defaults[key].z],
    axes: twoD && (key === "anchorA" || key === "anchorB") ? ["X", "Y"] : ["X", "Y", "Z"],
    onChange: (value) => update(key, { x: value[0], y: value[1], z: twoD && (key === "anchorA" || key === "anchorB") ? 0 : value[2] }),
  });
  const rows: PropertyRow[] = [
    {
      kind: "boolean", id: id("enabled"), label: "Enabled",
      value: parsed.enabled, defaultValue: true,
      description: "Connects this actor's physics body to the target body during Play. Both actors need collision; at least one must be dynamic.",
      onChange: (value) => update("enabled", value),
    },
    {
      kind: "asset", id: id("targetActorId"), label: "Target Actor",
      value: parsed.targetActorId || null, defaultValue: null,
      displayLabel: parsed.targetActorId
        ? context.actorLabel?.(parsed.targetActorId) ?? "Missing Actor"
        : undefined,
      displayType: parsed.targetActorId ? "Actor" : undefined,
      visual: { classId: "Actor", family: "class" },
      disabled: !context.onPickActor,
      description: context.onPickActor
        ? "Choose another physics actor in this scene. None leaves the constraint unconnected."
        : "Choose the target in Scene Details after placing this Class in a scene.",
      onPick: () => context.onPickActor?.(component.id),
      onChange: (value) => update("targetActorId", value ?? ""),
    },
    {
      kind: "enum", id: id("kind"), label: "Constraint Type", value: parsed.kind,
      options: [
        { value: "fixed", label: "Fixed" },
        { value: "ballSocket", label: twoD ? "Pivot" : "Ball Socket" },
        { value: "hinge", label: "Hinge" },
        ...(!twoD || parsed.kind === "distance" ? [{ value: "distance", label: "Distance", disabled: twoD }] : []),
      ],
      description: twoD && parsed.kind === "distance"
        ? "Distance constraints require 3D physics. Choose Fixed, Pivot, or Hinge for this scene."
        : "Fixed locks rotation. Ball Socket / Pivot lets the bodies rotate. Hinge rotates around one axis.",
      onChange: (value) => update("kind", value),
    },
    {
      kind: "boolean", id: id("collideConnected"), label: "Collide Connected",
      value: parsed.collideConnected, defaultValue: false,
      onChange: (value) => update("collideConnected", value),
    },
    vectorRow("anchorA", "Local Anchor", "Connection point in this body's local coordinates, in scene units."),
    vectorRow("anchorB", "Target Local Anchor", "Connection point in the target body's local coordinates, in scene units."),
  ];
  if (parsed.kind === "fixed") {
    for (const key of ["frameA", "frameB"] as const) {
      const frame = parsed[key];
      const angles = quaternionToEulerDegrees([frame.x, frame.y, frame.z, frame.w]);
      rows.push({
        kind: "vector3", id: id(key),
        label: key === "frameA" ? "Local Frame Rotation" : "Target Frame Rotation",
        description: "Joint frame orientation relative to its body, in degrees.",
        value: twoD ? [angles[2], 0, 0] : angles,
        axes: twoD ? ["Z"] : ["X", "Y", "Z"],
        onChange: (value) => {
          const [x, y, z, w] = eulerDegreesToQuaternion(twoD ? [0, 0, value[0]] : [value[0], value[1], value[2]]);
          update(key, { x, y, z, w });
        },
      });
    }
  }
  if (parsed.kind === "hinge") {
    const directions = [
      ["axisA", "Local Hinge Axis", "Rotation axis in this body's local coordinates; use a nonzero direction."],
      ["axisB", "Target Hinge Axis", "Rotation axis in the target body's local coordinates; use a nonzero direction."],
      ["referenceAxisA", "Local Reference Axis", "Zero-angle direction, perpendicular to this body's hinge axis."],
      ["referenceAxisB", "Target Reference Axis", "Zero-angle direction, perpendicular to the target body's hinge axis."],
    ] as const;
    for (const [key, label, description] of directions) {
      if (!twoD || directionProblem(key)) rows.push(vectorRow(key, label, description));
    }
    rows.push({
      kind: "boolean", id: id("limitsEnabled"), label: "Angle Limits",
      value: parsed.limitsEnabled, defaultValue: false,
      description: twoD ? "Restricts relative rotation around Z, in degrees." : "Restricts relative rotation from the reference axes, in degrees.",
      onChange: (value) => update("limitsEnabled", value),
    });
    if (parsed.limitsEnabled) rows.push(
      {
        kind: "number", id: id("minAngle"), label: "Minimum Angle",
        value: parsed.minAngle, min: -180, max: Math.max(-180, Math.min(180, parsed.maxAngle)),
        description: "Degrees from -180 to 180; must not exceed Maximum Angle.",
        onChange: (value) => update("minAngle", Math.max(-180, Math.min(180, value, parsed.maxAngle))),
      },
      {
        kind: "number", id: id("maxAngle"), label: "Maximum Angle",
        value: parsed.maxAngle, min: Math.min(180, Math.max(-180, parsed.minAngle)), max: 180,
        description: "Degrees from -180 to 180; must not precede Minimum Angle.",
        onChange: (value) => update("maxAngle", Math.min(180, Math.max(-180, value, parsed.minAngle))),
      },
    );
  }
  if (parsed.kind === "distance" && !twoD) rows.push({
    kind: "number", id: id("distance"), label: "Distance",
    value: parsed.distance, min: 0,
    description: "Exact separation between the local anchors, in scene units.",
    onChange: (value) => update("distance", Math.max(0, value)),
  });
  return rows;
}
