/** What the hosted-wasm plugins need from Rollup's transform context. */
type EmitContext = { emitFile: (file: { type: "asset"; fileName: string; source: Uint8Array }) => string };

/**
 * The wasm a glue embeds as its one base64 literal: `pattern` is a global regex
 * whose first group is the base64. Null unless exactly one literal matches and
 * it decodes to a wasm module, so a changed glue is reported, not shipped.
 */
export function embeddedWasm(code: string, pattern: RegExp): { bytes: Buffer; index: number; length: number } | null {
  const matches = [...code.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const [match] = matches;
  const bytes = Buffer.from(match[1], "base64");
  return isWasmBinary(bytes) ? { bytes, index: match.index, length: match[0].length } : null;
}

/**
 * Emits `bytes` once per build at the fixed `fileName` (the page and worker
 * builds emit the same file, which the bundler writes once) and returns the
 * expression the bundler replaces with its URL, resolved from the importing chunk.
 */
export function hostedWasmUrl(context: EmitContext, fileName: string, bytes: Uint8Array): string {
  return `import.meta.ROLLUP_FILE_URL_${context.emitFile({ type: "asset", fileName, source: bytes })}`;
}

/** `\0asm` followed by version 1. */
export function isWasmBinary(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d && bytes[4] === 1;
}
