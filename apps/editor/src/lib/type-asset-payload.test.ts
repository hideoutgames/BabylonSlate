import { describe, expect, it } from "vitest";
import {
  asEnumAsset,
  asScriptInterfaceAsset,
  asStructureAsset,
  memberKey,
  parseMemberIndex,
  parsePinKey,
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
  it("defaults field types and preserves defaultValue when present", () => {
    expect(
      asStructureAsset({
        guid: "s1",
        name: "Stats",
        fields: [
          { name: "Health", typeId: "int", defaultValue: 100 },
          { name: "Mana" },
          null,
        ],
      }),
    ).toEqual({
      kind: "structure",
      guid: "s1",
      name: "Stats",
      fields: [
        { name: "Health", typeId: "int", defaultValue: 100 },
        { name: "Mana", typeId: "float" },
        { name: "Field", typeId: "float" },
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
            { name: "bad", typeId: "float", direction: "in" },
          ],
        },
        { name: "Method", pins: [] },
      ],
    });
  });
});

describe("selection keys", () => {
  it("round-trips member and pin keys and rejects garbage", () => {
    expect(memberKey(3)).toBe("member:3");
    expect(parseMemberIndex("member:3")).toBe(3);
    expect(parseMemberIndex("member:1.5")).toBeNull();
    expect(parseMemberIndex("pin:0:1")).toBeNull();
    expect(parseMemberIndex(null)).toBeNull();

    expect(pinKey(1, 2)).toBe("pin:1:2");
    expect(parsePinKey("pin:1:2")).toEqual({ methodIndex: 1, pinIndex: 2 });
    expect(parsePinKey("pin:a:2")).toBeNull();
    expect(parsePinKey("member:1")).toBeNull();
    expect(parsePinKey(null)).toBeNull();
  });
});
