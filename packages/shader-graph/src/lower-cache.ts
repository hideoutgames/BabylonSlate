import type { MaterialDocument, MaterialFunctionDocument } from "./document";
import { lowerMaterialDocument, type MaterialLowerResult } from "./lower";

/**
 * The realm's one memo of Material lowerings with only Material Functions for context (no capabilities, texture
 * registry or Global Parameter catalog; the node catalog is static), shared by every caller: each Scene's
 * `MaterialLibrary`, previews, thumbnails and the parameter catalog.
 *
 * Material and Material Function documents are immutable once they reach it: hosts replace a document to change it,
 * never edit it in place. A lowering reads nothing but the document, the shading variant and the functions its
 * `function.call` nodes reach by guid, transitively (present or missing), so two levels answer:
 *
 * - By identity: per document object and variant, the last lowering and the value each reached guid had in its
 *   functions record. A lookup that finds the same values (whatever record holds them) returns it without
 *   serializing anything.
 * - By content: a bounded LRU keyed by the variant, the document's JSON and each reached function's guid and JSON
 *   (computed once per function document), so equal graphs held by different objects (an editor viewport's and a Play
 *   session's) share one plan. A miss lowers the caller's live documents.
 *
 * A reached guid whose value is not an own object of the record bypasses both levels. Failed lowerings are kept like
 * successful ones: their diagnostics are part of the result. Results are shared, so callers must not change them;
 * under Vitest each is deep-frozen so a mutation fails its test.
 */
export const MATERIAL_PLAN_CACHE_ENTRIES = 512;

type FunctionRecord = Record<string, MaterialFunctionDocument>;
/** A reached guid and the value its record held (a document, or a falsy value lowering treats as missing), flattened. */
type Reads = unknown[];
interface Slot { reads: Reads; result: MaterialLowerResult }

const NO_FUNCTIONS: FunctionRecord = Object.freeze({}) as FunctionRecord;
const byDocument = new WeakMap<MaterialDocument, { lit?: Slot; unlit?: Slot }>();
/** Least recently used first. */
const byContent = new Map<string, MaterialLowerResult>();
const functionContent = new WeakMap<object, { json: string; calls: readonly string[] }>();
const SEPARATOR = "\u0000"; // never appears raw in JSON.stringify output

function callsOf(graph: { nodes?: readonly { type?: string; properties?: Record<string, unknown> }[] }): string[] {
  const calls: string[] = [];
  for (const node of graph.nodes ?? []) {
    const guid = node.type === "function.call" ? node.properties?.functionGuid : undefined;
    if (typeof guid === "string") calls.push(guid);
  }
  return calls;
}

function contentOf(fn: object): { json: string; calls: readonly string[] } {
  let content = functionContent.get(fn);
  if (!content) functionContent.set(fn, (content = { json: JSON.stringify(fn), calls: callsOf(fn as MaterialFunctionDocument) }));
  return content;
}

function readsStill(reads: Reads, functions: FunctionRecord): boolean {
  for (let index = 0; index < reads.length; index += 2) {
    if (functions[reads[index] as string] !== reads[index + 1]) return false;
  }
  return true;
}

/** Every guid the document reaches with the value its record holds; null when one is not a plain own document. */
function reachedFunctions(doc: MaterialDocument, functions: FunctionRecord): Map<string, unknown> | null {
  const reached = new Map<string, unknown>();
  const pending = callsOf(doc);
  while (pending.length) {
    const guid = pending.pop()!;
    if (reached.has(guid)) continue;
    // Lowering looks a function up as `functions[guid]` and treats a falsy value as missing.
    const value: unknown = functions[guid];
    if (value && (typeof value !== "object" || !Object.hasOwn(functions, guid))) return null;
    reached.set(guid, value);
    if (value) pending.push(...contentOf(value).calls);
  }
  return reached;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

const FREEZE_RESULTS = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITEST !== undefined;

/** The document a shading variant lowers: an unlit request overrides the shading model. */
function documentForVariant(doc: MaterialDocument, unlit: boolean): MaterialDocument {
  if (!unlit || doc.shadingModel === "unlit") return doc;
  return { ...doc, shadingModel: "unlit" };
}

/** `lowerMaterialDocument(doc, { functions })` for the shading variant, shared by every caller in the realm. */
export function lowerMaterialDocumentCached(
  doc: MaterialDocument,
  functions: FunctionRecord = NO_FUNCTIONS,
  unlit = false,
): MaterialLowerResult {
  let slots = byDocument.get(doc);
  const known = unlit ? slots?.unlit : slots?.lit;
  if (known && readsStill(known.reads, functions)) return known.result;
  const reached = reachedFunctions(doc, functions);
  if (!reached) return lowerMaterialDocument(documentForVariant(doc, unlit), { functions });
  const guids = [...reached.keys()].sort();
  const reads: Reads = [];
  let key = unlit ? "unlit" : "lit";
  for (const guid of guids) {
    const value = reached.get(guid);
    reads.push(guid, value);
    key += SEPARATOR + JSON.stringify(guid) + SEPARATOR + (value ? contentOf(value).json : "-");
  }
  key += SEPARATOR + SEPARATOR + JSON.stringify(doc);
  let result = byContent.get(key);
  if (result) byContent.delete(key);
  else {
    result = lowerMaterialDocument(documentForVariant(doc, unlit), { functions });
    if (FREEZE_RESULTS) deepFreeze(result);
    if (byContent.size >= MATERIAL_PLAN_CACHE_ENTRIES) byContent.delete(byContent.keys().next().value!);
  }
  byContent.set(key, result);
  if (!slots) byDocument.set(doc, (slots = {}));
  slots[unlit ? "unlit" : "lit"] = { reads, result };
  return result;
}

/** Test isolation only: forgets the content level (identity slots die with their documents). */
export function resetMaterialPlanCacheForTests(): void {
  byContent.clear();
}
