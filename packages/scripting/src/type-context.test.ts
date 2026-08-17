import { describe, expect, it } from "vitest";
import {
  userInterfaceClassId,
  widgetClassIdForKind,
} from "@babylonslate/core";
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

  it("excludes UserInterface and Widget class ids from Actor assumptions", () => {
    const uiClassId = userInterfaceClassId("hud-guid");
    expect(isActorClassId("UserInterface", hierarchy)).toBe(false);
    expect(isActorClassId(uiClassId, hierarchy)).toBe(false);
    expect(isActorClassId("Widget", hierarchy)).toBe(false);
    expect(isActorClassId(widgetClassIdForKind("Button"), hierarchy)).toBe(false);
    expect(isActorClassId(widgetClassIdForKind("Image"), hierarchy)).toBe(false);
    expect(resultKindForClassId("UserInterface", hierarchy)).toBe("objectRef");
    expect(resultKindForClassId(uiClassId, hierarchy)).toBe("objectRef");
    expect(resultKindForClassId("Widget", hierarchy)).toBe("objectRef");
    expect(resultKindForClassId("ButtonWidget", hierarchy)).toBe("objectRef");
  });

  it("does not treat a namespaced UI class as Actor even without hierarchy", () => {
    expect(isActorClassId(userInterfaceClassId("hud-guid"))).toBe(false);
    expect(resultKindForClassId(userInterfaceClassId("hud-guid"))).toBe(
      "objectRef",
    );
    expect(isActorClassId("Actor")).toBe(true);
    expect(resultKindForClassId("Actor")).toBe("actorRef");
  });
});
