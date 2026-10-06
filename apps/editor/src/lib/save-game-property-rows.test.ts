import { describe, expect, it, vi } from "vitest";
import { componentPropertyRows } from "./component-property-rows";
import { saveGameVariableNames } from "./save-game-property-rows";

describe("Save Game component selection", () => {
  it("selects individual actor and prefab component variables without losing other choices", () => {
    const update = vi.fn();
    const rows = componentPropertyRows("hero", { id: "save", classId: "SaveGameComponent", properties: { actorVariables: ["Health"], componentVariables: { inventory: ["Coins"] } } }, update, {
      sortingLayers: [], collisionLayers: [], assetLabel: () => undefined, physicsWorld: "3d", onPickAsset: () => undefined,
      actorVariableNames: () => ["Health", "Level"], componentVariableNames: () => ["Coins", "Items"],
      actorComponents: () => [{ id: "instance-id", sourceId: "inventory", classId: "InventoryComponent", properties: {} }],
    });
    const level = rows.find((row) => row.label === "Save Level");
    const items = rows.find((row) => row.label === "Save Inventory Items");
    if (level?.kind !== "boolean" || items?.kind !== "boolean") throw new Error("Missing typed variable controls");
    level.onChange(true);
    expect(update).toHaveBeenLastCalledWith("actorVariables", ["Health", "Level"]);
    items.onChange(true);
    expect(update).toHaveBeenLastCalledWith("componentVariables", { inventory: ["Coins", "Items"] });
  });

  it("offers inherited variables once while excluding functions", () => {
    expect(saveGameVariableNames("Hero", {
      Hero: { nodes: [], edges: [], members: [{ id: "h", kind: "variable", name: "Health", typeId: "int" }, { id: "f", kind: "function", name: "Jump" }] },
      Base: { nodes: [], edges: [], members: [{ id: "h", kind: "variable", name: "Health", typeId: "int" }, { id: "s", kind: "variable", name: "Score", typeId: "int" }] },
    }, (id) => id === "Hero" ? "Base" : null)).toEqual(["Health", "Score"]);
  });
});
