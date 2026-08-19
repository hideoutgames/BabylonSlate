import { describe, expect, it } from "vitest";
import {
  BT_COMPOSITE_CATALOG,
  BT_DECORATOR_CATALOG,
  BT_SERVICE_CATALOG,
  BT_TASK_CATALOG,
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

describe("BT catalogs", () => {
  it("lists composites, tasks, decorators, and services with titles", () => {
    expect(BT_COMPOSITE_CATALOG.map((row) => row.classId)).toEqual([
      "bt.composite.selector",
      "bt.composite.sequence",
      "bt.composite.parallel",
    ]);
    expect(BT_TASK_CATALOG.some((row) => row.classId === "bt.task.moveTo")).toBe(true);
    expect(BT_DECORATOR_CATALOG.map((row) => row.classId)).toContain("bt.decorator.loop");
    expect(BT_SERVICE_CATALOG).toEqual([
      expect.objectContaining({ classId: "bt.service.setBlackboard", title: "Set Blackboard" }),
    ]);
  });
});

describe("propertyFieldsForClassId", () => {
  it("returns Wait duration and Set Blackboard key/value fields", () => {
    expect(propertyFieldsForClassId("bt.task.wait")).toEqual([
      expect.objectContaining({ id: "durationMs", kind: "number", key: "durationMs" }),
    ]);
    expect(propertyFieldsForClassId("BTTask_SetBlackboardValue").map((row) => row.id)).toEqual([
      "key",
      "value",
    ]);
  });

  it("returns Rotate To Face target vector", () => {
    expect(propertyFieldsForClassId("bt.task.rotateToFace")).toEqual([
      expect.objectContaining({
        id: "target",
        kind: "vector3",
        key: "target",
        label: "Target",
      }),
    ]);
    expect(defaultPropertiesForClassId("bt.task.rotateToFace")).toEqual({
      target: { x: 0, y: 0, z: 1 },
    });
  });

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

  it("returns Play Sound audio picker and volume", () => {
    expect(propertyFieldsForClassId("bt.task.playSound")).toEqual([
      expect.objectContaining({
        id: "audioAssetGuid",
        kind: "asset",
        key: "audioAssetGuid",
        assetType: "Audio",
      }),
      expect.objectContaining({
        id: "volume",
        kind: "number",
        key: "volume",
        min: 0,
        max: 1,
      }),
    ]);
    expect(defaultPropertiesForClassId("bt.task.playSound")).toEqual({
      audioAssetGuid: "",
      volume: 1,
    });
  });

  it("returns Loop / Cooldown / TimeLimit and compare fields", () => {
    expect(propertyFieldsForClassId("bt.decorator.loop")[0]).toMatchObject({
      key: "numLoops",
      kind: "number",
    });
    expect(propertyFieldsForClassId("bt.decorator.cooldown")[0]?.key).toBe("durationMs");
    expect(propertyFieldsForClassId("bt.decorator.timeLimit")[0]?.key).toBe("durationMs");
    expect(propertyFieldsForClassId("bt.decorator.compareBlackboardValue").map((row) => row.id)).toEqual(
      ["key", "op", "value"],
    );
  });
});

describe("defaultPropertiesForClassId", () => {
  it("seeds built-in defaults", () => {
    expect(defaultPropertiesForClassId("bt.task.wait")).toEqual({ durationMs: 1000 });
    expect(defaultPropertiesForClassId("bt.decorator.loop")).toEqual({ numLoops: 0 });
    expect(defaultPropertiesForClassId("bt.task.moveTo")).toEqual({
      destination: { x: 0, y: 0, z: 0 },
      acceptRadius: 0.5,
    });
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
