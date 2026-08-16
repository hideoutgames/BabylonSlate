import {
  defaultJsValue,
  pinAcceptsLiteralDefault,
  pinDefaultAsBoolean,
  pinDefaultAsNumber,
  pinDefaultAsString,
  pinDefaultAsVec3Tuple,
  pinDefaultAsVec4Tuple,
  pinDefaultColorRgb,
  readPinDefault,
  type PinType,
} from "@babylonslate/scripting";
import type { SerializedPin } from "./graph-types";

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
        | "enumRef"
        | "classRef";
      text: string;
    };

function asLiteralPinType(type: SerializedPin["type"]): PinType | null {
  if (!pinAcceptsLiteralDefault(type as PinType)) return null;
  return type as PinType;
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

export function pinDefaultPreview(
  pin: SerializedPin,
  properties: Record<string, unknown>,
  connected: boolean,
): PinDefaultPreview | null {
  if (connected) return null;
  if (pin.direction !== "in" || pin.kind !== "data") return null;
  const type = asLiteralPinType(pin.type);
  if (!type) return null;
  const stored = readPinDefault(properties, pin.name);
  const value = stored !== undefined ? stored : defaultJsValue(type);
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
      return {
        kind: "vec4",
        text: joinNumbers(pinDefaultAsVec4Tuple(value)),
      };
    case "enumRef":
      return { kind: "enumRef", text: pinDefaultAsString(value) };
    case "classRef":
      return {
        kind: "classRef",
        text:
          pinDefaultAsString(value) ||
          pinDefaultAsString(defaultJsValue(type)),
      };
    default:
      return null;
  }
}
