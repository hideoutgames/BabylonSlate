import { pinColorVar } from "@haptic/ui/lib/data-types";

export const PIN_PICKER_TYPES = [
  "bool",
  "int",
  "float",
  "string",
  "tag",
  "tagContainer",
  "enum",
  "vec2",
  "vec3",
  "vec4",
  "rotator",
  "quat",
  "color",
  "transform",
  "object",
  "class",
  "asset",
  "struct",
  "wildcard",
] as const;

export type PinPickerType = (typeof PIN_PICKER_TYPES)[number];

/** Function signature picker: exec plus the Structure/data pin types. */
export const FUNCTION_PIN_PICKER_TYPES = ["exec", ...PIN_PICKER_TYPES] as const;

export const PIN_PICKER_LABEL: Record<string, string> = {
  exec: "Exec",
  bool: "Bool",
  int: "Int",
  float: "Float",
  string: "String",
  tag: "Tag",
  tagContainer: "TagContainer",
  enum: "Enum",
  vec2: "Vector 2",
  vec3: "Vector 3",
  vec4: "Vector 4",
  rotator: "Rotator",
  quat: "Quaternion",
  color: "Color",
  transform: "Transform",
  texture: "Texture",
  object: "Object",
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
  tag: "tag",
  tagContainer: "structRef",
  enum: "enumRef",
  vec2: "vec2",
  vec3: "vec3",
  vec4: "vec4",
  rotator: "rotator",
  quat: "quat",
  color: "color",
  transform: "transform",
  object: "objectRef",
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

/** What a type's `typeClassId` names: a class, an asset type, or a Structure / Enum guid. */
function typeClassIdKind(type: string): string | undefined {
  switch (type) {
    case "object":
    case "class":
      return "class";
    case "asset":
    case "struct":
    case "enum":
      return type;
    default:
      return undefined;
  }
}

/**
 * Object/class constraints, asset types and Structure/Enum guids share
 * `typeClassId`. A type change keeps it only when both types read it the same
 * way (Object to Class keeps a class); Object to Enum must not keep a class id.
 */
export function pinPickerKeepsTypeClassId(from: string, to: string): boolean {
  const kind = typeClassIdKind(to);
  return kind !== undefined && kind === typeClassIdKind(from);
}

/** Content Browser types stored on `typeClassId` when the picker type is Asset. */
export const ASSET_REF_PICKER_TYPES = [
  "DataDefinition",
  "DataTree",
  "InputAction",
  "InputAxis",
  "Audio",
  "AudioChannel",
  "AudioMixer",
  "Texture",
  "RenderTarget",
  "RenderTargetTexture",
  "Material",
  "MaterialInstance",
  "Font",
  "Sprite",
  "SpriteAnimation",
  "ParticleEmitter",
  "ParticleGraph",
  "ParticleSystem",
  "Water",
  "Model",
  "Animation",
] as const;
