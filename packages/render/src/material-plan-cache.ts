import {
  lowerMaterialDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
  type MaterialLowerResult,
} from "@haptic/shader-graph";

/**
 * Lowered Material plans shared by every `MaterialLibrary` in the realm, keyed by content: a Play session's,
 * a preview's or a thumbnail's library reuses what the editor viewport already lowered for an equal graph.
 *
 * Lowering (`lowerMaterialDocument` with only `functions` for context) reads nothing but the document, the
 * shading variant, and the Material Functions its `function.call` nodes reach by guid (transitively, present or
 * missing); the node catalog is static. The key holds exactly those: the document's JSON, the variant, and each
 * reached function's guid and JSON. A miss lowers private parsed copies of that same content, so the result is a
 * function of the key alone and shares nothing with any caller's documents. Callers must not change a result.
 */
export const MATERIAL_PLAN_CACHE_ENTRIES = 512;

type FunctionRecord = Record<string, MaterialFunctionDocument>;
/** One referenced guid in one functions record: its JSON and calls, absent, or a value lowering would not treat as a document. */
type FunctionEntry = { content: string; calls: readonly string[] } | "absent" | "opaque";

/** Least recently used first. */
const plans = new Map<string, MaterialLowerResult>();
/** Per functions record, whose documents hosts replace rather than edit (the libraries' own memo assumes the same). */
const functionEntries = new WeakMap<FunctionRecord, Map<string, FunctionEntry>>();
const SEPARATOR = "\u0000"; // never appears raw in JSON.stringify output

function callsOf(graph: { nodes?: readonly { type?: string; properties?: Record<string, unknown> }[] }): string[] {
  const calls: string[] = [];
  for (const node of graph.nodes ?? []) {
    const guid = node.type === "function.call" ? node.properties?.functionGuid : undefined;
    if (typeof guid === "string") calls.push(guid);
  }
  return calls;
}

function functionEntry(functions: FunctionRecord, guid: string): FunctionEntry {
  let entries = functionEntries.get(functions);
  if (!entries) functionEntries.set(functions, (entries = new Map()));
  let entry = entries.get(guid);
  if (entry) return entry;
  // Lowering looks a function up as `functions[guid]` and treats a falsy value as missing.
  const value: unknown = functions[guid];
  if (!value) entry = "absent";
  else if (typeof value === "object" && Object.hasOwn(functions, guid)) {
    entry = { content: JSON.stringify(value), calls: callsOf(value as MaterialFunctionDocument) };
  } else entry = "opaque";
  entries.set(guid, entry);
  return entry;
}

/** Every function the document reaches, by guid; null when one is not a plain own document. */
function reachedFunctions(doc: MaterialDocument, functions: FunctionRecord): Map<string, FunctionEntry> | null {
  const reached = new Map<string, FunctionEntry>();
  const pending = callsOf(doc);
  while (pending.length) {
    const guid = pending.pop()!;
    if (reached.has(guid)) continue;
    const entry = functionEntry(functions, guid);
    if (entry === "opaque") return null;
    reached.set(guid, entry);
    if (entry !== "absent") pending.push(...entry.calls);
  }
  return reached;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

/** Under Vitest every shared result is frozen, so a consumer that changes one fails its tests. */
const FREEZE_RESULTS = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITEST !== undefined;

/**
 * The lowering of `doc` (`content` is its `JSON.stringify`, which the caller already holds) for the shading variant,
 * shared across libraries. Failed lowerings are cached like successful ones: their diagnostics are part of the result.
 */
export function sharedMaterialPlan(
  doc: MaterialDocument,
  content: string,
  unlit: boolean,
  functions: FunctionRecord,
): MaterialLowerResult {
  const reached = reachedFunctions(doc, functions);
  if (!reached) return lowerMaterialDocument(documentForPlan(doc, unlit), { functions });
  const guids = [...reached.keys()].sort();
  let key = unlit ? "unlit" : "lit";
  for (const guid of guids) {
    const entry = reached.get(guid)!;
    key += SEPARATOR + JSON.stringify(guid) + SEPARATOR + (entry === "absent" ? "-" : entry.content);
  }
  key += SEPARATOR + SEPARATOR + content;
  const cached = plans.get(key);
  if (cached) {
    plans.delete(key);
    plans.set(key, cached);
    return cached;
  }
  // A null-prototype record answers every reached guid as the caller's did, and only those are read.
  const parsedFunctions = Object.create(null) as FunctionRecord;
  for (const guid of guids) {
    const entry = reached.get(guid)!;
    if (entry !== "absent") parsedFunctions[guid] = JSON.parse(entry.content) as MaterialFunctionDocument;
  }
  const result = lowerMaterialDocument(documentForPlan(JSON.parse(content) as MaterialDocument, unlit), { functions: parsedFunctions });
  if (FREEZE_RESULTS) deepFreeze(result);
  plans.set(key, result);
  if (plans.size > MATERIAL_PLAN_CACHE_ENTRIES) plans.delete(plans.keys().next().value!);
  return result;
}

/** The document a shading variant lowers: an unlit request overrides the shading model. */
export function documentForPlan(doc: MaterialDocument, unlit?: boolean): MaterialDocument {
  if (!unlit || doc.shadingModel === "unlit") return doc;
  return { ...doc, shadingModel: "unlit" };
}

/** Test isolation only. */
export function resetMaterialPlanCacheForTests(): void {
  plans.clear();
}
