import type {
  ParameterRow,
  ParameterValueType,
  PropertyRow,
} from "@babylonslate/editor-kit";
import {
  classRowIdentity,
  assetRowIdentity,
  humanizePropertyLabel,
} from "@babylonslate/editor-kit";
import type { GraphPin, LiteralPinDefault, PinType } from "@babylonslate/scripting";
import {
  BOOL,
  ENGINE_ENUMS,
  FLOAT,
  INT,
  STRING,
  colorRgbToPinDefault,
  defaultJsValue,
  hydrateStructInstance,
  isDevelopmentOnlyNode,
  isDevelopmentOnlyByDefaultTypeId,
  listUnconnectedLiteralPinDefaults,
  pinDefaultAsBoolean,
  pinDefaultAsNumber,
  pinDefaultAsString,
  pinDefaultAsVec3Tuple,
  pinDefaultAsVec4Tuple,
  pinDefaultColorRgb,
  pinDefaultPropertyKey,
  pinTypeForMember,
  vec3TupleToObject,
  vec4TupleToObject,
  type TypeSchemas,
} from "@babylonslate/scripting";
import {
  ENGINE_INPUT_MODE_ENUM_ID,
  INPUT_MODE_MEMBERS,
  normalizeUserInterfaceClassRef,
  USER_INTERFACE_ENGINE_CLASS_ID,
} from "@babylonslate/core";

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

function memberNamesFromUnknown(members: unknown): string[] | null {
  if (!Array.isArray(members)) return null;
  const names: string[] = [];
  for (const row of members) {
    if (typeof row === "object" && row !== null) {
      const name = (row as { name?: unknown }).name;
      if (typeof name === "string" && name) names.push(name);
    }
  }
  return names;
}

export function collectEnumMemberNames(
  documents: ReadonlyArray<{ content: unknown }>,
  assets: ReadonlyArray<{
    header: { guid: string; type: string; payload?: Record<string, unknown> };
  }> = [],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const asset of assets) {
    if (asset.header.type !== "Enum") continue;
    const names = memberNamesFromUnknown(asset.header.payload?.members);
    if (names) result[asset.header.guid] = names;
  }
  for (const doc of documents) {
    const content = doc.content;
    if (typeof content !== "object" || content === null) continue;
    const record = content as Record<string, unknown>;
    if (record.kind !== "enum" || typeof record.guid !== "string" || !record.guid) {
      continue;
    }
    const names = memberNamesFromUnknown(record.members);
    if (names) result[record.guid] = names;
  }
  for (const entry of ENGINE_ENUMS) {
    if (!result[entry.id]) {
      result[entry.id] = entry.members.map((member) => member.name);
    }
  }
  result[ENGINE_INPUT_MODE_ENUM_ID] = [...INPUT_MODE_MEMBERS];
  return result;
}

type PinDefaultMapping = NonNullable<
  Parameters<typeof pinDefaultPropertyRows>[2]
>;

function flattenStructFieldRows(
  fields: ReadonlyArray<{
    name: string;
    typeId: string;
    typeClassId?: string;
    defaultValue?: unknown;
  }>,
  value: unknown,
  onChange: (next: Record<string, unknown>) => void,
  mapping: PinDefaultMapping | undefined,
  labelPrefix: string,
): PropertyRow[] {
  const schemas = mapping?.schemas;
  const instance = hydrateStructInstance(fields, value, schemas);
  const rows: PropertyRow[] = [];
  for (const field of fields) {
    if (!field.name) continue;
    const type = pinTypeForMember(field.typeId, field.typeClassId);
    const label = labelPrefix
      ? `${labelPrefix} ${humanizePropertyLabel(field.name)}`
      : humanizePropertyLabel(field.name);
    const fieldValue = instance[field.name];
    if (type.kind === "structRef") {
      const nested = type.guid ? schemas?.structs[type.guid] : undefined;
      if (nested) {
        rows.push(
          ...flattenStructFieldRows(
            nested.fields,
            fieldValue,
            (nestedValue) =>
              onChange({ ...instance, [field.name]: nestedValue }),
            mapping,
            label,
          ),
        );
        continue;
      }
    }
    rows.push(
      ...pinDefaultPropertyRows(
        [
          {
            pinId: `${labelPrefix}:${field.name}`,
            name: label,
            type,
            value: fieldValue,
          },
        ],
        (patch) => {
          const key = pinDefaultPropertyKey(label);
          if (key in patch) {
            onChange({ ...instance, [field.name]: patch[key] });
          }
        },
        mapping,
      ),
    );
  }
  return rows;
}

