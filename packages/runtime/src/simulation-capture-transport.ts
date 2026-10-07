/** Bounded UTF-8 JSON transport after canonical capture has admitted its byte/node budget.
 * Never builds a second complete scene JSON string. Strings are escaped in small pieces. */
export function* simulationCaptureChunks(value: unknown): Generator<Uint8Array> {
  const encoder = new TextEncoder(); let text = "";
  function* write(item: unknown): Generator<string> {
    if (typeof item === "string") {
      yield '"';
      for (let offset = 0; offset < item.length; offset += 2048) yield JSON.stringify(item.slice(offset, offset + 2048)).slice(1, -1);
      yield '"'; return;
    }
    if (item === null || typeof item === "boolean" || typeof item === "number") { yield JSON.stringify(item); return; }
    if (Array.isArray(item)) {
      yield "[";
      for (let index = 0; index < item.length; index++) { if (index) yield ","; yield* write(item[index] ?? null); }
      yield "]"; return;
    }
    if (item && typeof item === "object") {
      yield "{"; let count = 0;
      for (const key of Object.keys(item)) {
        const entry = (item as Record<string, unknown>)[key]; if (entry === undefined) continue;
        if (count++) yield ","; yield* write(key); yield ":"; yield* write(entry);
      }
      yield "}"; return;
    }
    throw new Error("Canonical scene contains an unsupported JSON value.");
  }
  for (const part of write(value)) {
    text += part;
    if (text.length >= 8192) { yield encoder.encode(text); text = ""; }
  }
  if (text) yield encoder.encode(text);
}
