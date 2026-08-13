import type {
  ParameterRow,
  ParameterValueType,
  PropertyRow,
} from "@babylonslate/editor-kit";
import type { GraphPin, LiteralPinDefault, PinType } from "@babylonslate/scripting";
import {
  BOOL,
  FLOAT,
  INT,
  STRING,
  colorRgbToPinDefault,
  defaultJsValue,
  listUnconnectedLiteralPinDefaults,
  pinDefaultAsBoolean,
  pinDefaultAsNumber,
  pinDefaultAsString,
  pinDefaultAsVec3Tuple,
  pinDefaultColorRgb,
  pinDefaultPropertyKey,
  vec3TupleToObject,
} from "@babylonslate/scripting";

export function connectedInputPinIds(
  edges: ReadonlyArray<{ target: string; targetHandle?: string }>,
  nodeId: string,
): Set<string> {
  const ids = new Set<string>();
  for (const edge of edges) {
    if (edge.target === nodeId && edge.targetHandle) {
      ids.add(edge.targetHandle);
    }
  }
  return ids;
}

export function pinsFromNodeData(data: Record<string, unknown>): GraphPin[] {
  return Array.isArray(data.__pins) ? (data.__pins as GraphPin[]) : [];
}

export function inspectorLiteralPinDefaults(
  node: { id: string; data: Record<string, unknown> },
  edges: ReadonlyArray<{ target: string; targetHandle?: string }>,
) {
  return listUnconnectedLiteralPinDefaults(
    pinsFromNodeData(node.data),
    node.data,
    connectedInputPinIds(edges, node.id),
  );
}

export const LOG_SEVERITY_OPTIONS = [
  { value: "verbose", label: "Verbose" },
  { value: "log", label: "Log" },
  { value: "warning", label: "Warning" },
  { value: "error", label: "Error" },
] as const;

export function pinDefaultPropertyRows(
  entries: readonly LiteralPinDefault[],
  onPatch: (patch: Record<string, unknown>) => void,
  mappingNames?: {
    actionNames?: readonly string[];
    axisNames?: readonly string[];
  },
): PropertyRow[] {
  const rows: PropertyRow[] = [];
  for (const entry of entries) {
    const key = pinDefaultPropertyKey(entry.name);
    const typeDefault = defaultJsValue(entry.type);
    switch (entry.type.kind) {
      case "bool":
        rows.push({
          kind: "boolean",
          id: entry.pinId,
          label: entry.name,
          value: pinDefaultAsBoolean(entry.value),
          defaultValue: pinDefaultAsBoolean(typeDefault),
          onChange: (value) => onPatch({ [key]: value }),
        });
        break;
      case "int":
      case "float":
        rows.push({
          kind: "number",
          id: entry.pinId,
          label: entry.name,
          value: pinDefaultAsNumber(entry.value),
          defaultValue: pinDefaultAsNumber(typeDefault),
          onChange: (value) => onPatch({ [key]: value }),
        });
        break;
      case "string": {
        const mapping =
          entry.name === "action"
            ? mappingNames?.actionNames
            : entry.name === "axis"
              ? mappingNames?.axisNames
              : undefined;
        const current = pinDefaultAsString(entry.value);
        if (mapping && mapping.length > 0) {
          const options = mapping.includes(current)
            ? mapping
            : current
              ? [...mapping, current]
              : mapping;
          rows.push({
            kind: "enum",
            id: entry.pinId,
            label: entry.name,
            value: current,
            defaultValue: pinDefaultAsString(typeDefault),
            options: options.map((name) => ({ value: name, label: name })),
            onChange: (value) => onPatch({ [key]: value }),
          });
          break;
        }
        rows.push({
          kind: "text",
          id: entry.pinId,
          label: entry.name,
          value: current,
          defaultValue: pinDefaultAsString(typeDefault),
          onChange: (value) => onPatch({ [key]: value }),
        });
        break;
      }
      case "vec2":
        rows.push({
          kind: "vector3",
          id: entry.pinId,
          label: entry.name,
          value: pinDefaultAsVec3Tuple(entry.value, ["x", "y"]),
          defaultValue: pinDefaultAsVec3Tuple(typeDefault, ["x", "y"]),
          axes: ["X", "Y"],
          onChange: (value) =>
            onPatch({ [key]: vec3TupleToObject(value, ["x", "y"]) }),
        });
        break;
      case "vec3":
        rows.push({
          kind: "vector3",
          id: entry.pinId,
          label: entry.name,
          value: pinDefaultAsVec3Tuple(entry.value, ["x", "y", "z"]),
          defaultValue: pinDefaultAsVec3Tuple(typeDefault, ["x", "y", "z"]),
          onChange: (value) =>
            onPatch({ [key]: vec3TupleToObject(value, ["x", "y", "z"]) }),
        });
        break;
      case "rotator":
        rows.push({
          kind: "vector3",
          id: entry.pinId,
          label: entry.name,
          value: pinDefaultAsVec3Tuple(entry.value, ["pitch", "yaw", "roll"]),
          defaultValue: pinDefaultAsVec3Tuple(typeDefault, [
            "pitch",
            "yaw",
            "roll",
          ]),
          axes: ["Pitch", "Yaw", "Roll"],
          onChange: (value) =>
            onPatch({
              [key]: vec3TupleToObject(value, ["pitch", "yaw", "roll"]),
            }),
        });
        break;
      case "color":
        rows.push({
          kind: "color",
          id: entry.pinId,
          label: entry.name,
          value: pinDefaultColorRgb(entry.value),
          defaultValue: pinDefaultColorRgb(typeDefault),
          onChange: (value) =>
            onPatch({ [key]: colorRgbToPinDefault(value, entry.value) }),
        });
        break;
      default:
        break;
    }
  }
  return rows;
}

