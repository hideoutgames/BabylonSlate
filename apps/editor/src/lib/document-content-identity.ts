import { stableStringify } from "@babylonslate/assets";

/**
 * Identity of an open document's content, recorded when its tab closes with
 * undo history and compared when it reopens (`EditSession.closeDocument` /
 * `reopenDocument`). Equal for structurally equal content whatever its key
 * order, so a saved document reloaded through its normalizer still matches.
 * Two independently mixed 32-bit hashes plus the serialized length keep an
 * accidental match between different contents negligible.
 */
export function documentContentIdentity(content: unknown): string {
  const text = stableStringify(content);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x5bd1e995);
    second ^= second >>> 15;
  }
  return `${text.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}
