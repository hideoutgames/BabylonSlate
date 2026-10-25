import { describe, expect, it } from "vitest";
import {
  BOOL,
  FLOAT,
  INT,
  TAG,
  STRING,
  VEC3,
  BOXED_WILDCARD,
  assetRef,
  classRef,
  objectRef,
  defaultValueLiteral,
  isAssignable,
  pinTypeEquals,
  pinTypeTag,
} from "./types";

describe("pin assignability", () => {
  it("keeps Tag pins distinct from numeric pins despite numeric runtime storage", () => {
    expect(isAssignable(TAG, TAG)).toBe(true);
    for (const numeric of [INT, FLOAT]) {
      expect(isAssignable(TAG, numeric)).toBe(false);
      expect(isAssignable(numeric, TAG)).toBe(false);
    }
    expect(isAssignable(TAG, BOXED_WILDCARD)).toBe(true);
  });
  it("allows int → float widening only", () => {
    expect(isAssignable(INT, FLOAT)).toBe(true);
    expect(isAssignable(FLOAT, INT)).toBe(false);
  });

  it("allows anything (except resolving) into boxed wildcard", () => {
    expect(isAssignable(STRING, BOXED_WILDCARD)).toBe(true);
    expect(isAssignable(VEC3, BOXED_WILDCARD)).toBe(true);
    expect(isAssignable(BOXED_WILDCARD, STRING)).toBe(false);
  });

  it("uses class hierarchy for object refs", () => {
    const hierarchy = {
      isSubclassOf(child: string, parent: string) {
        return child === "Player" && parent === "Actor";
      },
    };
    expect(
      isAssignable(objectRef("Player"), objectRef("Actor"), { hierarchy }),
    ).toBe(true);
    expect(
      isAssignable(objectRef("Actor"), objectRef("Player"), { hierarchy }),
    ).toBe(false);
  });

  it("treats objectRef Object (or empty classId) as the instance root without a hierarchy", () => {
    expect(isAssignable(objectRef("Actor"), objectRef("Object"))).toBe(true);
    expect(isAssignable(objectRef("Hero"), objectRef("Object"))).toBe(true);
    expect(isAssignable(objectRef("MeshComponent"), objectRef("Object"))).toBe(
      true,
    );
    expect(isAssignable(objectRef("Actor"), objectRef(""))).toBe(true);
    expect(isAssignable(objectRef("Hero"), objectRef("Actor"))).toBe(false);
  });

  it("follows the hierarchy from an actor subclass to Actor and Object", () => {
    const hierarchy = {
      isSubclassOf(child: string, parent: string) {
        return (
          child === parent ||
          (child === "Player" &&
            (parent === "Actor" || parent === "Object")) ||
          (child === "Actor" && parent === "Object")
        );
      },
    };
    expect(
      isAssignable(objectRef("Player"), objectRef("Object"), { hierarchy }),
    ).toBe(true);
    expect(
      isAssignable(objectRef("Player"), objectRef("Actor"), { hierarchy }),
    ).toBe(true);
    expect(
      isAssignable(objectRef("Object"), objectRef("Actor"), { hierarchy }),
    ).toBe(false);
    expect(
      isAssignable(objectRef("Player"), objectRef("Pawn"), { hierarchy }),
    ).toBe(false);
  });

  it("treats classRef as a class value assignable along the same hierarchy", () => {
    const hierarchy = {
      isSubclassOf(child: string, parent: string) {
        return child === "Player" && parent === "Actor";
      },
    };
    expect(classRef("Actor")).toEqual({ kind: "classRef", classId: "Actor" });
    expect(pinTypeEquals(classRef("Actor"), classRef("Actor"))).toBe(true);
    expect(
      isAssignable(classRef("Player"), classRef("Actor"), { hierarchy }),
    ).toBe(true);
    expect(
      isAssignable(classRef("Actor"), classRef("Player"), { hierarchy }),
    ).toBe(false);
    expect(isAssignable(classRef("Actor"), objectRef("Actor"))).toBe(false);
    expect(defaultValueLiteral(classRef("Actor"))).toBe('"Actor"');
    expect(pinTypeTag(classRef("Actor"))).toBe("classRef:Actor");
  });

  it("treats assetRef as a guid string constrained to one asset type", () => {
    expect(assetRef("Audio")).toEqual({ kind: "assetRef", assetType: "Audio" });
    expect(pinTypeEquals(assetRef("Audio"), assetRef("Audio"))).toBe(true);
    expect(pinTypeEquals(assetRef("Audio"), assetRef("AudioChannel"))).toBe(
      false,
    );
    expect(isAssignable(assetRef("Audio"), assetRef("Audio"))).toBe(true);
    expect(isAssignable(assetRef("Audio"), assetRef("AudioChannel"))).toBe(
      false,
    );
    expect(isAssignable(assetRef("Audio"), STRING)).toBe(false);
    expect(isAssignable(assetRef("Audio"), classRef("Audio"))).toBe(false);
    expect(isAssignable(assetRef(""), assetRef("Audio"))).toBe(true);
    // Instances plug into Material pins, never the reverse.
    expect(isAssignable(assetRef("MaterialInstance"), assetRef("Material"))).toBe(true);
    expect(isAssignable(assetRef("Material"), assetRef("MaterialInstance"))).toBe(false);
    expect(isAssignable(assetRef("Audio"), assetRef(""))).toBe(true);
    expect(defaultValueLiteral(assetRef("Audio"))).toBe('""');
    expect(pinTypeTag(assetRef("Audio"))).toBe("assetRef:Audio");
  });

  it.each([BOOL, INT, FLOAT, STRING, VEC3, objectRef("Object")])(
    "equal $kind types are assignable",
    (type) => {
      expect(isAssignable(type, type)).toBe(true);
      expect(pinTypeEquals(type, type)).toBe(true);
    },
  );
});
