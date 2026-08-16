import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  BOOL,
  FLOAT,
  INT,
  STRING,
  VEC3,
  BOXED_WILDCARD,
  actorRef,
  classRef,
  objectRef,
  defaultValueLiteral,
  isAssignable,
  pinTypeEquals,
  pinTypeTag,
} from "./types";

describe("pin assignability", () => {
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
      isAssignable(actorRef("Player"), actorRef("Actor"), { hierarchy }),
    ).toBe(true);
    expect(
      isAssignable(actorRef("Actor"), actorRef("Player"), { hierarchy }),
    ).toBe(false);
  });

  it("allows actorRef into objectRef when hierarchy says the actor is a subclass", () => {
    const hierarchy = {
      isSubclassOf(child: string, parent: string) {
        return (
          child === parent ||
          (child === "Player" && (parent === "Actor" || parent === "BObject")) ||
          (child === "Actor" && parent === "BObject")
        );
      },
    };
    expect(
      isAssignable(actorRef("Player"), objectRef("BObject"), { hierarchy }),
    ).toBe(true);
    expect(
      isAssignable(actorRef("Player"), objectRef("Actor"), { hierarchy }),
    ).toBe(true);
    expect(
      isAssignable(objectRef("Player"), actorRef("Actor"), { hierarchy }),
    ).toBe(false);
    expect(
      isAssignable(actorRef("Player"), objectRef("Pawn"), { hierarchy }),
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

  it("property: equal types are assignable", () => {
    const arb = fc.constantFrom(BOOL, INT, FLOAT, STRING, VEC3, objectRef("BObject"));
    fc.assert(
      fc.property(arb, (t) => {
        expect(isAssignable(t, t)).toBe(true);
        expect(pinTypeEquals(t, t)).toBe(true);
      }),
    );
  });
});
