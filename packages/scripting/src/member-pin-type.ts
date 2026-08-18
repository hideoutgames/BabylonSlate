import {
  BOOL,
  COLOR,
  EXEC,
  FLOAT,
  INT,
  ROTATOR,
  STRING,
  TRANSFORM,
  VEC2,
  VEC3,
  VEC4,
  classRef,
  enumRef,
  objectRef,
  structRef,
  type PinType,
} from "./types";

function trimmedOrEmpty(value?: string): string {
  return value?.trim() ?? "";
}

function constraintClassId(typeClassId?: string): string {
  const trimmed = trimmedOrEmpty(typeClassId);
  return trimmed ? trimmed : "BObject";
}

/** Convert a Class/function picker id plus optional typeClassId into a pin type. */
export function pinTypeForMember(
  typeId: string | undefined,
  typeClassId?: string,
): PinType {
  switch (typeId) {
    case "exec":
      return EXEC;
    case "bool":
      return BOOL;
    case "int":
      return INT;
    case "string":
      return STRING;
    case "vec2":
      return VEC2;
    case "vec3":
      return VEC3;
    case "vec4":
      return VEC4;
    case "rotator":
      return ROTATOR;
    case "color":
      return COLOR;
    case "transform":
      return TRANSFORM;
    case "object":
      return objectRef(constraintClassId(typeClassId));
    case "class":
      return classRef(constraintClassId(typeClassId));
    case "struct":
      return structRef(trimmedOrEmpty(typeClassId));
    case "enum":
      return enumRef(trimmedOrEmpty(typeClassId));
    default:
      return FLOAT;
  }
}

export function keepsTypeClassId(typeId: string | undefined): boolean {
  return (
    typeId === "object" ||
    typeId === "class" ||
    typeId === "struct" ||
    typeId === "enum"
  );
}

export function isStructOrEnumTypeId(typeId: string | undefined): boolean {
  return typeId === "struct" || typeId === "enum";
}

export function isClassConstraintTypeId(typeId: string | undefined): boolean {
  return typeId === "object" || typeId === "class";
}

/** Map a live pin type back to a PinTypePicker id. */
export function typeIdFromPinType(type: PinType): string {
  switch (type.kind) {
    case "exec":
      return "exec";
    case "bool":
    case "int":
    case "float":
    case "string":
    case "vec2":
    case "vec3":
    case "vec4":
    case "rotator":
    case "color":
    case "transform":
      return type.kind;
    case "objectRef":
    case "actorRef":
      return "object";
    case "classRef":
      return "class";
    case "structRef":
      return "struct";
    case "enumRef":
      return "enum";
    default:
      return "float";
  }
}

/** Class constraint or Structure/Enum guid stored on `typeClassId`. */
export function typeClassIdFromPinType(type: PinType): string | undefined {
  switch (type.kind) {
    case "objectRef":
    case "actorRef":
    case "classRef":
      return type.classId || undefined;
    case "structRef":
    case "enumRef":
      return type.guid.trim() || undefined;
    default:
      return undefined;
  }
}
