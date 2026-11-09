/**
 * Lists an object renderer draws, which Babylon observes: a `push`, `splice` or the like that empties such a list, or
 * that adds to an empty one, marks every Scene mesh's lights dirty, because its shadow defines read whether a shadow
 * map's list is empty. Emptying a populated list and pushing its next contents therefore costs a pass over the
 * Scene's meshes, and a repeated light define check on each of their draws, once per renderer drawing the list.
 *
 * These helpers write a list by index and length, which Babylon does not observe. Only the entry that fills an empty
 * list goes through `push`, so Babylon still hears that the list filled.
 */

/**
 * Write entry `index` of a list being rewritten from its start: call with 0, 1, 2 and so on, then set the list's
 * `length` to the count written.
 */
export function writeRenderListEntry<T>(list: T[], index: number, entry: T): void {
  if (list.length === 0) list.push(entry);
  else list[index] = entry;
}

/** Replace a list's contents with `entries` (those `keep` accepts), in order. `entries` must not be `list`. */
export function rewriteRenderList<T>(list: T[], entries: readonly T[], keep?: (entry: T) => boolean): T[] {
  let count = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!keep || keep(entry)) writeRenderListEntry(list, count++, entry);
  }
  list.length = count;
  return list;
}
