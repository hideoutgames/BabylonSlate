import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { AnimEvalState } from "@haptic/anim-graph";
import { AnimSpriteFrameView } from "./anim-sprite-frame-view";

/** Each Texture's pixels arrive when the test resolves them, so a test controls what has loaded. */
const harness = vi.hoisted(() => ({
  pending: new Map<string, (bytes: Uint8Array) => void>(),
  readAssetChunk: vi.fn<(path: string, chunk: string) => Promise<Uint8Array>>(),
}));

/** Idle and Walk each show one Texture frame. */
const animation = (textureGuid: string) => ({
  frameDurationMs: 100,
  source: "frames",
  frames: [{ textureGuid, durationMs: 100, pivot: { x: 0.5, y: 0.5 } }],
});
const assets = [
  { path: "assets/Idle.hasset", header: { guid: "idle", name: "Idle", type: "SpriteAnimation", payload: animation("idle-tex") } },
  { path: "assets/Walk.hasset", header: { guid: "walk", name: "Walk", type: "SpriteAnimation", payload: animation("walk-tex") } },
  { path: "assets/IdleTex.hasset", header: { guid: "idle-tex", name: "IdleTex", type: "Texture", payload: { width: 16, height: 16 } } },
  { path: "assets/WalkTex.hasset", header: { guid: "walk-tex", name: "WalkTex", type: "Texture", payload: { width: 16, height: 16 } } },
];

/** One registry for every hook call, as the editor's is. */
const assetRegistry = {
  list: () => assets,
  getByGuid: (guid: string) => assets.find((asset) => asset.header.guid === guid),
};

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    assetRegistry,
    readAssetChunk: harness.readAssetChunk,
  })),
);

function playing(clipAssetGuid: string): AnimEvalState {
  return {
    stateId: "move",
    normalisedTime: 0,
    blendWeights: { move: 1 },
    timeMs: 0,
    facts: { elapsedSeconds: 0, durationSeconds: 0.1, normalisedTime: 0, remainingSeconds: 0.1 },
    blendFromStateId: null,
    blendElapsedMs: 0,
    players: {},
    selectors: {},
    layers: [{ stateId: "move", clipAssetGuid, clipName: "", clipKind: "sprite", normalisedTime: 0, weight: 1 }],
  } as unknown as AnimEvalState;
}

async function load(path: string) {
  await act(async () => {
    harness.pending.get(path)?.(new Uint8Array([1, 2, 3]));
    await Promise.resolve();
  });
}

const view = () => screen.getByTestId("frames");
const image = () => view().querySelector("img")?.getAttribute("src") ?? null;

beforeEach(() => {
  harness.readAssetChunk.mockImplementation((path) => new Promise((resolve) => harness.pending.set(path, resolve)));
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:${harness.readAssetChunk.mock.calls.length}-${Math.random()}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  harness.pending.clear();
  harness.readAssetChunk.mockReset();
});

describe("AnimSpriteFrameView", () => {
  it("loads every Sprite Animation it can play up front, so a switch shows the next frame at once", async () => {
    const { rerender } = render(<AnimSpriteFrameView state={playing("idle")} spriteAnimationGuids={["idle", "walk"]} data-testid="frames" />);
    expect(harness.readAssetChunk.mock.calls.map(([path]) => path).sort()).toEqual(["assets/IdleTex.hasset", "assets/WalkTex.hasset"]);
    await load("assets/IdleTex.hasset");
    await load("assets/WalkTex.hasset");
    const idleImage = image();
    expect(idleImage).toMatch(/^blob:/);
    rerender(<AnimSpriteFrameView state={playing("walk")} spriteAnimationGuids={["idle", "walk"]} data-testid="frames" />);
    expect(view().getAttribute("data-clip")).toBe("walk");
    expect(view().getAttribute("data-frame-loading")).toBe("false");
    expect(image()).toMatch(/^blob:/);
    expect(image()).not.toBe(idleImage);
  });

  it("keeps the last frame while the next one's Texture loads, instead of a blank view", async () => {
    const { rerender } = render(<AnimSpriteFrameView state={playing("idle")} data-testid="frames" />);
    await load("assets/IdleTex.hasset");
    const idleImage = image();
    expect(idleImage).toMatch(/^blob:/);
    // Walk was not named up front: its Texture starts loading only now.
    rerender(<AnimSpriteFrameView state={playing("walk")} data-testid="frames" />);
    expect(view().getAttribute("data-clip")).toBe("walk");
    expect(view().getAttribute("data-frame-loading")).toBe("true");
    expect(image()).toBe(idleImage);
    await load("assets/WalkTex.hasset");
    expect(view().getAttribute("data-frame-loading")).toBe("false");
    expect(image()).not.toBe(idleImage);
    // Idle stays loaded once shown: switching back reads nothing again.
    const reads = harness.readAssetChunk.mock.calls.length;
    rerender(<AnimSpriteFrameView state={playing("idle")} data-testid="frames" />);
    expect(image()).toBe(idleImage);
    expect(harness.readAssetChunk.mock.calls.length).toBe(reads);
  });
});
