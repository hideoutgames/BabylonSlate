import { expect, it, vi } from "vitest";
import {
  appendFoliageInstance, applyFoliageModelEdit, chooseFoliageModel, decodeFoliageChunk, encodeFoliageChunk, foliageInstancesFingerprint,
  normalizeFoliageGroups, normalizeSerializedFoliageProperties, parseFoliageProperties, serializeFoliageProperties,
  type FoliageModel, type FoliageProperties,
} from "./foliage";
import { createActor, identitySerializedTransform, normalizeScene } from "./scene";

it("batches mixed Models by Model and Material while retaining one component payload", () => {
  const group = normalizeFoliageGroups([{ id: "forest", name: "Forest", models: [{ modelGuid: "tree" }, { modelGuid: "grass", materialGuid: "leaves" }] }])[0]!;
  const empty: FoliageProperties = { groupId: group.id, batches: [] };
  const a = appendFoliageInstance(empty, group.models[0]!, identitySerializedTransform());
  const b = appendFoliageInstance(a, group.models[1]!, { ...identitySerializedTransform(), position: [3, 0, 0] });
  const c = appendFoliageInstance(b, group.models[0]!, { ...identitySerializedTransform(), position: [7, 0, 0] });
  expect(c.batches.map((batch) => [batch.modelGuid, batch.transforms.length / 10])).toEqual([["tree", 2], ["grass", 1]]);
  expect(Array.from(c.batches[0]!.transforms.subarray(10, 13))).toEqual([7, 0, 0]);
  expect(a.batches[0]!.transforms).toHaveLength(10);
  expect(empty.batches).toHaveLength(0);
  // The stored JSON form survives a JSON round trip and decodes to the same instances.
  expect(parseFoliageProperties(JSON.parse(JSON.stringify(serializeFoliageProperties(c))))).toEqual(c);
});

it("persists groups and selects only positive-weight Models", () => {
  const scene = normalizeScene({ settings: { foliageGroups: [{ id: "g", models: [{ modelGuid: "off", weight: 0 }, { modelGuid: "a", weight: 1 }, { modelGuid: "b", weight: 3 }] }] } });
  const group = scene.settings.foliageGroups![0]!;
  expect(chooseFoliageModel(group, 0)?.modelGuid).toBe("a");
  expect(chooseFoliageModel(group, 0.25)?.modelGuid).toBe("b");
  expect(chooseFoliageModel({ ...group, models: [] }, 0)).toBeNull();
  expect(normalizeFoliageGroups([{ id: "x", models: [{ modelGuid: "a", minScale: 2, maxScale: 1 }] }])[0]!.models[0]!.maxScale).toBe(2);
});

it("defaults, clamps, and propagates foliage cull, fade, and shadow distances", () => {
  const group = normalizeFoliageGroups([{
    id: "meadow",
    models: [
      { modelGuid: "grass", cullDistance: 60, fadeRange: 10, shadowDistance: 20 },
      { modelGuid: "shrub", cullDistance: -5, fadeRange: 5000, shadowDistance: Number.NaN },
    ],
  }])[0]!;
  expect(group.models[0]).toMatchObject({ cullDistance: 60, fadeRange: 10, shadowDistance: 20 });
  expect(group.models[1]).toMatchObject({ cullDistance: 0, fadeRange: 1000, shadowDistance: 45 });

  const properties = appendFoliageInstance({ groupId: "meadow", batches: [] }, group.models[0]!, identitySerializedTransform());
  expect(properties.batches[0]).toMatchObject({ cullDistance: 60, fadeRange: 10, shadowDistance: 20 });
  expect(parseFoliageProperties(serializeFoliageProperties(properties)).batches[0]).toMatchObject({ cullDistance: 60, fadeRange: 10, shadowDistance: 20 });
});

it("carries a group Model's Material Override and distances to its painted batches, so the next edit still finds them", () => {
  const oak: FoliageModel = { modelGuid: "oak", materialGuid: null, weight: 1, minScale: 1, maxScale: 1, cullDistance: 120, fadeRange: 15, shadowDistance: 45 };
  const stroke = (id: string, groupId: string) => createActor(id, id, { components: [{ id: "foliage", classId: "FoliageComponent", properties: { groupId, batches: [
    { modelGuid: "oak", materialGuid: null, cullDistance: 120, fadeRange: 15, shadowDistance: 45 },
    { modelGuid: "oak", materialGuid: "bark", cullDistance: 120, fadeRange: 15, shadowDistance: 45 },
    { modelGuid: "pine", materialGuid: null, cullDistance: 120, fadeRange: 15, shadowDistance: 45 },
  ], data: "instances" } }] });
  const actors = [stroke("trees", "forest"), stroke("other", "meadow")];
  const overridden = { ...oak, materialGuid: "moss" };
  const afterOverride = applyFoliageModelEdit(actors, "forest", oak, overridden);
  const batches = (list: typeof actors, index: number) =>
    (list[index]!.components[0]!.properties.batches as Array<{ modelGuid: string; materialGuid: string | null; cullDistance: number }>);
  expect(batches(afterOverride, 0).map((batch) => [batch.modelGuid, batch.materialGuid])).toEqual([["oak", "moss"], ["oak", "bark"], ["pine", null]]);
  expect(afterOverride[1]).toBe(actors[1]);
  // A distance edit after the override reaches the same batch.
  const afterDistance = applyFoliageModelEdit(afterOverride, "forest", overridden, { ...overridden, cullDistance: 60 });
  expect(batches(afterDistance, 0).map((batch) => batch.cullDistance)).toEqual([60, 120, 120]);
  expect(applyFoliageModelEdit(actors, "forest", { ...oak, modelGuid: "birch" }, oak)).toBe(actors);
});

