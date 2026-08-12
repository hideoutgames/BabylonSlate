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
