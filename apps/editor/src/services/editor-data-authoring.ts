import {
  createDataSheetAsset,
  isDataSheetAsset,
  type DataDefinitionField,
  type DataSheetAsset,
  type DataSheetRow,
} from "@babylonslate/core";
import type { AssetRegistry, IndexedAsset } from "@babylonslate/assets";
import {
  createDataRowForDefinition,
  reconcileDataRow,
  resolveDataRowValues,
  serializeDataRowValues,
  validateDataDefinition,
  validateDataRow,
  type EditorDataApi,
  type EditorDataResult,
  type StructField,
  type TypeSchemas,
} from "@babylonslate/scripting";
import type { useDocuments } from "../context/document-context";
import { createProjectAsset } from "../lib/create-project-asset";
import { collectGraphTypeAssets, typeSchemasFromGraphAssets } from "../lib/logic-graph-document";

type Host = Pick<ReturnType<typeof useDocuments>,
  "assetRegistry" | "getOpenDocuments" | "loadAssetDocument" |
  "ensureAssetDocument" | "applyAssetDocumentChange" | "noteAssetsCreated"
>;
const structuralIssues = new Set(["rename-conflict", "ambiguous-schema", "invalid-schema", "recursive-schema"]);

function schemasFor(host: Host): TypeSchemas {
  return typeSchemasFromGraphAssets(collectGraphTypeAssets({
    assets: host.assetRegistry!.list(), openDocuments: host.getOpenDocuments(),
  }));
}

