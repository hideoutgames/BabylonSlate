import {
  BOOL,
  BOXED_WILDCARD,
  COLOR,
  EXEC,
  FLOAT,
  INT,
  QUAT,
  ROTATOR,
  STRING,
  TRANSFORM,
  VEC2,
  VEC3,
  VEC4,
  actorRef,
  arrayOf,
  assetRef,
  classRef,
  enumRef,
  mapOf,
  objectRef,
  structRef,
  type ClassHierarchy,
  type PinType,
} from "./types";
import { resultKindForClassId } from "./type-context";

function trimmedOrEmpty(value?: string): string {
  return value?.trim() ?? "";
}

function constraintClassId(typeClassId?: string): string {
  const trimmed = trimmedOrEmpty(typeClassId);
  return trimmed ? trimmed : "BObject";
}

export type VariableContainer = "single" | "array" | "map";

export function normalizeVariableContainer(value: unknown): VariableContainer {
  return value === "array" || value === "map" ? value : "single";
}

export type VariableTypeSpec = {
  typeId?: string;
  typeClassId?: string;
  container?: VariableContainer | string;
  keyTypeId?: string;
  keyTypeClassId?: string;
  hierarchy?: ClassHierarchy;
};

/** Convert a Class/function picker id plus optional typeClassId into a pin type. */
export function pinTypeForMember(
  typeId: string | undefined,
  typeClassId?: string,
  hierarchy?: ClassHierarchy,
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
    case "quat":
      return QUAT;
    case "color":
      return COLOR;
    case "transform":
      return TRANSFORM;
    case "object": {
      const classId = constraintClassId(typeClassId);
      return resultKindForClassId(classId, hierarchy) === "actorRef"
        ? actorRef(classId)
        : objectRef(classId);
    }
    case "actor":
      return actorRef(trimmedOrEmpty(typeClassId) || "Actor");
    case "class":
      return classRef(constraintClassId(typeClassId));
    case "asset":
      return assetRef(trimmedOrEmpty(typeClassId));
    case "struct":
      return structRef(trimmedOrEmpty(typeClassId));
    case "enum":
      return enumRef(trimmedOrEmpty(typeClassId));
    case "wildcard":
      return BOXED_WILDCARD;
    default:
      return FLOAT;
  }
}

/** Wrap a member value type with Single / Array / Map. */
export function pinTypeForVariable(spec: VariableTypeSpec): PinType {
  const inner = pinTypeForMember(spec.typeId, spec.typeClassId, spec.hierarchy);
  const container = normalizeVariableContainer(spec.container);
  if (container === "array") return arrayOf(inner);
  if (container === "map") {
    return mapOf(
      pinTypeForMember(
        spec.keyTypeId ?? "string",
        spec.keyTypeClassId,
        spec.hierarchy,
      ),
      inner,
    );
  }
  return inner;
}

export function keepsTypeClassId(typeId: string | undefined): boolean {
  return (
    typeId === "object" ||
    typeId === "actor" ||
    typeId === "class" ||
    typeId === "asset" ||
    typeId === "struct" ||
    typeId === "enum"
  );
}

export function isStructOrEnumTypeId(typeId: string | undefined): boolean {
  return typeId === "struct" || typeId === "enum";
}

export function isClassConstraintTypeId(typeId: string | undefined): boolean {
  return typeId === "object" || typeId === "actor" || typeId === "class";
}

export function isAssetTypeId(typeId: string | undefined): boolean {
  return typeId === "asset";
}

/** Map a live pin type back to a PinTypePicker id (unwraps one Array/Map level). */
export function typeIdFromPinType(type: PinType): string {
  switch (type.kind) {
    case "array":
      return typeIdFromPinType(type.element);
    case "map":
      return typeIdFromPinType(type.value);
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
    case "quat":
    case "color":
    case "transform":
      return type.kind;
    case "objectRef":
      return "object";
    case "actorRef":
      return "actor";
    case "classRef":
      return "class";
    case "assetRef":
      return "asset";
    case "structRef":
      return "struct";
    case "enumRef":
      return "enum";
    case "boxedWildcard":
      return "wildcard";
    default:
      return "float";
  }
}

/** Class constraint, Structure/Enum guid, or Content Browser asset type. */
export function typeClassIdFromPinType(type: PinType): string | undefined {
  switch (type.kind) {
    case "array":
      return typeClassIdFromPinType(type.element);
    case "map":
      return typeClassIdFromPinType(type.value);
    case "objectRef":
    case "actorRef":
    case "classRef":
      return type.classId || undefined;
    case "assetRef":
      return type.assetType.trim() || undefined;
    case "structRef":
    case "enumRef":
      return type.guid.trim() || undefined;
    default:
      return undefined;
  }
}

export function variableTypeFromPinType(type: PinType): {
  typeId: string;
  typeClassId?: string;
  container: VariableContainer;
  keyTypeId?: string;
  keyTypeClassId?: string;
} {
  if (type.kind === "array") {
    const inner = variableTypeFromPinType(type.element);
    return {
      typeId: inner.typeId,
      ...(inner.typeClassId ? { typeClassId: inner.typeClassId } : {}),
      container: "array",
    };
  }
  if (type.kind === "map") {
    const value = variableTypeFromPinType(type.value);
    const key = variableTypeFromPinType(type.key);
    return {
      typeId: value.typeId,
      ...(value.typeClassId ? { typeClassId: value.typeClassId } : {}),
      container: "map",
      keyTypeId: key.typeId,
      ...(key.typeClassId ? { keyTypeClassId: key.typeClassId } : {}),
    };
  }
  const typeId = typeIdFromPinType(type);
  const typeClassId = typeClassIdFromPinType(type);
  return {
    typeId,
    ...(typeClassId ? { typeClassId } : {}),
    container: "single",
  };
}
