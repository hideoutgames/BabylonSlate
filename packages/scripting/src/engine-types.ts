import { SCALABILITY_ENUMS, SCALABILITY_STRUCTS } from "./scalability-types";
import { ASSET_REGISTRY_ENUMS, ASSET_REGISTRY_STRUCTS } from "./asset-registry-types";
import { ENGINE_EASING_CURVE_ENUM_ID, EASING_CURVES, ENGINE_TWEEN_SPACE_ENUM_ID, TWEEN_SPACES } from "@haptic/core";
export { ENGINE_EASING_CURVE_ENUM_ID, ENGINE_TWEEN_SPACE_ENUM_ID } from "@haptic/core";
import {
  ASSET_LOAD_HANDLE_STATES, ASSET_LOAD_PRIORITIES, ASSET_LOAD_STATES,
  INPUT_KEYS, SCENE_STREAMING_STATES, ENGINE_RENDER_TARGET_MODE_ENUM_ID, RENDER_TARGET_MODES,
  TOUCH_PHASES, TOUCH_TYPES,
  CURVE_ALL_AXES,
} from "@haptic/core";
import { ENGINE_TEXT2D_APPEAR_MODE_ENUM_ID, ENGINE_TEXT2D_APPEAR_TRANSITION_ENUM_ID, ENGINE_TEXT2D_APPEAR_START_ENUM_ID,
  TEXT2D_APPEAR_MODES, TEXT2D_APPEAR_TRANSITIONS, TEXT2D_APPEAR_STARTS } from "@haptic/core";
export { ENGINE_RENDER_TARGET_MODE_ENUM_ID } from "@haptic/core";
import {
  CURVE_EXTRAPOLATIONS, CURVE_INTERPOLATIONS, ENGINE_CURVE_EXTRAPOLATION_ENUM_ID, ENGINE_CURVE_INTERPOLATION_ENUM_ID,
} from "@haptic/core";
export { ENGINE_CURVE_EXTRAPOLATION_ENUM_ID, ENGINE_CURVE_INTERPOLATION_ENUM_ID } from "@haptic/core";
import { ENGINE_TIMELINE_LOOP_MODE_ENUM_ID, TIMELINE_LOOP_MODE_LABELS, TIMELINE_LOOP_MODES } from "@haptic/core";
export { ENGINE_TIMELINE_LOOP_MODE_ENUM_ID } from "@haptic/core";
/** Engine enum/struct registry (stable ids, not Content Browser assets). */

import type { EnumMember, StructField } from "./type-assets";
import { structRef } from "./types";

export const ENGINE_TAG_CONTAINER_STRUCT_ID = "engine:TagContainer";
export const TAG_CONTAINER = structRef(ENGINE_TAG_CONTAINER_STRUCT_ID);

export const ENGINE_INPUT_TYPE_STRUCT_ID = "engine:InputType";
export const ENGINE_INPUT_BINDING_STRUCT_ID = "engine:InputBinding";
export const ENGINE_KEY_ENUM_ID = "engine:Key";
export const ENGINE_INPUT_COMPONENT_ENUM_ID = "engine:InputComponent";
export const ENGINE_TOUCH_STRUCT_ID = "engine:Touch";
export const ENGINE_TOUCH_PHASE_ENUM_ID = "engine:TouchPhase";
export const ENGINE_TOUCH_TYPE_ENUM_ID = "engine:TouchType";
export const ENGINE_SCENE_STREAMING_STATE_ENUM_ID = "engine:SceneStreamingState";
export const ENGINE_ASSET_LOAD_STATE_ENUM_ID = "engine:AssetLoadState";
export const ENGINE_ASSET_LOAD_HANDLE_STATE_ENUM_ID = "engine:AssetLoadHandleState";
export const ENGINE_ASSET_LOAD_PRIORITY_ENUM_ID = "engine:AssetLoadPriority";

export const ENGINE_COLLISION_CHANNEL_ENUM_ID = "engine:CollisionChannel";
export const ENGINE_NAV_OBSTACLE_KIND_ENUM_ID = "engine:NavObstacleKind";
export const ENGINE_HIT_RESULT_STRUCT_ID = "engine:HitResult";

export const ENGINE_INT_RANGE_STRUCT_ID = "engine:IntRange";
export const ENGINE_FLOAT_RANGE_STRUCT_ID = "engine:FloatRange";
export const ENGINE_VECTOR2_RANGE_STRUCT_ID = "engine:Vector2Range";
export const ENGINE_VECTOR_RANGE_STRUCT_ID = "engine:VectorRange";
export const ENGINE_ROTATOR_RANGE_STRUCT_ID = "engine:RotatorRange";
export const ENGINE_FLOAT_CURVE_STRUCT_ID = "engine:FloatCurve";
export const ENGINE_VECTOR_CURVE_STRUCT_ID = "engine:VectorCurve";
export const ENGINE_COLOR_CURVE_STRUCT_ID = "engine:ColorCurve";
export const ENGINE_FLOAT_CURVE_KEY_STRUCT_ID = "engine:FloatCurveKey";
export const ENGINE_VECTOR_CURVE_KEY_STRUCT_ID = "engine:VectorCurveKey";
export const ENGINE_COLOR_CURVE_KEY_STRUCT_ID = "engine:ColorCurveKey";