function requireDefinition(guid: unknown, schemas: TypeSchemas, registry: AssetRegistry): string {
  const asset = typeof guid === "string" ? registry.getByGuid(guid) : undefined;
  if (typeof guid !== "string" || !guid.trim() || !schemas.dataDefinitions?.[guid] ||
    !asset || asset.placeholder || asset.header.type !== "DataDefinition") {
    throw new Error("Select an existing Data Definition before authoring data.");
  }
  const errors = validateDataDefinition({ kind: "dataDefinition", fields: schemas.dataDefinitions[guid]!.fields as DataDefinitionField[] }, schemas, guid)
    .filter((issue) => issue.severity === "error");
  if (errors.length) throw new Error(errors.map((issue) => `${issue.path ? `${issue.path}: ` : ""}${issue.message}`).join("\n"));
  return guid;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validatedValues(values: unknown): Record<string, unknown> {
  if (!record(values)) throw new Error("Values must be a Data Definition value.");
  return values;
}

/** A typed read omits retained fields; writing it back must keep authored extras. */
function mergeValues(
  current: Record<string, unknown>, patch: Record<string, unknown>,
  fields: readonly StructField[], schemas: TypeSchemas, depth = 0,
): Record<string, unknown> {
  const next = { ...current, ...patch };
  if (depth >= 64) return next; // Full validation below rejects excessive nesting.
  for (const field of fields) {
    if (field.typeId !== "struct" || !field.typeClassId ||
      field.container === "array" || field.container === "map" ||
      !Object.prototype.hasOwnProperty.call(patch, field.name)) continue;
    const nested = schemas.structs[field.typeClassId];
    const previous = current[field.name];
    const value = patch[field.name];
    if (nested && record(previous) && record(value)) {
      Object.defineProperty(next, field.name, {
        value: mergeValues(previous, value, nested.fields, schemas, depth + 1),
        enumerable: true, configurable: true, writable: true,
      });
    }
  }
  return next;
}

function folderPath(folder: string): string {
  if (typeof folder !== "string" || folder.includes("\\") || folder.startsWith("/") ||
    folder.split("/").some((part) => part === "." || part === ".." || part.includes(":")) || Array.from(folder).some((char) => char.charCodeAt(0) < 32)) {
    throw new Error("Folder must be relative to project content, without parent traversal.");
  }
  return folder.replace(/\/+$/, "");
}

function matchingDefinition(sheet: DataSheetAsset, expected?: string): void {
  if (expected && sheet.definitionGuid !== expected) throw new Error("The Data Sheet uses a different Data Definition.");
}

function rowsById(sheet: DataSheetAsset): Map<string, DataSheetRow> {
  const rows = new Map<string, DataSheetRow>();
  for (const row of sheet.rows) {
    if (!row.id.trim() || rows.has(row.id)) throw new Error("The Data Sheet contains missing or duplicate row IDs. Repair the sheet before authoring rows.");
    rows.set(row.id, row);
  }
  return rows;
}

function requireRow(sheet: DataSheetAsset, id: string): DataSheetRow {
  const row = rowsById(sheet).get(id);
  if (!row) throw new Error("The row does not belong to this Data Sheet or no longer exists.");
  return row;
}

function uniqueRowName(sheet: DataSheetAsset, name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new Error("Enter a name for the new row.");
  const normalized = name.trim();
  if (sheet.rows.some((row) => row.name.trim().toLowerCase() === normalized.toLowerCase())) {
    throw new Error("A row with this name already exists in the Data Sheet.");
  }
  return normalized;
}

/**
 * Serializes utility operations, using live canonical sheets for every edit.
 * Only new sheets write immediately; row edits use the sheet's Undo/Save history.
 */
export function createEditorDataAuthoringApi(
  getHost: () => Host,
  isActive: () => boolean = () => true,
): EditorDataApi {
  let pending: Promise<unknown> = Promise.resolve();

  function run<A, T>(args: A, work: (args: A, host: Host, registry: AssetRegistry, check: () => void) => Promise<T>): Promise<EditorDataResult<T>> {
    let input: A;
    let owner: AssetRegistry | null;
    try {
      input = structuredClone(args);
      owner = getHost().assetRegistry;
    } catch (error) {
      return Promise.resolve({ success: false, value: null, error: error instanceof Error ? error.message : String(error) });
    }
    const operation = pending.then(async (): Promise<EditorDataResult<T>> => {
      try {
        const check = () => {
          if (!isActive() || !owner || getHost().assetRegistry !== owner) {
            throw new Error("The editor data operation was cancelled because its project or utility host changed.");
          }
        };
        check();
        const value = await work(input, getHost(), owner!, check);
        check();
        return { success: true, value, error: "" };
      } catch (error) {
        return { success: false, value: null, error: error instanceof Error ? error.message : String(error) };
      }
    });
    pending = operation;
    return operation;
  }

  function indexed(registry: AssetRegistry, reference: string): IndexedAsset {
    const asset = typeof reference === "string" ? registry.getByGuid(reference) : undefined;
    if (!asset || asset.placeholder || asset.header.type !== "DataSheet") throw new Error("The Data Sheet reference is missing or has the wrong type.");
    return asset;
  }

  async function read(host: Host, asset: IndexedAsset, check: () => void): Promise<DataSheetAsset> {
    const payload = await host.loadAssetDocument("data-sheet", asset.path);
    check();
    if (!isDataSheetAsset(payload)) throw new Error("The Data Sheet could not be read.");
    return payload;
  }

  function validateRow(row: DataSheetRow, definition: string, schemas: TypeSchemas, registry: AssetRegistry): void {
    const errors = validateDataRow(row, definition, schemas, {
      assetTypeForGuid: (guid) => {
        const referenced = registry.getByGuid(guid);
        return referenced?.placeholder ? null : referenced?.header.type;
      },
    }).filter((issue) => issue.severity === "error");
    if (errors.length) throw new Error(errors.map((issue) => `${issue.path ? `${issue.path}: ` : ""}${issue.message}`).join("\n"));
  }

  async function edit<T>(host: Host, registry: AssetRegistry, asset: IndexedAsset, check: () => void,
    change: (current: DataSheetAsset) => { sheet: DataSheetAsset; value: T }): Promise<T> {
    if (registry.getRoot(asset.rootId)?.readOnly) throw new Error("The Data Sheet is read-only.");
    const id = await host.ensureAssetDocument({ kind: "data-sheet", path: asset.path, label: asset.header.name });
    check();
    const current = host.getOpenDocuments().find((doc) => doc.id === id)?.content;
    if (!isDataSheetAsset(current)) throw new Error("The Data Sheet is no longer open.");
    const { sheet, value } = change(current);
    if (JSON.stringify(current) === JSON.stringify(sheet)) return value;
    // applyAssetDocumentChange performs source-control and project-plugin checks.
    if (!await host.applyAssetDocumentChange(id, { ...sheet })) throw new Error("The Data Sheet could not be edited. Check its read-only or source-control lock state.");
    check();
    return value;
  }

  return {
    listSheets: (definition) => run(definition, async (filter, host, registry, check) => {
      if (filter) requireDefinition(filter, schemasFor(host), registry);
      const result: string[] = [];
      const open = new Map(host.getOpenDocuments().map((doc) => [doc.ref.path, doc.content]));
      for (const asset of registry.list()) {
        if (asset.placeholder || asset.header.type !== "DataSheet") continue;
        if (!filter) { result.push(asset.header.guid); continue; }
        const live = open.get(asset.path);
        const header = asset.header.payload;
        const definition = isDataSheetAsset(live) ? live.definitionGuid :
          typeof header?.definitionGuid === "string" || header?.definitionGuid === null ? header.definitionGuid :
          (await read(host, asset, check)).definitionGuid;
        if (definition === filter) result.push(asset.header.guid);
      }
      return result;
    }),
    readSheet: (reference, definition) => run({ reference, definition }, async (args, host, registry, check) => {
      const sheet = await read(host, indexed(registry, args.reference), check);
      matchingDefinition(sheet, args.definition);
      return [...rowsById(sheet).keys()];
    }),
    readRow: (reference, rowId, definition) => run({ reference, rowId, definition }, async (args, host, registry, check) => {
      const sheet = await read(host, indexed(registry, args.reference), check);
      matchingDefinition(sheet, args.definition);
      const schemas = schemasFor(host);
      const guid = requireDefinition(sheet.definitionGuid, schemas, registry);
      const row = requireRow(sheet, args.rowId);
      validateRow(row, guid, schemas, registry);
      const values = resolveDataRowValues(row, guid, schemas);
      if (!values) throw new Error("Apply Data Definition changes to this row before it can be read.");
      return values;
    }),
    createSheet: (name, definition, folder = "") => run({ name, definition, folder }, async (args, host, registry, check) => {
      const schemas = schemasFor(host);
      const guid = requireDefinition(args.definition, schemas, registry);
      check();
      const created = await createProjectAsset({ registry, rootId: "project", folderRelative: folderPath(args.folder), type: "DataSheet", name: args.name, definitionGuid: guid, typeSchemas: schemas, dataSheet: createDataSheetAsset(guid) });
      check();
      host.noteAssetsCreated();
      return created.header.guid;
    }),
    addRow: (reference, definition, name, values = {}) => run({ reference, definition, name, values }, async (args, host, registry, check) => {
      validatedValues(args.values);
      return edit(host, registry, indexed(registry, args.reference), check, (current) => {
        const schemas = schemasFor(host);
        const guid = requireDefinition(args.definition, schemas, registry);
        matchingDefinition(current, guid);
        rowsById(current);
        const fields = schemas.dataDefinitions![guid]!.fields;
        const row = createDataRowForDefinition(guid, fields, schemas, uniqueRowName(current, args.name));
        const supplied = serializeDataRowValues(args.values, fields, schemas);
        row.values = mergeValues(row.values, supplied, fields, schemas);
        validateRow(row, guid, schemas, registry);
        return { sheet: { ...current, rows: [...current.rows, row] }, value: row.id };
      });
    }),
    updateRow: (reference, rowId, definition, values) => run({ reference, rowId, definition, values }, async (args, host, registry, check) => {
      validatedValues(args.values);
      return edit(host, registry, indexed(registry, args.reference), check, (current) => {
        const schemas = schemasFor(host);
        const guid = requireDefinition(args.definition, schemas, registry);
        matchingDefinition(current, guid);
        const row = requireRow(current, args.rowId);
        const fields = schemas.dataDefinitions![guid]!.fields;
        const migration = reconcileDataRow(row, guid, fields, schemas);
        if (migration.changes.some((change) => change.kind === "added" || change.kind === "renamed") ||
          migration.issues.some((issue) => issue.severity === "error" && structuralIssues.has(issue.code))) {
          throw new Error("Apply Data Definition changes to this row before updating its values.");
        }
        const supplied = serializeDataRowValues(args.values, fields, schemas);
        const next = { ...row, values: mergeValues(row.values, supplied, fields, schemas) };
        validateRow(next, guid, schemas, registry);
        // Keep old reference metadata until a script repairs incompatible values.
        const reconciled = reconcileDataRow(next, guid, fields, schemas).row;
        return { sheet: { ...current, rows: current.rows.map((entry) => entry.id === row.id ? reconciled : entry) }, value: row.id };
      });
    }),
    removeRow: (reference, rowId, definition) => run({ reference, rowId, definition }, async (args, host, registry, check) =>
      edit(host, registry, indexed(registry, args.reference), check, (current) => {
        const guid = requireDefinition(args.definition, schemasFor(host), registry);
        matchingDefinition(current, guid);
        const row = requireRow(current, args.rowId);
        return { sheet: { ...current, rows: current.rows.filter((entry) => entry.id !== row.id) }, value: row.id };
      })),
    reorderRows: (reference, definition, rowIds) => run({ reference, definition, rowIds }, async (args, host, registry, check) =>
      edit(host, registry, indexed(registry, args.reference), check, (current) => {
        const guid = requireDefinition(args.definition, schemasFor(host), registry);
        matchingDefinition(current, guid);
        const rows = rowsById(current);
        if (!Array.isArray(args.rowIds) || args.rowIds.length !== rows.size || new Set(args.rowIds).size !== rows.size ||
          args.rowIds.some((id) => typeof id !== "string" || !rows.has(id))) {
          throw new Error("Row order must contain every current row ID exactly once.");
        }
        return { sheet: { ...current, rows: args.rowIds.map((id) => rows.get(id)!) }, value: args.reference };
      })),
  };
}
