import { pinColorVar } from "@babylonslate/ui/lib/data-types";

export const PIN_PICKER_TYPES = [
  "bool",
  "int",
  "float",
  "string",
  "enum",
  "vec2",
  "vec3",
  "vec4",
  "rotator",
  "quat",
  "color",
  "transform",
  "object",
  "actor",
  "class",
  "asset",
  "struct",
  "wildcard",
] as const;

export type PinPickerType = (typeof PIN_PICKER_TYPES)[number];

/** Function signature picker: exec plus the Structure/data pin types. */
export const FUNCTION_PIN_PICKER_TYPES = ["exec", ...PIN_PICKER_TYPES] as const;

export type FunctionPinPickerType = (typeof FUNCTION_PIN_PICKER_TYPES)[number];

export const PIN_PICKER_LABEL: Record<string, string> = {
  exec: "Exec",
  bool: "Bool",
  int: "Int",
  float: "Float",
  string: "String",
  enum: "Enum",
  vec2: "Vector 2",
  vec3: "Vector 3",
  vec4: "Vector 4",
  rotator: "Rotator",
  quat: "Quaternion",
  color: "Color",
  transform: "Transform",
  object: "Object",
  actor: "Actor",
  class: "Class",
  asset: "Asset",
  struct: "Struct",
  wildcard: "Wildcard",
};

const PIN_PICKER_KIND: Record<PinPickerType, string> = {
  bool: "bool",
  int: "int",
  float: "float",
  string: "string",
  enum: "enumRef",
  vec2: "vec2",
  vec3: "vec3",
  vec4: "vec4",
  rotator: "rotator",
  quat: "quat",
  color: "color",
  transform: "transform",
  object: "objectRef",
  actor: "actorRef",
  class: "classRef",
  asset: "assetRef",
  struct: "structRef",
  wildcard: "boxedWildcard",
};

export function pinPickerColorVar(type: string): string {
  const kind =
    type in PIN_PICKER_KIND
      ? PIN_PICKER_KIND[type as PinPickerType]
      : type;
  return pinColorVar(kind);
}

export function pinPickerLabel(type: string): string {
  if (type in PIN_PICKER_LABEL) {
    return PIN_PICKER_LABEL[type as PinPickerType];
  }
  return type;
}

export function isPinPickerType(value: string): value is PinPickerType {
  return (PIN_PICKER_TYPES as readonly string[]).includes(value);
}

/** Object/class constraints and Structure/Enum guids share `typeClassId`. */
export function pinPickerKeepsTypeClassId(type: string): boolean {
  return (
    type === "object" ||
    type === "actor" ||
    type === "class" ||
    type === "asset" ||
    type === "struct" ||
    type === "enum"
  );
}

/** Content Browser types stored on `typeClassId` when the picker type is Asset. */
export const ASSET_REF_PICKER_TYPES = [
  "Audio",
  "AudioChannel",
  "AudioMixer",
  "Texture",
  "Material",
  "Font",
  "Sprite",
  "SpriteAnimation",
  "ParticleEmitter",
  "ParticleSystem",
  "Model",
  "Animation",
] as const;
