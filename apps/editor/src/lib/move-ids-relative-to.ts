/**
 * Moves the items named by `ids`, in their current order, to just before or
 * after `anchorId`; to the end when the anchor is one of them or missing.
 */
export function moveIdsRelativeTo<T extends { id: string }>(
  items: readonly T[],
  ids: readonly string[],
  anchorId: string,
  placement: "before" | "after",
): T[] {
  const movingSet = new Set(ids);
  const moving = items.filter((item) => movingSet.has(item.id));
  const rest = items.filter((item) => !movingSet.has(item.id));
  const index = rest.findIndex((item) => item.id === anchorId);
  if (index < 0) return [...rest, ...moving];
  const insertAt = placement === "before" ? index : index + 1;
  return [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
}
