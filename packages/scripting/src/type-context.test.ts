import { describe, expect, it } from "vitest";
import {
  isActorClassId,
  resultKindForClassId,
} from "./type-context";

describe("type context Actor assumptions", () => {
  const hierarchy = {
    isSubclassOf(child: string, parent: string) {
      if (child === parent) return true;
      if (parent === "BObject") return true;
      if (child === "Hero" && parent === "Actor") return true;
      return false;
    },
  };

  it("treats Actor subclasses as actor refs", () => {
    expect(isActorClassId("Actor", hierarchy)).toBe(true);
    expect(isActorClassId("Hero", hierarchy)).toBe(true);
    expect(resultKindForClassId("Actor", hierarchy)).toBe("actorRef");
    expect(resultKindForClassId("Hero", hierarchy)).toBe("actorRef");
  });

  it("treats non-Actor classes as object refs", () => {
    expect(isActorClassId("BObject", hierarchy)).toBe(false);
    expect(isActorClassId("GameInstance", hierarchy)).toBe(false);
    expect(resultKindForClassId("BObject", hierarchy)).toBe("objectRef");
    expect(resultKindForClassId("GameInstance", hierarchy)).toBe("objectRef");
  });

  it("treats Actor as actorRef even without hierarchy", () => {
    expect(isActorClassId("Actor")).toBe(true);
    expect(resultKindForClassId("Actor")).toBe("actorRef");
    expect(isActorClassId("BObject")).toBe(false);
    expect(resultKindForClassId("BObject")).toBe("objectRef");
  });
});
