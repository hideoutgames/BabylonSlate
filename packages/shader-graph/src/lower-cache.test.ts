import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "./document";
import { lowerMaterialDocument } from "./lower";
import { lowerMaterialDocumentCached, MATERIAL_PLAN_CACHE_ENTRIES, resetMaterialPlanCacheForTests } from "./lower-cache";

// The real lowering, observed: the memo must call it once per distinct content.
vi.mock("./lower", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lower")>();
  return { ...actual, lowerMaterialDocument: vi.fn(actual.lowerMaterialDocument) };
});

const lowerings = (name: string) =>
  vi.mocked(lowerMaterialDocument).mock.calls.filter(([doc]) => doc.name === name).length;

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });

/** A Material named `name` whose Base Color goes through Material Function `tint`, with a colour parameter. */
function callingDocument(name: string, value = 1): MaterialDocument {
  const doc = createDefaultMaterialDocument(name);
  doc.nodes.push(
    { id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "tint" } },
    { id: "param", type: "param.color", position: { x: 0, y: 0 }, properties: { name: "Tint", value: [value, 0.5, 0.25, 1] } },
  );
  doc.edges = [
    { id: "e-param-call", sourceNodeId: "param", sourcePinId: "out", targetNodeId: "call", targetPinId: "in_value" },
    { id: "e-call-out", sourceNodeId: "call", sourcePinId: "out_value", targetNodeId: "output", targetPinId: "baseColor" },
  ];
  return doc;
}

function boostedTint(): MaterialFunctionDocument {
  const boosted = createDefaultMaterialFunctionDocument("Tint");
  boosted.nodes.push({ id: "boost", type: "math.multiply", position: { x: 0, y: 0 }, properties: {} });
  boosted.edges = [
    { id: "e-in-boost", sourceNodeId: "inputs", sourcePinId: "in_value", targetNodeId: "boost", targetPinId: "a" },
    { id: "e-boost-out", sourceNodeId: "boost", sourcePinId: "out", targetNodeId: "outputs", targetPinId: "out_value" },
  ];
  return boosted;
}

describe("lowerMaterialDocumentCached", () => {
  it("lowers equal content once across documents and functions records", () => {
    const first = lowerMaterialDocumentCached(callingDocument("equal"), { tint: createDefaultMaterialFunctionDocument("Tint") });
    const second = lowerMaterialDocumentCached(callingDocument("equal"), { tint: createDefaultMaterialFunctionDocument("Tint") });
    expect(lowerings("equal")).toBe(1);
    expect(second).toBe(first);
    expect(first.ok).toBe(true);
  });

  it("answers the same document and functions again without serializing or parsing anything", () => {
    const tint = boostedTint();
    const doc = callingDocument("steady");
    const first = lowerMaterialDocumentCached(doc, { tint });
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");
    spies.push(stringify, parse);
    // A host may build a new record each time; only the function documents it holds matter.
    expect(lowerMaterialDocumentCached(doc, { tint })).toBe(first);
    expect(lowerMaterialDocumentCached(doc, { tint, unused: boostedTint() })).toBe(first);
    expect(stringify).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(lowerings("steady")).toBe(1);
  });

  it("lowers again when the document, the shading variant or a function it calls is replaced", () => {
    let functions: Record<string, MaterialFunctionDocument> = { tint: createDefaultMaterialFunctionDocument("Tint") };
    const doc = callingDocument("miss");
    const lit = lowerMaterialDocumentCached(doc, functions);
    expect(lowerings("miss")).toBe(1);

    const edited = lowerMaterialDocumentCached({ ...doc, nodes: callingDocument("miss", 0.5).nodes }, functions);
    expect(lowerings("miss")).toBe(2);
    expect(edited.ok && lit.ok && edited.plan.hash !== lit.plan.hash).toBe(true);
    expect(edited.ok && edited.plan.operations.find((operation) => operation.nodeType === "param.color")?.properties.value)
      .toEqual([0.5, 0.5, 0.25, 1]);

    const unlit = lowerMaterialDocumentCached(doc, functions, true);
    expect(lowerings("miss")).toBe(3);
    expect(unlit.ok && unlit.plan.shadingModel).toBe("unlit");
    expect(lit.ok && lit.plan.shadingModel).toBe("pbr");

    // A function the document does not call is not part of its key.
    functions = { ...functions, unused: boostedTint() };
    expect(lowerMaterialDocumentCached(callingDocument("miss"), functions)).toBe(lit);
    expect(lowerings("miss")).toBe(3);

    functions = { ...functions, tint: boostedTint() };
    const boosted = lowerMaterialDocumentCached(doc, functions);
    expect(lowerings("miss")).toBe(4);
    expect(boosted.ok && boosted.plan.operations.map((operation) => operation.nodeType)).toContain("math.multiply");

    // A function going missing is a change too.
    const missing = lowerMaterialDocumentCached(doc, {});
    expect(missing.ok).toBe(false);
    expect(lowerings("miss")).toBe(5);
  });

  it("keeps the least recently used plans up to its bound", () => {
    resetMaterialPlanCacheForTests();
    const plan = (name: string) => lowerMaterialDocumentCached(createDefaultMaterialDocument(name));
    plan("lru-kept");
    plan("lru-evicted");
    for (let index = 2; index < MATERIAL_PLAN_CACHE_ENTRIES; index++) plan(`lru-filler-${index}`);
    // Fresh documents: only the content level can answer.
    plan("lru-kept");
    plan("lru-overflow");
    plan("lru-kept");
    plan("lru-evicted");
    expect(lowerings("lru-kept")).toBe(1);
    expect(lowerings("lru-evicted")).toBe(2);
  });

  it("keeps a failed lowering with its diagnostics", () => {
    const first = lowerMaterialDocumentCached(callingDocument("failure"), {});
    const second = lowerMaterialDocumentCached(callingDocument("failure"), {});
    expect(lowerings("failure")).toBe(1);
    expect(second).toBe(first);
    expect(first).toEqual({ ok: false, diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: "material.function.missing", nodeId: "call" }),
    ]) });
  });

  it("does not remember a call whose function the record only inherits", () => {
    const doc = callingDocument("inherited");
    const functions = Object.create({ tint: boostedTint() }) as Record<string, MaterialFunctionDocument>;
    const first = lowerMaterialDocumentCached(doc, functions);
    expect(first.ok && first.plan.operations.map((operation) => operation.nodeType)).toContain("math.multiply");
    lowerMaterialDocumentCached(doc, functions);
    expect(lowerings("inherited")).toBe(2);
  });
});