export function pinDefaultPropertyRows(
  entries: readonly LiteralPinDefault[],
  onPatch: (patch: Record<string, unknown>) => void,
  mappingNames?: {
    actionNames?: readonly string[];
    axisNames?: readonly string[];
    enumMembers?: Record<string, readonly string[]>;
    classEntries?: ReadonlyArray<{ id: string; name: string }>;
    onPickClass?: (pinId: string, constraintClassId: string) => void;
    assetEntries?: ReadonlyArray<{ id: string; name: string; type: string }>;
    onPickAsset?: (pinId: string, assetType: string) => void;
    schemas?: TypeSchemas;
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
          axes: ["X", "Y", "Z"],
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
      case "vec4":
        rows.push({
          kind: "vector3",
          id: entry.pinId,
          label: entry.name,
          value: pinDefaultAsVec4Tuple(entry.value),
          defaultValue: pinDefaultAsVec4Tuple(typeDefault),
          axes: ["X", "Y", "Z", "W"],
          onChange: (value) => onPatch({ [key]: vec4TupleToObject(value) }),
        });
        break;
      case "enumRef": {
        const current = pinDefaultAsString(entry.value);
        const listed = mappingNames?.enumMembers?.[entry.type.guid] ?? [];
        const options = listed.includes(current)
          ? listed
          : current
            ? [...listed, current]
            : listed;
        rows.push({
          kind: "enum",
          id: entry.pinId,
          label: entry.name,
          value: current,
          defaultValue: pinDefaultAsString(typeDefault),
          options: options.map((name) => ({
            value: name,
            label: humanizePropertyLabel(name),
          })),
          onChange: (value) => onPatch({ [key]: value }),
        });
        break;
      }
      case "classRef": {
        const classId = entry.type.classId;
        const raw =
          pinDefaultAsString(entry.value) || pinDefaultAsString(typeDefault);
        const current =
          classId === USER_INTERFACE_ENGINE_CLASS_ID
            ? (normalizeUserInterfaceClassRef(raw) ?? raw)
            : raw;
        const display =
          mappingNames?.classEntries?.find((item) => item.id === current)
            ?.name ?? current;
        const identity = classRowIdentity(
          current
            ? { id: current, name: display || current }
            : undefined,
        );
        rows.push({
          kind: "asset",
          id: entry.pinId,
          label: entry.name,
          value: current || null,
          defaultValue: pinDefaultAsString(typeDefault) || null,
          displayLabel: identity.displayLabel,
          displayType: identity.displayType,
          visual: identity.visual,
          placeholder: classId,
          onPick: () => mappingNames?.onPickClass?.(entry.pinId, classId),
          onChange: (value) => onPatch({ [key]: value }),
        });
        break;
      }
      case "assetRef": {
        const assetType = entry.type.assetType;
        const current = pinDefaultAsString(entry.value);
        const listed = mappingNames?.assetEntries?.find(
          (item) => item.id === current,
        );
        const identity = assetRowIdentity(
          listed
            ? { name: listed.name, type: listed.type }
            : current
              ? { name: current, type: assetType }
              : undefined,
        );
        rows.push({
          kind: "asset",
          id: entry.pinId,
          label: entry.name,
          value: current || null,
          defaultValue: pinDefaultAsString(typeDefault) || null,
          displayLabel: identity.displayLabel,
          displayType: identity.displayType,
          visual: identity.visual,
          placeholder: assetType,
          onPick: () => mappingNames?.onPickAsset?.(entry.pinId, assetType),
          onChange: (value) => onPatch({ [key]: value }),
        });
        break;
      }
      case "structRef": {
        const schema = entry.type.guid
          ? mappingNames?.schemas?.structs[entry.type.guid]
          : undefined;
        if (!schema) break;
        const key = pinDefaultPropertyKey(entry.name);
        rows.push(
          ...flattenStructFieldRows(
            schema.fields,
            entry.value,
            (next) => onPatch({ [key]: next }),
            mappingNames,
            entry.name === "Default" ? "" : humanizePropertyLabel(entry.name),
          ),
        );
        break;
      }
      default:
        break;
    }
  }
  return rows;
}

