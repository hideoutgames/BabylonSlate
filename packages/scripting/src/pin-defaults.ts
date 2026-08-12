import type { GraphPin } from "./ir";
import type { PinType } from "./types";

const LITERAL_DEFAULT_KINDS = new Set<PinType["kind"]>([
  "bool",
  "int",
  "float",
  "string",
  "vec2",
  "vec3",
  "rotator",
  "color",
]);

export function pinAcceptsLiteralDefault(type: PinType): boolean {
  return LITERAL_DEFAULT_KINDS.has(type.kind);
}

export function pinDefaultPropertyKey(pinName: string): string {
  return `default:${pinName}`;
}

export function readPinDefault(
  properties: Record<string, unknown>,
  pinName: string,
): unknown {
  const keyed = properties[pinDefaultPropertyKey(pinName)];
  if (keyed !== undefined) return keyed;
  return properties[pinName];
}

/** JS value used when an applicable data pin has no authored default. */
export function defaultJsValue(type: PinType): unknown {
  switch (type.kind) {
    case "bool":
      return false;
    case "int":
    case "float":
      return 0;
    case "string":
      return "";
    case "vec2":
      return { x: 0, y: 0 };
    case "vec3":
      return { x: 0, y: 0, z: 0 };
    case "rotator":
      return { pitch: 0, yaw: 0, roll: 0 };
    case "color":
      return { x: 0, y: 0, z: 0, w: 0 };
    default:
      return null;
  }
}

export type LiteralPinDefault = {
  pinId: string;
  name: string;
  type: PinType;
  value: unknown;
};

export function listUnconnectedLiteralPinDefaults(
  pins: readonly GraphPin[],
  properties: Record<string, unknown>,
  connectedPinIds: ReadonlySet<string>,
): LiteralPinDefault[] {
  const listed: LiteralPinDefault[] = [];
  for (const pin of pins) {
    if (pin.direction !== "in" || pin.kind !== "data") continue;
    if (!pinAcceptsLiteralDefault(pin.type)) continue;
    if (connectedPinIds.has(pin.id)) continue;
    const stored = readPinDefault(properties, pin.name);
    listed.push({
      pinId: pin.id,
      name: pin.name,
      type: pin.type,
      value: stored !== undefined ? stored : defaultJsValue(pin.type),
    });
  }
  return listed;
}

export type Vec3Tuple = [number, number, number];

export function pinDefaultAsBoolean(value: unknown): boolean {
  return value === true;
}

export function pinDefaultAsNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function pinDefaultAsString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function pinDefaultAsVec3Tuple(
  value: unknown,
  keys: readonly [string, string] | readonly [string, string, string],
): Vec3Tuple {
  const record = recordOf(value);
  return [
    pinDefaultAsNumber(record?.[keys[0]]),
    pinDefaultAsNumber(record?.[keys[1]]),
    keys.length === 3 ? pinDefaultAsNumber(record?.[keys[2]]) : 0,
  ];
}

export function vec3TupleToObject(
  tuple: Vec3Tuple,
  keys: readonly [string, string] | readonly [string, string, string],
): Record<string, number> {
  const result: Record<string, number> = {
    [keys[0]]: tuple[0],
    [keys[1]]: tuple[1],
  };
  if (keys.length === 3) {
    result[keys[2]] = tuple[2];
  }
  return result;
}

export function pinDefaultColorRgb(value: unknown): Vec3Tuple {
  return pinDefaultAsVec3Tuple(value, ["x", "y", "z"]);
}

export function colorRgbToPinDefault(
  rgb: Vec3Tuple,
  previous: unknown,
): { x: number; y: number; z: number; w: number } {
  const record = recordOf(previous);
  return {
    x: rgb[0],
    y: rgb[1],
    z: rgb[2],
    w: pinDefaultAsNumber(record?.w),
  };
}
