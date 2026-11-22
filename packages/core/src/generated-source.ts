/**
 * Text from assets (node ids and types, asset guids and paths, class names) that generated JavaScript
 * carries outside a string literal: in a comment, or in a module's `//# sourceURL` label. Everything
 * else reaches generated code through `JSON.stringify` (literals) or `jsIdent` (identifiers).
 */

/**
 * Each UTF-16 unit a comment could end at: line terminators (U+2028 and U+2029 included), and with
 * them every other unit outside printable ASCII, lone surrogates too.
 */
const NOT_PRINTABLE_ASCII = /[^\x20-\x7e]/g;

const hex = (unit: string) => unit.charCodeAt(0).toString(16).padStart(4, "0");

/**
 * `text` for a generated `//` or `/* *\/` comment: it can end neither, as every unit outside
 * printable ASCII is written as `\uXXXX` and `*\/` is broken.
 */
export function generatedCommentText(text: string): string {
  return text.replace(NOT_PRINTABLE_ASCII, (unit) => `\\u${hex(unit)}`).replace(/\*\//g, "*\\/");
}

/**
 * A label for `//# sourceURL=haptic:///<label>.js`: printable ASCII stays as it is (so the usual guid
 * or path is unchanged, and stack mapping keys with it), every other unit becomes `%uXXXX`, so the
 * label cannot end the comment.
 */
export function sourceUrlLabel(label: string): string {
  return label.replace(NOT_PRINTABLE_ASCII, (unit) => `%u${hex(unit)}`);
}

/** The `//# sourceURL` line that names a generated module. */
export function sourceUrlComment(label: string): string {
  return `//# sourceURL=haptic:///${sourceUrlLabel(label)}.js`;
}
