/**
 * Move `from`'s value to `to` when a document id changes. A value already
 * under `to` described another document and is dropped.
 */
export function moveKeyedEntry<V>(map: Map<string, V>, from: string, to: string): void {
  if (from === to) return;
  const value = map.get(from);
  map.delete(from);
  if (value === undefined) map.delete(to);
  else map.set(to, value);
}
