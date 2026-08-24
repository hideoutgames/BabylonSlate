import { describe, expect, it } from "vitest";
import {
  dockviewApiKey,
  dockviewApiKeysForDocument,
} from "./dockview-surface";

describe("dockviewApiKey", () => {
  it("keeps the document id for the default surface", () => {
    expect(dockviewApiKey("anim-graph:loco")).toBe("anim-graph:loco");
    expect(dockviewApiKey("anim-graph:loco", "default")).toBe("anim-graph:loco");
  });

  it("namespaces Animation Graph surface APIs on the same document", () => {
    expect(dockviewApiKey("anim-graph:loco", "stateMachine")).toBe(
      "anim-graph:loco::stateMachine",
    );
    expect(dockviewApiKey("anim-graph:loco", "animationObject")).toBe(
      "anim-graph:loco::animationObject",
    );
  });
});

describe("dockviewApiKeysForDocument", () => {
  it("lists default plus Animation Graph surfaces so close disposes every shell", () => {
    expect(dockviewApiKeysForDocument("anim-graph:loco")).toEqual([
      "anim-graph:loco",
      "anim-graph:loco::stateMachine",
      "anim-graph:loco::animationObject",
    ]);
  });
});
