import { expect, it } from "vitest";
import { appendFoliageInstance, chooseFoliageModel, normalizeFoliageGroups, parseFoliageProperties, type FoliageProperties } from "./foliage";
import { identitySerializedTransform, normalizeScene } from "./scene";

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
