/** A project-local unsigned 32-bit identifier. Zero represents no selection. */
export type Tag = number;

/** Engine structure value. Stored entries are explicit selections only. */
export interface TagContainer {
  Tags: Tag[];
}

export interface TagDefinition {
  readonly id: Tag;
  readonly path: string;
  readonly parentId: Tag;
}

/** Replace the registry when editing it so cached runtime lookups stay valid. */
export interface TagRegistry {
  readonly tags: readonly TagDefinition[];
  /** Never decreases; 2^32 means the identifier space is exhausted. */
  readonly nextId: number;
}

const MAX_TAG = 0xffff_ffff;
const EXHAUSTED_TAG_ID = MAX_TAG + 1;
const TAG_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function normalizeTag(value: unknown): Tag {
  return typeof value === "number" && Number.isInteger(value) &&
    value > 0 && value <= MAX_TAG ? value : 0;
}

export function isValidTagPath(value: unknown): value is string {
  return typeof value === "string" && TAG_PATH.test(value);
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf(".");
  return separator < 0 ? "" : path.slice(0, separator);
}

function pathPrefixes(path: string): string[] {
  const prefixes: string[] = [];
  let end = path.indexOf(".");
  while (end >= 0) {
    prefixes.push(path.slice(0, end));
    end = path.indexOf(".", end + 1);
  }
  prefixes.push(path);
  return prefixes;
}

/**
 * Keeps unique paths without renumbering. Conflicting IDs stay unresolved;
 * reconciling registries must also reconcile their numeric references.
 * Discarded IDs advance the high-water mark so old values cannot alias newly
 * created tags. Parent IDs are derived from paths, never trusted input.
 */
export function normalizeTagRegistry(value: unknown): TagRegistry {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const rawNext = source.nextId;
  let nextId = typeof rawNext === "number" && Number.isInteger(rawNext) &&
    rawNext > 0 && rawNext <= EXHAUSTED_TAG_ID ? rawNext : 1;
  const candidates: Array<{ id: Tag; path: string }> = [];
  const idPaths = new Map<Tag, unknown>();
  const conflictingIds = new Set<Tag>();
  for (const raw of Array.isArray(source.tags) ? source.tags : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const id = normalizeTag(entry.id);
    if (!id) continue;
    nextId = Math.max(nextId, id + 1);
    const previousPath = idPaths.get(id);
    if (idPaths.has(id) && previousPath !== entry.path) conflictingIds.add(id);
    idPaths.set(id, entry.path);
    if (!isValidTagPath(entry.path)) continue;
    candidates.push({ id, path: entry.path });
  }
  const entries: Array<{ id: Tag; path: string }> = [];
  const ids = new Set<Tag>();
  const paths = new Map<string, Tag>();
  for (const entry of candidates) {
    const { id } = entry;
    if (conflictingIds.has(id) || ids.has(id) || paths.has(entry.path)) continue;
    ids.add(id);
    paths.set(entry.path, id);
    entries.push({ id, path: entry.path });
  }

  // Visit shallower paths first; an invalid exhausted branch cannot leave a
  // descendant pointing at a definition discarded during normalization.
  const ordered = [...entries].sort((a, b) => a.path.length - b.path.length);
  const added: Array<{ id: Tag; path: string }> = [];
  for (const entry of ordered) {
    const missing = pathPrefixes(entry.path).filter((path) => !paths.has(path));
    if (nextId + missing.length > EXHAUSTED_TAG_ID) {
      paths.delete(entry.path);
      continue;
    }
    for (const path of missing) {
      const id = nextId++;
      paths.set(path, id);
      added.push({ id, path });
    }
  }
  return {
    tags: [...entries, ...added]
      .filter((entry) => paths.has(entry.path))
      .map((entry) => ({
        ...entry,
        parentId: paths.get(parentPath(entry.path)) ?? 0,
      })),
    nextId,
  };
}

interface TagIndex {
  byId: Map<Tag, TagDefinition>;
  byPath: Map<string, Tag>;
}

const indexes = new WeakMap<TagRegistry, TagIndex>();