/** Range Structures by the value kind their Min and Max hold (`RangeKind` in core). */
export const ENGINE_RANGE_STRUCT_IDS = {
  int: ENGINE_INT_RANGE_STRUCT_ID,
  float: ENGINE_FLOAT_RANGE_STRUCT_ID,
  vec2: ENGINE_VECTOR2_RANGE_STRUCT_ID,
  vec3: ENGINE_VECTOR_RANGE_STRUCT_ID,
  rotator: ENGINE_ROTATOR_RANGE_STRUCT_ID,
} as const;

export type EngineRangeKind = keyof typeof ENGINE_RANGE_STRUCT_IDS;

/** The range kind of a built-in range Structure id, else undefined. */
export function rangeKindForStruct(structId: string | null | undefined): EngineRangeKind | undefined {
  if (!structId) return undefined;
  for (const [kind, id] of Object.entries(ENGINE_RANGE_STRUCT_IDS)) if (id === structId) return kind as EngineRangeKind;
  return undefined;
}

/** Curve Structures by the value kind their keys hold (`CurveKind` in core). */
export const ENGINE_CURVE_STRUCT_IDS = {
  float: ENGINE_FLOAT_CURVE_STRUCT_ID,
  vec3: ENGINE_VECTOR_CURVE_STRUCT_ID,
  color: ENGINE_COLOR_CURVE_STRUCT_ID,
} as const;

export type EngineCurveKind = keyof typeof ENGINE_CURVE_STRUCT_IDS;

/** The curve kind of a built-in curve Structure id, else undefined. */
export function curveKindForStruct(structId: string | null | undefined): EngineCurveKind | undefined {
  if (!structId) return undefined;
  for (const [kind, id] of Object.entries(ENGINE_CURVE_STRUCT_IDS)) if (id === structId) return kind as EngineCurveKind;
  return undefined;
}

/**
 * Query categories, stored by member name in graphs. `PhysicsQueryChannels.options` in the runtime is the only
 * place that gives them meaning: Static and Dynamic follow a body's motion, Character an actor with a Movement
 * component, Solid everything but trigger shapes, and Triggers only trigger shapes.
 */
export const COLLISION_CHANNEL_MEMBERS = [
  "All",
  "Static",
  "Dynamic",
  "Character",
  "Solid",
  "Triggers",
] as const;

export type CollisionChannel = (typeof COLLISION_CHANNEL_MEMBERS)[number];

export type EngineEnum = {
  id: string;
  name: string;
  members: EnumMember[];
};

export type EngineStruct = {
  id: string;
  name: string;
  fields: StructField[];
};

