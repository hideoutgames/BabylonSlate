import { buildDataTreeIndex, isDataTreeAsset } from "@babylonslate/core";

/** Data values are authored text unless their saved field schema says otherwise. */
type ReferenceKind = "asset" | "class";
type ReferenceMapper = (reference: string, kind: ReferenceKind) => string | null;
/** Resolves a Definition or an explicitly nested Structure when no snapshot exists. */
export type DataDefinitionFieldsResolver = (guid: string) => readonly unknown[] | undefined;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function isDataAssetPayload(value: unknown): boolean {
  const kind = record(value)?.kind;
  // Unsupported historical payloads are protected from generic string walkers.
  return kind === "dataDefinition" || kind === "dataTree" || kind === "dataSheet" || kind === "dataObject";
}

export function isDataGraphNodePayload(value: unknown): boolean {
  const row = record(value);
  const type = row?.type ?? row?.typeId;
  return typeof type === "string" && (type.startsWith("data.") || type.startsWith("editorData."));
}

/** Copy-on-write traversal shared by deletion, import, Class replacement, and export. */
export function mapDataAssetReferences<T>(value: T, map: ReferenceMapper, definitionFields?: DataDefinitionFieldsResolver): T {
  const payload = record(value);
  if (!payload || !isDataAssetPayload(payload)) return value;
  let next = payload;
  const assign = (key: string, result: unknown) => {
    if (result === payload[key]) return;
    if (next === payload) next = { ...payload };
    next[key] = result;
  };
  if (payload.kind === "dataDefinition" && Array.isArray(payload.fields)) {
    assign("fields", mapFields(payload.fields, map, definitionFields));
  } else if (payload.kind === "dataTree" && Array.isArray(payload.entries)) {
    // Resolve inheritance before changing asset GUIDs. Corrupt hierarchies still
    // retain explicit references and snapshots, without guessing inherited types.
    const index = isDataTreeAsset(payload) ? buildDataTreeIndex(payload).index : null;
    if (typeof payload.defaultDefinitionGuid === "string") assign("defaultDefinitionGuid", map(payload.defaultDefinitionGuid, "asset"));
    assign("entries", mapArray(payload.entries, (entry) => {
      const node = record(entry);
      if (!node) return entry;
      const definitionGuid = typeof node.definitionGuid === "string" ? map(node.definitionGuid, "asset") : node.definitionGuid;
      const effective = typeof node.definitionGuid === "string" ? node.definitionGuid
        : typeof node.id === "string" ? index?.effectiveDefinitionById.get(node.id) : undefined;
      const fields = Array.isArray(node.schema) ? node.schema : effective ? definitionFields?.(effective) : undefined;
      const values = fields ? mapValues(node.values, fields, map, definitionFields) : node.values;
      const schema = Array.isArray(node.schema) ? mapFields(node.schema, map, definitionFields) : node.schema;
      if (values === node.values && schema === node.schema && definitionGuid === node.definitionGuid) return entry;
      return { ...node, values, ...(Array.isArray(node.schema) ? { schema } : {}), ...(typeof node.definitionGuid === "string" ? { definitionGuid } : {}) };
    }));
  }
  return next as T;
}

function mapReference(value: unknown, kind: ReferenceKind, map: ReferenceMapper): unknown {
  // Typed values use the graph's empty-reference sentinel. Null is reserved for
  // a tree's missing Definition selection, not an optional field value.
  return typeof value === "string" ? map(value, kind) ?? "" : value;
}

function mapArray(entries: unknown[], transform: (entry: unknown) => unknown): unknown[] {
  let changed = false;
  const mapped = entries.map((entry) => {
    const next = transform(entry);
    changed ||= next !== entry;
    return next;
  });
  return changed ? mapped : entries;
}

function mapScalarValue(value: unknown, field: Record<string, unknown>, map: ReferenceMapper, definitionFields?: DataDefinitionFieldsResolver): unknown {
  if (field.typeId === "asset") return mapReference(value, "asset", map);
  if (field.typeId === "class") return mapReference(value, "class", map);
  // InputType has a typed asset component and a display name; preserve display text.
  if (field.typeId === "struct" && field.typeClassId === "engine:InputType") {
    const input = record(value);
    if (input && typeof input.Asset === "string") {
      const asset = map(input.Asset, "asset");
      if (asset !== input.Asset) return { ...input, Asset: asset ?? "", ...(asset === null ? { Name: "" } : {}) };
    }
  }
  if (field.typeId === "struct") {
    const fields = Array.isArray(field.fields) ? field.fields
      : typeof field.typeClassId === "string" ? definitionFields?.(field.typeClassId) : undefined;
    if (fields) return mapValues(value, fields, map, definitionFields);
  }
  return value;
}

