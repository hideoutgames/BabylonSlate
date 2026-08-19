/** Pure Array/Map helpers shared by catalog codegen and unit tests. */

export function makeArray<T>(items: readonly T[]): T[] {
  return items.slice();
}

export function arrayGetAt<T>(
  array: readonly T[] | null | undefined,
  index: number,
  fallback: T,
): { value: T; valid: boolean } {
  const list = array ?? [];
  const valid =
    Number.isInteger(index) && index >= 0 && index < list.length;
  return { value: valid ? list[index]! : fallback, valid };
}

export function arrayLength(array: readonly unknown[] | null | undefined): number {
  return (array ?? []).length;
}

export function arrayIsEmpty(array: readonly unknown[] | null | undefined): boolean {
  return arrayLength(array) === 0;
}

export function arrayLastIndex(
  array: readonly unknown[] | null | undefined,
): number {
  const length = arrayLength(array);
  return length === 0 ? -1 : length - 1;
}

export function arrayIsValidIndex(
  array: readonly unknown[] | null | undefined,
  index: number,
): boolean {
  return Number.isInteger(index) && index >= 0 && index < arrayLength(array);
}

export function arrayContains<T>(
  array: readonly T[] | null | undefined,
  item: T,
): boolean {
  return (array ?? []).includes(item);
}

export function arrayFindIndex<T>(
  array: readonly T[] | null | undefined,
  item: T,
): number {
  return (array ?? []).indexOf(item);
}

export function arrayAppendItem<T>(
  array: readonly T[] | null | undefined,
  item: T,
): T[] {
  return (array ?? []).concat([item]);
}

export function arrayAppendArray<T>(
  array: readonly T[] | null | undefined,
  other: readonly T[] | null | undefined,
): T[] {
  return (array ?? []).concat(other ?? []);
}

export function arraySetAt<T>(
  array: readonly T[] | null | undefined,
  index: number,
  item: T,
): { array: T[]; success: boolean } {
  const next = (array ?? []).slice();
  if (!arrayIsValidIndex(next, index)) {
    return { array: next, success: false };
  }
  next[index] = item;
  return { array: next, success: true };
}

export function arrayInsertAt<T>(
  array: readonly T[] | null | undefined,
  index: number,
  item: T,
): T[] {
  const next = (array ?? []).slice();
  const at = Number.isFinite(index) ? Math.max(0, index | 0) : 0;
  next.splice(at, 0, item);
  return next;
}

export function arrayRemoveAt<T>(
  array: readonly T[] | null | undefined,
  index: number,
): { array: T[]; success: boolean } {
  const next = (array ?? []).slice();
  if (!arrayIsValidIndex(next, index)) {
    return { array: next, success: false };
  }
  next.splice(index, 1);
  return { array: next, success: true };
}

export function arrayRemoveItem<T>(
  array: readonly T[] | null | undefined,
  item: T,
): { array: T[]; success: boolean } {
  const next = (array ?? []).slice();
  const index = next.indexOf(item);
  if (index < 0) return { array: next, success: false };
  next.splice(index, 1);
  return { array: next, success: true };
}

export function arrayClear(): [] {
  return [];
}

export function arrayReverse<T>(array: readonly T[] | null | undefined): T[] {
  return (array ?? []).slice().reverse();
}

export function arraySlice<T>(
  array: readonly T[] | null | undefined,
  start: number,
  end: number,
): T[] {
  return (array ?? []).slice(start, end);
}

export function arrayFirst<T>(
  array: readonly T[] | null | undefined,
  fallback: T,
): T {
  const list = array ?? [];
  return list.length > 0 ? list[0]! : fallback;
}

export function arrayLast<T>(
  array: readonly T[] | null | undefined,
  fallback: T,
): T {
  const list = array ?? [];
  return list.length > 0 ? list[list.length - 1]! : fallback;
}

export function makeMap<K, V>(pairs: ReadonlyArray<readonly [K, V]>): Map<K, V> {
  return new Map(pairs);
}

export function mapGet<K, V>(
  map: Map<K, V> | null | undefined,
  key: K,
  fallback: V,
): { value: V; found: boolean } {
  const target = map ?? new Map<K, V>();
  const found = target.has(key);
  return { value: found ? target.get(key)! : fallback, found };
}

export function mapSet<K, V>(
  map: Map<K, V> | null | undefined,
  key: K,
  value: V,
): Map<K, V> {
  const next = new Map(map ?? []);
  next.set(key, value);
  return next;
}

export function mapHas<K, V>(
  map: Map<K, V> | null | undefined,
  key: K,
): boolean {
  return (map ?? new Map()).has(key);
}

export function mapRemove<K, V>(
  map: Map<K, V> | null | undefined,
  key: K,
): { map: Map<K, V>; removed: boolean } {
  const next = new Map(map ?? []);
  const removed = next.delete(key);
  return { map: next, removed };
}

export function mapSize(map: Map<unknown, unknown> | null | undefined): number {
  return (map ?? new Map()).size;
}

export function mapIsEmpty(map: Map<unknown, unknown> | null | undefined): boolean {
  return mapSize(map) === 0;
}

export function mapClear(): Map<never, never> {
  return new Map();
}

export function mapKeys<K>(map: Map<K, unknown> | null | undefined): K[] {
  return [...(map ?? new Map()).keys()];
}

export function mapValues<V>(map: Map<unknown, V> | null | undefined): V[] {
  return [...(map ?? new Map()).values()];
}

export function mapBreakEntries<K, V>(
  map: Map<K, V> | null | undefined,
): { keys: K[]; values: V[] } {
  const keys: K[] = [];
  const values: V[] = [];
  for (const [key, value] of map ?? new Map<K, V>()) {
    keys.push(key);
    values.push(value);
  }
  return { keys, values };
}