export function variableDefaultPropertyRows(
  typeId: string,
  value: unknown,
  onChange: (value: unknown) => void,
  options?: {
    typeClassId?: string;
    schemas?: TypeSchemas;
    enumMembers?: Record<string, readonly string[]>;
  },
): PropertyRow[] {
  if (typeId === "object" || typeId === "class") return [];
  const type = pinTypeForMember(typeId, options?.typeClassId);
  const mapping = {
    enumMembers: options?.enumMembers,
    schemas: options?.schemas,
  };
  if (type.kind === "structRef") {
    const schema = type.guid ? options?.schemas?.structs[type.guid] : undefined;
    if (!schema) return [];
    return flattenStructFieldRows(
      schema.fields,
      value,
      (next) => onChange(next),
      mapping,
      "",
    );
  }
  const resolved = value === undefined ? defaultJsValue(type) : value;
  return pinDefaultPropertyRows(
    [{ pinId: "default", name: "Default", type, value: resolved }],
    (patch) => {
      if ("default:Default" in patch) onChange(patch["default:Default"]);
    },
    mapping,
  );
}

export function enumNodePropertyRows(
  typeId: string,
  data: Record<string, unknown>,
  onPatch: (patch: Record<string, unknown>) => void,
  options: {
    enums: ReadonlyArray<{ guid: string; name: string; members: Array<{ name: string }> }>;
    typeSelectDisabled?: boolean;
  },
): PropertyRow[] {
  const guid = typeof data.enumGuid === "string" ? data.enumGuid : "";
  const selected = options.enums.find((entry) => entry.guid === guid);
  const rows: PropertyRow[] = [
    {
      kind: "enum",
      id: "enumGuid",
      label: "Enum Type",
      value: guid,
      defaultValue: "",
      disabled: options.typeSelectDisabled === true,
      options: options.enums.map((entry) => ({
        value: entry.guid,
        label: entry.name,
      })),
      onChange: (nextGuid) => {
        const next = options.enums.find((entry) => entry.guid === nextGuid);
        const title = next
          ? typeId === "enum.make"
            ? `Make ${next.name}`
            : typeId === "enum.switch"
              ? `Switch on ${next.name}`
              : typeId === "enum.equals"
                ? `Equal ${next.name}`
                : typeId === "enum.notEquals"
                  ? `Not Equal ${next.name}`
                  : typeId === "enum.toString"
                    ? `${next.name} to String`
                    : undefined
          : undefined;
        onPatch({
          enumGuid: nextGuid,
          members: next?.members ?? [],
          ...(typeId === "enum.make"
            ? { value: next?.members[0]?.name ?? "" }
            : {}),
          ...(title ? { title } : {}),
        });
      },
    },
  ];
  if (typeId === "enum.make") {
    const members = selected?.members.map((member) => member.name) ?? [];
    const current = typeof data.value === "string" ? data.value : members[0] ?? "";
    rows.push({
      kind: "enum",
      id: "value",
      label: "Value",
      value: current,
      defaultValue: members[0] ?? "",
      options: members.map((name) => ({
        value: name,
        label: humanizePropertyLabel(name),
      })),
      onChange: (value) => onPatch({ value }),
    });
  }
  return rows;
}

export function connectedEnumGuidFromSerialized(
  graph: {
    nodes: ReadonlyArray<{
      id: string;
      data: Record<string, unknown>;
    }>;
    edges: ReadonlyArray<{
      source: string;
      target: string;
      sourceHandle?: string;
      targetHandle?: string;
    }>;
  },
  nodeId: string,
): string | undefined {
  const handles = new Set(["value", "a", "b", "in"]);
  for (const edge of graph.edges) {
    if (edge.target !== nodeId || !edge.targetHandle) continue;
    if (!handles.has(edge.targetHandle)) continue;
    const source = graph.nodes.find((node) => node.id === edge.source);
    if (!source) continue;
    const pins = pinsFromNodeData(source.data);
    const pin = pins.find(
      (entry) => entry.id === edge.sourceHandle || entry.name === edge.sourceHandle,
    );
    if (
      pin?.type &&
      typeof pin.type === "object" &&
      pin.type.kind === "enumRef" &&
      pin.type.guid.trim()
    ) {
      return pin.type.guid.trim();
    }
  }
  return undefined;
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

export function developmentOnlyPropertyRows(
  typeId: string,
  data: Record<string, unknown>,
  onPatch: (patch: Record<string, unknown>) => void,
): PropertyRow[] {
  return [
    {
      kind: "boolean",
      id: "developmentOnly",
      label: "Development Only",
      value: isDevelopmentOnlyNode({
        id: typeId,
        typeId,
        position: { x: 0, y: 0 },
        pins: [],
        properties: data,
      }),
      defaultValue: isDevelopmentOnlyByDefaultTypeId(typeId),
      onChange: (value) => onPatch({ developmentOnly: value }),
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