function tagIndex(registry: TagRegistry): TagIndex {
  let index = indexes.get(registry);
  if (!index) {
    index = {
      byId: new Map(registry.tags.map((entry) => [entry.id, entry])),
      byPath: new Map(registry.tags.map((entry) => [entry.path, entry.id])),
    };
    indexes.set(registry, index);
  }
  return index;
}

export function getTagName(registry: TagRegistry, tag: Tag): string {
  return tagIndex(registry).byId.get(tag)?.path ?? "";
}

export function findTag(registry: TagRegistry, path: string): Tag {
  return tagIndex(registry).byPath.get(path) ?? 0;
}

/** Adds every missing category, then the leaf; existing IDs stay untouched. */
export function createTag(
  registry: TagRegistry,
  path: string,
): { registry: TagRegistry; tag: Tag } {
  const canonical = path.trim();
  if (!isValidTagPath(canonical)) {
    throw new Error("Use letters, numbers, and underscores; separate categories with dots. Each segment must start with a letter or underscore.");
  }
  const existing = findTag(registry, canonical);
  if (existing) return { registry, tag: existing };
  const normalized = normalizeTagRegistry(registry);
  const byPath = new Map(normalized.tags.map((entry) => [entry.path, entry.id]));
  const missing = pathPrefixes(canonical).filter((prefix) => !byPath.has(prefix));
  if (normalized.nextId + missing.length > EXHAUSTED_TAG_ID) {
    throw new RangeError("The project has no remaining Tag identifiers.");
  }
  const tags = [...normalized.tags];
  let nextId = normalized.nextId;
  for (const prefix of missing) {
    const id = nextId++;
    const parentId = byPath.get(parentPath(prefix)) ?? 0;
    tags.push({ id, path: prefix, parentId });
    byPath.set(prefix, id);
  }
  return { registry: { tags, nextId }, tag: byPath.get(canonical)! };
}

/** Normalizes serialized structure values without dropping unknown valid IDs. */
export function normalizeTagContainer(value: unknown): TagContainer {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { Tags?: unknown }).Tags : undefined;
  const tags = new Set<Tag>();
  for (const raw of Array.isArray(source) ? source : []) {
    const tag = normalizeTag(raw);
    if (tag) tags.add(tag);
  }
  return { Tags: [...tags] };
}

/** A child matches its ancestors. None and unknown IDs never match. */
export function matchesTag(
  registry: TagRegistry,
  value: Tag,
  query: Tag,
  exact = false,
): boolean {
  const { byId } = tagIndex(registry);
  if (!query || !byId.has(query)) return false;
  let current = byId.get(value);
  if (exact) return current?.id === query;
  // The bound also makes hand-authored cyclic parent tables fail safely.
  for (let remaining = byId.size; current && remaining > 0; remaining--) {
    if (current.id === query) return true;
    current = byId.get(current.parentId);
  }
  return false;
}

export function tagContainerHas(
  registry: TagRegistry,
  container: TagContainer,
  query: Tag,
  exact = false,
): boolean {
  return container.Tags.some((tag) => matchesTag(registry, tag, query, exact));
}

export function tagContainerAny(
  registry: TagRegistry,
  container: TagContainer,
  queries: TagContainer,
  exact = false,
): boolean {
  return queries.Tags.some((query) => tagContainerHas(registry, container, query, exact));
}

export function tagContainerAll(
  registry: TagRegistry,
  container: TagContainer,
  queries: TagContainer,
  exact = false,
): boolean {
  return queries.Tags.every((query) => tagContainerHas(registry, container, query, exact));
}

/** Returns a detached structure so changing it cannot mutate a class default. */
export function addTag(container: TagContainer, value: Tag): TagContainer {
  const normalized = normalizeTagContainer(container);
  const tag = normalizeTag(value);
  if (tag && !normalized.Tags.includes(tag)) normalized.Tags.push(tag);
  return normalized;
}

/** Removes the explicit selection only; ancestor matching is unchanged. */
export function removeTag(container: TagContainer, tag: Tag): TagContainer {
  return { Tags: normalizeTagContainer(container).Tags.filter((value) => value !== tag) };
}
