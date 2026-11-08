import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { createDefaultTimelineClipAsset, defaultTimelineProxyPreview, type SerializedScene, type SerializedTimelineClipAsset } from "@haptic/core";
import { TIMELINE_PROXY_SHAPE_CLASS_ID } from "@haptic/render";
import { SceneToolsProvider, useSceneTools } from "../context/scene-tools-context";
import { selectProxies, useSelectedProxies } from "../components/timeline-clip-asset-editor";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";
import { TimelineClipPreviewPanel } from "./timeline-clip-preview-panel";

const DOC = "timeline-clip-3d:assets/Swing.timelineclip3d.hasset";
const harness = vi.hoisted(() => {
  const handle = {
    editor: {
      camera: {
        importSessionState: vi.fn(), exportSessionState: vi.fn(() => ({})), setPivotAroundCenter: vi.fn(),
        mode: "3d", pivotAroundCenter: false, fly: vi.fn(), look: vi.fn(),
      },
      setViewportMode: vi.fn(),
      setViewportShadingMode: vi.fn(),
      setSelectedActors: vi.fn(),
      setGridSettings: vi.fn(),
      grid: { setCameraBounds: vi.fn(), setVisible: vi.fn() },
      gizmos: { setTool: vi.fn(), setSpace: vi.fn(), setSnap: vi.fn() },
      selectedActorTransforms: vi.fn((): Array<{ actorId: string; position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] }> => []),
    },
    scheduler: { setAlwaysRender: vi.fn(), acquireObstruction: vi.fn(), setResizing: vi.fn(), acquireContinuous: vi.fn() },
    scaling: {},
    resourceCache: {},
    loadScene: vi.fn(),
    setMeshAssets: vi.fn(),
    setMaterialDocuments: vi.fn(),
    setRenderSettings: vi.fn(),
    setPaused: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    handle,
    createEngineMock: vi.fn<(canvas: unknown, options: Record<string, unknown>) => typeof handle>(() => handle),
    content: null as unknown as SerializedTimelineClipAsset,
    applyAssetDocumentChange: vi.fn(async (_id: string, payload: unknown) => {
      harness.content = payload as SerializedTimelineClipAsset;
      return true;
    }),
    kind: "timeline-clip-3d" as "timeline-clip-2d" | "timeline-clip-3d",
  };
});

vi.mock("@haptic/render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@haptic/render")>()),
  createEngine: (canvas: unknown, options: Record<string, unknown>) => harness.createEngineMock(canvas, options),
  syncEditorPlayState: vi.fn(),
}));
vi.mock("../context/play-context", () => {
  // Stable like the provider's: a fresh Engine or callback per render would remount the viewport each time.
  const sharedEngine = { id: "shared" };
  const play = { ensureSharedEngine: () => sharedEngine, sharedEngineGeneration: 1, registerScheduler: () => () => {}, playing: false, preparing: false };
  return { usePlay: () => play };
});
vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: DOC }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  get openDocuments() {
    return [{ id: DOC, ref: { kind: harness.kind, path: "assets/Swing.timelineclip3d.hasset" }, content: harness.content }];
  },
  assetRegistry: { generation: 1, list: () => [], getByPath: () => undefined } as never,
  applyAssetDocumentChange: harness.applyAssetDocumentChange,
  projectDocument: null,
  collectPlayModelBytes: async () => new Map(),
  collectPlayModelPayloads: async () => new Map(),
  collectPlayMaterialLibrary: async () => ({ documents: new Map(), functions: new Map(), textureGuids: [] }),
  collectPlayTextureBytes: async () => new Map(),
  collectPlayTexturePixelSizes: () => new Map(),
})));
vi.mock("../components/viewport-toolbar", () => ({ ViewportToolbar: () => null }));
vi.mock("../lib/viewport-render-gate", () => ({ attachViewportRenderGate: () => () => {} }));

const key = (id: string, Time: number, Value: unknown) => ({ id, Time, Value, Interpolation: "linear" as const, ArriveTangent: 0, LeaveTangent: 0 });
const panel = {} as IDockviewPanelProps;
let tools: ReturnType<typeof useSceneTools> | null = null;
let selected: readonly string[] = [];
function Probe() {
  tools = useSceneTools();
  selected = useSelectedProxies(DOC);
  useEffect(() => {});
  return null;
}
const lastScene = () => harness.handle.loadScene.mock.calls.at(-1)![0] as SerializedScene;