export function logNodePropertyRows(
  data: Record<string, unknown>,
  onPatch: (patch: Record<string, unknown>) => void,
): PropertyRow[] {
  return [
    {
      kind: "enum",
      id: "severity",
      label: "severity",
      value: pinDefaultAsString(data.severity) || "log",
      defaultValue: "log",
      options: [...LOG_SEVERITY_OPTIONS],
      onChange: (value) => onPatch({ severity: value }),
    },
    {
      kind: "text",
      id: "category",
      label: "category",
      value: pinDefaultAsString(data.category) || "Script",
      defaultValue: "Script",
      onChange: (value) => onPatch({ category: value }),
    },
  ];
}

const PARAMETER_TYPES = new Set<ParameterValueType>([
  "string",
  "float",
  "int",
  "bool",
  "enum",
]);

export function parameterTypeFromPin(type: unknown): ParameterValueType {
  if (typeof type === "string" && PARAMETER_TYPES.has(type as ParameterValueType)) {
    return type as ParameterValueType;
  }
  if (type && typeof type === "object" && "kind" in type) {
    const kind = (type as { kind: string }).kind;
    if (PARAMETER_TYPES.has(kind as ParameterValueType)) {
      return kind as ParameterValueType;
    }
  }
  return "float";
}

export function pinTypeFromParameterType(type: ParameterValueType): PinType {
  switch (type) {
    case "string":
    case "enum":
      return STRING;
    case "int":
      return INT;
    case "bool":
      return BOOL;
    default:
      return FLOAT;
  }
}

export function parameterRowsFromPinList(
  rows: ReadonlyArray<{ name: string; type?: unknown }>,
  prefix: string,
): ParameterRow[] {
  return rows.map((row, index) => ({
    id: `${prefix}-${index}-${row.name}`,
    name: row.name,
    type: parameterTypeFromPin(row.type),
  }));
}

export function pinListFromParameterRows(
  rows: readonly ParameterRow[],
): Array<{ name: string; type: PinType }> {
  return rows.map((row) => ({
    name: row.name,
    type: pinTypeFromParameterType(row.type),
  }));
}

export function commandParameterRows(
  rows: ReadonlyArray<{
    name: string;
    type?: unknown;
    optional?: boolean;
    defaultValue?: unknown;
    enumValues?: unknown;
  }>,
): ParameterRow[] {
  return rows.map((row, index) => ({
    id: `cmd-${index}-${row.name}`,
    name: row.name,
    type: parameterTypeFromPin(row.type),
    optional: row.optional === true,
    defaultValue:
      row.defaultValue == null ? undefined : String(row.defaultValue),
    enumValues: Array.isArray(row.enumValues)
      ? row.enumValues.filter((value): value is string => typeof value === "string")
      : undefined,
  }));
}

export function commandParametersFromRows(rows: readonly ParameterRow[]): Array<{
  name: string;
  type: ParameterValueType;
  optional?: boolean;
  defaultValue?: string;
  enumValues?: string[];
}> {
  return rows.map((row) => ({
    name: row.name,
    type: row.type,
    optional: row.optional,
    defaultValue: row.defaultValue,
    enumValues: row.enumValues ? [...row.enumValues] : undefined,
  }));
}
