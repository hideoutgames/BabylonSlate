import { describe, expect, it } from "vitest";
import {
  defaultPropertiesForClassId,
  kindForCatalogClassId,
  propertyFieldsForClassId,
  titleForBtClassId,
} from "./catalog";

describe("titleForBtClassId", () => {
  it("uses Title Case names for built-in class ids and aliases", () => {
    expect(titleForBtClassId("bt.composite.selector")).toBe("Selector");
    expect(titleForBtClassId("bt.task.wait")).toBe("Wait");
    expect(titleForBtClassId("BTTask_SetBlackboardValue")).toBe("Set Blackboard");
    expect(titleForBtClassId("bt.decorator.blackboardIsSet")).toBe("Blackboard Is Set");
    expect(titleForBtClassId("bt.decorator.timeLimit")).toBe("Time Limit");
  });

  it("title-cases an unknown class id from its last segment", () => {
    expect(titleForBtClassId("BTTask_PatrolGuard")).toBe("Patrol Guard");
  });
});

describe("propertyFieldsForClassId", () => {
  it("returns Play Animation clip kind and Animation picker by default", () => {
    expect(propertyFieldsForClassId("bt.task.playAnimation")).toEqual([
      expect.objectContaining({
        id: "clipKind",
        kind: "enum",
        key: "clipKind",
        label: "Clip Kind",
        options: [
          { value: "animation", label: "Animation" },
          { value: "sprite", label: "Sprite" },
        ],
      }),
      expect.objectContaining({
        id: "clipAssetGuid",
        kind: "asset",
        key: "clipAssetGuid",
        assetType: "Animation",
      }),
    ]);
    expect(defaultPropertiesForClassId("bt.task.playAnimation")).toEqual({
      clipKind: "animation",
      clipAssetGuid: "",
    });
  });

  it("switches Play Animation picker to Sprite Animation when clipKind is sprite", () => {
    expect(
      propertyFieldsForClassId("bt.task.playAnimation", { clipKind: "sprite" }),
    ).toEqual([
      expect.objectContaining({ id: "clipKind", key: "clipKind" }),
      expect.objectContaining({
        id: "clipAssetGuid",
        kind: "asset",
        key: "clipAssetGuid",
        assetType: "SpriteAnimation",
      }),
    ]);
  });
});

describe("kindForCatalogClassId", () => {
  const parentOf = (id: string) => {
    if (id === "MyBrain" || id === "BTComposite_PatrolSelector") return "BTComposite";
    if (id === "MySel") return "BTComposite_Selector";
    if (id === "BTComposite_Selector" || id === "BTComposite_Sequence" || id === "BTComposite_Parallel") {
      return "BTComposite";
    }
    if (id === "BTComposite") return "BObject";
    return null;
  };

  it("maps built-in composite aliases without using the user class name", () => {
    expect(kindForCatalogClassId("bt.composite.selector")).toBe("selector");
    expect(kindForCatalogClassId("BTComposite_Sequence")).toBe("sequence");
    expect(kindForCatalogClassId("BTComposite_Parallel")).toBe("parallel");
    expect(kindForCatalogClassId("bt.task.wait")).toBe("task");
  });

  it("does not treat a class whose id contains sequence as a composite", () => {
    expect(kindForCatalogClassId("custom.sequence.helper")).toBe("task");
  });

  it("maps a bare BTComposite subclass to sequence from ancestry", () => {
    expect(kindForCatalogClassId("MyBrain", parentOf)).toBe("sequence");
    expect(kindForCatalogClassId("BTComposite", parentOf)).toBe("sequence");
    expect(kindForCatalogClassId("BTComposite_PatrolSelector", parentOf)).toBe(
      "sequence",
    );
  });

  it("maps subclasses of Selector / Parallel built-ins from ancestry", () => {
    expect(kindForCatalogClassId("MySel", parentOf)).toBe("selector");
  });
});
