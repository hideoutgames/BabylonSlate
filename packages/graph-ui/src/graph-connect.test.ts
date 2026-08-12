import { describe, expect, it } from "vitest";
import type { PaletteNode, SerializedPin } from "./graph-types";
import {
  CONNECT_END_CANCEL_PX,
  displayNodeTitle,
  filterPaletteForPin,
  isNearSourcePin,
  pinsAreCompatible,
} from "./graph-connect";

const execOut: SerializedPin = {
  id: "execOut",
  name: "then",
  kind: "exec",
  direction: "out",
  type: { kind: "exec" },
};

const execIn: SerializedPin = {
  id: "execIn",
  name: "exec",
  kind: "exec",
  direction: "in",
  type: { kind: "exec" },
};

const stringOut: SerializedPin = {
  id: "value",
  name: "value",
  kind: "data",
  direction: "out",
  type: { kind: "string" },
};

const stringIn: SerializedPin = {
  id: "message",
  name: "message",
  kind: "data",
  direction: "in",
  type: { kind: "string" },
};

const floatIn: SerializedPin = {
  id: "a",
  name: "a",
  kind: "data",
  direction: "in",
  type: { kind: "float" },
};

describe("displayNodeTitle", () => {
  it("keeps an explicit title", () => {
    expect(displayNodeTitle("flow.event.beginPlay", "Event Begin Play")).toBe(
      "Event Begin Play",
    );
  });

  it("formats flow.event types as Event … instead of flow event …", () => {
    expect(displayNodeTitle("flow.event.beginPlay")).toBe("Event Begin Play");
    expect(displayNodeTitle("flow.event.tick")).toBe("Event Tick");
    expect(displayNodeTitle("flow.event.custom")).toBe("Event Custom");
    expect(displayNodeTitle("flow.event.camera2D")).toBe("Event Camera 2D");
  });
});

describe("pinsAreCompatible", () => {
  it("connects exec out to exec in", () => {
    expect(pinsAreCompatible(execOut, execIn)).toBe(true);
  });

  it("rejects same-direction or mismatched kinds", () => {
    expect(pinsAreCompatible(execOut, execOut)).toBe(false);
    expect(pinsAreCompatible(execOut, stringIn)).toBe(false);
    expect(pinsAreCompatible(stringOut, floatIn)).toBe(false);
  });

  it("connects matching data types", () => {
    expect(pinsAreCompatible(stringOut, stringIn)).toBe(true);
  });
});

describe("filterPaletteForPin", () => {
  const log: PaletteNode = {
    id: "debug.log",
    title: "Log",
    category: "Debug",
    pins: [execIn, execOut, stringIn],
  };
  const begin: PaletteNode = {
    id: "flow.event.beginPlay",
    title: "Event Begin Play",
    category: "Flow",
    pins: [execOut],
  };

  it("keeps nodes that expose a compatible opposite pin", () => {
    expect(filterPaletteForPin([log, begin], execOut).map((n) => n.id)).toEqual([
      "debug.log",
    ]);
    expect(filterPaletteForPin([log, begin], stringOut).map((n) => n.id)).toEqual(
      ["debug.log"],
    );
  });
});

describe("isNearSourcePin", () => {
  it("cancels when the drop is close to the source pin", () => {
    expect(
      isNearSourcePin({ x: 10, y: 10 }, { x: 12, y: 11 }, CONNECT_END_CANCEL_PX),
    ).toBe(true);
    expect(
      isNearSourcePin({ x: 10, y: 10 }, { x: 200, y: 80 }, CONNECT_END_CANCEL_PX),
    ).toBe(false);
  });
});
