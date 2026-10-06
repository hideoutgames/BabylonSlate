import { normalizeTag, normalizeTagRegistry, type TagRegistry } from "@babylonslate/core";

export function tagCasesOf(properties: Record<string, unknown>): number[] {
  const cases = Array.isArray(properties.cases) ? properties.cases : [];
  return [...new Set(cases.map(normalizeTag).filter((tag) => tag !== 0))];
}

export function tagCasePinId(tag: number): string {
  return `case:${tag}`;
}

export function tagOptionPinId(tag: number): string {
  return `option:${tag}`;
}

/** Standalone numeric operations shared by Play and exported graph modules. */
export function tagRuntimeSource(registry: TagRegistry | undefined): string {
  const tags = normalizeTagRegistry(registry).tags;
  const parents = tags.map((tag) => [tag.id, tag.parentId]);
  const names = tags.map((tag) => [tag.id, tag.path]);
  // Graph documents concatenate event/function modules. A var declaration is
  // intentionally repeatable, with the same project registry for every graph.
  return `var __tags = (() => {
  const parents = new Map(${JSON.stringify(parents)});
  const names = new Map(${JSON.stringify(names)});
  const normalize = value => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 4294967295 ? value : 0;
  const entries = value => Array.isArray(value?.Tags) ? value.Tags : [];
  const container = value => ({ Tags: [...new Set(entries(value).map(normalize).filter(Boolean))] });
  const valid = value => parents.has(value);
  const match = (value, query, exact = false) => {
    if (!valid(value) || !valid(query)) return false;
    if (exact) return value === query;
    for (let remaining = parents.size; value && remaining > 0; remaining--) {
      if (value === query) return true;
      value = parents.get(value);
    }
    return false;
  };
  const has = (value, query, exact) => entries(value).some(tag => match(tag, query, exact));
  const select = (value, cases, exact = true) => {
    if (!valid(value)) return 0;
    if (exact) return cases.includes(value) ? value : 0;
    for (let remaining = parents.size; value && remaining > 0; remaining--) {
      if (cases.includes(value)) return value;
      value = parents.get(value);
    }
    return 0;
  };
  return {
    normalize, container, valid, match, has, select,
    name: value => names.get(value) ?? "",
    any: (value, queries, exact) => entries(queries).some(query => has(value, query, exact)),
    all: (value, queries, exact) => entries(queries).every(query => has(value, query, exact)),
    add: (value, tag) => container({ Tags: [...container(value).Tags, tag] }),
    remove: (value, tag) => ({ Tags: container(value).Tags.filter(value => value !== tag) }),
    equals: (a, b) => { const left = container(a).Tags; const right = new Set(container(b).Tags); return left.length === right.size && left.every(tag => right.has(tag)); },
    union: (a, b) => container({ Tags: [...container(a).Tags, ...container(b).Tags] }),
    intersection: (a, b) => { const right = new Set(container(b).Tags); return { Tags: container(a).Tags.filter(tag => right.has(tag)) }; },
    difference: (a, b) => { const right = new Set(container(b).Tags); return { Tags: container(a).Tags.filter(tag => !right.has(tag)) }; }
  };
})();`;
}
