import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createActor, createDefaultScene, type SerializedScene } from "@haptic/core";
import type { EngineHandle } from "@haptic/render";
import { useLiveTilemapEdits } from "./use-live-tilemap-edits";

const state = vi.hoisted(() => ({
  openDocuments: [] as Array<{ id: string; ref: { kind: string; path: string }; content: unknown; dirty: boolean }>,
  assets: [
    { header: { guid: "map-guid", name: "Level", type: "Tilemap" }, path: "assets/Level.tilemap.hasset" },
    { header: { guid: "other-guid", name: "Other", type: "Tilemap" }, path: "assets/Other.tilemap.hasset" },
  ],
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: state.openDocuments,
  assetRegistry: {
    getByPath: (path: string) => state.assets.find((asset) => asset.path === path),
    getByGuid: (guid: string) => state.assets.find((asset) => asset.header.guid === guid),
    list: () => state.assets,
  },
})));

function sceneDrawing(guid: string): SerializedScene {
  return {
    ...createDefaultScene("2d"),
    actors: [createActor("ground", "Ground", { components: [{ id: "map", classId: "TilemapComponent", properties: { assetGuid: guid } }] })],
  };
}

function Probe({ scene, engine, onDiscarded }: { scene: SerializedScene; engine: EngineHandle; onDiscarded: () => void }) {
  useLiveTilemapEdits({ scene, engineRef: { current: engine }, onDiscarded });
  return null;
}

const tilemapDoc = (path: string, content: object, dirty: boolean) => ({ id: `tilemap:${path}`, ref: { kind: "tilemap", path }, content, dirty });

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.openDocuments = [];
});

describe("useLiveTilemapEdits", () => {
  it("hands each edit of an open Tilemap the Scene draws to the viewport, and hands it back when the tab closes", () => {
    const setLiveTilemap = vi.fn();
    const engine = { setLiveTilemap } as unknown as EngineHandle;
    const onDiscarded = vi.fn();
    const scene = sceneDrawing("map-guid");
    const first = { layers: [] };
    state.openDocuments = [tilemapDoc("assets/Level.tilemap.hasset", first, false), tilemapDoc("assets/Other.tilemap.hasset", { layers: [] }, true)];
    const view = render(<Probe scene={scene} engine={engine} onDiscarded={onDiscarded} />);
    // Only the Tilemap the Scene draws, with its open-document revision.
    expect(setLiveTilemap.mock.calls).toEqual([["map-guid", first, expect.stringMatching(/^open:\d+$/)]]);

    // A render with the same document hands nothing over again.
    view.rerender(<Probe scene={{ ...scene }} engine={engine} onDiscarded={onDiscarded} />);
    expect(setLiveTilemap).toHaveBeenCalledTimes(1);

    const edited = { layers: [{ id: "layer-1" }] };
    state.openDocuments = [tilemapDoc("assets/Level.tilemap.hasset", edited, true)];
    act(() => view.rerender(<Probe scene={scene} engine={engine} onDiscarded={onDiscarded} />));
    expect(setLiveTilemap).toHaveBeenLastCalledWith("map-guid", edited, expect.stringMatching(/^open:\d+$/));
    expect(setLiveTilemap.mock.calls[1]![2]).not.toBe(setLiveTilemap.mock.calls[0]![2]);

    // Closed with unsaved edits: handed back, and the saved map is asked for.
    state.openDocuments = [];
    act(() => view.rerender(<Probe scene={scene} engine={engine} onDiscarded={onDiscarded} />));
    expect(setLiveTilemap).toHaveBeenLastCalledWith("map-guid", null);
    expect(onDiscarded).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing more when a saved Tilemap's tab closes", () => {
    const setLiveTilemap = vi.fn();
    const engine = { setLiveTilemap } as unknown as EngineHandle;
    const onDiscarded = vi.fn();
    const scene = sceneDrawing("map-guid");
    state.openDocuments = [tilemapDoc("assets/Level.tilemap.hasset", { layers: [] }, false)];
    const view = render(<Probe scene={scene} engine={engine} onDiscarded={onDiscarded} />);
    state.openDocuments = [];
    act(() => view.rerender(<Probe scene={scene} engine={engine} onDiscarded={onDiscarded} />));
    expect(setLiveTilemap).toHaveBeenLastCalledWith("map-guid", null);
    expect(onDiscarded).not.toHaveBeenCalled();
  });
});
