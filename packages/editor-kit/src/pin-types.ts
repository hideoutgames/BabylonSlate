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
  "color",
  "transform",
  "object",
  "class",
  "struct",
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
  color: "Color",
  transform: "Transform",
  object: "Object",
  class: "Class",
  struct: "Struct",
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
  color: "color",
  transform: "transform",
  object: "objectRef",
  class: "classRef",
  struct: "structRef",
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
    type === "class" ||
    type === "struct" ||
    type === "enum"
  );
}
