import {
  defaultJsValue,
  pinAcceptsLiteralDefault,
  pinDefaultAsBoolean,
  pinDefaultAsNumber,
  pinDefaultAsString,
  pinDefaultAsVec3Tuple,
  pinDefaultAsVec4Tuple,
  pinDefaultColorRgb,
  pinDefaultPropertyKey,
  readPinDefault,
  type PinType,
} from "@babylonslate/scripting";
import type { SerializedPin } from "./graph-types";

export type PinTypeNames = Readonly<Record<string, string>>;

export type PinDefaultPreview =
  | { kind: "bool"; checked: boolean }
  | { kind: "color"; rgb: string }
  | {
      kind:
        | "string"
        | "int"
        | "float"
        | "vec2"
        | "vec3"
        | "vec4"
        | "rotator"
        | "quat"
        | "enumRef"
        | "classRef"
        | "assetRef"
        | "objectRef"
        | "actorRef"
        | "structRef";
      text: string;
    };

function asLiteralPinType(
  pin: SerializedPin,
): PinType | null {
  if (pin.colorHint) return { kind: "color" };
  if (pin.type.kind === "generic") return { kind: "float" };
  if (!pinAcceptsLiteralDefault(pin.type as PinType)) return null;
  return pin.type as PinType;
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  if (Number.isInteger(value)) return String(value);
  return String(Number.parseFloat(value.toPrecision(6)));
}

function joinNumbers(values: readonly number[]): string {
  return values.map(compactNumber).join(", ");
}

function rgbCss(value: unknown): string {
  const [x, y, z] = pinDefaultColorRgb(value);
  const toByte = (channel: number) =>
    Math.max(0, Math.min(255, Math.round(channel * 255)));
  return `rgb(${toByte(x)}, ${toByte(y)}, ${toByte(z)})`;
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((component) =>
    typeof component === "number" && Number.isFinite(component) ? component : 0,
  );
}

function coerceLiteralValue(type: PinType, value: unknown): unknown {
  const numbers = asNumberArray(value);
  if (!numbers) return value;
  switch (type.kind) {
    case "int":
    case "float":
      return numbers[0] ?? 0;
    case "vec2":
      return { x: numbers[0] ?? 0, y: numbers[1] ?? 0 };
    case "vec3":
      return { x: numbers[0] ?? 0, y: numbers[1] ?? 0, z: numbers[2] ?? 0 };
    case "color":
    case "vec4":
    case "quat":
      return {
        x: numbers[0] ?? 0,
        y: numbers[1] ?? 0,
        z: numbers[2] ?? 0,
        w: numbers[3] ?? (type.kind === "quat" ? 1 : 0),
      };
    default:
      return value;
  }
}

function readPreviewValue(
  pin: SerializedPin,
  properties: Record<string, unknown>,
): unknown {
  const byId = properties[pinDefaultPropertyKey(pin.id)];
  if (byId !== undefined) return byId;
  const stored = readPinDefault(properties, pin.name);
  if (stored !== undefined) return stored;
  if (pin.defaultValue !== undefined) return pin.defaultValue;
  return undefined;
}

function stripEnginePrefix(id: string): string {
  return id.replace(/^engine:/, "");
}

function namedGuid(guid: string, names?: PinTypeNames): string {
  const trimmed = guid.trim();
  if (!trimmed) return "";
  return names?.[trimmed] ?? stripEnginePrefix(trimmed);
}

function pinConstraintPreview(
  pin: SerializedPin,
  names?: PinTypeNames,
): PinDefaultPreview | null {
  const type = pin.type;
  switch (type.kind) {
    case "objectRef":
    case "actorRef":
    case "classRef": {
      const classId =
        typeof type.classId === "string" ? type.classId.trim() : "";
      return { kind: type.kind, text: classId };
    }
    case "assetRef": {
      const assetType =
        typeof type.assetType === "string" ? type.assetType.trim() : "";
      return { kind: "assetRef", text: assetType };
    }
    case "structRef":
    case "enumRef": {
      const guid = typeof type.guid === "string" ? type.guid : "";
      return { kind: type.kind, text: namedGuid(guid, names) };
    }
    default:
      return null;
  }
}

export function pinDefaultPreview(
  pin: SerializedPin,
  properties: Record<string, unknown>,
  connected: boolean,
  pinTypeNames?: PinTypeNames,
): PinDefaultPreview | null {
  if (connected) return null;
  if (pin.direction !== "in" || pin.kind !== "data") return null;
  const constraint = pinConstraintPreview(pin, pinTypeNames);
  if (constraint) return constraint;
  const type = asLiteralPinType(pin);
  if (!type) return null;
  const stored = readPreviewValue(pin, properties);
  const value = coerceLiteralValue(
    type,
    stored !== undefined ? stored : defaultJsValue(type),
  );
  switch (type.kind) {
    case "bool":
      return { kind: "bool", checked: pinDefaultAsBoolean(value) };
    case "color":
      return { kind: "color", rgb: rgbCss(value) };
    case "string":
      return { kind: "string", text: pinDefaultAsString(value) };
    case "int":
    case "float":
      return {
        kind: type.kind,
        text: compactNumber(pinDefaultAsNumber(value)),
      };
    case "vec2":
      return {
        kind: "vec2",
        text: joinNumbers(pinDefaultAsVec3Tuple(value, ["x", "y"]).slice(0, 2)),
      };
    case "vec3":
      return {
        kind: "vec3",
        text: joinNumbers(pinDefaultAsVec3Tuple(value, ["x", "y", "z"])),
      };
    case "rotator":
      return {
        kind: "rotator",
        text: joinNumbers(
          pinDefaultAsVec3Tuple(value, ["pitch", "yaw", "roll"]),
        ),
      };
    case "vec4":
    case "quat":
      return {
        kind: type.kind === "quat" ? "quat" : "vec4",
        text: joinNumbers(pinDefaultAsVec4Tuple(value)),
      };
    default:
      return null;
  }
}
