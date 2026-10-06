import { formatValue, normalizeTag, normalizeTagContainer, parseMapDefaultEntries } from "@babylonslate/core";
import type {
  ColorValue,
  PropertyRow,
  Vector3Value,
} from "@babylonslate/editor-kit";

export type PlayInspectRowSource = {
  id: string;
  label: string;
  value: unknown;
  type?: string;
  testId?: string;
};

const noop = () => {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectRef(
  value: unknown,
): value is { guid: string; classId: string } {
  return (
    isRecord(value) &&
    typeof value.guid === "string" &&
    typeof value.classId === "string"
  );
}

function numberTuple(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (!value.every((entry) => typeof entry === "number")) return null;
  return value;
}

function xyzTuple(value: unknown): number[] | null {
  const fromArray = numberTuple(value);
  if (fromArray) return fromArray;
  if (!isRecord(value)) return null;
  if (typeof value.x !== "number" || typeof value.y !== "number") return null;
  if (typeof value.z === "number") {
    if (typeof value.w === "number") {
      return [value.x, value.y, value.z, value.w];
    }
    return [value.x, value.y, value.z];
  }
  return [value.x, value.y];
}

function rgbColor(value: unknown): ColorValue | null {
  const tuple = numberTuple(value);
  if (tuple && tuple.length >= 3) {
    return [tuple[0]!, tuple[1]!, tuple[2]!];
  }
  if (
    isRecord(value) &&
    typeof value.r === "number" &&
    typeof value.g === "number" &&
    typeof value.b === "number"
  ) {
    return [value.r, value.g, value.b];
  }
  return null;
}

function inferType(value: unknown, declared?: string): string {
  if (declared) return declared;
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "float";
  if (isObjectRef(value)) return "object";
  const nums = xyzTuple(value);
  if (nums) {
    if (nums.length === 2) return "vec2";
    if (nums.length === 3) return "vec3";
    return "vec4";
  }
  if (typeof value === "string") return "string";
  return "unknown";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function vectorValue(value: unknown, axisCount: number): Vector3Value {
  const nums = xyzTuple(value) ?? [];
  const x = nums[0] ?? 0;
  const y = nums[1] ?? 0;
  const z = nums[2] ?? 0;
  const w = nums[3] ?? 0;
  if (axisCount >= 4) return [x, y, z, w];
  return [x, y, z];
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return formatValue(value);
}

function toRow(source: PlayInspectRowSource): PropertyRow {
  const type = inferType(source.value, source.type);
  const base = {
    id: source.id,
    label: source.label,
    disabled: true as const,
    testId: source.testId,
  };
  switch (type) {
    case "tag":
      return {
        ...base,
        kind: "tag",
        value: normalizeTag(source.value),
        onChange: noop,
      };
    case "tag-container":
    case "struct:engine:TagContainer":
      return {
        ...base,
        kind: "tag-container",
        value: normalizeTagContainer(source.value),
        onChange: noop,
      };
    case "bool":
    case "boolean":
      return {
        ...base,
        kind: "boolean",
        value: source.value === true,
        onChange: noop,
      };
    case "int":
    case "float":
      return {
        ...base,
        kind: "number",
        value: asNumber(source.value),
        onChange: noop,
      };
    case "vec2":
      return {
        ...base,
        kind: "vector3",
        value: vectorValue(source.value, 2),
        axes: ["X", "Y"],
        onChange: noop,
      };
    case "vec3":
      return {
        ...base,
        kind: "vector3",
        value: vectorValue(source.value, 3),
        axes: ["X", "Y", "Z"],
        onChange: noop,
      };
    case "vec4":
      return {
        ...base,
        kind: "vector3",
        value: vectorValue(source.value, 4),
        axes: ["X", "Y", "Z", "W"],
        onChange: noop,
      };
    case "color":
      return {
        ...base,
        kind: "color",
        value: rgbColor(source.value),
        onChange: noop,
      };
    case "object":
    case "class": {
      if (isObjectRef(source.value)) {
        return {
          ...base,
          kind: "asset",
          value: source.value.guid,
          displayLabel: source.value.classId,
          displayType: source.value.guid,
          onPick: noop,
          onChange: noop,
        };
      }
      const text = textFrom(source.value);
      return {
        ...base,
        kind: "asset",
        value: text || null,
        displayLabel: text || "None",
        displayType: text || undefined,
        onPick: noop,
        onChange: noop,
      };
    }
    default:
      return {
        ...base,
        kind: "text",
        value: textFrom(source.value),
        onChange: noop,
      };
  }
}

/** Disabled PropertyGrid rows for Play inspect (read-only; no setVariable). */
export function playInspectPropertyRows(
  sources: readonly PlayInspectRowSource[],
): PropertyRow[] {
  return sources.flatMap((source) => {
    if (source.type?.startsWith("array:")) {
      const value = Array.isArray(source.value) ? source.value : [];
      if (value.length === 0) return [toRow({ ...source, type: "string", value: "Empty Array" })];
      const type = source.type.slice("array:".length);
      return playInspectPropertyRows(value.map((entry, index) => ({
        ...source,
        id: `${source.id}:${index}`,
        label: `${source.label} [${index}]`,
        type,
        value: entry,
        testId: source.testId ? `${source.testId}-${index}` : undefined,
      })));
    }
    if (source.type?.startsWith("map:")) {
      const separator = source.type.indexOf("=>", "map:".length);
      if (separator < 0) return [toRow({ ...source, type: "unknown" })];
      const keyType = source.type.slice("map:".length, separator);
      const valueType = source.type.slice(separator + 2);
      const entries = isRecord(source.value) && !(source.value instanceof Map)
        ? Object.entries(source.value).map(([key, value]) => ({ key: keyType === "tag" ? Number(key) : key, value }))
        : parseMapDefaultEntries(source.value);
      if (entries.length === 0) return [toRow({ ...source, type: "string", value: "Empty Map" })];
      return playInspectPropertyRows(entries.flatMap((entry, index) => [
        { ...source, id: `${source.id}:${index}:key`, label: `${source.label} [${index}] Key`, type: keyType, value: entry.key,
          testId: source.testId ? `${source.testId}-${index}-key` : undefined },
        { ...source, id: `${source.id}:${index}:value`, label: `${source.label} [${index}] Value`, type: valueType, value: entry.value,
          testId: source.testId ? `${source.testId}-${index}-value` : undefined },
      ]));
    }
    return [toRow(source)];
  });
}

export function playInspectIdentityRows(node: {
  id: string;
  label: string;
  classId: string;
}): PropertyRow[] {
  return playInspectPropertyRows([
    { id: "name", label: "Name", value: node.label },
    { id: "class", label: "Class", value: node.classId },
    { id: "guid", label: "GUID", value: node.id },
  ]);
}

export function playInspectTransformRows(transform: {
  position: readonly number[];
  rotation: readonly number[];
  scale: readonly number[];
}): PropertyRow[] {
  return playInspectPropertyRows([
    {
      id: "position",
      label: "Position",
      value: [...transform.position],
      type: "vec3",
    },
    {
      id: "rotation",
      label: "Rotation",
      value: [...transform.rotation],
      type: "vec4",
    },
    {
      id: "scale",
      label: "Scale",
      value: [...transform.scale],
      type: "vec3",
    },
  ]);
}

export function playInspectVariableRows(
  variables: Record<string, unknown>,
  variableTypes?: Record<string, string>,
): PropertyRow[] {
  return playInspectPropertyRows(
    Object.entries(variables).map(([key, value]) => ({
      id: key,
      label: key,
      value,
      type: variableTypes?.[key],
      testId: `debug-inspect-var-${key}`,
    })),
  );
}
