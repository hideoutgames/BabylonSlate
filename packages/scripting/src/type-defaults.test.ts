import { describe, expect, it } from "vitest";
import {
  defaultValueForMember,
  defaultValueForPinType,
  hydrateStructInstance,
  mergeEngineTypeSchemas,
  structInstanceDefault,
} from "./type-defaults";
import { enumRef, structRef } from "./types";
import type { StructField } from "./type-assets";

describe("type defaults", () => {
  const schemas = mergeEngineTypeSchemas({
    enums: {
      "enum-team": {
        name: "Team",
        members: [
          { name: "None", value: 0 },
          { name: "Red", value: 1 },
        ],
      },
    },
    structs: {
      "struct-stats": {
        name: "Stats",
        fields: [
          { name: "Health", typeId: "int", defaultValue: 100 },
          { name: "Team", typeId: "enum", typeClassId: "enum-team" },
          { name: "Nested", typeId: "struct", typeClassId: "struct-inner" },
        ],
      },
      "struct-inner": {
        name: "Inner",
        fields: [{ name: "Label", typeId: "string", defaultValue: "ok" }],
      },
    },
  });

  it("defaults a bound enum to its first member name", () => {
    expect(defaultValueForPinType(enumRef("enum-team"), schemas)).toBe("None");
    expect(defaultValueForMember("enum", "enum-team", schemas)).toBe("None");
    expect(defaultValueForPinType(enumRef(""), schemas)).toBe("");
  });

  it("creates detached TagContainer defaults and typed Tag collection fields", () => {
    const first = defaultValueForMember("struct", "engine:TagContainer", schemas) as { Tags: number[] };
    first.Tags.push(42);
    expect(defaultValueForMember("struct", "engine:TagContainer", schemas)).toEqual({ Tags: [] });
    expect(defaultValueForMember("tag", undefined, schemas)).toBe(0);
    expect(structInstanceDefault([
      { name: "Selected", typeId: "tag", container: "array" },
      { name: "Nested", typeId: "struct", typeClassId: "engine:TagContainer" },
    ])).toEqual({ Selected: [], Nested: { Tags: [] } });
  });

  it("builds a structure instance from field defaults and nested schemas", () => {
    expect(structInstanceDefault(schemas.structs["struct-stats"]!.fields, schemas)).toEqual({
      Health: 100,
      Team: "None",
      Nested: { Label: "ok" },
    });
    expect(defaultValueForPinType(structRef("struct-stats"), schemas)).toEqual({
      Health: 100,
      Team: "None",
      Nested: { Label: "ok" },
    });
    expect(defaultValueForPinType(structRef(""), schemas)).toEqual({});
  });

  it("hydrates authored struct values by adding missing keys and dropping unknown ones", () => {
    const fields: StructField[] = schemas.structs["struct-stats"]!.fields;
    expect(
      hydrateStructInstance(
        fields,
        { Health: 40, Extra: true, Nested: { Label: "hit", skip: 1 } },
        schemas,
      ),
    ).toEqual({
      Health: 40,
      Team: "None",
      Nested: { Label: "hit" },
    });
  });
});
