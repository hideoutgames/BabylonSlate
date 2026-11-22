import { expect, it } from "vitest";
import { appendFoliageInstance, applyFoliageModelEdit, chooseFoliageModel, normalizeFoliageGroups, parseFoliageProperties, type FoliageModel, type FoliageProperties } from "./foliage";
import { createActor, identitySerializedTransform, normalizeScene } from "./scene";

it("batches mixed Models by Model and Material while retaining one component payload", () => {
  const group = normalizeFoliageGroups([{ id: "forest", name: "Forest", models: [{ modelGuid: "tree" }, { modelGuid: "grass", materialGuid: "leaves" }] }])[0]!;
  const empty: FoliageProperties = { groupId: group.id, batches: [] };
  const a = appendFoliageInstance(empty, group.models[0]!, identitySerializedTransform());
  const b = appendFoliageInstance(a, group.models[1]!, { ...identitySerializedTransform(), position: [3, 0, 0] });
  const c = appendFoliageInstance(b, group.models[0]!, { ...identitySerializedTransform(), position: [7, 0, 0] });
  expect(c.batches.map((batch) => [batch.modelGuid, batch.transforms.length])).toEqual([["tree", 2], ["grass", 1]]);
  expect(a.batches[0]!.transforms).toHaveLength(1);
  expect(empty.batches).toHaveLength(0);
  expect(parseFoliageProperties(JSON.parse(JSON.stringify(c)))).toEqual(c);
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
  expect(parseFoliageProperties(properties).batches[0]).toMatchObject({ cullDistance: 60, fadeRange: 10, shadowDistance: 20 });
});

it("carries a group Model's Material Override and distances to its painted batches, so the next edit still finds them", () => {
  const oak: FoliageModel = { modelGuid: "oak", materialGuid: null, weight: 1, minScale: 1, maxScale: 1, cullDistance: 120, fadeRange: 15, shadowDistance: 45 };
  const stroke = (id: string, groupId: string) => createActor(id, id, { components: [{ id: "foliage", classId: "FoliageComponent", properties: { groupId, batches: [
    { modelGuid: "oak", materialGuid: null, cullDistance: 120, fadeRange: 15, shadowDistance: 45, transforms: [identitySerializedTransform()] },
    { modelGuid: "oak", materialGuid: "bark", cullDistance: 120, fadeRange: 15, shadowDistance: 45, transforms: [identitySerializedTransform()] },
    { modelGuid: "pine", materialGuid: null, cullDistance: 120, fadeRange: 15, shadowDistance: 45, transforms: [identitySerializedTransform()] },
  ] } }] });
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
