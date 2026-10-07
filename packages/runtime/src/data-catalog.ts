import { buildDataTreeIndex, isDataDefinitionAsset, isDataTreeEntry, type DataAssetCatalogEntry, type DataTreeAsset } from "@babylonslate/core";
import { dataTypeSchemas, resolveDataEntryValues, validateDataDefinition } from "@babylonslate/scripting";

export { dataTypeSchemas } from "@babylonslate/scripting";

/** Read-only tree data. All paths match exact names, with no leading slash. */
export interface RuntimeDataApi {
  readEntry(tree: unknown, path: unknown, definitionGuid?: string): Record<string, unknown> | null;
  canReadEntry(tree: unknown, path: unknown, definitionGuid?: string): boolean;
  /** Structural presence includes untyped grouping entries, but not the root. */
  hasEntry(tree: unknown, path: unknown): boolean;
  hasTree(tree: unknown): boolean;
  getChildren(tree: unknown, parentPath?: unknown): string[];
  getDescendants(tree: unknown, parentPath?: unknown): string[];
  /** Top-level entries return ''; unknown entries and the virtual root return null. */
  getParent(tree: unknown, path: unknown): string | null;
}

type RuntimeEntry = {
  definitionGuid: string | null;
  values: Record<string, unknown> | null;
  parentPath: string;
  children: string[];
  start: number;
  end: number;
};

type RuntimeTree = {
  entries: Map<string, RuntimeEntry>;
  paths: string[];
  roots: string[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Builds hierarchy, exact-path lookups and contiguous descendant ranges once per
 * prepared source union. Reads only copy requested values or indexed path ranges;
 * no asset I/O, schema validation, or ancestor traversal occurs during reads.
 */
export class RuntimeDataCatalog implements RuntimeDataApi {
  private readonly trees = new Map<string, RuntimeTree>();

  constructor(catalog: readonly DataAssetCatalogEntry[] = []) { this.replace(catalog); }

  replace(catalog: readonly DataAssetCatalogEntry[]): void {
    this.trees.clear();
    const schemas = dataTypeSchemas(catalog);
    const definitions = new Set<string>();
    for (const asset of catalog) {
      if (asset.type !== "DataDefinition" || !isDataDefinitionAsset(asset.payload)) continue;
      try {
        if (!validateDataDefinition(asset.payload, schemas, asset.guid).some((issue) => issue.severity === "error")) {
          definitions.add(asset.guid);
        }
      } catch {
        // Malformed external schemas must not abort unrelated Definitions.
      }
    }
    for (const asset of catalog) {
      const payload = asset.payload;
      if (asset.type !== "DataTree" || !record(payload) || payload.kind !== "dataTree" || !Array.isArray(payload.entries)) continue;
      // The shared index validates topology independently of entry values, so a
      // malformed values object does not hide navigable, unrelated entries.
      const { index } = buildDataTreeIndex(payload as unknown as DataTreeAsset);
      if (!index) continue;
      const paths = index.orderedEntries.map((entry) => index.pathById.get(entry.id)!);
      const pathsFor = (parentId: string | null) => (index.childrenByParentId.get(parentId) ?? []).map((entry) => index.pathById.get(entry.id)!);
      const entries = new Map<string, RuntimeEntry>();
      for (const [position, entry] of index.orderedEntries.entries()) {
        const effective = index.effectiveDefinitionById.get(entry.id);
        const definitionGuid = typeof effective === "string" ? effective : null;
        let values: Record<string, unknown> | null = null;
        if (definitionGuid && definitions.has(definitionGuid) && isDataTreeEntry(entry)) {
          try {
            values = resolveDataEntryValues(entry, definitionGuid, schemas);
          } catch {
            // Invalid entry data blocks that read, while navigation stays available.
          }
        }
        entries.set(paths[position]!, {
          definitionGuid, values,
          parentPath: entry.parentId === null ? "" : index.pathById.get(entry.parentId)!,
          children: pathsFor(entry.id), start: position, end: position + 1,
        });
      }
      // Preorder descendants form contiguous ranges, requiring O(entries) space.
      for (let position = paths.length - 1; position >= 0; position--) {
        const entry = entries.get(paths[position]!)!;
        const parent = entries.get(entry.parentPath);
        if (parent) parent.end = Math.max(parent.end, entry.end);
      }
      this.trees.set(asset.guid, { entries, paths, roots: pathsFor(null) });
    }
  }

  private getTree(tree: unknown): RuntimeTree | undefined {
    return typeof tree === "string" ? this.trees.get(tree) : undefined;
  }

  private getEntry(tree: unknown, path: unknown): RuntimeEntry | undefined {
    return typeof path === "string" ? this.getTree(tree)?.entries.get(path) : undefined;
  }

  canReadEntry(tree: unknown, path: unknown, definitionGuid?: string): boolean {
    const entry = this.getEntry(tree, path);
    return !!entry && entry.values !== null && (!definitionGuid || entry.definitionGuid === definitionGuid);
  }

  readEntry(tree: unknown, path: unknown, definitionGuid?: string): Record<string, unknown> | null {
    const entry = this.getEntry(tree, path);
    if (!entry || entry.values === null || (definitionGuid && entry.definitionGuid !== definitionGuid)) return null;
    return structuredClone(entry.values);
  }

  hasEntry(tree: unknown, path: unknown): boolean {
    return this.getEntry(tree, path) !== undefined;
  }

  hasTree(tree: unknown): boolean {
    return this.getTree(tree) !== undefined;
  }

  getChildren(tree: unknown, parentPath: unknown = ""): string[] {
    const indexed = this.getTree(tree);
    if (!indexed) return [];
    return [...(parentPath === "" ? indexed.roots : this.getEntry(tree, parentPath)?.children ?? [])];
  }

  getDescendants(tree: unknown, parentPath: unknown = ""): string[] {
    const indexed = this.getTree(tree);
    if (!indexed) return [];
    if (parentPath === "") return [...indexed.paths];
    const entry = this.getEntry(tree, parentPath);
    return entry ? indexed.paths.slice(entry.start + 1, entry.end) : [];
  }

  getParent(tree: unknown, path: unknown): string | null {
    return this.getEntry(tree, path)?.parentPath ?? null;
  }
}
