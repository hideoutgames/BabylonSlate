import { describe, expect, it } from "vitest";
import { normalizeProjectSettings } from "./project";
import {
  addTag,
  createTag,
  findTag,
  getTagName,
  isValidTagPath,
  matchesTag,
  normalizeTag,
  normalizeTagContainer,
  normalizeTagRegistry,
  removeTag,
  tagContainerAll,
  tagContainerAny,
  tagContainerHas,
  type TagRegistry,
} from "./tags";

describe("Tags", () => {
  it("creates implicit categories and keeps IDs stable across project save/load", () => {
    const empty = normalizeProjectSettings(undefined);
    const created = createTag(empty.tags, " Ability.Damage.Fire ");
    expect(created.registry.tags).toEqual([
      { id: 1, path: "Ability", parentId: 0 },
      { id: 2, path: "Ability.Damage", parentId: 1 },
      { id: 3, path: "Ability.Damage.Fire", parentId: 2 },
    ]);
    const loaded = normalizeProjectSettings(JSON.parse(JSON.stringify({
      ...empty,
      tags: created.registry,
    })));
    const sibling = createTag(loaded.tags, "Ability.Damage.Ice");
    expect(sibling.tag).toBe(4);
    expect(findTag(sibling.registry, "Ability.Damage.Fire")).toBe(3);
    expect(getTagName(sibling.registry, 3)).toBe("Ability.Damage.Fire");
    expect(createTag(sibling.registry, "Ability.Damage.Fire").registry).toBe(sibling.registry);
    expect(empty.tags.tags).toEqual([]);
    expect(loaded.tags.tags).toHaveLength(3);
  });

  it.each(["", ".Ability", "Ability.", "Ability..Fire", "Ability.Fire Ball", "2D.Fire", "Ability.Fire-Ball"])(
    "rejects malformed path %j without creating partial categories",
    (path) => {
      const registry = normalizeTagRegistry(undefined);
      expect(isValidTagPath(path)).toBe(false);
      expect(() => createTag(registry, path)).toThrow();
      expect(registry.tags).toEqual([]);
    },
  );

  it("preserves the first valid unique definitions and never reuses discarded IDs", () => {
    const registry = normalizeTagRegistry({
      nextId: 2,
      tags: [
        { id: 8, path: "State.Ready", parentId: 999 },
        { id: 8, path: "State.Ready" },
        { id: 12, path: "State.Ready" },
        { id: 20, path: "Broken..Path" },
        { id: 0, path: "Zero" },
        { id: 3.5, path: "Fraction" },
      ],
    });
    expect(registry.tags).toEqual([
      { id: 8, path: "State.Ready", parentId: 21 },
      { id: 21, path: "State", parentId: 0 },
    ]);
    expect(createTag(registry, "State.Blocked").tag).toBe(22);
    expect(getTagName(registry, 12)).toBe("");
    expect(normalizeTagRegistry({ tags: [], nextId: 77 }).nextId).toBe(77);
  });

  it("leaves conflicting IDs unresolved instead of silently matching an unrelated retained path", () => {
    const registry = normalizeTagRegistry({ tags: [
      { id: 8, path: "State.Ready" },
      { id: 9, path: "State.Ready.Running", parentId: 8 },
      { id: 8, path: "State.Blocked" },
      { id: 8, path: "State.Ready" },
    ] });
    expect(getTagName(registry, 8)).toBe("");
    expect(matchesTag(registry, 9, 8)).toBe(false);
    expect(findTag(registry, "State.Blocked")).toBe(0);
    expect(registry.tags).toEqual([
      { id: 9, path: "State.Ready.Running", parentId: 11 },
      { id: 10, path: "State", parentId: 0 },
      { id: 11, path: "State.Ready", parentId: 10 },
    ]);
    expect(createTag(registry, "State.Blocked").tag).toBe(12);
  });

  it("does not reinterpret an ID shared with a malformed path as its surviving valid path", () => {
    const registry = normalizeTagRegistry({ tags: [
      { id: 3, path: "Safe" },
      { id: 8, path: "State.Ready" },
      { id: 8, path: "State..Blocked" },
    ] });
    expect(registry.tags).toEqual([{ id: 3, path: "Safe", parentId: 0 }]);
    expect(getTagName(registry, 8)).toBe("");
    expect(createTag(registry, "New").tag).toBe(9);
  });

  it("derives parent IDs from case-sensitive paths even when serialized parents are cyclic", () => {
    const registry = normalizeTagRegistry({
      tags: [
        { id: 9, path: "State.Ready", parentId: 9 },
        { id: 4, path: "State", parentId: 9 },
        { id: 6, path: "state", parentId: 4 },
      ],
    });
    expect(matchesTag(registry, 9, 4)).toBe(true);
    expect(matchesTag(registry, 9, 6)).toBe(false);
    expect(createTag(registry, "state.Ready").tag).toBe(10);
    expect(registry.tags.find((tag) => tag.id === 4)?.parentId).toBe(0);
  });

  it("does not wrap or partially allocate when uint32 identifiers are exhausted", () => {
    const registry = normalizeTagRegistry({ tags: [], nextId: 0xffff_ffff });
    expect(() => createTag(registry, "State.Ready")).toThrow(RangeError);
    expect(registry.tags).toEqual([]);
    const last = createTag(registry, "State");
    expect(last.tag).toBe(0xffff_ffff);
    expect(createTag(last.registry, "State").tag).toBe(0xffff_ffff);
    expect(() => createTag(last.registry, "Other")).toThrow(RangeError);
    expect(normalizeTag(0x1_0000_0000)).toBe(0);
    expect(normalizeTag(-1)).toBe(0);
    expect(normalizeTag(Infinity)).toBe(0);
    expect(normalizeTag("1")).toBe(0);
  });

  it("rejects malformed exhausted branches without reassigning surviving IDs", () => {
    const registry = normalizeTagRegistry({ tags: [
      { id: 3, path: "Safe" },
      { id: 0xffff_ffff, path: "Missing.Parent.Child" },
      { id: 4, path: "Missing.Parent.Child.Leaf" },
    ] });
    expect(registry.tags).toEqual([{ id: 3, path: "Safe", parentId: 0 }]);
    expect(() => createTag(registry, "New")).toThrow(RangeError);
  });

  const registry: TagRegistry = {
    tags: [
      { id: 1, path: "State", parentId: 0 },
      { id: 2, path: "State.Ready", parentId: 1 },
      { id: 3, path: "State.Ready.Running", parentId: 2 },
      { id: 4, path: "State.Readiness", parentId: 1 },
      { id: 5, path: "Damage", parentId: 0 },
    ],
    nextId: 6,
  };

  it("matches children against ancestors without matching siblings, parents against children, or unknown values", () => {
    expect(matchesTag(registry, 3, 1)).toBe(true);
    expect(matchesTag(registry, 3, 2)).toBe(true);
    expect(matchesTag(registry, 3, 2, true)).toBe(false);
    expect(matchesTag(registry, 3, 3, true)).toBe(true);
    expect(matchesTag(registry, 1, 3)).toBe(false);
    expect(matchesTag(registry, 4, 2)).toBe(false);
    expect(matchesTag(registry, 0, 0)).toBe(false);
    expect(matchesTag(registry, 999, 999, true)).toBe(false);
  });

  it("queries explicit container selections with directional any/all and empty-query semantics", () => {
    const container = { Tags: [3, 5] };
    expect(tagContainerHas(registry, container, 1)).toBe(true);
    expect(tagContainerHas(registry, container, 1, true)).toBe(false);
    expect(tagContainerAny(registry, container, { Tags: [2, 4] })).toBe(true);
    expect(tagContainerAny(registry, container, { Tags: [2, 4] }, true)).toBe(false);
    expect(tagContainerAll(registry, container, { Tags: [1, 5] })).toBe(true);
    expect(tagContainerAll(registry, container, { Tags: [1, 4] })).toBe(false);
    expect(tagContainerAny(registry, container, { Tags: [] })).toBe(false);
    expect(tagContainerAll(registry, container, { Tags: [] })).toBe(true);
    expect(tagContainerHas(registry, { Tags: [1] }, 3)).toBe(false);
  });

  it("normalizes structure values and edits explicit selections without mutating shared defaults", () => {
    const source = { Tags: [3, 3, 0, -1, 2.5, "2", null, 900] };
    const container = normalizeTagContainer(source);
    expect(container).toEqual({ Tags: [3, 900] });
    const added = addTag(container, 1);
    expect(added).toEqual({ Tags: [3, 900, 1] });
    expect(removeTag(added, 1)).toEqual({ Tags: [3, 900] });
    expect(addTag(container, 3)).toEqual({ Tags: [3, 900] });
    expect(addTag(container, 0)).toEqual({ Tags: [3, 900] });
    added.Tags.push(5);
    expect(container).toEqual({ Tags: [3, 900] });
    expect(normalizeTagContainer([1, 2])).toEqual({ Tags: [] });
  });
});
