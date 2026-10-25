import { parseRagdollProperties, type SerializedComponent } from "@haptic/core";
import { humanizePropertyLabel, type PropertyRow } from "@haptic/editor-kit";
import {
  parseColliderProperties,
  type ColliderShape,
} from "@haptic/physics";
import { collisionRows } from "./collision-property-rows";
import {
  asNumber,
  genericRows,
  guidValue,
  rowId,
  sliderRow,
  type ComponentPropertyContext,
  type ComponentPropertyUpdate,
} from "./component-property-row-helpers";
import { fittedColliderShape } from "./fitted-collider";

const MOTION_TYPES = ["static", "kinematic", "dynamic"] as const;
const SHAPE_KINDS_3D = ["box", "sphere", "capsule", "cylinder"] as const;
const SHAPE_KINDS_2D = ["box2d", "circle", "capsule2d"] as const;
const POINT_CLOUD_KINDS = new Set(["convex", "mesh", "polygon", "chain"]);
const MIN_RIGID_BODY_MASS = 0.001;
/** Physics rejects zero-sized primitives; sizes are unsigned. */
const MIN_COLLIDER_EXTENT = 0.001;
const colliderExtent = (value: number) =>
  Math.max(MIN_COLLIDER_EXTENT, Math.abs(value));

/** Authored rows keep object-per-vertex mesh data; physics packs it when parsing. */
function defaultShape(kind: string):
  | Exclude<ColliderShape, { kind: "mesh" }>
  | { kind: "mesh"; vertices: never[]; indices: never[] } {
  switch (kind) {
    case "sphere":
      return { kind: "sphere", radius: 0.5 };
    case "capsule":
      return { kind: "capsule", radius: 0.25, halfHeight: 0.5 };
    case "cylinder":
      return { kind: "cylinder", radius: 0.5, height: 1 };
    case "box2d":
      return { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } };
    case "circle":
      return { kind: "circle", radius: 0.5 };
    case "capsule2d":
      return { kind: "capsule2d", radius: 0.25, halfHeight: 0.5 };
    case "convex":
      return { kind: "convex", points: [] };
    case "mesh":
      return { kind: "mesh", vertices: [], indices: [] };
    case "polygon":
      return { kind: "polygon", points: [] };
    case "chain":
      return { kind: "chain", points: [] };
    case "box":
    default:
      return { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } };
  }
}

function colliderShapeRows(
  actorId: string,
  component: SerializedComponent,
  update: (property: string, value: unknown) => void,
  physicsWorld: "3d" | "2d",
  siblings: readonly SerializedComponent[],
): PropertyRow[] {
  const parsed = parseColliderProperties(component.properties, physicsWorld, { validation: "authoring" });
  const shape = parsed.shape;
  const kinds: string[] =
    physicsWorld === "2d" ? [...SHAPE_KINDS_2D] : [...SHAPE_KINDS_3D];
  if (!kinds.includes(shape.kind)) {
    kinds.push(shape.kind);
  }
  const rows: PropertyRow[] = [
    {
      kind: "enum",
      id: rowId(actorId, component.id, "shape-kind"),
      label: "Shape Kind",
      value: shape.kind,
      options: kinds.map((kind) => ({ value: kind, label: humanizePropertyLabel(kind) })),
      onChange: (next) =>
        update("shape", fittedColliderShape(next, siblings) ?? defaultShape(next)),
    },
  ];

  if (shape.kind === "box") {
    rows.push({
      kind: "vector3",
      id: rowId(actorId, component.id, "shape-half-extents"),
      label: "Half Extents",
      value: [shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z],
      onChange: (value) =>
        update("shape", {
          kind: "box",
          halfExtents: {
            x: colliderExtent(value[0]),
            y: colliderExtent(value[1]),
            z: colliderExtent(value[2]),
          },
        }),
    });
  } else if (shape.kind === "box2d") {
    // Play sizes a Box 2D from the actor's first Sprite collision box whenever that Sprite has an asset.
    const spriteSizesBox = guidValue(
      siblings.find((sibling) => sibling.classId === "SpriteComponent")?.properties.assetGuid,
    ) !== null;
    rows.push({
      kind: "vector3",
      id: rowId(actorId, component.id, "shape-half-extents"),
      label: "Half Extents",
      value: [shape.halfExtents.x, shape.halfExtents.y, 0],
      axes: ["X", "Y"],
      disabled: spriteSizesBox,
      description: spriteSizesBox
        ? "No effect while the actor's Sprite has an asset: the Sprite's Collision box sets the size."
        : undefined,
      onChange: (value) =>
        update("shape", {
          kind: "box2d",
          halfExtents: { x: colliderExtent(value[0]), y: colliderExtent(value[1]) },
        }),
    });
  } else if (shape.kind === "sphere" || shape.kind === "circle") {
    rows.push({
      kind: "number",
      id: rowId(actorId, component.id, "shape-radius"),
      label: "Radius",
      value: shape.radius,
      min: MIN_COLLIDER_EXTENT,
      onChange: (radius) => update("shape", { ...shape, radius }),
    });
  } else if (shape.kind === "capsule" || shape.kind === "capsule2d") {
    rows.push(
      {
        kind: "number",
        id: rowId(actorId, component.id, "shape-radius"),
        label: "Radius",
        value: shape.radius,
        min: MIN_COLLIDER_EXTENT,
        onChange: (radius) => update("shape", { ...shape, radius }),
      },
      {
        kind: "number",
        id: rowId(actorId, component.id, "shape-half-height"),
        label: "Half Height",
        value: shape.halfHeight,
        min: 0,
        onChange: (halfHeight) => update("shape", { ...shape, halfHeight }),
      },
    );
  } else if (shape.kind === "cylinder") {
    rows.push(
      {
        kind: "number",
        id: rowId(actorId, component.id, "shape-radius"),
        label: "Radius",
        value: shape.radius,
        min: MIN_COLLIDER_EXTENT,
        onChange: (radius) => update("shape", { ...shape, radius }),
      },
      {
        kind: "number",
        id: rowId(actorId, component.id, "shape-height"),
        label: "Height",
        value: shape.height,
        min: MIN_COLLIDER_EXTENT,
        onChange: (height) => update("shape", { ...shape, height }),
      },
    );
  } else if (!POINT_CLOUD_KINDS.has(shape.kind)) {
    // Unknown primitive — no extra numeric fields.
  }

  return rows;
}

