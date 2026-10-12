import { describe, expect, it } from "vitest";
import { createDefaultScene, type SerializedScene, type SerializedSceneLayer } from "@babylonslate/core";
import { indexSceneLibrary } from "./scene-library";

function named(name: string): SerializedScene {
  return { ...createDefaultScene(), name };
}

function index(sceneLibrary: Record<string, SerializedScene>) {
  const targets = { scenes: new Map<string, SerializedScene>(), sceneGuids: new Map<string, string>(), sceneLayers: new Map<string, SerializedSceneLayer>() };
  indexSceneLibrary({ sceneLibrary, playSceneGuid: "play", acquired: false }, targets);
  return targets;
}

describe("indexSceneLibrary", () => {
  it.each([
    ["before", (a: SerializedScene, b: SerializedScene) => ({ a, b })],
    ["after", (a: SerializedScene, b: SerializedScene) => ({ b, a })],
  ])("keeps a key when another Scene's display name matches it, listed %s that Scene", (_order, library) => {
    const a = named("b");
    const b = named("Second");
    const { scenes, sceneGuids } = index(library(a, b));
    expect(scenes.get("b")).toBe(b);
    expect(sceneGuids.get("b")).toBe("b");
    expect(scenes.get("Second")).toBe(b);
    expect(sceneGuids.get("Second")).toBe("b");
  });

  it("resolves a shared display name to one Scene in both lookups", () => {
    const first = named("Level");
    const second = named("Level");
    const { scenes, sceneGuids } = index({ first, second });
    expect(sceneGuids.get("Level")).toBe("first");
    expect(scenes.get("Level")).toBe(first);
  });
});
