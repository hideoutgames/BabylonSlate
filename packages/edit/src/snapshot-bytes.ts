/** Conservative serialized size of retained document snapshots. */
export function snapshotBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Validate and count canonical JSON without allocating a full encoded copy. */
export function canonicalSnapshotBytes(value: unknown, maxBytes = Number.MAX_SAFE_INTEGER): number {
  let total = 0;
  const ancestors = new Set<object>();
  const add = (bytes: number) => {
    total += bytes;
    if (total > maxBytes) throw new Error("Apply Simulation Changes exceeds the configured Undo history budget.");
  };
  const string = (text: string) => {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) add(2);
      else if (code < 32) add(6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { add(4); i++; }
      else add(code >= 0xd800 && code <= 0xdfff ? 6 : 3);
    }
  };
  const visit = (entry: unknown, depth: number) => {
    if (entry === null) { add(4); return; }
    if (typeof entry === "string") { string(entry); return; }
    if (typeof entry === "boolean") { add(entry ? 4 : 5); return; }
    if (typeof entry === "number" && Number.isFinite(entry) && !Object.is(entry, -0)) { add(String(entry).length); return; }
    if (!entry || typeof entry !== "object" || depth > 128 || ancestors.has(entry)) throw new Error("Scene transaction requires canonical JSON values.");
    const array = Array.isArray(entry);
    if ((!array && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) || Object.getOwnPropertySymbols(entry).length) throw new Error("Scene transaction cannot retain native objects or symbols.");
    ancestors.add(entry);
    if (array) add(2 + Math.max(0, entry.length - 1));
    const keys = array ? Array.from({ length: entry.length }, (_, index) => String(index)) : Object.keys(entry);
    if (array && Object.keys(entry).length !== keys.length) throw new Error("Scene transaction cannot retain extra or sparse array properties.");
    if (!array) add(2 + Math.max(0, keys.length - 1));
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Scene transaction requires plain data properties.");
      if (!array) { string(key); add(1); }
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(entry);
  };
  visit(value, 0);
  return total;
}
