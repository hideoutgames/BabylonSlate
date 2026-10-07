import { normalizeTag, normalizeTagContainer, type TagContainer } from "@babylonslate/core";
import {
  defaultJsValue,
  pinAcceptsLiteralDefault,
  pinDefaultAsBoolean,
  pinDefaultAsNumber,
  pinDefaultAsString,
  pinDefaultAsVec3Tuple,
  pinDefaultAsVec4Tuple,
  pinDefaultColorRgb,
  readPinDefaultForPin,
  type PinType,
} from "@babylonslate/scripting";
import type { SerializedPin } from "./graph-types";
import { humanizePropertyLabel } from "@babylonslate/editor-kit";

export type PinTypeNames = Readonly<Record<string, string>>;

export type PinDefaultPreview =
  | { kind: "tag"; value: number }
  | { kind: "tag-container"; value: TagContainer }
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
      /**
       * The text names the expected type, not a stored value: the pin is
       * empty and must be wired (or is the implicit Self target).
       */
      placeholder?: boolean;
    };

export function literalPinType(
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
  const component = (index: number, fallback = 0) => numbers.length === 1 ? numbers[0]! : numbers[index] ?? fallback;
  switch (type.kind) {
    case "int":
    case "float":
      return numbers[0] ?? 0;
    case "vec2":
      return { x: component(0), y: component(1) };
    case "vec3":
      return { x: component(0), y: component(1), z: component(2) };
    case "color":
    case "vec4":
    case "quat":
      return {
        x: component(0),
        y: component(1),
        z: component(2),
        w: component(3, type.kind === "quat" || type.kind === "color" ? 1 : 0),
      };
    default:
      return value;
  }
}

export function readPinDefaultValue(
  pin: SerializedPin,
  properties: Record<string, unknown>,
): unknown {
  const type = literalPinType(pin);
  const stored = readPinDefaultForPin(properties, pin);
  const value = stored !== undefined ? stored : pin.defaultValue !== undefined
    ? pin.defaultValue : type ? defaultJsValue(type) : undefined;
  return type ? coerceLiteralValue(type, value) : value;
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
    case "actorRef": {
      const classId =
        typeof type.classId === "string" ? type.classId.trim() : "";
      return { kind: type.kind, text: classId, placeholder: true };
    }
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
    case "structRef": {
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
  if (pin.reference === "required") return null;
  if (pin.direction !== "in" || pin.kind !== "data") return null;
  if (pin.type.kind === "tag") {
    return { kind: "tag", value: normalizeTag(readPinDefaultValue(pin, properties)) };
  }
  if (pin.type.kind === "structRef" && pin.type.guid === "engine:TagContainer") {
    return { kind: "tag-container", value: normalizeTagContainer(readPinDefaultValue(pin, properties)) };
  }
  if (pin.type.kind === "enumRef") {
    return {
      kind: "enumRef",
      text: humanizePropertyLabel(pinDefaultAsString(readPinDefaultValue(pin, properties))),
    };
  }
  if (pin.type.kind === "structRef" && pin.type.guid === "engine:InputType") {
    const input = readPinDefaultValue(pin, properties) as { Name?: string } | undefined;
    return input?.Name ? { kind: "structRef", text: input.Name } : null;
  }
  if (pin.type.kind === "structRef" && pin.type.guid === "engine:InputBinding") {
    const binding = readPinDefaultValue(pin, properties) as { Input?: { Name?: string } } | undefined;
    return binding?.Input?.Name ? { kind: "structRef", text: binding.Input.Name } : null;
  }
  if (pin.type.kind === "classRef") {
    const selectedClass = readPinDefaultValue(pin, properties);
    if (selectedClass !== undefined) {
      return { kind: "classRef", text: pinDefaultAsString(selectedClass) };
    }
  }
  if (
    pin.name === "target" &&
    properties.implicitSelf === true &&
    (pin.type.kind === "objectRef" || pin.type.kind === "actorRef")
  ) {
    return { kind: pin.type.kind, text: "Self" };
  }
  const constraint = pinConstraintPreview(pin, pinTypeNames);
  if (constraint) return constraint;
  const type = literalPinType(pin);
  if (!type) return null;
  const stored = readPinDefaultValue(pin, properties);
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
