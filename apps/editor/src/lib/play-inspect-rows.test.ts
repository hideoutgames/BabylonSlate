import { describe, expect, it } from "vitest";
import {
  playInspectIdentityRows,
  playInspectPropertyRows,
  playInspectTransformRows,
  playInspectVariableRows,
} from "./play-inspect-rows";

describe("playInspectPropertyRows", () => {
  it("maps bool values to disabled checkboxes", () => {
    const [row] = playInspectPropertyRows([
      { id: "alive", label: "alive", value: true, type: "bool" },
    ]);
    expect(row).toMatchObject({
      kind: "boolean",
      id: "alive",
      value: true,
      disabled: true,
    });
    if (row?.kind === "boolean") {
      row.onChange(false);
      expect(row.value).toBe(true);
    }
  });

  it("maps int, float, and inferred numbers to disabled numeric fields", () => {
    const [health] = playInspectPropertyRows([
      { id: "health", label: "health", value: 10, type: "float" },
    ]);
    expect(health).toMatchObject({
      kind: "number",
      value: 10,
      disabled: true,
    });
    const [count] = playInspectPropertyRows([
      { id: "count", label: "count", value: 3, type: "int" },
    ]);
    expect(count).toMatchObject({ kind: "number", value: 3, disabled: true });
    const [inferred] = playInspectPropertyRows([
      { id: "score", label: "score", value: 7 },
    ]);
    expect(inferred).toMatchObject({ kind: "number", value: 7, disabled: true });
  });

  it("maps vec2, vec3, tuples, and xyz objects to vector rows", () => {
    const [vec2] = playInspectPropertyRows([
      { id: "uv", label: "uv", value: [1, 2], type: "vec2" },
    ]);
    expect(vec2).toMatchObject({
      kind: "vector3",
      value: [1, 2, 0],
      axes: ["X", "Y"],
      disabled: true,
    });
    const [vec3] = playInspectPropertyRows([
      { id: "offset", label: "offset", value: { x: 1, y: 2, z: 3 } },
    ]);
    expect(vec3).toMatchObject({
      kind: "vector3",
      value: [1, 2, 3],
      axes: ["X", "Y", "Z"],
      disabled: true,
    });
    const [tuple] = playInspectPropertyRows([
      { id: "pos", label: "pos", value: [4, 5, 6] },
    ]);
    expect(tuple).toMatchObject({
      kind: "vector3",
      value: [4, 5, 6],
      disabled: true,
    });
  });

  it("maps color values to disabled color fields", () => {
    const [row] = playInspectPropertyRows([
      { id: "tint", label: "tint", value: [1, 0, 0], type: "color" },
    ]);
    expect(row).toMatchObject({
      kind: "color",
      value: [1, 0, 0],
      disabled: true,
    });
  });

  it("maps object refs to disabled picker identity rows", () => {
    const [row] = playInspectPropertyRows([
      {
        id: "target",
        label: "target",
        value: { guid: "a1", classId: "Actor" },
      },
    ]);
    expect(row).toMatchObject({
      kind: "asset",
      value: "a1",
      displayLabel: "Actor",
      displayType: "a1",
      disabled: true,
    });
    if (row?.kind === "asset") {
      row.onPick();
      row.onChange(null);
      expect(row.value).toBe("a1");
    }
  });

  it("maps object and class declared types to asset pickers", () => {
    const [objectRow] = playInspectPropertyRows([
      {
        id: "owner",
        label: "owner",
        value: { guid: "g1", classId: "Hero" },
        type: "object",
      },
    ]);
    expect(objectRow).toMatchObject({
      kind: "asset",
      displayLabel: "Hero",
      displayType: "g1",
    });
    const [classRow] = playInspectPropertyRows([
      { id: "kind", label: "kind", value: "Actor", type: "class" },
    ]);
    expect(classRow).toMatchObject({
      kind: "asset",
      value: "Actor",
      displayLabel: "Actor",
      displayType: "Actor",
    });
  });

  it("maps strings, enums, and unknown values to disabled text", () => {
    const [name] = playInspectPropertyRows([
      { id: "name", label: "name", value: "Hero" },
    ]);
    expect(name).toMatchObject({
      kind: "text",
      value: "Hero",
      disabled: true,
    });
    const [mode] = playInspectPropertyRows([
      { id: "mode", label: "mode", value: "idle", type: "enum" },
    ]);
    expect(mode).toMatchObject({ kind: "text", value: "idle", disabled: true });
    const [unknown] = playInspectPropertyRows([
      { id: "loop", label: "loop", value: { nested: true } },
    ]);
    expect(unknown).toMatchObject({
      kind: "text",
      disabled: true,
    });
    if (unknown?.kind === "text") {
      expect(unknown.value).toContain("nested");
    }
  });

  it("attaches optional test ids for inspect variable wrappers", () => {
    const [row] = playInspectPropertyRows([
      {
        id: "health",
        label: "health",
        value: 10,
        testId: "debug-inspect-var-health",
      },
    ]);
    expect(row?.testId).toBe("debug-inspect-var-health");
  });
});

describe("playInspectIdentityRows", () => {
  it("maps name, class, and GUID onto disabled text rows", () => {
    const rows = playInspectIdentityRows({
      id: "hero",
      label: "Hero",
      classId: "Actor",
    });
    expect(rows).toMatchObject([
      { kind: "text", id: "name", label: "Name", value: "Hero", disabled: true },
      { kind: "text", id: "class", label: "Class", value: "Actor", disabled: true },
      { kind: "text", id: "guid", label: "GUID", value: "hero", disabled: true },
    ]);
  });
});

describe("playInspectTransformRows", () => {
  it("maps position and scale to XYZ and rotation to XYZW", () => {
    const rows = playInspectTransformRows({
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    expect(rows).toMatchObject([
      {
        kind: "vector3",
        id: "position",
        label: "Position",
        value: [1, 2, 3],
        axes: ["X", "Y", "Z"],
        disabled: true,
      },
      {
        kind: "vector3",
        id: "rotation",
        label: "Rotation",
        value: [0, 0, 0, 1],
        axes: ["X", "Y", "Z", "W"],
        disabled: true,
      },
      {
        kind: "vector3",
        id: "scale",
        label: "Scale",
        value: [1, 1, 1],
        axes: ["X", "Y", "Z"],
        disabled: true,
      },
    ]);
  });
});

describe("playInspectVariableRows", () => {
  it("uses registry types when present and infers otherwise", () => {
    const rows = playInspectVariableRows(
      {
        health: 10,
        alive: true,
        target: { guid: "a1", classId: "Actor" },
      },
      { health: "float" },
    );
    expect(rows.map((row) => row.id)).toEqual(["health", "alive", "target"]);
    expect(rows).toMatchObject([
      { kind: "number", id: "health", testId: "debug-inspect-var-health" },
      { kind: "boolean", id: "alive", testId: "debug-inspect-var-alive" },
      {
        kind: "asset",
        id: "target",
        displayLabel: "Actor",
        displayType: "a1",
        testId: "debug-inspect-var-target",
      },
    ]);
  });
});
