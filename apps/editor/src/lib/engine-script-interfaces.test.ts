import { describe, expect, it } from "vitest";
import { engineScriptInterfaceAssets } from "./engine-script-interfaces";

describe("engineScriptInterfaceAssets", () => {
  const parents: Record<string, string> = { Counter: "Object", Hero: "Actor", Inventory: "GameSubsystem" };
  const parentOf = (id: string) => parents[id];

  it("offers Tickable Object to plain Object classes only", () => {
    const tickable = [{ guid: "engine:TickableObject", name: "Tickable Object", type: "ScriptInterface" }];
    expect(engineScriptInterfaceAssets("Object", parentOf)).toEqual(tickable);
    expect(engineScriptInterfaceAssets("Counter", parentOf)).toEqual(tickable);
    for (const parent of ["Actor", "Hero", "Inventory", "GameInstance", "FunctionLibrary", null]) {
      expect(engineScriptInterfaceAssets(parent, parentOf)).toEqual([]);
    }
  });
});