const transforms = (...floats: number[]) => new Float32Array(floats);
const instance = (x: number) => [x, 0.5, -x, 0, 0.6, 0, 0.8, 2, 2, 2];

it("round-trips HPFG chunks bit for bit into typed views without one object per instance", () => {
  const batches = [{ transforms: transforms(...instance(1), ...instance(-3.25)) }, { transforms: transforms(...instance(1e6)) }];
  const bytes = encodeFoliageChunk(batches);
  // Magic, version 1, two batches with 2 and 1 instances, then 30 floats.
  expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("HPFG");
  expect(Array.from(new Uint16Array(bytes.buffer, 4, 2))).toEqual([1, 2]);
  expect(Array.from(new Uint32Array(bytes.buffer, 8, 2))).toEqual([2, 1]);
  expect(bytes.byteLength).toBe(16 + 30 * 4);
  const decoded = decodeFoliageChunk(bytes);
  expect(decoded.map((batch) => Array.from(batch))).toEqual(batches.map((batch) => Array.from(batch.transforms)));
  expect(decoded.every((batch) => batch instanceof Float32Array)).toBe(true);
  // An unaligned chunk (a view at an odd offset) still decodes.
  const shifted = new Uint8Array(bytes.byteLength + 1);
  shifted.set(bytes, 1);
  expect(decodeFoliageChunk(shifted.subarray(1)).map((batch) => Array.from(batch))).toEqual(decoded.map((batch) => Array.from(batch)));
});

it("rejects malformed HPFG chunks", () => {
  const bytes = encodeFoliageChunk([{ transforms: transforms(...instance(1)) }]);
  const changed = (offset: number, value: number) => { const copy = bytes.slice(); copy[offset] = value; return copy; };
  expect(() => decodeFoliageChunk(bytes.subarray(0, 6))).toThrow(/truncated header/);
  expect(() => decodeFoliageChunk(changed(0, 0x42))).toThrow(/bad magic/);
  expect(() => decodeFoliageChunk(changed(4, 2))).toThrow(/version: 2/);
  expect(() => decodeFoliageChunk(bytes.subarray(0, bytes.byteLength - 4))).toThrow(/length does not match/);
  expect(() => decodeFoliageChunk(changed(8, 2))).toThrow(/length does not match/);
  expect(() => decodeFoliageChunk(changed(6, 200))).toThrow(/truncated batch table/);
  const tooMany = new Uint8Array(12);
  tooMany.set(bytes.subarray(0, 8));
  new DataView(tooMany.buffer).setUint32(8, 20001, true);
  expect(() => decodeFoliageChunk(tooMany)).toThrow(/20001 instances/);
});

it("drops instances whose chunk does not match the batch list instead of misassigning them", () => {
  const data = serializeFoliageProperties({ groupId: "g", batches: [
    { modelGuid: "a", materialGuid: null, cullDistance: 1, fadeRange: 1, shadowDistance: 1, transforms: transforms(...instance(1)) },
  ] }).data;
  const twoBatches = { groupId: "g", data, batches: [{ modelGuid: "a" }, { modelGuid: "b" }] };
  expect(parseFoliageProperties(twoBatches)).toEqual({ groupId: "g", batches: [], unreadable: true });
  expect(parseFoliageProperties({ groupId: "g", chunkId: "foliage:a/b", batches: [{ modelGuid: "a" }] }).unreadable).toBe(true);
  expect(parseFoliageProperties({ groupId: "g", data: null, batches: [] }).unreadable).toBeUndefined();
  expect(parseFoliageProperties({ groupId: "g", data: "not base64!", batches: [{ modelGuid: "a" }] }).batches).toEqual([]);
});

it("normalizes stored JSON without decoding, and fingerprints instances without serializing them", () => {
  const properties = serializeFoliageProperties({ groupId: "g", batches: [
    { modelGuid: "a", materialGuid: null, cullDistance: 1, fadeRange: 1, shadowDistance: 1, transforms: transforms(...instance(1)) },
  ] });
  const stored = { groupId: "g", batches: properties.batches, chunkId: "foliage:c1", transforms: "ignored" };
  expect(normalizeSerializedFoliageProperties(stored)).toEqual({ groupId: "g", batches: properties.batches, chunkId: "foliage:c1" });
  expect(normalizeSerializedFoliageProperties({ groupId: "g", batches: [{ modelGuid: "a" }] })).toMatchObject({ data: null });
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    const same = foliageInstancesFingerprint({ ...properties });
    expect(foliageInstancesFingerprint(properties)).toBe(same);
    const moved = serializeFoliageProperties({ groupId: "g", batches: [{ ...parseFoliageProperties(properties).batches[0]!, transforms: transforms(...instance(2)) }] });
    expect(foliageInstancesFingerprint(moved)).not.toBe(same);
    expect(foliageInstancesFingerprint(stored)).toBe("chunk:foliage:c1");
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
});
