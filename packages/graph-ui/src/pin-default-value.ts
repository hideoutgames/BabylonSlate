import { normalizeTag, normalizeTagContainer } from "@babylonslate/core";
import {
  pinDefaultAsBoolean,
  pinDefaultAsNumber,
  pinDefaultAsString,
  pinDefaultAsVec3Tuple,
  pinDefaultAsVec4Tuple,
  vec3TupleToObject,
  vec4TupleToObject,
} from "@babylonslate/scripting";
import type { SerializedPin } from "./graph-types";
import { literalPinType } from "./pin-default-preview";

/** Shared controls use scalar/object values; numeric graph hosts persist arrays. */
export function inlinePinDefaultStorageValue(pin: SerializedPin, nodeData: Record<string, unknown>, value: unknown): unknown {
  const type = literalPinType(pin);
  if (!type) return undefined;
  const numericArray = nodeData.__material === true || typeof nodeData.__particleRole === "string";
  const bounded = (number: number) => Math.min(
    typeof pin.max === "number" && Number.isFinite(pin.max) ? pin.max : Infinity,
    Math.max(typeof pin.min === "number" && Number.isFinite(pin.min) ? pin.min : -Infinity, number),
  );
  switch (type.kind) {
    case "tag": return normalizeTag(value);
    case "bool": return pinDefaultAsBoolean(value);
    case "int": {
      const integer = Math.trunc(bounded(pinDefaultAsNumber(value)));
      return numericArray ? [integer] : integer;
    }
    case "float": {
      const number = bounded(pinDefaultAsNumber(value));
      return numericArray ? [number] : number;
    }
    case "string": case "enumRef": case "classRef": case "assetRef":
      return pinDefaultAsString(value);
    case "vec2": case "vec3": case "rotator": {
      const keys = type.kind === "rotator" ? ["pitch", "yaw", "roll"] as const
        : type.kind === "vec2" ? ["x", "y"] as const : ["x", "y", "z"] as const;
      const tuple = pinDefaultAsVec3Tuple(value, keys).map(bounded) as [number, number, number];
      return numericArray ? tuple.slice(0, keys.length) : vec3TupleToObject(tuple, keys);
    }
    case "vec4": case "quat": case "color": {
      const tuple = pinDefaultAsVec4Tuple(value).map(bounded) as [number, number, number, number];
      const count = pin.colorHint && pin.type.kind === "vec3" ? 3 : 4;
      return numericArray ? tuple.slice(0, count) : vec4TupleToObject(tuple);
    }
    case "structRef":
      if (type.guid === "engine:TagContainer") return normalizeTagContainer(value);
      return undefined;
    default:
      return undefined;
  }
}