beforeEach(() => {
  harness.kind = "timeline-clip-3d";
  harness.content = {
    ...createDefaultTimelineClipAsset("story"),
    length: 2,
    proxies: [{ id: "door", name: "Door", represents: "actor", classId: "Actor", tracks: [{
      id: "t", target: { kind: "transform", property: "location" }, valueType: "vec3",
      keys: [key("a", 0, { x: 0, y: 0, z: 0 }), key("b", 2, { x: 2, y: 0, z: 0 })],
    }] }],
    editorPreview: { proxies: { door: { ...defaultTimelineProxyPreview(0), location: [5, 0, 0], scale: [2, 2, 2] } } },
  };
  harness.createEngineMock.mockClear();
  harness.handle.loadScene.mockClear();
  harness.applyAssetDocumentChange.mockClear();
});
afterEach(() => {
  cleanup();
  tools = null;
  selectProxies(DOC, []);
});

describe("TimelineClipPreviewPanel", () => {
  it("renders its proxies to a texture on the shared Engine, each by its representation", async () => {
    render(<SceneToolsProvider><Probe /><TimelineClipPreviewPanel {...panel} /></SceneToolsProvider>);
    await waitFor(() => expect(harness.handle.loadScene).toHaveBeenCalled());
    expect(harness.createEngineMock.mock.calls[0]![1]).toMatchObject({ editor: true, present: "rtt", viewportMode: "3d", previewLighting: true, sharedEngine: { id: "shared" } });
    const door = lastScene().actors.find((actor) => actor.id === "door")!;
    // A Shape in the proxy's colour, sized by the proxy's Scale.
    expect(door.components).toEqual([expect.objectContaining({ classId: TIMELINE_PROXY_SHAPE_CLASS_ID, properties: { color: "#f97316", twoD: false } })]);
    expect(door.transform.scale).toEqual([2, 2, 2]);
    // Relative: the keyed offset at 0 s is the preview placement itself.
    expect(door.transform.position).toEqual([5, 0, 0]);
  });

  it("moves the proxies with the playhead, and a pick selects the proxy", async () => {
    render(<SceneToolsProvider><Probe /><TimelineClipPreviewPanel {...panel} /></SceneToolsProvider>);
    await waitFor(() => expect(harness.handle.loadScene).toHaveBeenCalled());
    act(() => tools!.timelinePlayhead.set(1));
    expect(lastScene().actors.find((actor) => actor.id === "door")!.transform.position).toEqual([6, 0, 0]);
    const { onPickActor } = harness.createEngineMock.mock.calls[0]![1] as { onPickActor: (id: string) => void };
    act(() => onPickActor("door"));
    expect(selected).toEqual(["door"]);
    await waitFor(() => expect(harness.handle.editor.setSelectedActors).toHaveBeenLastCalledWith(["door"]));
  });

  it("turns a released gizmo into a moved placement, and a tracked move into an unkeyed value without Auto Key", async () => {
    render(<SceneToolsProvider><Probe /><TimelineClipPreviewPanel {...panel} /></SceneToolsProvider>);
    await waitFor(() => expect(harness.handle.loadScene).toHaveBeenCalled());
    expect(harness.handle.editor.gizmos.setTool).toHaveBeenCalled();
    const { onGizmoDragEnd } = harness.createEngineMock.mock.calls[0]![1] as { onGizmoDragEnd: () => void };
    // Turned 30 degrees where it stands: Rotation has no track, so the placement turns.
    const yaw30: [number, number, number, number] = [0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)];
    harness.handle.editor.selectedActorTransforms.mockReturnValue([{ actorId: "door", position: [5, 0, 0], rotation: yaw30, scale: [2, 2, 2] }]);
    act(() => onGizmoDragEnd());
    const placed = harness.applyAssetDocumentChange.mock.calls.at(-1)![1] as SerializedTimelineClipAsset;
    expect(placed.editorPreview!.proxies.door!.rotation.map((value) => Math.round(value))).toEqual([0, 30, 0]);
    // Moved along the tracked Location while Auto Key is off: an unkeyed value, the asset unchanged.
    harness.applyAssetDocumentChange.mockClear();
    harness.handle.editor.selectedActorTransforms.mockReturnValue([{ actorId: "door", position: [7, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 2] }]);
    act(() => onGizmoDragEnd());
    expect(harness.applyAssetDocumentChange).not.toHaveBeenCalled();
    expect([...tools!.timelineUnkeyed.keys()]).toEqual(["t"]);
  });

  it("selects the proxies a marquee frames, and adds or takes out a proxy on a Shift or Ctrl tap", async () => {
    harness.content = { ...harness.content, proxies: [...harness.content.proxies, { id: "lamp", name: "Lamp", represents: "actor", classId: "Actor", tracks: [] }] };
    render(<SceneToolsProvider><Probe /><TimelineClipPreviewPanel {...panel} /></SceneToolsProvider>);
    await waitFor(() => expect(harness.handle.loadScene).toHaveBeenCalled());
    const options = harness.createEngineMock.mock.calls[0]![1] as {
      onPickActor: (id: string | null, pick?: { additive: boolean }) => void;
      onMarqueeSelect: (ids: string[]) => void;
      onMarqueeMove: (rect: { x: number; y: number; width: number; height: number } | null) => void;
    };
    // The live marquee draws over the canvas while the finger drags.
    act(() => options.onMarqueeMove({ x: 4, y: 6, width: 40, height: 30 }));
    expect(document.querySelector('[data-testid="timeline-clip-viewport-marquee"]')).not.toBeNull();
    act(() => options.onMarqueeMove(null));
    expect(document.querySelector('[data-testid="timeline-clip-viewport-marquee"]')).toBeNull();
    act(() => options.onMarqueeSelect(["door", "lamp"]));
    expect(selected).toEqual(["door", "lamp"]);
    await waitFor(() => expect(harness.handle.editor.setSelectedActors).toHaveBeenLastCalledWith(["door", "lamp"]));
    act(() => options.onPickActor("door", { additive: true }));
    expect(selected).toEqual(["lamp"]);
    act(() => options.onPickActor("door", { additive: true }));
    expect(selected).toEqual(["lamp", "door"]);
    // A plain tap selects one; a tap on empty space clears.
    act(() => options.onPickActor("lamp", { additive: false }));
    expect(selected).toEqual(["lamp"]);
    act(() => options.onPickActor(null));
    expect(selected).toEqual([]);
    await waitFor(() => expect(harness.handle.editor.setSelectedActors).toHaveBeenLastCalledWith([]));
  });

  it("shows the Joystick, whose stick flies the preview camera under a render lease", async () => {
    const release = vi.fn();
    harness.handle.scheduler.acquireContinuous.mockReturnValue(release);
    // jsdom has no pointer capture.
    HTMLElement.prototype.setPointerCapture = () => {};
    render(<SceneToolsProvider><TimelineClipPreviewPanel {...panel} /></SceneToolsProvider>);
    await waitFor(() => expect(harness.handle.loadScene).toHaveBeenCalled());
    const stick = screen.getByTestId("viewport-joystick");
    // Pushed straight up from its centre: forward.
    act(() => dispatchPointerEvent(stick, "pointerdown", { clientX: 0, clientY: -40 }));
    expect(harness.handle.scheduler.acquireContinuous).toHaveBeenCalledWith("viewport-joystick");
    await waitFor(() => expect(harness.handle.editor.camera.fly.mock.calls.some(([forward, right]) => forward > 0 && right === 0)).toBe(true));
    act(() => dispatchPointerEvent(stick, "pointerup", { clientX: 0, clientY: -40 }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("previews a 2D clip in a locked 2D overlay viewport", async () => {
    harness.kind = "timeline-clip-2d";
    render(<SceneToolsProvider><TimelineClipPreviewPanel {...panel} /></SceneToolsProvider>);
    await waitFor(() => expect(harness.handle.loadScene).toHaveBeenCalled());
    expect(harness.createEngineMock.mock.calls[0]![1]).toMatchObject({ viewportMode: "2d", overlayTransformBox: true, previewLighting: false });
    expect(lastScene()).toMatchObject({ viewportMode: "2d", overlayEditor: true });
  });
});
