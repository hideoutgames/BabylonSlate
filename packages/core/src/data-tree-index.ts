import type { DataTreeAsset, DataTreeEntry } from "./data-assets";

export interface DataTreeHierarchyIssue {
  code: string;
  severity: "error";
  entryId?: string;
  path: string;
  message: string;
}

export interface DataTreeIndex {
  readonly byId: ReadonlyMap<string, DataTreeEntry>;
  readonly childrenByParentId: ReadonlyMap<string | null, readonly DataTreeEntry[]>;
  readonly pathById: ReadonlyMap<string, string>;
  readonly idByPath: ReadonlyMap<string, string>;
  readonly effectiveDefinitionById: ReadonlyMap<string, string | null>;
  readonly orderedEntries: readonly DataTreeEntry[];
}

/** Exact name paths and schema inheritance; never mutates or repairs authored data. */
export function buildDataTreeIndex(tree: DataTreeAsset): { index: DataTreeIndex | null; issues: DataTreeHierarchyIssue[] } {
  const issues: DataTreeHierarchyIssue[] = [];
  const addIssue = (code: string, message: string, entryId?: string): void => {
    issues.push({ code, severity: "error", ...(entryId !== undefined ? { entryId } : {}), path: "", message });
  };
  if (!tree || tree.kind !== "dataTree" || !Array.isArray(tree.entries)) {
    addIssue("invalid-tree", "Data Tree entries must be an array.");
    return { index: null, issues };
  }
  const byId = new Map<string, DataTreeEntry>();
  const childrenByParentId = new Map<string | null, DataTreeEntry[]>();
  const siblingNames = new Map<string | null, Set<string>>();
  for (const entry of tree.entries) {
    if (!entry || typeof entry !== "object") { addIssue("invalid-entry", "Data Tree entries must be objects."); continue; }
    if (typeof entry.id !== "string" || !entry.id || entry.id.trim() !== entry.id || byId.has(entry.id)) {
      addIssue("duplicate-entry", "Entries need unique, non-empty identities without surrounding whitespace.", typeof entry.id === "string" ? entry.id : undefined);
      continue;
    }
    byId.set(entry.id, entry);
    if (entry.parentId !== null && (typeof entry.parentId !== "string" || !entry.parentId || entry.parentId.trim() !== entry.parentId)) {
      addIssue("invalid-parent", "Entry parent must be an existing internal identity or null for the tree root.", entry.id);
      continue;
    }
    const siblings = childrenByParentId.get(entry.parentId) ?? [];
    siblings.push(entry);
    childrenByParentId.set(entry.parentId, siblings);
    if (typeof entry.name !== "string" || !entry.name || entry.name.trim() !== entry.name || entry.name === "." || entry.name === ".." || /[/\p{Cc}]/u.test(entry.name)) {
      addIssue("invalid-entry-name", "Entry names must be trimmed, non-empty, and cannot contain slashes or control characters, or equal '.' or '..'.", entry.id);
      continue;
    }
    const names = siblingNames.get(entry.parentId) ?? new Set<string>();
    const normalized = entry.name.toLowerCase();
    if (names.has(normalized)) addIssue("duplicate-entry-name", "Entry names must be unique among siblings.", entry.id);
    names.add(normalized);
    siblingNames.set(entry.parentId, names);
  }
  for (const entry of byId.values()) {
    if (entry.parentId === entry.id) addIssue("cyclic-tree", "An entry cannot parent itself.", entry.id);
    else if (entry.parentId !== null && !byId.has(entry.parentId)) addIssue("missing-parent", "Entry parent no longer exists.", entry.id);
  }
  if (issues.length) return { index: null, issues };

  // Every parent chain is visited once, including disconnected cycles with no root.
  const visited = new Set<string>();
  for (const entry of byId.values()) {
    const chain = new Set<string>();
    let current: DataTreeEntry | undefined = entry;
    while (current && !visited.has(current.id)) {
      if (chain.has(current.id)) { addIssue("cyclic-tree", "Entry parent links contain a cycle.", current.id); break; }
      chain.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    for (const id of chain) visited.add(id);
  }
  if (issues.length) return { index: null, issues };

  const pathById = new Map<string, string>();
  const idByPath = new Map<string, string>();
  const effectiveDefinitionById = new Map<string, string | null>();
  const orderedEntries: DataTreeEntry[] = [];
  const stack = [...(childrenByParentId.get(null) ?? [])].reverse().map((entry) => ({ entry, depth: 1 }));
  while (stack.length) {
    const { entry, depth } = stack.pop()!;
    if (depth > 128) { addIssue("tree-depth", "Data Trees cannot exceed 128 entry levels.", entry.id); continue; }
    const parentPath = entry.parentId === null ? "" : pathById.get(entry.parentId)!;
    const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    const inherited = entry.parentId === null ? tree.defaultDefinitionGuid : effectiveDefinitionById.get(entry.parentId)!;
    pathById.set(entry.id, path);
    idByPath.set(path, entry.id);
    effectiveDefinitionById.set(entry.id, entry.definitionGuid === undefined ? inherited : entry.definitionGuid);
    orderedEntries.push(entry);
    const children = childrenByParentId.get(entry.id) ?? [];
    for (let index = children.length - 1; index >= 0; index--) stack.push({ entry: children[index]!, depth: depth + 1 });
  }
  if (issues.length) return { index: null, issues };
  return { index: { byId, childrenByParentId, pathById, idByPath, effectiveDefinitionById, orderedEntries }, issues };
}
