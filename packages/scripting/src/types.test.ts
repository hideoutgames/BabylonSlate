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
  objectRef,
  isAssignable,
  pinTypeEquals,
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
