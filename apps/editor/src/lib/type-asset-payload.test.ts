import { describe, expect, it } from "vitest";
import {
  asEnumAsset,
  asScriptInterfaceAsset,
  asStructureAsset,
  memberKey,
  parseMemberIndex,
  pinKey,
} from "./type-asset-payload";

describe("asEnumAsset", () => {
  it("fills defaults and coerces member rows", () => {
    expect(asEnumAsset({})).toEqual({
      kind: "enum",
      guid: "",
      name: "Enum",
      members: [],
    });
    expect(
      asEnumAsset({
        guid: "e1",
        name: "Colors",
        members: [
          { name: "Red", value: 1 },
          { name: 12, value: "x" },
          "skip",
        ],
      }),
    ).toEqual({
      kind: "enum",
      guid: "e1",
      name: "Colors",
      members: [
        { name: "Red", value: 1 },
        { name: "Member", value: 0 },
        { name: "Member", value: 0 },
      ],
    });
  });
});

describe("asStructureAsset", () => {
  it("keeps typed collection metadata for Structure defaults and data editors", () => {
    expect(asStructureAsset({ fields: [
      { name: "Materials", typeId: "asset", typeClassId: "Material", container: "map", keyTypeId: " enum ", keyTypeClassId: " tiers " },
      { name: "Tags", typeId: "tag", container: "array" },
      { name: "Invalid", container: "set", keyTypeId: 2, keyTypeClassId: " " },
    ] }).fields).toEqual([
      { name: "Materials", typeId: "asset", typeClassId: "Material", container: "map", keyTypeId: "enum", keyTypeClassId: "tiers" },
      { name: "Tags", typeId: "tag", container: "array" },
      { name: "Invalid", typeId: "float" },
    ]);
  });

  it("keeps a Hard Loading policy across reopening and drops any other value", () => {
    const fields = asStructureAsset({ fields: [
      { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model", loading: "hard" },
      { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture", loading: "soft" },
      { id: "boss", name: "Boss", typeId: "class", loading: 1 },
    ] }).fields;
    expect(fields).toEqual([
      { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model", loading: "hard" },
      { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" },
      { id: "boss", name: "Boss", typeId: "class" },
    ]);
    expect(asStructureAsset({ fields: JSON.parse(JSON.stringify(fields)) }).fields).toEqual(fields);
  });

  it("defaults field types and preserves defaultValue when present", () => {
    expect(
      asStructureAsset({
        guid: "s1",
        name: "Stats",
        fields: [
          { id: "health-field", name: "Health", typeId: "int", defaultValue: 100 },
          { name: "Mana" },
          null,
          { name: "Team", typeId: "enum", typeClassId: " enum-team " },
        ],
      }),
    ).toEqual({
      kind: "structure",
      guid: "s1",
      name: "Stats",
      fields: [
        { id: "health-field", name: "Health", typeId: "int", defaultValue: 100 },
        { name: "Mana", typeId: "float" },
        { name: "Field", typeId: "float" },
        { name: "Team", typeId: "enum", typeClassId: "enum-team" },
      ],
    });
  });
});

describe("asScriptInterfaceAsset", () => {
  it("normalizes methods and pin directions", () => {
    expect(
      asScriptInterfaceAsset({
        guid: "i1",
        name: "Damageable",
        methods: [
          {
            name: "ApplyDamage",
            pins: [
              { name: "exec", typeId: "exec", direction: "in" },
              { name: "amount", typeId: "float", direction: "out" },
              {
                name: "other",
                typeId: "object",
                direction: "in",
                typeClassId: "Actor",
              },
              { name: "bad" },
            ],
          },
          "nope",
        ],
      }),
    ).toEqual({
      kind: "scriptInterface",
      guid: "i1",
      name: "Damageable",
      methods: [
        {
          name: "ApplyDamage",
          pins: [
            { name: "exec", typeId: "exec", direction: "in" },
            { name: "amount", typeId: "float", direction: "out" },
            {
              name: "other",
              typeId: "object",
              direction: "in",
              typeClassId: "Actor",
            },
            { name: "bad", typeId: "float", direction: "in" },
          ],
        },
        { name: "Method", pins: [] },
      ],
    });
  });
});

describe("selection keys", () => {
  it("round-trips member keys and keeps pin keys out of member parsing", () => {
    expect(memberKey(3)).toBe("member:3");
    expect(parseMemberIndex("member:3")).toBe(3);
    expect(parseMemberIndex("member:1.5")).toBeNull();
    expect(parseMemberIndex("pin:0:1")).toBeNull();
    expect(parseMemberIndex(null)).toBeNull();

    expect(pinKey(1, 2)).toBe("pin:1:2");
  });
});
