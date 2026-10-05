import { SCALABILITY_ENUMS, SCALABILITY_STRUCTS } from "./scalability-types";
import { ENGINE_EASING_CURVE_ENUM_ID, EASING_CURVES, ENGINE_TWEEN_SPACE_ENUM_ID, TWEEN_SPACES } from "@babylonslate/core";
export { ENGINE_EASING_CURVE_ENUM_ID, ENGINE_TWEEN_SPACE_ENUM_ID } from "@babylonslate/core";
import { INPUT_KEYS, SCENE_STREAMING_STATES, ENGINE_RENDER_TARGET_MODE_ENUM_ID, RENDER_TARGET_MODES } from "@babylonslate/core";
import { ENGINE_TEXT2D_APPEAR_MODE_ENUM_ID, ENGINE_TEXT2D_APPEAR_TRANSITION_ENUM_ID, ENGINE_TEXT2D_APPEAR_START_ENUM_ID,
  TEXT2D_APPEAR_MODES, TEXT2D_APPEAR_TRANSITIONS, TEXT2D_APPEAR_STARTS } from "@babylonslate/core";
export { ENGINE_RENDER_TARGET_MODE_ENUM_ID } from "@babylonslate/core";
/** Engine enum/struct registry (stable ids, not Content Browser assets). */

import type { EnumMember, StructField } from "./type-assets";

export const ENGINE_INPUT_TYPE_STRUCT_ID = "engine:InputType";
export const ENGINE_INPUT_BINDING_STRUCT_ID = "engine:InputBinding";
export const ENGINE_KEY_ENUM_ID = "engine:Key";
export const ENGINE_INPUT_COMPONENT_ENUM_ID = "engine:InputComponent";
export const ENGINE_SCENE_STREAMING_STATE_ENUM_ID = "engine:SceneStreamingState";

export const ENGINE_COLLISION_CHANNEL_ENUM_ID = "engine:CollisionChannel";
export const ENGINE_HIT_RESULT_STRUCT_ID = "engine:HitResult";

export const COLLISION_CHANNEL_MEMBERS = [
  "All",
  "WorldStatic",
  "WorldDynamic",
  "Pawn",
  "Visibility",
] as const;

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
    id: ENGINE_KEY_ENUM_ID,
    name: "Key",
    members: INPUT_KEYS.map(({ key }, value) => ({ name: key, value })),
  },
  {
    id: ENGINE_INPUT_COMPONENT_ENUM_ID,
    name: "Input Component",
    members: ["X", "Y"].map((name, value) => ({ name, value })),
  },
];

/** Engine user-style structs. Pin-kind math types stay first-class. */
export const ENGINE_STRUCTS: readonly EngineStruct[] = [
  ...SCALABILITY_STRUCTS,
  {
    id: ENGINE_HIT_RESULT_STRUCT_ID,
    name: "Hit Result",
    fields: [
      { name: "Hit", typeId: "bool" },
      { name: "Location", typeId: "vec3" },
      { name: "Normal", typeId: "vec3" },
      { name: "Actor", typeId: "actor" },
      { name: "Distance", typeId: "float" },
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
