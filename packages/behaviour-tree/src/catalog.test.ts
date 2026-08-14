import { describe, expect, it } from "vitest";
import {
  BT_COMPOSITE_CATALOG,
  BT_DECORATOR_CATALOG,
  BT_SERVICE_CATALOG,
  BT_TASK_CATALOG,
  defaultPropertiesForClassId,
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

  it("returns MoveTo destination and accept radius", () => {
    expect(propertyFieldsForClassId("bt.task.moveTo").map((row) => row.id)).toEqual([
      "destination",
      "acceptRadius",
    ]);
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
