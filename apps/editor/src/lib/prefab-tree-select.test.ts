import { describe, expect, it } from "vitest";
import { PREFAB_ROOT_ID } from "./prefab-preview";
import { applyPrefabTreeSelect } from "./prefab-tree-select";

const visible = [PREFAB_ROOT_ID, "mesh-a", "mesh-b", "light"];

describe("applyPrefabTreeSelect", () => {
  it("replaces the selection on exclusive click", () => {
    expect(
      applyPrefabTreeSelect({
        visibleIds: visible,
        selectedIds: [PREFAB_ROOT_ID],
        id: "mesh-b",
      }),
    ).toEqual(["mesh-b"]);
  });

  it("toggles a component into the set on additive click", () => {
    expect(
      applyPrefabTreeSelect({
        visibleIds: visible,
        selectedIds: ["mesh-a"],
        id: "light",
        additive: true,
      }),
    ).toEqual(["mesh-a", "light"]);
  });

  it("toggles a component out of the set on additive click", () => {
    expect(
      applyPrefabTreeSelect({
        visibleIds: visible,
        selectedIds: ["mesh-a", "light"],
        id: "mesh-a",
        additive: true,
      }),
    ).toEqual(["light"]);
  });

  it("drops Prefab Root when additively selecting a component", () => {
    expect(
      applyPrefabTreeSelect({
        visibleIds: visible,
        selectedIds: [PREFAB_ROOT_ID],
        id: "mesh-a",
        additive: true,
      }),
    ).toEqual(["mesh-a"]);
  });

  it("exclusive-selects Prefab Root on additive click", () => {
    expect(
      applyPrefabTreeSelect({
        visibleIds: visible,
        selectedIds: ["mesh-a", "mesh-b"],
        id: PREFAB_ROOT_ID,
        additive: true,
      }),
    ).toEqual([PREFAB_ROOT_ID]);
  });

  it("range-selects visible rows from the last selected id", () => {
    expect(
      applyPrefabTreeSelect({
        visibleIds: visible,
        selectedIds: ["mesh-a"],
        id: "light",
        range: true,
      }),
    ).toEqual(["mesh-a", "mesh-b", "light"]);
  });

  it("selects only the target when the range anchor is missing", () => {
    expect(
      applyPrefabTreeSelect({
        visibleIds: visible,
        selectedIds: ["gone"],
        id: "mesh-b",
        range: true,
      }),
    ).toEqual(["mesh-b"]);
  });
});