function mapFieldValue(value: unknown, field: Record<string, unknown>, map: ReferenceMapper, definitionFields?: DataDefinitionFieldsResolver): unknown {
  if (field.container === "array") {
    return Array.isArray(value) ? mapArray(value, (entry) => mapScalarValue(entry, field, map, definitionFields)) : value;
  }
  if (field.container === "map") {
    if (!Array.isArray(value)) return value;
    const keyField = { typeId: field.keyTypeId, typeClassId: field.keyTypeClassId, fields: field.keyFields };
    let changed = false;
    const next: unknown[] = [];
    for (const entry of value) {
      const pair = record(entry);
      if (!pair) { next.push(entry); continue; }
      // A deleted asset/Class key has no identity. Remove that pair instead of
      // creating duplicate empty keys; values and array slots retain their place.
      const key = typeof pair.key === "string" && (keyField.typeId === "asset" || keyField.typeId === "class")
        ? map(pair.key, keyField.typeId === "asset" ? "asset" : "class")
        : mapScalarValue(pair.key, keyField, map, definitionFields);
      if (key === null && pair.key !== null) { changed = true; continue; }
      const mapped = mapScalarValue(pair.value, field, map, definitionFields);
      if (key !== pair.key || mapped !== pair.value) {
        changed = true;
        next.push({ ...pair, key, value: mapped });
      } else next.push(entry);
    }
    return changed ? next : value;
  }
  return mapScalarValue(value, field, map, definitionFields);
}

function mapValues(value: unknown, fields: readonly unknown[], map: ReferenceMapper, definitionFields?: DataDefinitionFieldsResolver): unknown {
  const values = record(value);
  if (!values) return value;
  let next = values;
  for (const entry of fields) {
    const field = record(entry);
    if (!field || typeof field.name !== "string" || !Object.hasOwn(values, field.name)) continue;
    const mapped = mapFieldValue(values[field.name], field, map, definitionFields);
    if (mapped === values[field.name]) continue;
    if (next === values) next = { ...values };
    next[field.name] = mapped;
  }
  return next;
}

function mapFields(fields: unknown[], map: ReferenceMapper, definitionFields?: DataDefinitionFieldsResolver): unknown[] {
  let changed = false;
  const next = fields.map((entry) => {
    const field = record(entry);
    if (!field) return entry;
    let result = field;
    const assign = (key: string, mapped: unknown) => {
      if (mapped === field[key]) return;
      if (result === field) result = { ...field };
      if (mapped === null && (key === "typeClassId" || key === "keyTypeClassId")) delete result[key];
      else result[key] = mapped;
    };
    if (["struct", "enum", "class", "object"].includes(String(field.typeId)) && typeof field.typeClassId === "string") {
      assign("typeClassId", map(field.typeClassId, field.typeId === "struct" || field.typeId === "enum" ? "asset" : "class"));
    }
    if (field.container === "map" && ["struct", "enum", "class", "object"].includes(String(field.keyTypeId)) && typeof field.keyTypeClassId === "string") {
      assign("keyTypeClassId", map(field.keyTypeClassId, field.keyTypeId === "struct" || field.keyTypeId === "enum" ? "asset" : "class"));
    }
    if (Object.hasOwn(field, "defaultValue")) assign("defaultValue", mapFieldValue(field.defaultValue, field, map, definitionFields));
    if (Array.isArray(field.fields)) assign("fields", mapFields(field.fields, map, definitionFields));
    if (field.container === "map" && Array.isArray(field.keyFields)) assign("keyFields", mapFields(field.keyFields, map, definitionFields));
    changed ||= result !== field;
    return result;
  });
  return changed ? next : fields;
}

/** Properties on typed data nodes carry the schema for their authored value literal. */
export function mapDataGraphLiteralReferences<T>(value: T, map: ReferenceMapper, definitionFields?: DataDefinitionFieldsResolver): T {
  const props = record(value);
  if (!props || !Array.isArray(props.dataSchema)) return value;
  const schema = mapFields(props.dataSchema, map, definitionFields);
  const values = mapValues(props["default:values"], props.dataSchema, map, definitionFields);
  if (schema === props.dataSchema && values === props["default:values"]) return value;
  return { ...props, dataSchema: schema, ...(Object.hasOwn(props, "default:values") ? { "default:values": values } : {}) } as T;
}

/** Structure and Enum identity/type references also participate in a bundled import. */
export function mapDataTypeReferences<T>(assetType: string, value: T, map: ReferenceMapper, definitionFields?: DataDefinitionFieldsResolver): T {
  if (assetType === "DataDefinition" || assetType === "DataTree") return mapDataAssetReferences(value, map, definitionFields);
  const payload = record(value);
  if (!payload || (assetType !== "Structure" && assetType !== "Enum")) return value;
  const guid = typeof payload.guid === "string" ? map(payload.guid, "asset") : payload.guid;
  const fields = assetType === "Structure" && Array.isArray(payload.fields) ? mapFields(payload.fields, map, definitionFields) : payload.fields;
  if (guid === payload.guid && fields === payload.fields) return value;
  return { ...payload, ...(guid !== payload.guid ? { guid } : {}), ...(fields !== payload.fields ? { fields } : {}) } as T;
}

