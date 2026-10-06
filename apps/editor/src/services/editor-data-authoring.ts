import {
  createDataSheetAsset,
  isDataObjectAsset,
  isDataSheetAsset,
  type DataObjectAsset,
  type DataSheetAsset,
} from "@babylonslate/core";
import type { AssetRegistry, IndexedAsset } from "@babylonslate/assets";
import {
  createDataObjectForStructure,
  reconcileDataObject,
  resolveDataObjectValues,
  validateDataObject,
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

function requireStructure(guid: string, schemas: TypeSchemas): string {
  if (typeof guid !== "string" || !guid.trim() || !schemas.structs[guid]) {
    throw new Error("Select an existing Structure before authoring data.");
  }
  return guid;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validatedValues(values: unknown): Record<string, unknown> {
  if (!record(values)) throw new Error("Values must be a Structure value.");
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

function matchingStructure(asset: DataObjectAsset | DataSheetAsset, expected?: string): void {
  if (expected && asset.structureGuid !== expected) throw new Error("The asset uses a different Structure.");
}

/**
 * Serializes utility operations, using live canonical documents for every edit.
 * Only new assets write immediately; updates participate in normal Undo/Save All.
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

  function indexed(registry: AssetRegistry, reference: string, type: "DataObject" | "DataSheet"): IndexedAsset {
    const asset = typeof reference === "string" ? registry.getByGuid(reference) : undefined;
    if (!asset || asset.placeholder || asset.header.type !== type) throw new Error(`The ${type === "DataObject" ? "Data Object" : "Data Sheet"} reference is missing or has the wrong type.`);
    return asset;
  }

  async function read(host: Host, asset: IndexedAsset, check: () => void): Promise<DataObjectAsset | DataSheetAsset> {
    const payload = await host.loadAssetDocument(asset.header.type === "DataObject" ? "data-object" : "data-sheet", asset.path);
    check();
    if (asset.header.type === "DataObject" ? !isDataObjectAsset(payload) : !isDataSheetAsset(payload)) {
      throw new Error("The data asset could not be read.");
    }
    return payload as DataObjectAsset | DataSheetAsset;
  }

  function validateObject(asset: DataObjectAsset, schemas: TypeSchemas, registry: AssetRegistry): void {
    const errors = validateDataObject(asset, schemas, {
      assetTypeForGuid: (guid) => {
        const referenced = registry.getByGuid(guid);
        return referenced?.placeholder ? null : referenced?.header.type;
      },
    }).filter((issue) => issue.severity === "error");
    if (errors.length) throw new Error(errors.map((issue) => `${issue.path ? `${issue.path}: ` : ""}${issue.message}`).join("\n"));
  }

  async function members(host: Host, registry: AssetRegistry, references: string[], structure: string, check: () => void): Promise<string[]> {
    if (!Array.isArray(references) || references.some((reference) => typeof reference !== "string" || !reference)) {
      throw new Error("Objects must be an array of Data Object references.");
    }
    const unique = [...new Set(references)];
    for (const reference of unique) matchingStructure(await read(host, indexed(registry, reference, "DataObject"), check), structure);
    return unique;
  }

  async function edit(host: Host, registry: AssetRegistry, asset: IndexedAsset, check: () => void,
    change: (current: DataObjectAsset | DataSheetAsset) => DataObjectAsset | DataSheetAsset): Promise<string> {
    if (registry.getRoot(asset.rootId)?.readOnly) throw new Error("The data asset is read-only.");
    const id = await host.ensureAssetDocument({
      kind: asset.header.type === "DataObject" ? "data-object" : "data-sheet", path: asset.path, label: asset.header.name,
    });
    check();
    const current = host.getOpenDocuments().find((doc) => doc.id === id)?.content;
    if (!isDataObjectAsset(current) && !isDataSheetAsset(current)) throw new Error("The data asset is no longer open.");
    const next = change(current);
    if (JSON.stringify(current) === JSON.stringify(next)) return asset.header.guid;
    // applyAssetDocumentChange performs source-control and project-plugin checks.
    if (!await host.applyAssetDocumentChange(id, { ...next })) throw new Error("The data asset could not be edited. Check its read-only or source-control lock state.");
    check();
    return asset.header.guid;
  }

  function list(type: "DataObject" | "DataSheet", structure?: string) {
    return run(structure, async (filter, host, registry, check) => {
      const result: string[] = [];
      const open = new Map(host.getOpenDocuments().map((doc) => [doc.ref.path, doc.content]));
      for (const asset of registry.list()) {
        if (asset.placeholder || asset.header.type !== type) continue;
        if (!filter) { result.push(asset.header.guid); continue; }
        const live = open.get(asset.path);
        const header = asset.header.payload;
        const structure = isDataObjectAsset(live) || isDataSheetAsset(live) ? live.structureGuid :
          typeof header?.structureGuid === "string" || header?.structureGuid === null ? header.structureGuid :
          (await read(host, asset, check)).structureGuid;
        if (structure === filter) result.push(asset.header.guid);
      }
      return result;
    });
  }

  return {
    listObjects: (structure) => list("DataObject", structure),
    listSheets: (structure) => list("DataSheet", structure),
    readObject: (reference, structure) => run({ reference, structure }, async (args, host, registry, check) => {
      const asset = await read(host, indexed(registry, args.reference, "DataObject"), check) as DataObjectAsset;
      matchingStructure(asset, args.structure);
      const schemas = schemasFor(host);
      validateObject(asset, schemas, registry);
      const values = resolveDataObjectValues(asset, schemas);
      if (!values) throw new Error("The Data Object needs its Structure changes applied before it can be read.");
      return values;
    }),
    readSheet: (reference, structure) => run({ reference, structure }, async (args, host, registry, check) => {
      const sheet = await read(host, indexed(registry, args.reference, "DataSheet"), check) as DataSheetAsset;
      matchingStructure(sheet, args.structure);
      return [...sheet.objectGuids];
    }),
    createObject: (name, structure, values = {}, folder = "") => run({ name, structure, values, folder }, async (args, host, registry, check) => {
      const schemas = schemasFor(host);
      const guid = requireStructure(args.structure, schemas);
      const asset = createDataObjectForStructure(guid, schemas.structs[guid]!.fields, schemas);
      asset.values = mergeValues(asset.values, validatedValues(args.values), schemas.structs[guid]!.fields, schemas);
      validateObject(asset, schemas, registry);
      check();
      const created = await createProjectAsset({ registry, rootId: "project", folderRelative: folderPath(args.folder), type: "DataObject", name: args.name, structureGuid: guid, typeSchemas: schemas, dataObject: asset });
      check();
      host.noteAssetsCreated();
      return created.header.guid;
    }),
    updateObject: (reference, structure, values) => run({ reference, structure, values }, async (args, host, registry, check) => {
      validatedValues(args.values);
      return edit(host, registry, indexed(registry, args.reference, "DataObject"), check, (current) => {
        if (!isDataObjectAsset(current)) throw new Error("Expected a Data Object.");
        const schemas = schemasFor(host);
        const guid = requireStructure(args.structure, schemas);
        matchingStructure(current, guid);
        const migration = reconcileDataObject(current, schemas.structs[guid]!.fields, schemas);
        if (migration.changes.some((change) => change.kind === "added" || change.kind === "renamed") ||
          migration.issues.some((issue) => issue.severity === "error" && structuralIssues.has(issue.code))) {
          throw new Error("Apply Structure changes to the Data Object before updating its values.");
        }
        const next = { ...current, values: mergeValues(current.values, args.values, schemas.structs[guid]!.fields, schemas) };
        validateObject(next, schemas, registry);
        // Once a script repairs an incompatible value, record its current type.
        // Until then validation above keeps the old value and reference metadata.
        return reconcileDataObject(next, schemas.structs[guid]!.fields, schemas).asset;
      });
    }),
    createSheet: (name, structure, objectGuids = [], folder = "") => run({ name, structure, objectGuids, folder }, async (args, host, registry, check) => {
      const schemas = schemasFor(host);
      const guid = requireStructure(args.structure, schemas);
      const objects = await members(host, registry, args.objectGuids, guid, check);
      const created = await createProjectAsset({ registry, rootId: "project", folderRelative: folderPath(args.folder), type: "DataSheet", name: args.name, structureGuid: guid, typeSchemas: schemas, dataSheet: createDataSheetAsset(guid, objects) });
      check();
      host.noteAssetsCreated();
      return created.header.guid;
    }),
    setSheetObjects: (reference, structure, objectGuids) => run({ reference, structure, objectGuids }, async (args, host, registry, check) => {
      const guid = requireStructure(args.structure, schemasFor(host));
      const asset = indexed(registry, args.reference, "DataSheet");
      const objects = await members(host, registry, args.objectGuids, guid, check);
      return edit(host, registry, asset, check, (current) => {
        if (!isDataSheetAsset(current)) throw new Error("Expected a Data Sheet.");
        matchingStructure(current, guid);
        return { ...current, objectGuids: objects };
      });
    }),
  };
}