/** Built-in engine enums (`engine:CollisionChannel`, …). */
export const ENGINE_ENUMS: readonly EngineEnum[] = [
  ...SCALABILITY_ENUMS,
  ...ASSET_REGISTRY_ENUMS,
  { id: ENGINE_EASING_CURVE_ENUM_ID, name: "Easing Curve", members: EASING_CURVES.map((name, value) => ({ name, value })) },
  { id: ENGINE_TWEEN_SPACE_ENUM_ID, name: "Tween Space", members: TWEEN_SPACES.map((name, value) => ({ name, value })) },
  {
    id: ENGINE_TEXT2D_APPEAR_MODE_ENUM_ID,
    name: "Text 2D Appear Mode",
    members: TEXT2D_APPEAR_MODES.map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_TEXT2D_APPEAR_TRANSITION_ENUM_ID,
    name: "Text 2D Appear Transition",
    members: TEXT2D_APPEAR_TRANSITIONS.map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_TEXT2D_APPEAR_START_ENUM_ID,
    name: "Text 2D Appear Start",
    members: TEXT2D_APPEAR_STARTS.map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_SCENE_STREAMING_STATE_ENUM_ID,
    name: "Scene Streaming State",
    members: SCENE_STREAMING_STATES.map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_ASSET_LOAD_STATE_ENUM_ID,
    name: "Asset Load State",
    members: ASSET_LOAD_STATES.map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_ASSET_LOAD_HANDLE_STATE_ENUM_ID,
    name: "Asset Load Handle State",
    members: ASSET_LOAD_HANDLE_STATES.map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_ASSET_LOAD_PRIORITY_ENUM_ID,
    name: "Asset Load Priority",
    members: ASSET_LOAD_PRIORITIES.map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_RENDER_TARGET_MODE_ENUM_ID,
    name: "Render Target Mode",
    members: RENDER_TARGET_MODES.map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_COLLISION_CHANNEL_ENUM_ID,
    name: "Collision Channel",
    members: COLLISION_CHANNEL_MEMBERS.map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_NAV_OBSTACLE_KIND_ENUM_ID,
    name: "Nav Obstacle Kind",
    members: ["box", "cylinder"].map((name, value) => ({ name, value })),
  },

  {
    id: ENGINE_CURVE_INTERPOLATION_ENUM_ID,
    name: "Curve Interpolation",
    members: CURVE_INTERPOLATIONS.map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_CURVE_EXTRAPOLATION_ENUM_ID,
    name: "Curve Extrapolation",
    members: CURVE_EXTRAPOLATIONS.map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_TIMELINE_LOOP_MODE_ENUM_ID,
    name: "Timeline Loop Mode",
    members: TIMELINE_LOOP_MODES.map((mode, value) => ({ name: TIMELINE_LOOP_MODE_LABELS[mode], value })),
  },

  {
    id: ENGINE_KEY_ENUM_ID,
    name: "Key",
    members: INPUT_KEYS.map(({ key }, value) => ({ name: key, value })),
  },
  {
    id: ENGINE_INPUT_COMPONENT_ENUM_ID,
    name: "Input Component",
    members: ["X", "Y"].map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_TOUCH_PHASE_ENUM_ID,
    name: "Touch Phase",
    members: TOUCH_PHASES.map((name, value) => ({ name, value })),
  },
  {
    id: ENGINE_TOUCH_TYPE_ENUM_ID,
    name: "Touch Type",
    members: TOUCH_TYPES.map((name, value) => ({ name, value })),
  },
];

const ZERO_VECTOR2 = { x: 0, y: 0 };
const ZERO_VECTOR = { x: 0, y: 0, z: 0 };
const ZERO_ROTATOR = { pitch: 0, yaw: 0, roll: 0 };
const ZERO_COLOR = { x: 0, y: 0, z: 0, w: 0 };

function rangeStruct(id: string, name: string, typeId: string, min: unknown, max: unknown): EngineStruct {
  return {
    id, name,
    fields: [{ name: "Min", typeId, defaultValue: min }, { name: "Max", typeId, defaultValue: max }],
  };
}

/** Min is at most Max on every axis; the editors and loaders keep it so (`normalizeRange` in core). */
const RANGE_STRUCTS: readonly EngineStruct[] = [
  rangeStruct(ENGINE_INT_RANGE_STRUCT_ID, "Int Range", "int", 0, 1),
  rangeStruct(ENGINE_FLOAT_RANGE_STRUCT_ID, "Float Range", "float", 0, 1),
  rangeStruct(ENGINE_VECTOR2_RANGE_STRUCT_ID, "Vector 2 Range", "vec2", ZERO_VECTOR2, ZERO_VECTOR2),
  rangeStruct(ENGINE_VECTOR_RANGE_STRUCT_ID, "Vector Range", "vec3", ZERO_VECTOR, ZERO_VECTOR),
  rangeStruct(ENGINE_ROTATOR_RANGE_STRUCT_ID, "Rotator Range", "rotator", ZERO_ROTATOR, ZERO_ROTATOR),
];

function curveStructs(curveId: string, keyId: string, name: string, typeId: string, zero: unknown, extraKeyFields: EngineStruct["fields"] = []): EngineStruct[] {
  return [
    {
      id: keyId,
      name: `${name} Curve Key`,
      fields: [
        { name: "Time", typeId: "float", defaultValue: 0 },
        { name: "Value", typeId, defaultValue: zero },
        { name: "Interpolation", typeId: "enum", typeClassId: ENGINE_CURVE_INTERPOLATION_ENUM_ID, defaultValue: "auto" },
        { name: "ArriveTangent", typeId, defaultValue: zero },
        { name: "LeaveTangent", typeId, defaultValue: zero },
        ...extraKeyFields,
      ],
    },
    {
      id: curveId,
      name: `${name} Curve`,
      fields: [
        { name: "Keys", typeId: "struct", typeClassId: keyId, container: "array", defaultValue: [] },
        { name: "Before", typeId: "enum", typeClassId: ENGINE_CURVE_EXTRAPOLATION_ENUM_ID, defaultValue: "constant" },
        { name: "After", typeId: "enum", typeClassId: ENGINE_CURVE_EXTRAPOLATION_ENUM_ID, defaultValue: "constant" },
      ],
    },
  ];
}

/**
 * Keys are sorted by time (`normalizeCurve` in core); one key holds the whole value, with tangents per channel.
 * A Vector Curve Key's `Axes` (X 1, Y 2, Z 4; 7 all) lets it set only some axes, so each axis has its own keys.
 */
