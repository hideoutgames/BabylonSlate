import {
  buildDataTreeIndex,
  createDataTreeAsset,
  createDataTreeEntry,
  type DataTreeIndex,
  isDataTreeAsset,
  type DataDefinitionField,
  type DataTreeAsset,
  type DataTreeEntry,
} from "@babylonslate/core";
import type { AssetRegistry, IndexedAsset } from "@babylonslate/assets";
import {
  createDataEntryForDefinition,
  reconcileDataEntry,
  resolveDataEntryValues,
  serializeDataEntryValues,
  validateDataDefinition,
  validateDataEntry,
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

function indexTree(tree: DataTreeAsset): DataTreeIndex {
  const result = buildDataTreeIndex(tree);
  if (!result.index) throw new Error(result.issues.map((issue) => issue.message).join("\n"));
  return result.index;
}

function requireEntry(index: DataTreeIndex, path: string): DataTreeEntry {
  const id = typeof path === "string" ? index.idByPath.get(path) : undefined;
  if (id === undefined) throw new Error("No entry with this exact path exists in the Data Tree.");
  return index.byId.get(id)!;
}

function parentId(index: DataTreeIndex, path: string): string | null {
  return path === "" ? null : requireEntry(index, path).id;
}

function descendants(index: DataTreeIndex, parent: string | null): DataTreeEntry[] {
  const result: DataTreeEntry[] = [];
  const stack = [...(index.childrenByParentId.get(parent) ?? [])].reverse();
  while (stack.length) {
    const entry = stack.pop()!;
    result.push(entry);
    const children = index.childrenByParentId.get(entry.id) ?? [];
    for (let offset = children.length - 1; offset >= 0; offset--) stack.push(children[offset]!);
  }
  return result;
}

/** Changes only sibling ordering, retaining every other entry and its metadata. */
function orderChildren(tree: DataTreeAsset, parent: string | null, children: readonly DataTreeEntry[]): DataTreeAsset {
  let offset = 0;
  return { ...tree, entries: tree.entries.map((entry) => entry.parentId === parent ? children[offset++]! : entry) };
}

/** Serialized, cancellable operations on live canonical tree documents. */
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
    if (!asset || asset.placeholder || asset.header.type !== "DataTree") throw new Error("The Data Tree reference is missing or has the wrong type. Legacy Data Sheets and Data Objects are unsupported.");
    return asset;
  }

  async function read(host: Host, asset: IndexedAsset, check: () => void): Promise<DataTreeAsset> {
    const payload = await host.loadAssetDocument("data-tree", asset.path);
    check();
    if (!isDataTreeAsset(payload)) throw new Error("The Data Tree could not be read.");
    return payload;
  }

  function validateEntry(entry: DataTreeEntry, definition: string | null, schemas: TypeSchemas, registry: AssetRegistry): void {
    const errors = validateDataEntry(entry, definition, schemas, {
      assetTypeForGuid: (guid) => {
        const referenced = registry.getByGuid(guid);
        return referenced?.placeholder ? null : referenced?.header.type;
      },
    }).filter((issue) => issue.severity === "error");
    if (errors.length) throw new Error(errors.map((issue) => `${issue.path ? `${issue.path}: ` : ""}${issue.message}`).join("\n"));
  }

  async function edit<T>(host: Host, registry: AssetRegistry, asset: IndexedAsset, check: () => void,
    change: (current: DataTreeAsset, index: DataTreeIndex) => { tree: DataTreeAsset; value: T }): Promise<T> {
    if (registry.getRoot(asset.rootId)?.readOnly) throw new Error("The Data Tree is read-only.");
    const id = await host.ensureAssetDocument({ kind: "data-tree", path: asset.path, label: asset.header.name });
    check();
    const current = host.getOpenDocuments().find((doc) => doc.id === id)?.content;
    if (!isDataTreeAsset(current)) throw new Error("The Data Tree is no longer open.");
    const { tree, value } = change(current, indexTree(current));
    indexTree(tree);
    if (JSON.stringify(current) === JSON.stringify(tree)) return value;
    if (!await host.applyAssetDocumentChange(id, { ...tree })) throw new Error("The Data Tree could not be edited. Check its read-only or source-control lock state.");
    check();
    return value;
  }

  function navigate(reference: string, path: string, recursive: boolean): Promise<EditorDataResult<string[]>> {
    return run({ reference, path }, async (args, host, registry, check) => {
      const index = indexTree(await read(host, indexed(registry, args.reference), check));
      const parent = parentId(index, args.path);
      const entries = recursive ? descendants(index, parent) : index.childrenByParentId.get(parent) ?? [];
      return entries.map((entry) => index.pathById.get(entry.id)!);
    });
  }

  return {
    listTrees: (definition) => run(definition, async (filter, host, registry, check) => {
      if (filter) requireDefinition(filter, schemasFor(host), registry);
      const result: string[] = [];
      const open = new Map(host.getOpenDocuments().map((doc) => [doc.ref.path, doc.content]));
      for (const asset of registry.list()) {
        if (asset.placeholder || asset.header.type !== "DataTree") continue;
        if (!filter) { result.push(asset.header.guid); continue; }
        const live = open.get(asset.path) ?? asset.header.payload;
        const tree = isDataTreeAsset(live) ? live : await read(host, asset, check);
        const index = indexTree(tree);
        if (tree.defaultDefinitionGuid === filter || [...index.effectiveDefinitionById.values()].includes(filter)) result.push(asset.header.guid);
      }
      return result;
    }),
    readTree: (reference) => run(reference, async (ref, host, registry, check) => {
      const index = indexTree(await read(host, indexed(registry, ref), check));
      return index.orderedEntries.map((entry) => index.pathById.get(entry.id)!);
    }),
    readEntry: (reference, entryPath, definition) => run({ reference, entryPath, definition }, async (args, host, registry, check) => {
      const index = indexTree(await read(host, indexed(registry, args.reference), check));
      const entry = requireEntry(index, args.entryPath);
      const schemas = schemasFor(host);
      const guid = requireDefinition(index.effectiveDefinitionById.get(entry.id), schemas, registry);
      if (args.definition && guid !== args.definition) throw new Error("The entry uses a different Data Definition.");
      validateEntry(entry, guid, schemas, registry);
      const values = resolveDataEntryValues(entry, guid, schemas);
      if (!values) throw new Error("Apply Data Definition changes to this entry before it can be read.");
      return values;
    }),
    getChildren: (reference, path = "") => navigate(reference, path, false),
    getDescendants: (reference, path = "") => navigate(reference, path, true),
    getParent: (reference, path) => run({ reference, path }, async (args, host, registry, check) => {
      const index = indexTree(await read(host, indexed(registry, args.reference), check));
      const entry = requireEntry(index, args.path);
      return entry.parentId === null ? "" : index.pathById.get(entry.parentId)!;
    }),
    createTree: (name, definition = null, folder = "") => run({ name, definition, folder }, async (args, host, registry, check) => {
      const schemas = schemasFor(host);
      const guid = args.definition === null ? null : requireDefinition(args.definition, schemas, registry);
      check();
      const created = await createProjectAsset({ registry, rootId: "project", folderRelative: folderPath(args.folder), type: "DataTree", name: args.name, defaultDefinitionGuid: guid, typeSchemas: schemas, dataTree: createDataTreeAsset(guid) });
      check();
      host.noteAssetsCreated();
      return created.header.guid;
    }),
    addEntry: (reference, parentPath, name, definition, values = {}) => run({ reference, parentPath, name, definition, values }, async (args, host, registry, check) => {
      validatedValues(args.values);
      return edit(host, registry, indexed(registry, args.reference), check, (current, index) => {
        const parent = parentId(index, args.parentPath);
        const effective = args.definition === undefined ? parent === null ? current.defaultDefinitionGuid : index.effectiveDefinitionById.get(parent)! : args.definition;
        const schemas = schemasFor(host);
        let entry: DataTreeEntry;
        if (effective === null) {
          entry = createDataTreeEntry({ name: args.name, parentId: parent, values: args.values });
        } else {
          const guid = requireDefinition(effective, schemas, registry);
          const fields = schemas.dataDefinitions![guid]!.fields;
          entry = createDataEntryForDefinition(guid, fields, schemas, args.name, undefined, parent);
          entry.values = mergeValues(entry.values, serializeDataEntryValues(args.values, fields, schemas), fields, schemas);
        }
        if (args.definition === undefined) delete entry.definitionGuid;
        else entry.definitionGuid = args.definition;
        validateEntry(entry, effective, schemas, registry);
        const tree = { ...current, entries: [...current.entries, entry] };
        return { tree, value: indexTree(tree).pathById.get(entry.id)! };
      });
    }),
    updateEntry: (reference, entryPath, definition, values) => run({ reference, entryPath, definition, values }, async (args, host, registry, check) => {
      validatedValues(args.values);
      return edit(host, registry, indexed(registry, args.reference), check, (current, index) => {
        const schemas = schemasFor(host);
        const guid = requireDefinition(args.definition, schemas, registry);
        const entry = requireEntry(index, args.entryPath);
        if (index.effectiveDefinitionById.get(entry.id) !== guid) throw new Error("The entry uses a different Data Definition.");
        const fields = schemas.dataDefinitions![guid]!.fields;
        const migration = reconcileDataEntry(entry, guid, fields, schemas);
        if (migration.changes.some((change) => change.kind === "added" || change.kind === "renamed") ||
          migration.issues.some((issue) => issue.severity === "error" && structuralIssues.has(issue.code))) {
          throw new Error("Apply Data Definition changes to this entry before updating its values.");
        }
        const supplied = serializeDataEntryValues(args.values, fields, schemas);
        const next = { ...entry, values: mergeValues(entry.values, supplied, fields, schemas) };
        validateEntry(next, guid, schemas, registry);
        const reconciled = reconcileDataEntry(next, guid, fields, schemas).entry;
        return { tree: { ...current, entries: current.entries.map((other) => other.id === entry.id ? reconciled : other) }, value: args.entryPath };
      });
    }),
    removeEntry: (reference, entryPath) => run({ reference, entryPath }, async (args, host, registry, check) =>
      edit(host, registry, indexed(registry, args.reference), check, (current, index) => {
        const entry = requireEntry(index, args.entryPath);
        const removed = new Set([entry.id, ...descendants(index, entry.id).map((child) => child.id)]);
        return { tree: { ...current, entries: current.entries.filter((other) => !removed.has(other.id)) }, value: args.entryPath };
      })),
    moveEntry: (reference, entryPath, newParentPath, position) => run({ reference, entryPath, newParentPath, position }, async (args, host, registry, check) =>
      edit(host, registry, indexed(registry, args.reference), check, (current, index) => {
        const entry = requireEntry(index, args.entryPath);
        const parent = parentId(index, args.newParentPath);
        const siblings = (index.childrenByParentId.get(parent) ?? []).filter((child) => child.id !== entry.id);
        const offset = args.position ?? siblings.length;
        if (!Number.isInteger(offset) || offset < 0 || offset > siblings.length) throw new Error("The destination index must be within the parent's child list.");
        const moved = { ...entry, parentId: parent };
        siblings.splice(offset, 0, moved);
        const tree = orderChildren({ ...current, entries: current.entries.map((other) => other.id === entry.id ? moved : other) }, parent, siblings);
        return { tree, value: indexTree(tree).pathById.get(entry.id)! };
      })),
    reorderChildren: (reference, parentPath, entryPaths) => run({ reference, parentPath, entryPaths }, async (args, host, registry, check) =>
      edit(host, registry, indexed(registry, args.reference), check, (current, index) => {
        const parent = parentId(index, args.parentPath);
        const children = index.childrenByParentId.get(parent) ?? [];
        const expected = new Map(children.map((entry) => [index.pathById.get(entry.id)!, entry]));
        if (!Array.isArray(args.entryPaths) || args.entryPaths.length !== expected.size || new Set(args.entryPaths).size !== expected.size ||
          args.entryPaths.some((path) => typeof path !== "string" || !expected.has(path))) {
          throw new Error("Child order must contain every immediate child path exactly once.");
        }
        return { tree: orderChildren(current, parent, args.entryPaths.map((path) => expected.get(path)!)), value: args.reference };
      })),
  };
}
