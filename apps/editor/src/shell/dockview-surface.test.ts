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

  it("namespaces a Scene mode's surface API on the same document", () => {
    expect(dockviewApiKey("scene:level", "script")).toBe("scene:level::script");
  });
});

describe("dockviewApiKeysForDocument", () => {
  it("lists all document surfaces so close disposes every shell", () => {
    expect(dockviewApiKeysForDocument("anim-graph:loco")).toEqual([
      "anim-graph:loco",
      "anim-graph:loco::design",
      "anim-graph:loco::landscape",
      "anim-graph:loco::foliage",
      "anim-graph:loco::script",
      "anim-graph:loco::timeline",
    ]);
  });
});