/** Class names resolve through headers; engine types are not project asset GUIDs. */
export function dataAssetDependencies(
  assetType: string,
  value: unknown,
  classes: readonly { guid: string; classId: string }[] = [],
  definitionFields?: DataDefinitionFieldsResolver,
): string[] {
  const refs = new Set<string>();
  const classGuids = new Map<string, string>();
  for (const entry of classes) {
    classGuids.set(entry.classId, entry.guid);
    classGuids.set(entry.guid, entry.guid);
  }
  const ownGuid = record(value)?.guid;
  mapDataTypeReferences(assetType, value, (reference, kind) => {
    if (!reference || reference.startsWith("engine:") || reference === ownGuid) return reference;
    if (kind === "asset") refs.add(reference);
    else {
      const guid = classGuids.get(reference);
      if (guid) refs.add(guid);
    }
    return reference;
  }, definitionFields);
  return [...refs].sort();
}

export function remapDataPayloadGuids<T>(assetType: string, value: T, remap: ReadonlyMap<string, string>, definitionFields?: DataDefinitionFieldsResolver): T {
  const map = (reference: string) => remap.get(reference) ?? reference;
  return assetType === "Class" || assetType === "Graph"
    ? mapDataGraphReferences(value, map, definitionFields) : mapDataTypeReferences(assetType, value, map, definitionFields);
}

/** Data graph literals and variables retain asset identity through imports. */
export function mapDataGraphReferences<T>(value: T, map: ReferenceMapper, definitionFields?: DataDefinitionFieldsResolver): T {
  const guid = (entry: unknown) => typeof entry === "string" ? map(entry, "asset") ?? "" : entry;
  const withValue = (row: Record<string, unknown>, key: string, next: unknown): Record<string, unknown> =>
    row[key] === next ? row : { ...row, [key]: next };
  const variable = (spec: Record<string, unknown>, entry: unknown): unknown => {
    const isData = (type: unknown) => type === "DataDefinition" || type === "DataTree";
    const valueRef = spec.typeId === "asset" && isData(spec.typeClassId);
    if (spec.container === "map" && Array.isArray(entry)) {
      const keyRef = spec.keyTypeId === "asset" && isData(spec.keyTypeClassId);
      return mapArray(entry, (pair) => {
        const row = record(pair);
        return row ? withValue(withValue(row, "key", keyRef ? guid(row.key) : row.key), "value", valueRef ? guid(row.value) : row.value) : pair;
      });
    }
    return valueRef ? (Array.isArray(entry) ? mapArray(entry, guid) : guid(entry)) : entry;
  };
  const walk = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return mapArray(entry, walk);
    const row = record(entry);
    if (!row) return entry;
    let next = row;
    for (const [key, child] of Object.entries(row)) {
      // Defaults are user values, not graph nodes. Their declared type owns traversal.
      if (key === "defaultValue" || key.startsWith("default:")) continue;
      next = withValue(next, key, walk(child));
    }
    if (row.kind === "variable" && Object.hasOwn(row, "defaultValue")) next = withValue(next, "defaultValue", variable(row, row.defaultValue));
    const type = row.type ?? row.typeId;
    if (typeof type !== "string" || (!type.startsWith("data.") && !type.startsWith("editorData.") && type !== "variables.set")) return next;
    const data = record(next.data);
    const nested = record(data?.properties);
    const props = nested ?? data ?? record(next.properties);
    if (!props) return next;
    let mapped = props;
    if (type === "variables.set") {
      const name = typeof props.variableName === "string" ? props.variableName : "Value";
      for (const key of ["default:value", "value", `default:${name}`]) if (Object.hasOwn(props, key)) mapped = withValue(mapped, key, variable(props, props[key]));
    } else {
      for (const key of ["definitionGuid", "default:tree", "default:Tree"]) {
        if (Object.hasOwn(props, key)) mapped = withValue(mapped, key, guid(props[key]));
      }
      if (Array.isArray(props.dataSchema)) {
        mapped = withValue(mapped, "dataSchema", mapFields(props.dataSchema, map, definitionFields));
        if (Object.hasOwn(props, "default:values")) mapped = withValue(mapped, "default:values", mapValues(props["default:values"], props.dataSchema, map, definitionFields));
      }
    }
    if (nested) next = withValue(next, "data", withValue(data!, "properties", mapped));
    else if (data) next = withValue(next, "data", mapped);
    else next = withValue(next, "properties", mapped);
    return next;
  };
  return walk(value) as T;
}

export function dataGraphAssetDependencies(value: unknown, classes: readonly { guid: string; classId: string }[] = [], definitionFields?: DataDefinitionFieldsResolver): string[] {
  const refs = new Set<string>();
  const classGuids = new Map<string, string>();
  for (const entry of classes) {
    classGuids.set(entry.classId, entry.guid);
    classGuids.set(entry.guid, entry.guid);
  }
  mapDataGraphReferences(value, (reference, kind) => {
    const guid = kind === "class" ? classGuids.get(reference) : reference;
    if (guid && !guid.startsWith("engine:")) refs.add(guid);
    return reference;
  }, definitionFields);
  return [...refs].sort();
}
