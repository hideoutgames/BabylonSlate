import { describe, expect, it } from "vitest";
import {
  dockviewApiKey,
  dockviewApiKeysForDocument,
  dockviewSurfaceForUiMode,
} from "./dockview-surface";

describe("dockviewSurfaceForUiMode", () => {
  it("maps Designer and Logic to distinct DockView surfaces", () => {
    expect(dockviewSurfaceForUiMode("designer")).toBe("designer");
    expect(dockviewSurfaceForUiMode("logic")).toBe("logic");
  });
});

describe("dockviewApiKey", () => {
  it("keeps the document id for the default surface", () => {
    expect(dockviewApiKey("ui:hud")).toBe("ui:hud");
    expect(dockviewApiKey("ui:hud", "default")).toBe("ui:hud");
  });

  it("namespaces Designer and Logic APIs on the same document", () => {
    expect(dockviewApiKey("ui:hud", "designer")).toBe("ui:hud::designer");
    expect(dockviewApiKey("ui:hud", "logic")).toBe("ui:hud::logic");
  });
});

describe("dockviewApiKeysForDocument", () => {
  it("lists default plus UI and Animation Graph surfaces so close disposes every shell", () => {
    expect(dockviewApiKeysForDocument("ui:hud")).toEqual([
      "ui:hud",
      "ui:hud::designer",
      "ui:hud::logic",
      "ui:hud::stateMachine",
      "ui:hud::animationObject",
    ]);
  });
});
