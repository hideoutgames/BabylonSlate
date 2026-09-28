import type { CatalogCategory } from "./catalog-dialog";

/**
 * Sidebar categories for every item in first-seen order, led by "All". Counts
 * come from `matches` (the search results) so the list stays stable while typing.
 */
export function catalogCategories<T>(
  items: readonly T[],
  getCategory: (item: T) => string,
  matches: readonly T[] = items,
): CatalogCategory[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(getCategory(item), 0);
  for (const item of matches) {
    const category = getCategory(item);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [
    { id: "all", label: "All", count: matches.length },
    ...[...counts].map(([id, count]) => ({ id, label: id, count })),
  ];
}

export interface CatalogSection<T> {
  category: string;
  items: T[];
}

/** Buckets visible items by category, keeping first-seen category order. */
export function catalogSections<T>(
  items: readonly T[],
  getCategory: (item: T) => string,
): CatalogSection<T>[] {
  const byCategory = new Map<string, T[]>();
  for (const item of items) {
    const category = getCategory(item);
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(item);
    else byCategory.set(category, [item]);
  }
  return [...byCategory].map(([category, bucket]) => ({
    category,
    items: bucket,
  }));
}