export function ragdollPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const parsed = parseRagdollProperties(component.properties);
  const defaults = parseRagdollProperties({});
  const number = (
    property: "totalMass" | "radius" | "angularLimit" | "linearDamping" | "angularDamping" | "friction" | "restitution",
    label: string,
    min: number,
    description?: string,
    max?: number,
  ): PropertyRow => ({
    kind: "number", id: rowId(actorId, component.id, property), label,
    value: parsed[property], defaultValue: defaults[property], min, max, description,
    onChange: (value) => update(property, Math.min(max ?? Infinity, Math.max(min, value))),
  });
  return [
    {
      kind: "boolean", id: rowId(actorId, component.id, "enabled"), label: "Enabled",
      value: parsed.enabled, defaultValue: false,
      disabled: context.physicsWorld !== "3d",
      description: context.physicsWorld === "3d"
        ? "Requires a Model with a skeleton. Enabling captures its current animation pose for physics; disabling resumes animation."
        : "Ragdoll requires a 3D physics scene.",
      onChange: (value) => update("enabled", value),
    },
    number("totalMass", "Total Mass", 0.001, "Mass shared across the selected bones, in kilograms."),
    number("radius", "Bone Radius", 0.001, "Collision radius of each bone, in scene units."),
    { ...number("angularLimit", "Angular Limit", 0, "Maximum rotation from the captured pose.", 180), unit: "deg" },
    number("linearDamping", "Linear Damping", 0),
    number("angularDamping", "Angular Damping", 0),
    number("friction", "Friction", 0),
    number("restitution", "Restitution", 0, undefined, 1),
    ...collisionRows(actorId, component, update, context),
  ];
}

export function rigidBodyPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  const motionType =
    component.properties.motionType === "static" ||
    component.properties.motionType === "kinematic" ||
    component.properties.motionType === "dynamic"
      ? component.properties.motionType
      : "dynamic";
  const motionRow: PropertyRow = {
    kind: "enum",
    id: rowId(actorId, component.id, "motionType"),
    label: "Motion Type",
    value: motionType,
    options: MOTION_TYPES.map((type) => ({ value: type, label: type })),
    onChange: (next) => update("motionType", next),
  };
  const skip = new Set([
    "motionType",
    "mass",
    "gravityScale",
    "linearDamping",
    "angularDamping",
  ]);
  // A static body never moves, so mass, gravity and damping do nothing.
  if (motionType === "static") {
    return [motionRow, ...genericRows(actorId, component, update, skip)];
  }
  return [
    motionRow,
    {
      kind: "number",
      id: rowId(actorId, component.id, "mass"),
      label: "Mass",
      value: asNumber(component.properties.mass, 1),
      // Physics needs a positive mass; zero or negative would vanish (NaN).
      min: MIN_RIGID_BODY_MASS,
      onChange: (next) => update("mass", Math.max(MIN_RIGID_BODY_MASS, next)),
    },
    sliderRow(
      actorId,
      component.id,
      "gravityScale",
      "Gravity Scale",
      asNumber(component.properties.gravityScale, 1),
      0,
      10,
      update,
    ),
    sliderRow(
      actorId,
      component.id,
      "linearDamping",
      "Linear Damping",
      asNumber(component.properties.linearDamping, 0),
      0,
      10,
      update,
    ),
    sliderRow(
      actorId,
      component.id,
      "angularDamping",
      "Angular Damping",
      asNumber(component.properties.angularDamping, 0),
      0,
      10,
      update,
    ),
    ...genericRows(actorId, component, update, skip),
  ];
}

export function colliderPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return [
    ...colliderShapeRows(
      actorId,
      component,
      update,
      context.physicsWorld,
      context.actorComponents?.(actorId) ?? [],
    ),
    sliderRow(
      actorId,
      component.id,
      "friction",
      "Friction",
      asNumber(component.properties.friction, 0.5),
      0,
      1,
      update,
    ),
    sliderRow(
      actorId,
      component.id,
      "restitution",
      "Restitution",
      asNumber(component.properties.restitution, 0),
      0,
      1,
      update,
    ),
    ...collisionRows(actorId, component, update, context),
    {
      kind: "boolean",
      id: rowId(actorId, component.id, "isTrigger"),
      label: "Is Trigger",
      value: component.properties.isTrigger === true,
      defaultValue: false,
      onChange: (next) => update("isTrigger", next),
    },
    {
      kind: "boolean",
      id: rowId(actorId, component.id, "renderInGame"),
      label: "Render In Game",
      value: component.properties.renderInGame === true,
      defaultValue: false,
      onChange: (next) => update("renderInGame", next),
    },
    ...genericRows(
      actorId,
      component,
      update,
      new Set([
        "shape",
        "friction",
        "restitution",
        "collisionPreset",
        "layer",
        "mask",
        "overlapMask",
        "isTrigger",
        "renderInGame",
      ]),
    ),
  ];
}