const CURVE_STRUCTS: readonly EngineStruct[] = [
  ...curveStructs(ENGINE_FLOAT_CURVE_STRUCT_ID, ENGINE_FLOAT_CURVE_KEY_STRUCT_ID, "Float", "float", 0),
  ...curveStructs(ENGINE_VECTOR_CURVE_STRUCT_ID, ENGINE_VECTOR_CURVE_KEY_STRUCT_ID, "Vector", "vec3", ZERO_VECTOR,
    [{ name: "Axes", typeId: "int", defaultValue: CURVE_ALL_AXES }]),
  ...curveStructs(ENGINE_COLOR_CURVE_STRUCT_ID, ENGINE_COLOR_CURVE_KEY_STRUCT_ID, "Color", "color", ZERO_COLOR),
];

/** Engine user-style structs. Pin-kind math types stay first-class. */
export const ENGINE_STRUCTS: readonly EngineStruct[] = [
  {
    id: ENGINE_TAG_CONTAINER_STRUCT_ID,
    name: "TagContainer",
    fields: [{ name: "Tags", typeId: "tag", container: "array", defaultValue: [] }],
  },
  ...SCALABILITY_STRUCTS,
  ...ASSET_REGISTRY_STRUCTS,
  {
    id: "engine:SaveGameInfo", name: "Save Game Info",
    fields: [
      { name: "projectId", typeId: "string" }, { name: "profile", typeId: "string" },
      { name: "slot", typeId: "string" }, { name: "definitionId", typeId: "string" },
      { name: "schemaVersion", typeId: "int" }, { name: "sequence", typeId: "int" },
      { name: "createdAt", typeId: "string" }, { name: "recovered", typeId: "bool" },
      { name: "status", typeId: "string" },
    ],
  },
  {
    id: ENGINE_HIT_RESULT_STRUCT_ID,
    name: "Hit Result",
    fields: [
      { name: "Hit", typeId: "bool" },
      { name: "Location", typeId: "vec3" },
      { name: "Normal", typeId: "vec3" },
      { name: "Actor", typeId: "object", typeClassId: "Actor" },
      { name: "Distance", typeId: "float" },
    ],
  },

  ...RANGE_STRUCTS,
  ...CURVE_STRUCTS,

  {
    // `TouchInput` in core; the input resolver produces this shape directly.
    id: ENGINE_TOUCH_STRUCT_ID,
    name: "Touch",
    fields: [
      { name: "Finger", typeId: "int", defaultValue: 0 },
      { name: "Position", typeId: "vec2", defaultValue: { x: 0, y: 0 } },
      { name: "Delta", typeId: "vec2", defaultValue: { x: 0, y: 0 } },
      { name: "Velocity", typeId: "vec2", defaultValue: { x: 0, y: 0 } },
      { name: "StartPosition", typeId: "vec2", defaultValue: { x: 0, y: 0 } },
      { name: "Pressure", typeId: "float", defaultValue: 0 },
      { name: "Phase", typeId: "enum", typeClassId: ENGINE_TOUCH_PHASE_ENUM_ID, defaultValue: "Began" },
      { name: "Type", typeId: "enum", typeClassId: ENGINE_TOUCH_TYPE_ENUM_ID, defaultValue: "Finger" },
    ],
  },

  {
    id: ENGINE_INPUT_TYPE_STRUCT_ID,
    name: "Input Type",
    fields: [
      { name: "Name", typeId: "string" },
      { name: "Asset", typeId: "asset" },
    ],
  },
  {
    id: ENGINE_INPUT_BINDING_STRUCT_ID,
    name: "Input Binding",
    fields: [
      {
        name: "Input",
        typeId: "struct",
        typeClassId: ENGINE_INPUT_TYPE_STRUCT_ID,
        defaultValue: { Name: "", Asset: "" },
      },
      { name: "Id", typeId: "string", defaultValue: "" },
      { name: "Label", typeId: "string", defaultValue: "" },
      {
        name: "Key",
        typeId: "enum",
        typeClassId: ENGINE_KEY_ENUM_ID,
        defaultValue: "None",
      },
      ...["Shift", "Ctrl", "Alt", "Meta"].map((name) => ({
        name,
        typeId: "bool",
        defaultValue: false,
      })),
      {
        name: "Component",
        typeId: "enum",
        typeClassId: ENGINE_INPUT_COMPONENT_ENUM_ID,
        defaultValue: "X",
      },
      { name: "DeadZone", typeId: "float", defaultValue: 0 },
      { name: "Scale", typeId: "float", defaultValue: 1 },
      { name: "Invert", typeId: "bool", defaultValue: false },
      { name: "Sensitivity", typeId: "float", defaultValue: 1 },
      { name: "DigitalValue", typeId: "float", defaultValue: 1 },
    ],
  },
];
