/** Category folder segments: split on `|`, trimmed, empty segments dropped. */
export function classMemberCategoryPath(category: unknown): string[] {
  if (typeof category !== "string") return [];
  return category
    .split("|")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Canonical stored category (`A|B`), or undefined when it has no segments. */
export function normalizeClassMemberCategory(
  category: unknown,
): string | undefined {
  const path = classMemberCategoryPath(category);
  return path.length > 0 ? path.join("|") : undefined;
}
