import { describe, expect, it } from "vitest";
import {
  graphSessionViewportKey,
  loadGraphSessionViewport,
  saveGraphSessionViewport,
} from "./graph-session-viewport";

describe("graph session viewport store", () => {
  it("round-trips a viewport for a document surface key", () => {
    const key = graphSessionViewportKey("graph:Hero", "event");
    saveGraphSessionViewport(key, { x: 12, y: 34, zoom: 0.75 });
    expect(loadGraphSessionViewport(key)).toEqual({
      x: 12,
      y: 34,
      zoom: 0.75,
    });
  });

  it("does not share viewports across surfaces", () => {
    saveGraphSessionViewport(
      graphSessionViewportKey("graph:Hero", "event"),
      { x: 1, y: 2, zoom: 0.5 },
    );
    expect(
      loadGraphSessionViewport(graphSessionViewportKey("graph:Hero", "fn-1")),
    ).toBeNull();
  });
});
